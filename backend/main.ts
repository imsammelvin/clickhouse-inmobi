/**
 * Application entry point. Runs the read workload against ClickHouse with the ClickStack pipeline
 * attached, so a pass produces all three signals at once:
 *
 *   traces   app.pass -> app.query -> clickhouse.select      (nested, one trace per pass)
 *   metrics  app.queries, app.query.duration, app.pass.duration
 *   logs     one record per query, stamped with the trace_id of the span it ran in
 *
 *   bun run start                       one pass, then exit
 *   bun run start -- --loop             keep going until Ctrl-C (feeds a live ClickStack dashboard)
 *   bun run start -- --loop --interval=10 --iterations=20
 *
 * The queries themselves are the ones already defined in constants/queries.ts -- this file is the
 * harness that runs them under observability, not a place to add new analysis.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { DATABASE, makeClient, select } from "./clickhouse/client";
import { APP_WORKLOAD_INTERVAL_S, OTEL_ENDPOINT, SERVICE_NAME } from "../shared/constants";
import * as Q from "../shared/constants/queries";
import { AppFlag } from "../shared/enums";
import type { AppOptions, WorkloadQuery } from "../shared/interfaces";
import { elapsed, flagValue, hasFlag, runScript, sleep } from "../shared/utils/common.utils";
import {
  counter,
  flushObservability,
  histogram,
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../shared/utils/telemetryUtils";

// ---------------------------------------------------------------------------
// workload
// ---------------------------------------------------------------------------

/**
 * The read workload, in execution order. Every entry is an existing named query -- the point is to
 * put realistic ClickHouse work behind the pipeline, not to compute anything new.
 */
const WORKLOAD: WorkloadQuery[] = [
  { name: "server_info", sql: Q.SERVER_INFO },
  { name: "funnel_totals", sql: Q.funnelTotals },
  { name: "glossary_metrics", sql: Q.glossaryMetrics },
  { name: "funnel_integrity", sql: Q.funnelIntegrity },
  { name: "revenue_identity", sql: Q.revenueIdentity },
  { name: "daily_totals", sql: Q.dailyTotals },
  { name: "enrichment_gaps", sql: Q.enrichmentGaps },
  { name: "storage_stats", sql: Q.storageStats(DATABASE) },
];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

export const parseArgs = (argv: string[]): AppOptions => {
  const loop = hasFlag(argv, AppFlag.Loop);

  const interval = Number(flagValue(argv, AppFlag.Interval) ?? APP_WORKLOAD_INTERVAL_S);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error(
      `${AppFlag.Interval} must be a non-negative number of seconds, got "${interval}"`,
    );
  }

  const rawIterations = flagValue(argv, AppFlag.Iterations);
  // Without --loop a single pass is the whole run; with it, unbounded unless capped.
  const iterations = rawIterations ? Number(rawIterations) : loop ? Infinity : 1;
  if (!(iterations > 0)) {
    throw new Error(`${AppFlag.Iterations} must be a positive integer, got "${rawIterations}"`);
  }

  return { loop, interval, iterations };
};

// ---------------------------------------------------------------------------
// instruments
//
// Lazy -- see counter()/histogram() in telemetryUtils. Created at module load they would bind to
// the no-op meter provider that exists before initObservability() runs and export nothing.
// ---------------------------------------------------------------------------

const queryCounter = counter("app.queries", "Workload queries executed, by name and outcome");

const queryDuration = histogram(
  "app.query.duration",
  "Wall-clock duration of one workload query",
  "ms",
);

const passDuration = histogram(
  "app.pass.duration",
  "Wall-clock duration of one full workload pass",
  "ms",
);

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/**
 * Run one query under its own span. The `select()` helper opens a nested `clickhouse.select` span
 * underneath, which is what gives the trace its shape: pass -> query -> statement.
 */
const runQuery = async (client: ClickHouseClient, query: WorkloadQuery): Promise<void> => {
  const startedAt = performance.now();

  await withSpan("app.query", { "app.query.name": query.name }, async (span) => {
    try {
      const rows = await select<Record<string, unknown>>(client, query.sql);
      const ms = elapsed(startedAt) * 1000;

      span.setAttribute("app.query.rows", rows.length);
      span.setAttribute("app.query.duration_ms", Math.round(ms));
      queryCounter().add(1, {
        "app.query.name": query.name,
        "app.query.outcome": "ok",
      });
      queryDuration().record(ms, { "app.query.name": query.name });

      // Emitted inside the span, so ClickStack files it under this trace.
      log.info("query ok", {
        "app.query.name": query.name,
        "app.query.rows": rows.length,
        "app.query.duration_ms": Math.round(ms),
      });
    } catch (error) {
      queryCounter().add(1, {
        "app.query.name": query.name,
        "app.query.outcome": "error",
      });
      log.error("query failed", {
        "app.query.name": query.name,
        "error.message": error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
};

/** One full pass over the workload. Becomes exactly one trace in ClickStack. */
const runPass = async (client: ClickHouseClient, pass: number): Promise<number> => {
  const startedAt = performance.now();

  await withSpan(
    "app.pass",
    { "app.pass.number": pass, "app.pass.queries": WORKLOAD.length },
    async () => {
      log.info("pass started", { "app.pass.number": pass });

      for (const query of WORKLOAD) {
        await runQuery(client, query);
      }

      const ms = elapsed(startedAt) * 1000;
      passDuration().record(ms);
      log.info("pass finished", {
        "app.pass.number": pass,
        "app.pass.duration_ms": Math.round(ms),
      });
    },
  );

  return elapsed(startedAt) * 1000;
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));

  initObservability();
  const client = makeClient();

  // Ctrl-C in loop mode must still flush: an un-flushed batch is a lost trace.
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  log.info(
    `service "${SERVICE_NAME}" -> ClickStack ${OTEL_ENDPOINT}  ` +
      `(database "${DATABASE}", ${WORKLOAD.length} queries/pass)\n`,
  );

  try {
    for (let pass = 1; pass <= options.iterations && !stopping; pass++) {
      const ms = await runPass(client, pass);
      log.info(`  pass ${pass} done in ${ms.toFixed(0)}ms\n`);

      // Make the pass visible in the UI now rather than at process exit.
      if (options.loop) await flushObservability();

      const isLast = pass >= options.iterations;
      if (options.loop && !isLast && !stopping) {
        await sleep(options.interval * 1000);
      }
    }
  } finally {
    await client.close();
    // Flushes the batch processors; without it the last pass never reaches ClickStack.
    await shutdownObservability();
  }

  log.info("Telemetry flushed. View it at http://localhost:8080");
};

if (import.meta.main) await runScript(main);
