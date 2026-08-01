/**
 * Paths, tuning knobs and expected values. No script should hard-code any of these.
 */
import { join, resolve } from "node:path";
import { DimensionKey, EnvVar, SourceFile, Table } from "../enums";
import type { DimensionExpectation, DimensionSource } from "../interfaces";

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const DATA_DIR = join(REPO_ROOT, "InMobi", "data");
export const SCHEMA_FILE = join(REPO_ROOT, "backend", "clickhouse", "schema.sql");
export const FACT_FILE = join(DATA_DIR, SourceFile.AdEvents);

/** Scratch space for the per-day Parquet chunks. Gitignored; deleted after a successful load. */
export const CHUNK_DIR = join(REPO_ROOT, "backend", "clickhouse", ".chunks");

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
  {
    table: Table.Advertisers,
    file: SourceFile.Advertisers,
    key: DimensionKey.Advertiser,
  },
  {
    table: Table.GeoDevice,
    file: SourceFile.GeoDevice,
    key: DimensionKey.GeoDevice,
  },
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

// ---------------------------------------------------------------------------
// observability (OTLP -> ClickStack collector)
// ---------------------------------------------------------------------------

/**
 * Identifies this process in ClickStack. Every signal -- trace, metric, log -- is tagged with it,
 * and it is the first thing you filter on in the UI. Override per process with OTEL_SERVICE_NAME
 * so the ingest scripts and the app show up as separate services.
 */
export const SERVICE_NAME = process.env[EnvVar.OtelServiceName] ?? "clickhouse-inmobi-ingest";

/** Shown in ClickStack alongside the service name; lets you tell a local run from a deployed one. */
export const DEPLOYMENT_ENVIRONMENT = process.env[EnvVar.DeploymentEnv] ?? "local";

/** Bumped by hand. Useful for "did this regression start with the version I shipped?" queries. */
export const SERVICE_VERSION = "0.1.0";

/** OTLP/HTTP endpoint of the local ClickStack collector (docker-compose maps 4318). */
export const OTEL_ENDPOINT = process.env[EnvVar.OtelEndpoint] ?? "http://localhost:4318";

/** How often the metric reader ships a batch to the collector. */
export const METRIC_EXPORT_INTERVAL_MS = 5_000;

/** Default seconds between workload passes when main.ts runs with --loop. */
export const APP_WORKLOAD_INTERVAL_S = 15;

/** Port the HTTP API listens on. */
export const API_PORT = Number(process.env[EnvVar.Port] ?? 2345);

/**
 * How many consecutive ports to try when API_PORT is taken. A stale `bun run serve` holding the
 * port should not stop you starting another one -- the actual port is printed on startup.
 */
export const API_PORT_SCAN = 10;

/**
 * Where ClickStack keeps the telemetry it ingests -- the otel_* tables.
 *
 * Deliberately separate from CLICKHOUSE_URL. The fact data lives in ClickHouse Cloud, but the
 * ClickStack all-in-one container writes its signals to its own bundled ClickHouse, so
 * observability/verify.ts has to look somewhere else than the app does. Defaults to that container.
 */
export const CLICKSTACK_URL = process.env[EnvVar.ClickStackUrl] ?? "http://localhost:8123";

/**
 * Standalone ClickStack collector (observability/collector.ts). Ports are offset by one from the
 * OTLP defaults because the local all-in-one container already holds 4317/4318.
 */
export const COLLECTOR_IMAGE = "clickhouse/clickstack-otel-collector:latest";
export const COLLECTOR_CONTAINER = "clickstack-collector";
export const COLLECTOR_HTTP_PORT = 4319;
export const COLLECTOR_GRPC_PORT = 4320;

/** DDL for ClickStack's otel_* tables, applied by observability/schema.ts. */
export const CLICKSTACK_SCHEMA_FILE = join(
  REPO_ROOT,
  "backend",
  "observability",
  "clickstack-schema.sql",
);
export const CLICKSTACK_USER = process.env[EnvVar.ClickStackUser] ?? "api";
export const CLICKSTACK_PASSWORD = process.env[EnvVar.ClickStackPassword] ?? "api";

/**
 * ClickStack generates an ingestion token at startup; the collector's bearer-token extension
 * requires it on every OTLP request. Defaults to the local dev container's token so the pipeline
 * works out of the box; override with OTEL_INGESTION_TOKEN for any other ClickStack instance.
 */
export const OTEL_INGESTION_TOKEN =
  process.env[EnvVar.OtelToken] ?? "9f575aae-5dea-47d8-95d2-a350cbab9d19";
