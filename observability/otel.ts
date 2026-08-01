/**
 * The ClickStack pipeline. All three OTLP signals -- traces, metrics, logs -- are exported over
 * OTLP/HTTP to the ClickStack collector (:4318), which writes them into the `otel_traces`,
 * `otel_metrics_*` and `otel_logs` tables of the same ClickHouse the app queries.
 *
 * Lifecycle: every entry point calls `initObservability()` first and `shutdownObservability()` in a
 * finally block. The shutdown is not optional -- the batch processors hold un-exported data, and a
 * CLI process that exits without flushing loses the tail of its own run, which is exactly the part
 * you want when something failed.
 *
 *   initObservability()
 *     |-- traces   BatchSpanProcessor        -> /v1/traces   -> otel_traces
 *     |-- metrics  PeriodicExportingReader   -> /v1/metrics  -> otel_metrics_*
 *     +-- logs     BatchLogRecordProcessor   -> /v1/logs     -> otel_logs
 *
 * Correlation is the whole point: `withSpan` puts a span on the active context, and the log SDK
 * stamps that context's trace_id/span_id onto every record emitted inside it. In the ClickStack UI
 * that turns into "open a trace, see the logs it produced".
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
  type Span,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  DEPLOYMENT_ENVIRONMENT,
  METRIC_EXPORT_INTERVAL_MS,
  OTEL_ENDPOINT,
  OTEL_INGESTION_TOKEN,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "../constants";
import { EnvVar, OtlpPath } from "../enums";

let tracerProvider: BasicTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let loggerProvider: LoggerProvider | undefined;

/** The name every tracer, meter and logger in this codebase is created under. */
export const INSTRUMENTATION_SCOPE = "clickhouse-inmobi";

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
function enableDiagnostics(): void {
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
  diag.setLogger(
    new DiagConsoleLogger(),
    levels[level.toLowerCase()] ?? DiagLogLevel.INFO,
  );
}

/**
 * Wire up all three OTLP pipelines to ClickStack. Idempotent -- a second call is a no-op, so
 * modules that each initialise defensively cannot double-register exporters.
 *
 * The AsyncLocalStorage context manager is what lets child spans nest under their parent, and what
 * lets a log record find the span it was emitted inside. Without it `startActiveSpan` falls back to
 * a no-op context: every span becomes a root and every log loses its trace_id.
 */
export function initObservability(): void {
  if (tracerProvider) return;

  enableDiagnostics();

  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );

  // W3C `traceparent`. Lets an inbound HTTP request continue a caller's trace instead of starting
  // a disconnected one, and lets our own outbound calls pass the trace on.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    // Not exported as a stable semconv constant in this version, so spelled out.
    "deployment.environment.name": DEPLOYMENT_ENVIRONMENT,
  });

  tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: url(OtlpPath.Traces), headers }),
      ),
    ],
  });
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
}

/**
 * Flush and tear down all three pipelines so the process can exit without dropping data.
 * `allSettled` rather than `all`: a collector that rejects one signal must not stop the other two
 * from flushing, and a failed flush is not worth crashing a run that already did its work.
 */
export async function shutdownObservability(): Promise<void> {
  await Promise.allSettled([
    tracerProvider?.shutdown(),
    meterProvider?.shutdown(),
    loggerProvider?.shutdown(),
  ]);
  tracerProvider = undefined;
  meterProvider = undefined;
  loggerProvider = undefined;
}

/**
 * Push buffered signals to ClickStack without tearing the pipelines down -- for a long-running
 * loop where the UI should show the current run before it finishes.
 */
export async function flushObservability(): Promise<void> {
  await Promise.allSettled([
    tracerProvider?.forceFlush(),
    meterProvider?.forceFlush(),
    loggerProvider?.forceFlush(),
  ]);
}

/** What a `trySpan` produced: the value, or the error, plus how long the span took. */
export type SpanOutcome<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; error: Error; ms: number };

/**
 * Like `withSpan`, but the span times itself and failure comes back as a value instead of a throw.
 *
 * Exists to kill the boilerplate that otherwise shows up in every request handler: a
 * `performance.now()` before the call, an `elapsed()` after it, and the same figure recomputed in
 * the catch block so the error response can report a latency too. The span is already measuring
 * exactly that interval, so the duration is read off the span's own timing and returned as `ms`
 * -- and recorded on the span as `app.duration_ms` so it is filterable in ClickStack.
 *
 * Not rethrowing is the point for HTTP handlers: an error is a 503 to render, not an exception to
 * unwind. The span is still marked ERROR and still carries the recorded exception, so the trace
 * looks identical to what `withSpan` would have produced.
 *
 *   const found = await trySpan("db.count", {}, () => selectOne(client, sql));
 *   if (!found.ok) return json({ error: found.error.message, ms: found.ms }, 503);
 *   return json({ count: found.value.n, ms: found.ms }, 200);
 */
export async function trySpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<SpanOutcome<T>> {
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
}

/**
 * Defer creating something until it is first used.
 *
 * Use this for every metric instrument. `metrics.getMeter()` resolves against whatever provider is
 * global *at that moment*, and module top-level code runs before `initObservability()` does -- so an
 * instrument created at import time binds to the no-op provider and silently records nothing for
 * the life of the process. Tracing does not have this problem because `withSpan` resolves its
 * tracer per call; metrics are captured once, which is what makes the mistake permanent.
 *
 *   const requests = lazyInstrument(() =>
 *     metrics.getMeter(INSTRUMENTATION_SCOPE).createCounter("app.requests"));
 *   requests().add(1);
 */
export function lazyInstrument<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= create());
}

/**
 * Run `fn` inside a span, recording errors and ending the span. Returns what `fn` returned.
 * Safe to call before initObservability() -- the API falls back to a no-op tracer, so code
 * that forgets to initialise still works, it just emits nothing.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return trace
    .getTracer(INSTRUMENTATION_SCOPE)
    .startActiveSpan(name, { kind }, async (span) => {
      span.setAttributes(attributes);
      try {
        return await fn(span);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw error;
      } finally {
        span.end();
      }
    });
}
