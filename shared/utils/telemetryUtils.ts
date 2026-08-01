/**
 * All telemetry in one place: the ClickStack OTLP pipeline, the Langfuse trace export, span
 * helpers, and structured logging. Every entry point imports from here -- there is no second
 * telemetry module.
 *
 * Pipeline: every span created via `withSpan`/`trySpan` goes to TWO destinations off the same
 * OTel TracerProvider, as two independent span processors:
 *
 *   initObservability()
 *     |-- traces   BatchSpanProcessor        -> /v1/traces   -> ClickStack -> otel_traces
 *     |-- traces   LangfuseSpanProcessor      ------------------> Langfuse Cloud
 *     |-- metrics  PeriodicExportingReader   -> /v1/metrics  -> ClickStack -> otel_metrics_*
 *     +-- logs     BatchLogRecordProcessor   -> /v1/logs     -> ClickStack -> otel_logs
 *
 * This means `investigation` / `stage.*` / `ledger.run.*` -- already instrumented for ClickStack --
 * are traced in Langfuse too with no changes to orchestrate.ts, ledger.ts or any stage file. No LLM
 * runs in this pipeline yet, so there is nothing "generation"-shaped to send; these are plain spans,
 * and `shouldExportSpan: () => true` is required because Langfuse's default filter only exports
 * spans that already look like Langfuse/GenAI spans, which a hand-built OTel span never does.
 * Skipped entirely (falls back to ClickStack-only) when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`
 * are not set, so a teammate without Langfuse configured locally isn't affected.
 *
 * Lifecycle: every entry point calls `initObservability()` first and `shutdownObservability()` in a
 * finally block. The shutdown is not optional -- the batch processors hold un-exported data, and a
 * CLI process that exits without flushing loses the tail of its own run, which is exactly the part
 * you want when something failed. `tracerProvider.shutdown()` shuts down every registered span
 * processor, so this flushes both ClickStack and Langfuse without extra plumbing.
 *
 * Correlation is the whole point. `withSpan` puts a span on the active context; `log` stamps every
 * record with that span's trace_id/span_id (as attributes, and the SDK sets them as columns too),
 * so in the ClickStack UI a log shows up attached to the operation that produced it.
 */
import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type Span,
} from "@opentelemetry/api";
import { logs, SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  DEPLOYMENT_ENVIRONMENT,
  METRIC_EXPORT_INTERVAL_MS,
  OTEL_ENDPOINT,
  OTEL_INGESTION_TOKEN,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "../constants";
import { EnvVar, OtlpPath } from "../enums";

/** The name every tracer, meter and logger in this codebase is created under. */
const INSTRUMENTATION_SCOPE = "clickhouse-inmobi";

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

let tracerProvider: BasicTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let loggerProvider: LoggerProvider | undefined;

/** ClickStack's collector authenticates every OTLP request with this bearer token. */
const headers = { Authorization: OTEL_INGESTION_TOKEN };

const url = (path: OtlpPath): string => `${OTEL_ENDPOINT}${path}`;

/**
 * Route OpenTelemetry's internal logging to the console when OTEL_LOG_LEVEL is set.
 *
 * Worth knowing about: by default the SDK swallows export failures. A wrong endpoint, an expired
 * ingestion key or a TLS problem all look exactly like a working pipeline from the application's
 * side -- the process runs fine and no telemetry ever appears. `OTEL_LOG_LEVEL=debug` is the way
 * to see the actual HTTP result of each export.
 */
const enableDiagnostics = (): void => {
  const level = process.env[EnvVar.OtelLogLevel];
  if (!level) return;

  const levels: Record<string, DiagLogLevel> = {
    none: DiagLogLevel.NONE,
    error: DiagLogLevel.ERROR,
    warn: DiagLogLevel.WARN,
    info: DiagLogLevel.INFO,
    debug: DiagLogLevel.DEBUG,
    verbose: DiagLogLevel.VERBOSE,
  };
  diag.setLogger(new DiagConsoleLogger(), levels[level.toLowerCase()] ?? DiagLogLevel.INFO);
};

/**
 * Wire up all three OTLP pipelines to ClickStack. Idempotent -- a second call is a no-op, so
 * modules that each initialise defensively cannot double-register exporters.
 *
 * The AsyncLocalStorage context manager is what lets child spans nest under their parent, and what
 * lets a log record find the span it was emitted inside. Without it `startActiveSpan` falls back to
 * a no-op context: every span becomes a root and every log loses its trace_id.
 */
export const initObservability = (): void => {
  if (tracerProvider) return;

  enableDiagnostics();

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  // W3C `traceparent`. Lets an inbound HTTP request continue a caller's trace instead of starting
  // a disconnected one, and lets our own outbound calls pass the trace on.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    // Not exported as a stable semconv constant in this version, so spelled out.
    "deployment.environment.name": DEPLOYMENT_ENVIRONMENT,
  });

  const spanProcessors: SpanProcessor[] = [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: url(OtlpPath.Traces), headers })),
  ];

  // Same spans, second destination. Only added when Langfuse is actually configured, so a
  // teammate running without it locally gets ClickStack-only tracing and nothing breaks.
  if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
    spanProcessors.push(
      new LangfuseSpanProcessor({
        // Default filter only forwards spans already shaped like Langfuse/GenAI spans. Every span
        // in this codebase is a hand-built OTel span (no LLM in the loop yet), so without this
        // override every one of them would be silently dropped before reaching Langfuse.
        shouldExportSpan: () => true,
      }),
    );
  }

  tracerProvider = new BasicTracerProvider({ resource, spanProcessors });
  trace.setGlobalTracerProvider(tracerProvider);

  meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: url(OtlpPath.Metrics),
          headers,
        }),
        exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: url(OtlpPath.Logs), headers }),
      }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
};

