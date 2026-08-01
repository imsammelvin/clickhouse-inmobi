/**
 * Every literal that names something -- a table, a column, a file, a flag -- lives here.
 * If you are about to type one of those as a raw string, add it to an enum instead.
 */

/** Physical tables created by clickhouse/schema.sql. */
export enum Table {
  AdEvents = "ad_events",
  Apps = "apps",
  Advertisers = "advertisers",
  GeoDevice = "geo_device",
}

/** Views. `AdEventsEnriched` is the query interface every other lane should use. */
export enum View {
  AdEventsEnriched = "ad_events_enriched",
}

/** In-memory dictionaries backing the enriched view. LIFETIME(0) -- reload explicitly. */
export enum Dictionary {
  Apps = "dict_apps",
  Advertisers = "dict_advertisers",
  GeoDevice = "dict_geo_device",
}

/** Primary key column of each dimension table. */
export enum DimensionKey {
  App = "app_id",
  Advertiser = "advertiser_id",
  GeoDevice = "geo_device_id",
}

/** Source files under InMobi/data/. */
export enum SourceFile {
  AdEvents = "ad_events.parquet",
  Apps = "apps.csv",
  Advertisers = "advertisers.csv",
  GeoDevice = "geo_device.csv",
}

/** ClickHouse data formats used for inserts and queries. */
export enum DataFormat {
  Parquet = "Parquet",
  CsvWithNames = "CSVWithNames",
  JsonEachRow = "JSONEachRow",
}

/** Environment variables read from .env. */
export enum EnvVar {
  Url = "CLICKHOUSE_URL",
  User = "CLICKHOUSE_USER",
  Password = "CLICKHOUSE_PASSWORD",
  Database = "CLICKHOUSE_DATABASE",
  OtelEndpoint = "OTEL_EXPORTER_OTLP_ENDPOINT",
  OtelToken = "OTEL_INGESTION_TOKEN",
  OtelServiceName = "OTEL_SERVICE_NAME",
  DeploymentEnv = "DEPLOYMENT_ENVIRONMENT",
  /**
   * Where ClickStack *stores* the telemetry it ingests. This is a different ClickHouse from
   * CLICKHOUSE_URL: the app's data lives in ClickHouse Cloud, while the ClickStack container keeps
   * its otel_* tables locally. Only observability/verify.ts reads these.
   */
  ClickStackUrl = "CLICKSTACK_CLICKHOUSE_URL",
  ClickStackUser = "CLICKSTACK_CLICKHOUSE_USER",
  ClickStackPassword = "CLICKSTACK_CLICKHOUSE_PASSWORD",
  /** Port for the HTTP API in api/server.ts. */
  Port = "PORT",
  /**
   * Turns on OpenTelemetry's own internal logging: none | error | warn | info | debug | verbose.
   * Unset by default. This is how you find out that exports are silently failing -- the SDK
   * swallows exporter errors otherwise.
   */
  OtelLogLevel = "OTEL_LOG_LEVEL",
}

/** OTLP signal paths appended to the collector's base endpoint. */
export enum OtlpPath {
  Traces = "/v1/traces",
  Metrics = "/v1/metrics",
  Logs = "/v1/logs",
}

/** Outcome of a single verification assertion. */
export enum CheckStatus {
  Pass = "PASS",
  Fail = "FAIL",
}

/** CLI flags accepted by observability/verify.ts. */
export enum VerifyFlag {
  /** Which service to check. Defaults to OTEL_SERVICE_NAME / SERVICE_NAME. */
  Service = "--service",
}

/** HTTP routes served by api/server.ts. */
export enum ApiRoute {
  /** Liveness only -- answers even when ClickHouse is down. */
  Health = "/health",
  /** Round-trips a query to ClickHouse and reports what came back. */
  Ping = "/ping",
  /** Row count of the ad_events fact table. */
  AdEventsCount = "/ad-events/count",
}

/** CLI flags accepted by main.ts. */
export enum AppFlag {
  /** Keep running the workload instead of exiting after one pass. */
  Loop = "--loop",
  /** Seconds between passes in loop mode. */
  Interval = "--interval",
  /** Stop after N passes. Defaults to unbounded in loop mode, 1 otherwise. */
  Iterations = "--iterations",
}

/** CLI flags accepted by scripts/load.ts. */
export enum LoadFlag {
  Force = "--force",
  DimsOnly = "--dims-only",
  FactsOnly = "--facts-only",
  KeepChunks = "--keep-chunks",
  SkipExtract = "--skip-extract",
  Concurrency = "--concurrency",
  Only = "--only",
}
