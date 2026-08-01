/**
 * Every SQL statement the scripts run, named. Scripts call these; they never build SQL inline.
 *
 * Statements prefixed `src` run in DuckDB against the raw source files. Everything else runs in
 * ClickHouse. The funnel-totals expression list is deliberately shared between the two so that
 * verify.ts compares like with like.
 */
import { Dictionary, Table, View } from "../enums";
import type { DimensionKey } from "../enums";

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export const VERSION = "SELECT version() AS version";

export const SERVER_INFO = `
  SELECT version()                         AS version,
         formatReadableTimeDelta(uptime()) AS uptime,
         toString(now())                   AS now`;

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

export const countRows = (table: Table): string => `SELECT count() AS n FROM ${table}`;

export const truncate = (table: Table): string => `TRUNCATE TABLE ${table}`;

export const reloadDictionary = (dictionary: Dictionary): string =>
  `SYSTEM RELOAD DICTIONARY ${dictionary}`;

/** Instant metadata op -- this is what makes a re-load idempotent instead of duplicating rows. */
export const dropPartition = (partition: string): string =>
  `ALTER TABLE ${Table.AdEvents} DROP PARTITION ${partition}`;

/**
 * The same drop, against a table a materialized view writes into.
 *
 * Needed because DROP PARTITION does not cascade. `ad_events` losing partition 20260621 leaves
 * `rollup_segment_hourly` holding that day's rows, and the re-INSERT then makes the MV add a second
 * copy -- so every rollup-served number for that day comes back exactly doubled, with no error and
 * no row-count mismatch on the fact table to notice. The loader drops the derived partitions in the
 * same retried unit as the fact partition, before the insert.
 */
export const dropDerivedPartition = (table: Table, partition: string): string =>
  `ALTER TABLE ${table} DROP PARTITION ${partition}`;

/**
 * Does the rollup agree with the fact table about how many events exist?
 *
 * Cheap enough to run at every entry point: `count()` on a MergeTree is metadata, and summing the
 * rollup's `ad_format` rows touches ~175 rows. Any single dimension's rows sum to the platform
 * total, so this is a complete check rather than a spot check -- one row missing from a day, one day
 * double-counted, or a rollup never backfilled all show up here as a mismatch.
 */
export const rollupCoverage = `
  SELECT (SELECT count() FROM ${Table.AdEvents})                        AS fact_events,
         (SELECT sum(events) FROM ${Table.RollupDaily} WHERE dim = 'ad_format') AS rollup_events,
         (SELECT count() FROM ${Table.RollupDaily})                     AS rollup_rows,
         (SELECT count() FROM ${Table.RollupHourly})                    AS rollup_hourly_rows`;

/** Rows currently in one derived partition -- the post-backfill assertion. */
export const derivedPartitionRows = (table: Table, partition: string): string => `
  SELECT count() AS n
    FROM ${table}
   WHERE toYYYYMMDD(event_date) = ${partition}
   SETTINGS select_sequential_consistency = 1`;

export const derivedPartitionCounts = (database: string, table: Table): string => `
  SELECT partition, sum(rows) AS rows
    FROM system.parts
   WHERE database = '${database}' AND table = '${table}' AND active
   GROUP BY partition`;

/**
 * Rows currently in one partition, read from the table itself rather than system.parts.
 * system.parts is replica-local metadata and lags a fresh insert on ClickHouse Cloud, which makes
 * it useless as a post-insert assertion. Sequential consistency gives us read-your-writes.
 */
export const partitionRowCount = (partition: string): string => `
  SELECT count() AS n
    FROM ${Table.AdEvents}
   WHERE toYYYYMMDD(event_time) = ${partition}
   SETTINGS select_sequential_consistency = 1`;

export const partitionCounts = (database: string): string => `
  SELECT partition, sum(rows) AS rows
    FROM system.parts
   WHERE database = '${database}' AND table = '${Table.AdEvents}' AND active
   GROUP BY partition`;

