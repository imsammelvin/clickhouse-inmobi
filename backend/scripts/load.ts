/**
 * Ingest: InMobi/data/* -> ClickHouse. Repeatable and idempotent (TASKS.md T-008).
 *
 *   bun run ch:load
 *   bun run ch:load -- --force --concurrency=6
 *   bun run ch:load -- --only=2026-06-21
 *
 * How it works
 * ------------
 * The 9M-row fact file is split once by DuckDB into one Parquet file per calendar day, which maps
 * 1:1 onto the daily partitions of `ad_events`. Each day is then loaded as:
 *
 *     ALTER TABLE ad_events DROP PARTITION <day>   -- instant metadata op
 *     INSERT INTO ad_events FORMAT Parquet         -- stream that day's file
 *
 * Drop-then-insert is what makes this idempotent: re-running can never double-count revenue, and a
 * crash halfway through leaves the finished days intact. Days upload in parallel because a single
 * 103 MB POST from a laptop is bottlenecked on uplink round-trips, not on the server.
 *
 * Requires the `duckdb` CLI on PATH (brew install duckdb).
 */
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import type { ClickHouseClient } from "@clickhouse/client";
import { DATABASE, exec, insert, makeClient, select, selectOne } from "../clickhouse/client";
import {
  CHUNK_DATE_PATTERN,
  CHUNK_DIR,
  CHUNK_GLOB,
  DEFAULT_CONCURRENCY,
  DIMENSION_SOURCES,
  FACT_FILE,
  MAX_CONCURRENCY,
  RETRY_ATTEMPTS,
} from "../../shared/constants";
import * as Q from "../../shared/constants/queries";
import { DataFormat, DERIVED_TABLES, Dictionary, LoadFlag, Table } from "../../shared/enums";
import type {
  CountRow,
  DayChunk,
  LoadOptions,
  PartitionRow,
  VersionRow,
} from "../../shared/interfaces";
import {
  assertDuckdb,
  duckdb,
  elapsed,
  flagList,
  flagValue,
  fmt,
  hasFlag,
  parquetFileMeta,
  pool,
  relPath,
  runScript,
  secondsSince,
  sourcePath,
  withRetry,
} from "../../shared/utils/common.utils";
import {
  counter,
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

export const parseArgs = (argv: string[]): LoadOptions => {
  const concurrency = Number(flagValue(argv, LoadFlag.Concurrency) ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(
      `${LoadFlag.Concurrency} must be an integer between 1 and ${MAX_CONCURRENCY}, ` +
        `got "${concurrency}"`,
    );
  }

  return {
    force: hasFlag(argv, LoadFlag.Force),
    dimsOnly: hasFlag(argv, LoadFlag.DimsOnly),
    factsOnly: hasFlag(argv, LoadFlag.FactsOnly),
    keepChunks: hasFlag(argv, LoadFlag.KeepChunks),
    skipExtract: hasFlag(argv, LoadFlag.SkipExtract),
    concurrency,
    only: flagList(argv, LoadFlag.Only),
  };
};

// ---------------------------------------------------------------------------
// dimensions
// ---------------------------------------------------------------------------

const dimensionsLoaded = counter(
  "ingest.dimensions.loaded",
  "Dimension rows loaded (replace), by table",
);

const loadDimensions = async (client: ClickHouseClient): Promise<void> => {
  log.info("== dimensions ==");

  for (const { table, file } of DIMENSION_SOURCES) {
    const path = sourcePath(file);
    if (!existsSync(path)) throw new Error(`Missing source file: ${path}`);

    const startedAt = performance.now();

    await withSpan("load.dimension", { "load.table": table }, async () => {
      // The dims are a few thousand rows with no natural version column, so a full replace is both
      // simplest and correct. TRUNCATE + INSERT is not atomic, but nothing reads these tables during
      // ingest -- queries hit the dictionaries, which only pick up new contents on the RELOAD below.
      await withRetry(`load ${table}`, RETRY_ATTEMPTS, async () => {
        await exec(client, Q.truncate(table));
        await insert(client, table, createReadStream(path), DataFormat.CsvWithNames);
      });
    });

    const { n } = await selectOne<CountRow>(client, Q.countRows(table));
    dimensionsLoaded().add(Number(n), { "load.table": table });
    log.info(
      `  ${table.padEnd(12)} ${fmt(Number(n)).padStart(9)} rows  ${secondsSince(startedAt)}`,
    );
  }

  // Dictionaries are LIFETIME(0), so they never refresh on their own. Without this reload the
  // enriched view would keep serving the previous load's dimension values.
  for (const dictionary of Object.values(Dictionary)) {
    await exec(client, Q.reloadDictionary(dictionary));
  }
  log.info("  dictionaries reloaded\n");
};

// ---------------------------------------------------------------------------
// fact: extract
// ---------------------------------------------------------------------------

const extractChunks = async (options: LoadOptions): Promise<DayChunk[]> => {
  return withSpan("load.extract", { "load.skip_extract": options.skipExtract }, async (span) => {
    const chunks = await extractChunksInner(options);
    span.setAttributes({
      "load.chunks": chunks.length,
      "load.rows": chunks.reduce((sum, chunk) => sum + chunk.rows, 0),
    });
    return chunks;
  });
};

const extractChunksInner = async (options: LoadOptions): Promise<DayChunk[]> => {
  if (!existsSync(FACT_FILE)) throw new Error(`Missing source file: ${FACT_FILE}`);

  if (options.skipExtract) {
    log.info("== extract (skipped, reusing existing chunks) ==");
  } else {
    log.info("== extract ==");
    const startedAt = performance.now();

    rmSync(CHUNK_DIR, { recursive: true, force: true });
    mkdirSync(CHUNK_DIR, { recursive: true });
    await duckdb(Q.srcSplitByDay(FACT_FILE, CHUNK_DIR));

    log.info(`  split ${relPath(FACT_FILE)} by day in ${secondsSince(startedAt)}`);
  }

  const meta = await parquetFileMeta(CHUNK_GLOB);
  if (meta.length === 0) throw new Error(`No chunks found under ${relPath(CHUNK_DIR)}`);

  const chunks: DayChunk[] = meta.map(({ file_name, num_rows }) => {
    const match = CHUNK_DATE_PATTERN.exec(file_name);
    if (!match) throw new Error(`Cannot infer date from chunk path: ${file_name}`);

    const date = match[1]!;
    return {
      date,
      partition: date.replaceAll("-", ""),
      path: file_name,
      rows: Number(num_rows),
    };
  });

  assertOneFilePerDay(chunks);
  chunks.sort((a, b) => a.date.localeCompare(b.date));

  const total = chunks.reduce((sum, chunk) => sum + chunk.rows, 0);
  log.info(
    `  ${chunks.length} daily chunks, ${fmt(total)} rows, ` +
      `${chunks[0]!.date} .. ${chunks.at(-1)!.date}\n`,
  );
  return chunks;
};

/**
 * One file per day is the expected shape. More than one would break the 1:1 chunk-to-partition
 * mapping that idempotency relies on, so refuse rather than silently load a partial day.
 */
const assertOneFilePerDay = (chunks: DayChunk[]): void => {
  const perDay = new Map<string, number>();
  for (const chunk of chunks) perDay.set(chunk.date, (perDay.get(chunk.date) ?? 0) + 1);

  const split = [...perDay].filter(([, count]) => count > 1).map(([date]) => date);
  if (split.length > 0) {
    throw new Error(
      `DuckDB wrote multiple files for ${split.join(", ")}. ` +
        `Delete ${relPath(CHUNK_DIR)} and re-run without ${LoadFlag.SkipExtract}.`,
    );
  }
};

// ---------------------------------------------------------------------------
// fact: load
// ---------------------------------------------------------------------------

/** Live row count per partition, straight from system.parts. */
const partitionCounts = async (client: ClickHouseClient): Promise<Map<string, number>> => {
  const rows = await select<PartitionRow>(client, Q.partitionCounts(DATABASE));
  return new Map(rows.map((row) => [row.partition, Number(row.rows)]));
};

/** Days still needing work: everything under --force, otherwise those whose counts disagree. */
const selectPending = (
  chunks: DayChunk[],
  existing: Map<string, number>,
  options: LoadOptions,
): DayChunk[] => {
  if (options.force) return chunks;

  return chunks.filter((chunk) => {
    const loaded = existing.get(chunk.partition);
    if (loaded === chunk.rows) {
      log.info(`  ${chunk.date}  skip (already ${fmt(loaded)} rows)`);
      return false;
    }
    return true;
  });
};

const loadDay = async (client: ClickHouseClient, chunk: DayChunk): Promise<void> => {
  await withSpan("load.day", { "load.date": chunk.date, "load.rows": chunk.rows }, async () => {
    // Drop, insert and confirm are retried as one unit: if the confirmation fails we do not know
    // which half went wrong, and redoing both is always safe because the drop comes first.
    await withRetry(`load ${chunk.date}`, RETRY_ATTEMPTS, async () => {
      // Drop first so a retry after a partially-consumed body cannot leave duplicate rows behind.
      // alter_sync = 2 waits for every replica to apply the drop -- without it the drop can land
      // *after* the insert that follows it and silently wipe the day we just loaded.
      await exec(client, Q.dropPartition(chunk.partition), {
        alter_sync: "2",
      });

      // The rollup tables get the same treatment, and this is not optional. A materialized view
      // fires on INSERT and knows nothing about the DROP that preceded it, so leaving yesterday's
      // rollup rows in place and re-inserting the day makes the MV *add* a second copy: every
      // rollup-served figure for that day comes back exactly doubled, with the fact table's own
      // row-count assertion still passing. The property D-014 bought -- "a reload can never
      // double-count revenue" -- has to be bought again for every derived table.
      for (const table of DERIVED_TABLES) {
        await exec(client, Q.dropDerivedPartition(table, chunk.partition), { alter_sync: "2" });
      }

      await insert(client, Table.AdEvents, createReadStream(chunk.path), DataFormat.Parquet);

      // Confirm the partition holds exactly the rows the source file claimed. Ingest that silently
      // loses rows is worse than ingest that fails.
      const { n } = await selectOne<CountRow>(client, Q.partitionRowCount(chunk.partition));
      if (Number(n) !== chunk.rows) {
        throw new Error(
          `expected ${fmt(chunk.rows)} rows in partition ${chunk.partition}, found ${fmt(Number(n))}`,
        );
      }
    });
  });
};

const loadFacts = async (client: ClickHouseClient, options: LoadOptions): Promise<void> => {
  return withSpan(
    "load.facts",
    { "load.force": options.force, "load.only": options.only?.join(",") ?? "(all)" },
    () => loadFactsInner(client, options),
  );
};

const loadFactsInner = async (client: ClickHouseClient, options: LoadOptions): Promise<void> => {
  await assertDuckdb();

  let chunks = await extractChunks(options);

  if (options.only) {
    const unknown = options.only.filter((date) => !chunks.some((chunk) => chunk.date === date));
    if (unknown.length > 0) {
      throw new Error(`${LoadFlag.Only} names days with no data: ${unknown.join(", ")}`);
    }
    const wanted = new Set(options.only);
    chunks = chunks.filter((chunk) => wanted.has(chunk.date));
  }

  log.info(`== load ${Table.AdEvents} ==`);
  const pending = selectPending(chunks, await partitionCounts(client), options);

  if (pending.length === 0) {
    log.info("  nothing to do -- all days already match the source\n");
    return;
  }

  const startedAt = performance.now();
  let done = 0;

  await pool(pending, options.concurrency, async (chunk) => {
    const dayStartedAt = performance.now();
    await loadDay(client, chunk);
    done++;
    log.info(
      `  ${chunk.date}  ${fmt(chunk.rows).padStart(9)} rows  ` +
        `${elapsed(dayStartedAt).toFixed(1)}s  [${done}/${pending.length}]`,
    );
  });

  const rows = pending.reduce((sum, chunk) => sum + chunk.rows, 0);
  const seconds = elapsed(startedAt);
  log.info(
    `\n  loaded ${fmt(rows)} rows in ${seconds.toFixed(1)}s ` +
      `(${fmt(Math.round(rows / seconds))} rows/s, concurrency ${options.concurrency})\n`,
  );
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  initObservability();
  const client = makeClient();
  const startedAt = performance.now();

  try {
    await withSpan(
      "load.run",
      {
        "load.concurrency": options.concurrency,
        "load.force": options.force,
        "load.dimsOnly": options.dimsOnly,
        "load.factsOnly": options.factsOnly,
        "load.only": options.only?.join(",") ?? "all",
      },
      async () => {
        const { version } = await selectOne<VersionRow>(client, Q.VERSION);
        log.info(`ClickHouse ${version}, database "${DATABASE}"\n`);

        if (!options.factsOnly) await loadDimensions(client);
        if (!options.dimsOnly) await loadFacts(client, options);

        if (!options.dimsOnly && !options.keepChunks) {
          rmSync(CHUNK_DIR, { recursive: true, force: true });
        }

        log.info(`Done in ${secondsSince(startedAt)}. Next: bun run ch:verify`);
      },
    );
  } finally {
    await client.close();
    await shutdownObservability();
  }
};

if (import.meta.main) await runScript(main);