/**
 * Flush and tear down all three pipelines so the process can exit without dropping data.
 * `allSettled` rather than `all`: a collector that rejects one signal must not stop the other two
 * from flushing, and a failed flush is not worth crashing a run that already did its work.
 */
export const shutdownObservability = async (): Promise<void> => {
  await Promise.allSettled([
    tracerProvider?.shutdown(),
    meterProvider?.shutdown(),
    loggerProvider?.shutdown(),
  ]);
  tracerProvider = undefined;
  meterProvider = undefined;
  loggerProvider = undefined;
};

/**
 * Push buffered signals to ClickStack without tearing the pipelines down -- for a long-running
 * loop where the UI should show the current run before it finishes.
 */
export const flushObservability = async (): Promise<void> => {
  await Promise.allSettled([
    tracerProvider?.forceFlush(),
    meterProvider?.forceFlush(),
    loggerProvider?.forceFlush(),
  ]);
};

// ---------------------------------------------------------------------------
// spans
// ---------------------------------------------------------------------------

/** What a span produced: the value, or the error, plus how long it took. */
export type SpanOutcome<T> =
  { ok: true; value: T; ms: number } | { ok: false; error: Error; ms: number };

/**
 * Run `fn` inside a span and return the outcome as a value. The span's own timing is measured and
 * recorded on it as `app.duration_ms` so it is filterable in ClickStack; `withSpan` rethrows on
 * failure, `trySpan` returns it.
 */
const runSpan = async <T>(
  name: string,
  attributes: Attributes,
  kind: SpanKind,
  fn: (span: Span) => Promise<T>,
): Promise<SpanOutcome<T>> => {
  const startedAt = performance.now();

  return trace
    .getTracer(INSTRUMENTATION_SCOPE)
    .startActiveSpan(name, { kind }, async (span): Promise<SpanOutcome<T>> => {
      span.setAttributes(attributes);
      try {
        const value = await fn(span);
        const ms = Math.round(performance.now() - startedAt);
        span.setAttribute("app.duration_ms", ms);
        return { ok: true, value, ms };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const ms = Math.round(performance.now() - startedAt);
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.setAttribute("app.duration_ms", ms);
        return { ok: false, error: err, ms };
      } finally {
        span.end();
      }
    });
};

/**
 * Run `fn` inside a span, recording errors and ending the span. Returns what `fn` returned.
 * Safe to call before initObservability() -- the API falls back to a no-op tracer, so code
 * that forgets to initialise still works, it just emits nothing.
 */
