/**
 * Structured logging into ClickStack's `otel_logs`.
 *
 * Two destinations, on purpose. The console line is for the human watching the run; the OTLP record
 * is for ClickStack. The OTLP record is the valuable one: because it is emitted inside whatever span
 * `withSpan` has on the active context, the SDK stamps it with that span's trace_id and span_id, so
 * in the UI the log shows up attached to the operation that produced it rather than in a flat
 * firehose you have to grep by timestamp.
 *
 *   log.info("loaded partition", { "load.date": "2026-06-23", "load.rows": 257_000 })
 *
 * Attributes, not string interpolation. `"load.rows": 257000` is filterable in ClickStack;
 * `"loaded 257000 rows"` is a string you have to regex out of the message body.
 */
import {
  logs,
  SeverityNumber,
  type LogAttributes,
} from "@opentelemetry/api-logs";
import { INSTRUMENTATION_SCOPE } from "./otel";

/** Console sink per severity, so warnings and errors reach stderr like they should. */
const consoleSink: Record<string, (message: string) => void> = {
  DEBUG: console.debug,
  INFO: console.log,
  WARN: console.warn,
  ERROR: console.error,
};

function emit(
  severityNumber: SeverityNumber,
  severityText: string,
  message: string,
  attributes: LogAttributes = {},
): void {
  // Resolved per call rather than cached at import time: the global logger provider is only
  // registered by initObservability(), which may run after this module is first imported.
  logs.getLogger(INSTRUMENTATION_SCOPE).emit({
    severityNumber,
    severityText,
    body: message,
    attributes,
  });

  const detail =
    Object.keys(attributes).length > 0 ? ` ${format(attributes)}` : "";
  (consoleSink[severityText] ?? log.info)(`${message}${detail}`);
}

/** Compact `key=value` rendering for the console half; the OTLP half keeps real types. */
const format = (attributes: LogAttributes): string =>
  Object.entries(attributes)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

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