/**
 * Split the fact Parquet into one file per calendar day, in a single pass. DuckDB writes
 * hive-style directories and leaves the partition column out of the files themselves, so each
 * chunk carries exactly the nine columns `ad_events` expects.
 */
export const srcSplitByDay = (factFile: string, outDir: string): string => `
  COPY (
    SELECT *, CAST(event_time AS DATE) AS event_date
    FROM read_parquet('${factFile}')
  )
  TO '${outDir}'
  (FORMAT PARQUET, PARTITION_BY (event_date), COMPRESSION ZSTD, OVERWRITE_OR_IGNORE 1);`;

/** Row counts straight from Parquet footers -- a metadata read, not a scan. */
export const srcParquetFileMeta = (glob: string): string =>
  `SELECT file_name, num_rows FROM parquet_file_metadata('${glob}');`;

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/** Shared by both engines so the comparison is apples to apples. */
const FUNNEL_TOTALS_SELECT = `
  count(*)           AS rows,
  sum(is_filled)     AS fills,
  sum(is_impression) AS impressions,
  sum(is_click)      AS clicks,
  sum(revenue)       AS revenue,
  min(event_time)    AS min_time,
  max(event_time)    AS max_time`;

export const funnelTotals = `SELECT ${FUNNEL_TOTALS_SELECT} FROM ${Table.AdEvents}`;

export const srcFunnelTotals = (factFile: string): string =>
  `SELECT ${FUNNEL_TOTALS_SELECT} FROM read_parquet('${factFile}');`;

export const dimensionUniqueness = (table: Table, key: DimensionKey): string =>
  `SELECT count() AS n, uniqExact(${key}) AS distinct FROM ${table}`;

export const dailyTotals = `
  SELECT toString(toDate(event_time)) AS d,
         count(*)                     AS rows,
         sum(revenue)                 AS revenue
    FROM ${Table.AdEvents}
   GROUP BY d
   ORDER BY d`;

export const srcDailyTotals = (factFile: string): string => `
  SELECT CAST(event_time AS DATE)::VARCHAR AS d,
         count(*)                          AS rows,
         sum(revenue)                      AS revenue
    FROM read_parquet('${factFile}')
   GROUP BY 1
   ORDER BY 1;`;

/**
 * Unresolved keys mean a drill-down would bucket real revenue under a blank label. Unfilled
 * requests are the one legitimate gap -- no ad was served, so there is no advertiser to resolve.
 */
export const enrichmentGaps = `
  SELECT countIf(app_category        = '')                  AS no_app,
         countIf(region              = '')                  AS no_geo,
         countIf(advertiser_vertical = '' AND is_filled = 1) AS no_adv_on_filled,
         countIf(advertiser_vertical = '' AND is_filled = 0) AS no_adv_on_unfilled
    FROM ${View.AdEventsEnriched}`;

/** The metrics_glossary.md formulas, verbatim. Ratios are sum/sum, never an average of ratios. */
export const glossaryMetrics = `
  SELECT sum(is_filled)     / count()             AS fill_rate,
         sum(is_impression) / sum(is_filled)      AS render_rate,
         sum(is_click)      / sum(is_impression)  AS ctr,
         sum(revenue) / sum(is_impression) * 1000 AS ecpm,
         sum(revenue) / count()                   AS rpr
    FROM ${Table.AdEvents}`;

/** Request -> Fill -> Impression -> Click must be monotonic, and revenue only lands on impressions. */
export const funnelIntegrity = `
  SELECT countIf(revenue > 0 AND is_impression = 0)  AS revenue_without_impression,
         countIf(is_impression = 1 AND is_filled = 0) AS impression_without_fill,
         countIf(is_click = 1 AND is_impression = 0)  AS click_without_impression
    FROM ${Table.AdEvents}`;

/**
 * Revenue = Requests x Fill rate x (Impressions / Fills) x eCPM / 1000.
 * If this does not hold, the decomposition the RCA drill-down walks is built on sand.
 */