export const withSpan = async <T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> => {
  const outcome = await runSpan(name, attributes, kind, fn);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

/**
 * Like `withSpan`, but failure comes back as a value instead of a throw, with the duration
 * (`ms`) ready to put in an error response.
 *
 * Not rethrowing is the point for HTTP handlers: an error is a 503 to render, not an exception to
 * unwind. The span is still marked ERROR and still carries the recorded exception, so the trace
 * looks identical to what `withSpan` would have produced.
 *
 *   const found = await trySpan("db.count", {}, () => selectOne(client, sql));
 *   if (!found.ok) return json({ error: found.error.message, ms: found.ms }, 503);
 *   return json({ count: found.value.n, ms: found.ms }, 200);
 */
export const trySpan = async <T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<SpanOutcome<T>> => {
  return runSpan(name, attributes, kind, fn);
};

/**
 * `withSpan` for a function that is not async.
 *
 * `withSpan` and `trySpan` both `await fn()` and hand back a Promise, so wrapping a synchronous
 * function in them makes it async and forces every caller to `await` — which, for the pure maths in
 * `backend/baseline.ts`, would mean rewriting the call sites of `mean`, `median` and friends
 * throughout the stages. This is the same span with a synchronous callback instead, so a sync
 * function stays sync.
 *
 * Use it for a computation STEP, not for a one-line helper. A span costs meaningfully more than a
 * function call, so wrapping something like `fmt(n)` — called hundreds of times per render — buys a
 * flood of spans that hide the work worth looking at. Wrapping `trendAwareBaseline` is useful;
 * wrapping the `Math.abs` beside it is not.
 */
export const withSyncSpan = <T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => T,
  kind: SpanKind = SpanKind.INTERNAL,
): T => {
  const startedAt = performance.now();

  return trace.getTracer(INSTRUMENTATION_SCOPE).startActiveSpan(name, { kind }, (span): T => {
    span.setAttributes(attributes);
    try {
      const value = fn(span);
      span.setAttribute("app.duration_ms", Math.round(performance.now() - startedAt));
      return value;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.setAttribute("app.duration_ms", Math.round(performance.now() - startedAt));
      throw err;
    } finally {
      span.end();
    }
  });
};

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/**
 * Defer creating something until it is first used.
 *
 * Use this for every metric instrument. `metrics.getMeter()` resolves against whatever provider is
 * global *at that moment*, and module top-level code runs before `initObservability()` does -- so an
 * instrument created at import time binds to the no-op provider and silently records nothing for
 * the life of the process. Tracing does not have this problem because `withSpan` resolves its
 * tracer per call; metrics are captured once, which is what makes the mistake permanent.
 */
const lazyInstrument = <T>(create: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= create());
};

/**
 * A counter instrument under this repo's meter. Lazy, so it is safe to create at module top level.
 * Call the returned function at record time: `requests().add(1, { route })`.
 */
export const counter = (name: string, description: string): (() => Counter) => {
  return lazyInstrument(() =>
    metrics.getMeter(INSTRUMENTATION_SCOPE).createCounter(name, {
      description,
    }),
  );
};

/**
 * A histogram instrument under this repo's meter. Lazy, so it is safe to create at module top
 * level. Call the returned function at record time: `duration().record(ms, { route })`.
 */
export const histogram = (name: string, description: string, unit?: string): (() => Histogram) => {
  return lazyInstrument(() =>
    metrics.getMeter(INSTRUMENTATION_SCOPE).createHistogram(name, {
      description,
      ...(unit ? { unit } : {}),
    }),
  );
};

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

/** Console sink per severity, so warnings and errors reach stderr like they should. */
const consoleSink: Record<string, (message: string) => void> = {
  DEBUG: console.debug,
  INFO: console.log,
  WARN: console.warn,
  ERROR: console.error,
};

/** Compact `key=value` rendering for the console half; the OTLP half keeps real types. */
const format = (attributes: LogAttributes): string =>
  Object.entries(attributes)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

/**
 * Emit one structured log record to ClickStack, plus a compact console line for the terminal.
 *
 * The record is stamped with the trace_id/span_id of whatever span is active at the call site
 * (the span of the function currently running -- `withSpan` keeps it on the context), so in the
 * UI the log is attached to the operation that produced it. The ids are only added to the OTLP
 * record, not the console line: the terminal output is for the human, the attributes are for the
 * database.
 */
const emit = (
  severityNumber: SeverityNumber,
  severityText: string,
  message: string,
  attributes: LogAttributes = {},
): void => {
  const spanContext = trace.getActiveSpan()?.spanContext();
  const recordAttributes: LogAttributes = spanContext
    ? {
        "trace.id": spanContext.traceId,
        "span.id": spanContext.spanId,
        ...attributes,
      }
    : attributes;

  // Resolved per call rather than cached at import time: the global logger provider is only
  // registered by initObservability(), which may run after this module is first imported.
  logs.getLogger(INSTRUMENTATION_SCOPE).emit({
    severityNumber,
    severityText,
    body: message,
    attributes: recordAttributes,
  });

  const detail = Object.keys(attributes).length > 0 ? ` ${format(attributes)}` : "";
  (consoleSink[severityText] ?? console.log)(`${message}${detail}`);
};

export const log = {
  debug: (message: string, attributes?: LogAttributes): void =>
    emit(SeverityNumber.DEBUG, "DEBUG", message, attributes),

  info: (message: string, attributes?: LogAttributes): void =>
    emit(SeverityNumber.INFO, "INFO", message, attributes),

  warn: (message: string, attributes?: LogAttributes): void =>
    emit(SeverityNumber.WARN, "WARN", message, attributes),

  error: (message: string, attributes?: LogAttributes): void =>
    emit(SeverityNumber.ERROR, "ERROR", message, attributes),
};
