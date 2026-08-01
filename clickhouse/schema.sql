-- Canonical DDL for the InMobi ad-events star schema.
-- Owner: samarth (see TASKS.md T-006). Others: propose changes via BROADCAST + goal.md decision log.
--
-- Statements are separated by `;` on its own trailing position and executed in order by
-- `bun run clickhouse/schema.ts`. Everything is idempotent (IF NOT EXISTS / OR REPLACE), so the
-- script is safe to re-run. Nothing here drops data.
--
-- Layout:
--   1. dimension tables  (apps, advertisers, geo_device)   -- small, fully reloaded each ingest
--   2. dictionaries      (dict_*)                          -- in-memory lookups over the dims
--   3. fact table        (ad_events)                       -- 9M rows, daily partitions
--   4. ad_events_enriched VIEW                             -- THE query interface for other lanes
--   5. rollup tables + MVs (rollup_segment_hourly/_daily)  -- GENERATED, see clickhouse/rollup.ts
--
-- Section 5 is NOT in this file. The two rollup targets and the two materialized views that
-- maintain them are generated from the dimension registry in `clickhouse/rollup.ts`, because the
-- insert-time fan-out is 47 expressions that must agree exactly with what the query planner
-- believes exists -- maintaining that list in two places is how you get a planner reading a `dim`
-- the MV never wrote, which returns no rows and looks like a real zero. `bun run ch:schema` applies
-- this file and then those statements, in that order. Read rollup.ts for the grain and its
-- justification; the short version is that goal.md's proposed
-- (hour, app_id, geo_device_id, advertiser_id, ad_format) grain was measured and compresses
-- nothing -- 9M events land on ~9M keys -- so the rollup is long-format (bucket, dim, val) instead.

-- ---------------------------------------------------------------------------
-- 1. Dimensions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS apps
(
    app_id          String,
    category        LowCardinality(String),
    publisher_tier  LowCardinality(String)
)
ENGINE = MergeTree
ORDER BY app_id;

CREATE TABLE IF NOT EXISTS advertisers
(
    advertiser_id   String,
    vertical        LowCardinality(String),
    campaign_type   LowCardinality(String)
)
ENGINE = MergeTree
ORDER BY advertiser_id;

CREATE TABLE IF NOT EXISTS geo_device
(
    geo_device_id   String,
    region          LowCardinality(String),
    country         LowCardinality(String),
    device_model    LowCardinality(String),
    os_version      LowCardinality(String)
)
ENGINE = MergeTree
ORDER BY geo_device_id;

-- ---------------------------------------------------------------------------
-- 2. Dictionaries
--
-- The dims are tiny (2000 / 500 / 5000 rows), so we hold them in RAM and enrich with dictGet
-- instead of JOIN. A drill-down that groups by five dimensions at once then costs one hash probe
-- per row per dim rather than five join builds. LIFETIME 0 = never auto-refresh; the loader calls
-- SYSTEM RELOAD DICTIONARY explicitly after it reloads the dim tables.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE DICTIONARY dict_apps
(
    app_id          String,
    category        String DEFAULT '',
    publisher_tier  String DEFAULT ''
)
PRIMARY KEY app_id
SOURCE(CLICKHOUSE(TABLE 'apps'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(0);

CREATE OR REPLACE DICTIONARY dict_advertisers
(
    advertiser_id   String,
    vertical        String DEFAULT '',
    campaign_type   String DEFAULT ''
)
PRIMARY KEY advertiser_id
SOURCE(CLICKHOUSE(TABLE 'advertisers'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(0);

CREATE OR REPLACE DICTIONARY dict_geo_device
(
    geo_device_id   String,
    region          String DEFAULT '',
    country         String DEFAULT '',
    device_model    String DEFAULT '',
    os_version      String DEFAULT ''
)
PRIMARY KEY geo_device_id
SOURCE(CLICKHOUSE(TABLE 'geo_device'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(0);

-- ---------------------------------------------------------------------------
-- 3. Fact table
--
-- PARTITION BY day: 35 partitions over the 5-week window. Daily granularity is what makes the
-- loader idempotent -- one source chunk maps 1:1 onto one partition, so a re-run is
-- DROP PARTITION + re-INSERT with no dedup logic and no risk of double-counted revenue.
--
-- ORDER BY starts with event_time because every RCA query is time-windowed first ("what happened
-- between 14:00 and 18:00 on Jun 23") and only then sliced by dimension. Time-leading order plus
-- daily partitions means a one-hour investigation touches ~1/840th of the granules. ad_format is
-- second because it is the lowest-cardinality slice (5 values) and prunes cheaply; app_id and
-- geo_device_id follow for locality within a format.
--
-- Codecs: Delta+ZSTD on the monotonically increasing timestamp; ZSTD on the flags, which are
-- long runs of 0/1 and compress to near nothing.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ad_events
(
    event_time      DateTime CODEC(Delta(4), ZSTD(1)),
    app_id          LowCardinality(String),
    geo_device_id   LowCardinality(String),
    advertiser_id   LowCardinality(String),   -- '' when the request was not filled
    ad_format       LowCardinality(String),
    is_filled       UInt8 CODEC(ZSTD(1)),
    is_impression   UInt8 CODEC(ZSTD(1)),
    is_click        UInt8 CODEC(ZSTD(1)),
    revenue         Float64 CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (event_time, ad_format, app_id, geo_device_id);

-- ---------------------------------------------------------------------------
-- 4. The query interface
--
-- Other lanes should query `ad_events_enriched`, not `ad_events`. It is a plain VIEW, so it costs
-- zero storage and zero ingest time -- the dictGet calls resolve at query time against the
-- in-memory dictionaries. Every dimension in metrics_glossary.md is available as a flat column,
-- so a drill-down is a plain GROUP BY with no JOINs to get wrong.
--
-- Contract: this view's column names are stable. Add columns freely; renaming or removing one is a
-- Breaking: change and needs a BROADCAST entry.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW ad_events_enriched AS
SELECT
    event_time,
    toDate(event_time)                                                    AS event_date,
    toStartOfHour(event_time)                                             AS event_hour,
    toDayOfWeek(event_time)                                               AS day_of_week,
    toHour(event_time)                                                    AS hour_of_day,

    app_id,
    geo_device_id,
    advertiser_id,
    ad_format,

    dictGet('dict_apps',        'category',       tuple(app_id))          AS app_category,
    dictGet('dict_apps',        'publisher_tier', tuple(app_id))          AS publisher_tier,
    dictGet('dict_advertisers', 'vertical',       tuple(advertiser_id))   AS advertiser_vertical,
    dictGet('dict_advertisers', 'campaign_type',  tuple(advertiser_id))   AS campaign_type,
    dictGet('dict_geo_device',  'region',         tuple(geo_device_id))   AS region,
    dictGet('dict_geo_device',  'country',        tuple(geo_device_id))   AS country,
    dictGet('dict_geo_device',  'device_model',   tuple(geo_device_id))   AS device_model,
    dictGet('dict_geo_device',  'os_version',     tuple(geo_device_id))   AS os_version,

    is_filled,
    is_impression,
    is_click,
    revenue
FROM ad_events;
