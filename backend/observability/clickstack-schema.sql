-- ClickStack telemetry schema: the otel_* tables HyperDX reads.
--
-- Owner: observability lane. This is NOT clickhouse/schema.sql (the ad-events star schema, owned
-- separately) -- nothing here touches the fact or dimension tables.
--
-- Why this file exists: ClickStack's collector creates these tables itself on first ingest. When
-- telemetry is pointed at a ClickHouse that the collector has never written to -- e.g. ClickHouse
-- Cloud, with the collector managed elsewhere -- the tables are simply absent and every query in
-- the HyperDX UI comes back empty. This applies them up front.
--
-- Captured verbatim from the ClickStack all-in-one container (ClickHouse 26.5) with SHOW CREATE
-- TABLE, so the layout matches what ClickStack expects rather than an approximation of it.
-- Two deliberate edits from that dump:
--   * IF NOT EXISTS everywhere, so this is safe to re-run.
--   * the `text(tokenizer = 'array')` attribute-item indexes are dropped -- that index type needs
--     26.5+ and ClickHouse Cloud is on 26.2. They are a search optimisation only; the ALIAS
--     columns they indexed are kept, so queries still work, just without that acceleration.
--
-- On ClickHouse Cloud, MergeTree/SummingMergeTree are transparently mapped to their Shared*
-- equivalents, so the engine lines need no change.
--
--   bun run otel:schema

-- ------------------------------------------------------------------------
-- otel_logs
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_logs
(
    `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TraceId` String CODEC(ZSTD(1)),
    `SpanId` String CODEC(ZSTD(1)),
    `TraceFlags` UInt8,
    `SeverityText` LowCardinality(String) CODEC(ZSTD(1)),
    `SeverityNumber` UInt8,
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `Body` String CODEC(ZSTD(1)),
    `ResourceSchemaUrl` LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl` LowCardinality(String) CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` LowCardinality(String) CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `LogAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `EventName` String CODEC(ZSTD(1)),
    `__hdx_materialized_k8s.cluster.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.cluster.name'] CODEC(ZSTD(1)),
    `__hdx_materialized_k8s.container.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.container.name'] CODEC(ZSTD(1)),
    `__hdx_materialized_k8s.deployment.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.deployment.name'] CODEC(ZSTD(1)),
    `__hdx_materialized_k8s.namespace.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.namespace.name'] CODEC(ZSTD(1)),
    `__hdx_materialized_k8s.node.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.node.name'] CODEC(ZSTD(1)),
    `__hdx_materialized_k8s.pod.name` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.pod.name'] CODEC(ZSTD(1)),
    `__hdx_materialized_k8s.pod.uid` LowCardinality(String) MATERIALIZED ResourceAttributes['k8s.pod.uid'] CODEC(ZSTD(1)),
    `__hdx_materialized_deployment.environment.name` LowCardinality(String) MATERIALIZED ResourceAttributes['deployment.environment.name'] CODEC(ZSTD(1)),
    `ResourceAttributeItems` Array(String) ALIAS arrayMap(arr -> concat(arr.1, '=', arr.2), CAST(ResourceAttributes, 'Array(Tuple(String, String))')),
    `ScopeAttributeItems` Array(String) ALIAS arrayMap(arr -> concat(arr.1, '=', arr.2), CAST(ScopeAttributes, 'Array(Tuple(String, String))')),
    `LogAttributeItems` Array(String) ALIAS arrayMap(arr -> concat(arr.1, '=', arr.2), CAST(LogAttributes, 'Array(Tuple(String, String))'))
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)
TTL toDateTime(Timestamp) + toIntervalDay(30)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1, enable_block_number_column = 1, enable_block_offset_column = 1;