export const revenueIdentity = `
  SELECT sum(revenue) AS lhs,
         count() * (sum(is_filled) / count())
                 * (sum(is_impression) / sum(is_filled))
                 * (sum(revenue) / sum(is_impression) * 1000) / 1000 AS rhs
    FROM ${Table.AdEvents}`;

// ---------------------------------------------------------------------------
// observability
//
// ClickStack writes the OTLP signals into otel_* tables in this same ClickHouse, so the pipeline
// can be verified with plain SQL rather than by squinting at the UI.
// ---------------------------------------------------------------------------

/** Row count and freshness of each signal for one service. Zero rows anywhere = a broken pipeline. */
export const signalCounts = (service: string): string => `
  SELECT * FROM (
    SELECT 'traces'  AS signal, toString(count()) AS rows, toString(max(Timestamp)) AS latest
      FROM otel_traces  WHERE ServiceName = '${service}'
     UNION ALL
    SELECT 'logs',              toString(count()),         toString(max(Timestamp))
      FROM otel_logs    WHERE ServiceName = '${service}'
     UNION ALL
    SELECT 'metrics.sum',       toString(count()),         toString(max(TimeUnix))
      FROM otel_metrics_sum WHERE ServiceName = '${service}'
     UNION ALL
    SELECT 'metrics.histogram', toString(count()),         toString(max(TimeUnix))
      FROM otel_metrics_histogram WHERE ServiceName = '${service}'
  )
   ORDER BY signal`;

/**
 * How many log records carry the trace they were emitted inside. This is the check that matters:
 * logs without a TraceId still arrive, they are just no longer attached to the operation that
 * produced them, which is the entire reason for running logs through OTel rather than stdout.
 */
export const logTraceCorrelation = (service: string): string => `
  SELECT count()                            AS logs,
         countIf(TraceId != '')             AS correlated,
         uniqExactIf(TraceId, TraceId != '') AS traces
    FROM otel_logs
   WHERE ServiceName = '${service}'`;

/**
 * The span tree of the most recent trace, in start order. A flat list of roots here means context
 * propagation is broken -- see the AsyncLocalStorage note in utils/telemetryUtils.ts.
 */
export const latestTraceTree = (service: string): string => `
  SELECT SpanName                        AS span,
         if(ParentSpanId = '', 0, 1)     AS nested,
         round(Duration / 1e6, 1)        AS ms
    FROM otel_traces
   WHERE ServiceName = '${service}'
     AND TraceId = (
           -- Prefer a multi-span trace: a single-span one (e.g. /health, which touches nothing)
           -- would show the tree structure off badly even when propagation is fine.
           SELECT TraceId FROM otel_traces
            WHERE ServiceName = '${service}'
            GROUP BY TraceId
            ORDER BY count() > 1 DESC, max(Timestamp) DESC
            LIMIT 1)
   ORDER BY Timestamp`;

/** Metric names this service has published, with their latest value. */
export const publishedMetrics = (service: string): string => `
  SELECT MetricName AS metric, toString(count()) AS points, toString(max(TimeUnix)) AS latest
    FROM (
      SELECT MetricName, TimeUnix FROM otel_metrics_sum       WHERE ServiceName = '${service}'
      UNION ALL
      SELECT MetricName, TimeUnix FROM otel_metrics_histogram WHERE ServiceName = '${service}'
    )
   GROUP BY metric
   ORDER BY metric`;

export const storageStats = (database: string): string => `
  SELECT table,
         sum(rows)                                        AS total_rows,
         formatReadableSize(sum(data_compressed_bytes))   AS compressed,
         formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
         round(sum(data_uncompressed_bytes) / sum(data_compressed_bytes), 2) AS ratio,
         count()                                          AS parts
    FROM system.parts
   WHERE database = '${database}' AND active
   GROUP BY table
   ORDER BY total_rows DESC`;
