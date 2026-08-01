/**
 * Backfill the rollup tables from rows already in `ad_events` (TASKS.md T-013).
 *
 *   bun run ch:rollup
 *   bun run ch:rollup -- --only=2026-06-21
 *   bun run ch:rollup -- --concurrency=3
 *
 * WHY A BACKFILL EXISTS AT ALL. A materialized view is a trigger, not a definition: it only sees
 * inserts made after it was created. Creating the MVs over an already-loaded 9M-row table leaves
 * both rollups completely empty, and an empty rollup does not error -- it returns no rows, which a
 * caller reads as a real zero. So this script is not a convenience, it is the other half of
 * `ch:schema` whenever the fact table was loaded first.
 *
 * WHY NOT `POPULATE`. `CREATE MATERIALIZED VIEW ... POPULATE` is one statement and does the wrong
 * thing: rows inserted while it runs are silently missed. Explicit per-day backfill is idempotent
 * (drop the day's partitions first, exactly as the loader does), restartable after a failure, and
 * cheap to verify per day.
 *
 * Runs entirely server-side -- ClickHouse reads `ad_events` and writes the rollup without a byte
 * crossing the network.
 */
import { exec, makeClient, select, selectOne } from "../clickhouse/client";
import { ROLLUP_TABLES, backfillHourlySql } from "../clickhouse/rollup";
import * as Q from "../../shared/constants/queries";
import { DERIVED_TABLES, LoadFlag, Table } from "../../shared/enums";
import type { CountRow } from "../../shared/interfaces";
import {
  elapsed,
  flagList,
  flagValue,
  fmt,
  pool,
  runScript,
  secondsSince,
} from "../../shared/utils/common.utils";
import {
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

interface Options {
  only?: string[];
  concurrency: number;
}

/**
 * Default concurrency of 2, not the loader's 6.
 *
 * The loader's bottleneck is a laptop uplink, so parallelism is free there. Here the work is all
 * server-side: one day is 257k events fanned out 47 ways into ~12M intermediate rows before
 * grouping. Running six of those at once competes for the same memory the queries we are trying to
 * speed up will want.
 */
const DEFAULT_CONCURRENCY = 2;

const parseArgs = (argv: string[]): Options => {
  const raw = flagValue(argv, LoadFlag.Concurrency);
  const concurrency = raw === undefined ? DEFAULT_CONCURRENCY : Number(raw);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error(`${LoadFlag.Concurrency} must be an integer between 1 and 8, got "${raw}"`);
  }
  return { only: flagList(argv, LoadFlag.Only) ?? undefined, concurrency };
};

const partition = (date: string): string => date.replaceAll("-", "");

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  initObservability();
  const client = makeClient();
  const startedAt = performance.now();

  try {
    const days = (
      await select<{ d: string }>(
        client,
        `SELECT DISTINCT toString(toDate(event_time)) AS d FROM ${Table.AdEvents} ORDER BY d`,
      )
    ).map((row) => row.d);

    if (days.length === 0)
      throw new Error(`${Table.AdEvents} is empty -- run bun run ch:load first`);

    const wanted = options.only ? days.filter((d) => options.only!.includes(d)) : days;
    if (options.only) {
      const unknown = options.only.filter((d) => !days.includes(d));
      if (unknown.length > 0)
        throw new Error(`${LoadFlag.Only} names days with no data: ${unknown}`);
    }

    log.info(
      `== backfill ${ROLLUP_TABLES.hourly} + ${ROLLUP_TABLES.daily} ==\n` +
        `  ${wanted.length} day(s), concurrency ${options.concurrency}\n`,
    );

    let done = 0;
    await pool(wanted, options.concurrency, async (date) => {
      const dayStartedAt = performance.now();
      await withSpan("rollup.backfill.day", { "rollup.date": date }, async () => {
        // Same idempotency contract as the loader: drop before insert, so a re-run replaces a day
        // rather than adding a second copy of it.
        for (const table of DERIVED_TABLES) {
          await exec(client, Q.dropDerivedPartition(table, partition(date)), {
            alter_sync: "2",
          });
        }

        // Only the HOURLY insert is issued. `mv_rollup_segment_daily` is attached to the hourly
        // table, so this insert cascades into the daily rollup on its own -- issuing the daily
        // backfill as well would write every daily row twice. (`backfillDailySql` exists for
        // repairing daily in isolation, e.g. if that MV were ever recreated on its own.)
        await exec(client, backfillHourlySql(date));
      });

      const { n } = await selectOne<CountRow>(
        client,
        Q.derivedPartitionRows(Table.RollupHourly, partition(date)),
      );
      done++;
      log.info(
        `  ${date}  ${fmt(Number(n)).padStart(8)} hourly rows  ` +
          `${elapsed(dayStartedAt).toFixed(1)}s  [${done}/${wanted.length}]`,
      );
    });

    const coverage = await selectOne<{
      fact_events: string;
      rollup_events: string;
      rollup_rows: string;
      rollup_hourly_rows: string;
    }>(client, Q.rollupCoverage);

    const fact = Number(coverage.fact_events);
    const rollup = Number(coverage.rollup_events);
    log.info(
      `\n  ${ROLLUP_TABLES.hourly}: ${fmt(Number(coverage.rollup_hourly_rows))} rows` +
        `\n  ${ROLLUP_TABLES.daily}:  ${fmt(Number(coverage.rollup_rows))} rows` +
        `\n  events: fact ${fmt(fact)} vs rollup ${fmt(rollup)}`,
    );

    // A partial backfill is worse than none: it answers, and the answer is short by whatever is
    // missing. Fail rather than report success.
    if (options.only === undefined && fact !== rollup) {
      throw new Error(
        `rollup covers ${fmt(rollup)} events but ${Table.AdEvents} has ${fmt(fact)}. ` +
          `Re-run bun run ch:rollup, and do not query the rollup until they agree.`,
      );
    }

    log.info(`\nDone in ${secondsSince(startedAt)}. Next: bun run ch:verify-rollup`);
  } finally {
    await client.close();
    await shutdownObservability();
  }
};

if (import.meta.main) await runScript(main);
