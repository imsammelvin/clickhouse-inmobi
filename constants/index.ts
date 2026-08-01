/**
 * Paths, tuning knobs and expected values. No script should hard-code any of these.
 */
import { join, resolve } from "node:path";
import { DimensionKey, SourceFile, Table } from "../enums";
import type { DimensionExpectation, DimensionSource } from "../interfaces";

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const DATA_DIR = join(REPO_ROOT, "InMobi", "data");
export const SCHEMA_FILE = join(REPO_ROOT, "clickhouse", "schema.sql");
export const FACT_FILE = join(DATA_DIR, SourceFile.AdEvents);

/** Scratch space for the per-day Parquet chunks. Gitignored; deleted after a successful load. */
export const CHUNK_DIR = join(REPO_ROOT, "clickhouse", ".chunks");

/** Glob matching the hive-partitioned chunks DuckDB writes into CHUNK_DIR. */
export const CHUNK_GLOB = `${CHUNK_DIR}/*/*.parquet`;

/** Pulls the ISO date back out of a chunk path like `.../event_date=2026-06-23/data_0.parquet`. */
export const CHUNK_DATE_PATTERN = /event_date=(\d{4}-\d{2}-\d{2})/;

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

export const DEFAULT_DATABASE = "default";

/** Big Parquet bodies over a long-haul link; the default 30s socket timeout is not enough. */
export const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/** How often the server emits a progress header to keep the cloud load balancer from idling us out. */
export const PROGRESS_HEADER_INTERVAL_MS = "50000";

// ---------------------------------------------------------------------------
// ingest tuning
// ---------------------------------------------------------------------------

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
export const RETRY_ATTEMPTS = 3;

/** Backoff before retry N, in ms: 1s, 2s, 4s ... */
export const retryBackoffMs = (attempt: number): number => 2 ** attempt * 500;

// ---------------------------------------------------------------------------
// data expectations
// ---------------------------------------------------------------------------

/** Dimension tables in load order, with the CSV that populates each. */
export const DIMENSION_SOURCES: DimensionSource[] = [
  { table: Table.Apps, file: SourceFile.Apps, key: DimensionKey.App },
  { table: Table.Advertisers, file: SourceFile.Advertisers, key: DimensionKey.Advertiser },
  { table: Table.GeoDevice, file: SourceFile.GeoDevice, key: DimensionKey.GeoDevice },
];

/** Row counts documented in InMobi/README_START_HERE.md. */
export const DIMENSION_EXPECTATIONS: DimensionExpectation[] = [
  { table: Table.Apps, key: DimensionKey.App, rows: 2000 },
  { table: Table.Advertisers, key: DimensionKey.Advertiser, rows: 500 },
  { table: Table.GeoDevice, key: DimensionKey.GeoDevice, rows: 5000 },
];

/**
 * Float sums differ in the last bits depending on summation order, so DuckDB and ClickHouse can
 * hold identical data and still disagree. Compare relatively, not exactly.
 */
export const FLOAT_TOLERANCE = 1e-9;

/** Render rate can legitimately reach exactly 1.0; allow a hair over for float error. */
export const RATIO_UPPER_BOUND = 1.0001;
