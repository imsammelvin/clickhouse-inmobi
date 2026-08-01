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
}

/** Outcome of a single verification assertion. */
export enum CheckStatus {
  Pass = "PASS",
  Fail = "FAIL",
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