-- ------------------------------------------------------------------------
-- otel_traces
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_traces
(
    `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TraceId` String CODEC(ZSTD(1)),
    `SpanId` String CODEC(ZSTD(1)),
    `ParentSpanId` String CODEC(ZSTD(1)),
    `TraceState` String CODEC(ZSTD(1)),
    `SpanName` LowCardinality(String) CODEC(ZSTD(1)),
    `SpanKind` LowCardinality(String) CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `SpanAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `Duration` UInt64 CODEC(ZSTD(1)),
    `StatusCode` LowCardinality(String) CODEC(ZSTD(1)),
    `StatusMessage` String CODEC(ZSTD(1)),
    `Events.Timestamp` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Events.Name` Array(LowCardinality(String)) CODEC(ZSTD(1)),
    `Events.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Links.TraceId` Array(String) CODEC(ZSTD(1)),
    `Links.SpanId` Array(String) CODEC(ZSTD(1)),
    `Links.TraceState` Array(String) CODEC(ZSTD(1)),
    `Links.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `__hdx_materialized_rum.sessionId` String MATERIALIZED ResourceAttributes['rum.sessionId'] CODEC(ZSTD(1)),
    `SampleRate` UInt64 MATERIALIZED greatest(toUInt64OrZero(SpanAttributes['SampleRate']), 1) CODEC(T64, ZSTD(1)),
    `ResourceAttributeItems` Array(String) ALIAS arrayMap(arr -> concat(arr.1, '=', arr.2), CAST(ResourceAttributes, 'Array(Tuple(String, String))')),
    `SpanAttributeItems` Array(String) ALIAS arrayMap(arr -> concat(arr.1, '=', arr.2), CAST(SpanAttributes, 'Array(Tuple(String, String))')),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_rum_session_id __hdx_materialized_rum.sessionId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1,
    INDEX idx_lower_span_name lower(SpanName) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))
TTL toDate(Timestamp) + toIntervalDay(30)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- ------------------------------------------------------------------------
-- otel_metrics_sum
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_metrics_sum
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `TimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `Value` Float64 CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    `Exemplars.FilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Exemplars.TimeUnix` Array(DateTime) CODEC(ZSTD(1)),
    `Exemplars.Value` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.SpanId` Array(String) CODEC(ZSTD(1)),
    `Exemplars.TraceId` Array(String) CODEC(ZSTD(1)),
    `AggregationTemporality` Int32 CODEC(ZSTD(1)),
    `IsMonotonic` Bool CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
TTL toDateTime(TimeUnix) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1, index_granularity = 8192;

-- ------------------------------------------------------------------------
-- otel_metrics_gauge
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_metrics_gauge
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `TimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `Value` Float64 CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    `Exemplars.FilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Exemplars.TimeUnix` Array(DateTime) CODEC(ZSTD(1)),
    `Exemplars.Value` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.SpanId` Array(String) CODEC(ZSTD(1)),
    `Exemplars.TraceId` Array(String) CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
TTL toDateTime(TimeUnix) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1, index_granularity = 8192;

-- ------------------------------------------------------------------------
-- otel_metrics_histogram
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_metrics_histogram
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `TimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `Count` UInt64 CODEC(Delta(8), ZSTD(1)),
    `Sum` Float64 CODEC(ZSTD(1)),
    `BucketCounts` Array(UInt64) CODEC(ZSTD(1)),
    `ExplicitBounds` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.FilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Exemplars.TimeUnix` Array(DateTime) CODEC(ZSTD(1)),
    `Exemplars.Value` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.SpanId` Array(String) CODEC(ZSTD(1)),
    `Exemplars.TraceId` Array(String) CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    `Min` Float64 CODEC(ZSTD(1)),
    `Max` Float64 CODEC(ZSTD(1)),
    `AggregationTemporality` Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
TTL toDateTime(TimeUnix) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1, index_granularity = 8192;

-- ------------------------------------------------------------------------
-- otel_metrics_exponential_histogram
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_metrics_exponential_histogram
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `TimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `Count` UInt64 CODEC(Delta(8), ZSTD(1)),
    `Sum` Float64 CODEC(ZSTD(1)),
    `Scale` Int32 CODEC(ZSTD(1)),
    `ZeroCount` UInt64 CODEC(ZSTD(1)),
    `PositiveOffset` Int32 CODEC(ZSTD(1)),
    `PositiveBucketCounts` Array(UInt64) CODEC(ZSTD(1)),
    `NegativeOffset` Int32 CODEC(ZSTD(1)),
    `NegativeBucketCounts` Array(UInt64) CODEC(ZSTD(1)),
    `Exemplars.FilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Exemplars.TimeUnix` Array(DateTime) CODEC(ZSTD(1)),
    `Exemplars.Value` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.SpanId` Array(String) CODEC(ZSTD(1)),
    `Exemplars.TraceId` Array(String) CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    `Min` Float64 CODEC(ZSTD(1)),
    `Max` Float64 CODEC(ZSTD(1)),
    `AggregationTemporality` Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
TTL toDateTime(TimeUnix) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1, index_granularity = 8192;

-- ------------------------------------------------------------------------
-- otel_metrics_summary
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_metrics_summary
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `TimeUnix` DateTime CODEC(Delta(4), ZSTD(1)),
    `Count` UInt64 CODEC(Delta(8), ZSTD(1)),
    `Sum` Float64 CODEC(ZSTD(1)),
    `ValueAtQuantiles.Quantile` Array(Float64) CODEC(ZSTD(1)),
    `ValueAtQuantiles.Value` Array(Float64) CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_time_minmax TimeUnix TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, toStartOfHour(TimeUnix), cityHash64(Attributes), TimeUnix)
TTL toDateTime(TimeUnix) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1, index_granularity = 8192;

