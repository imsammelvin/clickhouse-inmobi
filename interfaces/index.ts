/**
 * Every shape used by more than one line of code. No `interface` or inline object type should
 * appear in scripts/ or utils/ -- it belongs here.
 */
import type { DimensionKey, SourceFile, Table } from "../enums";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** A dimension table, the CSV that fills it, and its primary key. */
export interface DimensionSource {
  table: Table;
  file: SourceFile;
  key: DimensionKey;
}

/** A dimension table and the row count it must have after a correct load. */
export interface DimensionExpectation {
  table: Table;
  key: DimensionKey;
  rows: number;
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

/** Parsed CLI options for scripts/load.ts. */
export interface LoadOptions {
  /** Reload every day even when its row count already matches the source. */
  force: boolean;
  dimsOnly: boolean;
  factsOnly: boolean;
  /** Keep the extracted per-day Parquet files instead of deleting them. */
  keepChunks: boolean;
  /** Reuse chunks already on disk -- the extract step is deterministic. */
  skipExtract: boolean;
  concurrency: number;
  /** ISO dates to load, or null for all of them. */
  only: string[] | null;
}

/** One calendar day of the fact table: one Parquet file, one ClickHouse partition. */
export interface DayChunk {
  /** ISO date, e.g. "2026-06-23". */
  date: string;
  /** ClickHouse partition id, e.g. "20260623". */
  partition: string;
  /** Absolute path to the extracted Parquet file. */
  path: string;
  /** Row count read from the Parquet footer, not a scan. */
  rows: number;
}

// ---------------------------------------------------------------------------
// query results
// ---------------------------------------------------------------------------

export interface VersionRow {
  version: string;
}

export interface ServerInfo {
  version: string;
  uptime: string;
  now: string;
}

/** `SELECT count() AS n` */
export interface CountRow {
  n: string;
}

/** Row count plus distinct-key count for a dimension table. */
export interface UniquenessRow {
  n: string;
  distinct: string;
}

/** Row of DuckDB's parquet_file_metadata(). */
export interface ParquetFileMeta {
  file_name: string;
  num_rows: number;
}

/** Funnel totals, computed identically in DuckDB and ClickHouse so they can be compared. */
export interface FunnelTotals {
  rows: number;
  fills: number;
  impressions: number;
  clicks: number;
  revenue: number;
  min_time: string;
  max_time: string;
}

/** Per-day rollup used for reconciliation. Numeric in DuckDB, string over the CH HTTP interface. */
export interface DayAggregate {
  d: string;
  rows: number;
  revenue: number;
}

export interface DayAggregateRaw {
  d: string;
  rows: string;
  revenue: string;
}

/** Row count of one active partition, from system.parts. */
export interface PartitionRow {
  partition: string;
  rows: string;
}

/** Storage footprint of one table, from system.parts. */
export interface PartStats {
  table: string;
  total_rows: string;
  compressed: string;
  uncompressed: string;
  ratio: number;
  parts: string;
}

/** The glossary metrics computed over a set of events. */
export interface MetricSnapshot {
  fill_rate: number;
  render_rate: number;
  ctr: number;
  ecpm: number;
  rpr: number;
}

/** Events that violate the Request -> Fill -> Impression -> Click ordering. All must be zero. */
export interface FunnelIntegrity {
  revenue_without_impression: string;
  impression_without_fill: string;
  click_without_impression: string;
}

/** Both sides of the revenue identity from metrics_glossary.md. */
export interface RevenueIdentity {
  lhs: number;
  rhs: number;
}

/** Counts of events whose dimension keys failed to resolve through the dictionaries. */
export interface EnrichmentGaps {
  no_app: string;
  no_geo: string;
  no_adv_on_filled: string;
  no_adv_on_unfilled: string;
}

// ---------------------------------------------------------------------------
// application (main.ts)
// ---------------------------------------------------------------------------

/** Parsed CLI options for main.ts. */
export interface AppOptions {
  /** Keep running passes instead of exiting after one. */
  loop: boolean;
  /** Seconds to wait between passes in loop mode. */
  interval: number;
  /** Number of passes to run. `Infinity` in unbounded loop mode. */
  iterations: number;
}

/** One named statement in the workload main.ts runs under observability. */
export interface WorkloadQuery {
  /** Stable label -- becomes the `app.query.name` attribute on spans, metrics and logs. */
  name: string;
  sql: string;
}

// ---------------------------------------------------------------------------
// http api (api/server.ts)
// ---------------------------------------------------------------------------

/** GET /ping -- ClickHouse round-trip plus the trace id that recorded it. */
export interface PingResponse {
  status: "ok" | "error";
  /** Round-trip time to ClickHouse and back, in milliseconds. */
  latencyMs: number;
  clickhouse?: ServerInfo;
  database: string;
  /** Look this up in ClickStack to see the trace this request produced. */
  traceId: string;
  error?: string;
}

/** GET /ad-events/count -- row count of the fact table. */
export interface CountResponse {
  status: "ok" | "error";
  table: string;
  /** Rows currently in the table. Safe as a JS number: 9M is far below 2^53. */
  count: number;
  latencyMs: number;
  traceId: string;
  error?: string;
}

/** GET /health -- liveness only, no dependencies touched. */
export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
}

// ---------------------------------------------------------------------------
// observability
// ---------------------------------------------------------------------------

/** One signal's row count in ClickStack, used by observability/verify.ts. */
export interface SignalCount {
  signal: string;
  rows: string;
  latest: string;
}

/** How many log records carry the trace they were emitted inside. */
export interface LogCorrelation {
  logs: string;
  correlated: string;
  traces: string;
}

/** One span of the most recent trace. `nested` is 0 for a root span, 1 for a child. */
export interface TraceSpanRow {
  span: string;
  nested: number;
  ms: number;
}

/** One metric this service has published to ClickStack. */
export interface PublishedMetric {
  metric: string;
  points: string;
  latest: string;
}