-- ------------------------------------------------------------------------
-- otel_logs_kv_rollup_15m
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_logs_kv_rollup_15m
(
    `Timestamp` DateTime,
    `ColumnIdentifier` LowCardinality(String),
    `Key` LowCardinality(String),
    `Value` String,
    `count` UInt64,
    INDEX idx_count_minmax count TYPE minmax GRANULARITY 1,
    INDEX idx_timestamp_minmax Timestamp TYPE minmax GRANULARITY 1
)
ENGINE = SummingMergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (ColumnIdentifier, Key, Timestamp, Value)
TTL Timestamp + toIntervalDay(30)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- ------------------------------------------------------------------------
-- otel_traces_kv_rollup_15m
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel_traces_kv_rollup_15m
(
    `Timestamp` DateTime,
    `ColumnIdentifier` LowCardinality(String),
    `Key` LowCardinality(String),
    `Value` String,
    `count` UInt64,
    INDEX idx_count_minmax count TYPE minmax GRANULARITY 1,
    INDEX idx_timestamp_minmax Timestamp TYPE minmax GRANULARITY 1
)
ENGINE = SummingMergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (ColumnIdentifier, Key, Timestamp, Value)
TTL Timestamp + toIntervalDay(30)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- ------------------------------------------------------------------------
-- otel_logs_attr_kv_rollup_15m_mv
-- ------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS otel_logs_attr_kv_rollup_15m_mv TO otel_logs_kv_rollup_15m
(
    `Timestamp` DateTime,
    `ColumnIdentifier` String,
    `Key` String,
    `Value` String,
    `count` UInt64
)
AS WITH elements AS
    (
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'SeverityText' AS Key,
            CAST(SeverityText, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'ServiceName' AS Key,
            CAST(ServiceName, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'ScopeName' AS Key,
            CAST(ScopeName, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'ScopeVersion' AS Key,
            CAST(ScopeVersion, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'ResourceSchemaUrl' AS Key,
            CAST(ResourceSchemaUrl, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'ScopeSchemaUrl' AS Key,
            CAST(ScopeSchemaUrl, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            '__hdx_materialized_k8s.cluster.name' AS Key,
            CAST(`__hdx_materialized_k8s.cluster.name`, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            '__hdx_materialized_k8s.container.name' AS Key,
            CAST(`__hdx_materialized_k8s.container.name`, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            '__hdx_materialized_k8s.deployment.name' AS Key,
            CAST(`__hdx_materialized_k8s.deployment.name`, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            '__hdx_materialized_k8s.namespace.name' AS Key,
            CAST(`__hdx_materialized_k8s.namespace.name`, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            '__hdx_materialized_k8s.node.name' AS Key,
            CAST(`__hdx_materialized_k8s.node.name`, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            '__hdx_materialized_k8s.pod.name' AS Key,
            CAST(`__hdx_materialized_k8s.pod.name`, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            '__hdx_materialized_k8s.pod.uid' AS Key,
            CAST(`__hdx_materialized_k8s.pod.uid`, 'String') AS Value
        FROM otel_logs
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            '__hdx_materialized_deployment.environment.name' AS Key,
            CAST(`__hdx_materialized_deployment.environment.name`, 'String') AS Value
        FROM otel_logs
    )
SELECT
    Timestamp,
    ColumnIdentifier,
    Key,
    Value,
    count() AS count
FROM elements
GROUP BY
    Timestamp,
    ColumnIdentifier,
    Key,
    Value;

-- ------------------------------------------------------------------------
-- otel_traces_kv_rollup_15m_mv
-- ------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS otel_traces_kv_rollup_15m_mv TO otel_traces_kv_rollup_15m
(
    `Timestamp` DateTime,
    `ColumnIdentifier` String,
    `Key` String,
    `Value` String,
    `count` UInt64
)
AS WITH elements AS
    (
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'ServiceName' AS Key,
            CAST(ServiceName, 'String') AS Value
        FROM otel_traces
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'SpanName' AS Key,
            CAST(SpanName, 'String') AS Value
        FROM otel_traces
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'SpanKind' AS Key,
            CAST(SpanKind, 'String') AS Value
        FROM otel_traces
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'StatusCode' AS Key,
            CAST(StatusCode, 'String') AS Value
        FROM otel_traces
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'ScopeName' AS Key,
            CAST(ScopeName, 'String') AS Value
        FROM otel_traces
        UNION ALL
        SELECT
            'NativeColumn' AS ColumnIdentifier,
            toStartOfFifteenMinutes(Timestamp) AS Timestamp,
            'ScopeVersion' AS Key,
            CAST(ScopeVersion, 'String') AS Value
        FROM otel_traces
    )
SELECT
    Timestamp,
    ColumnIdentifier,
    Key,
    Value,
    count() AS count
FROM elements
GROUP BY
    Timestamp,
    ColumnIdentifier,
    Key,
    Value;
