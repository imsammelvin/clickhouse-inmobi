/**
 * Proves the ClickStack pipeline actually works, in SQL rather than by eye.
 *
 *   bun run otel:verify
 *
 * ClickStack lands the OTLP signals in otel_* tables, so "did my telemetry arrive" is just a
 * SELECT. Exits non-zero on any failure, so it can gate a demo checklist the same way ch:verify
 * gates a load.
 *
 * Note the two ClickHouses: the fact data lives in ClickHouse Cloud (CLICKHOUSE_URL) while the
 * ClickStack container stores telemetry in its own bundled instance (CLICKSTACK_CLICKHOUSE_URL).
 * This script reads the latter.
 *
 * What it asserts:
 *   1. all three signals present   -- traces, logs, metrics all have rows for this service
 *   2. logs are correlated         -- every log record carries the trace_id of its span
 *   3. spans are nested            -- the latest trace is a tree, not a pile of roots
 *
 * Deliberately does NOT initialise observability itself: a verifier that emits the thing it is
 * verifying can pass against its own output.
 */
import { makeTelemetryClient, select, selectOne } from "../clickhouse/client";
import { CLICKSTACK_URL, OTEL_ENDPOINT, SERVICE_NAME } from "../../shared/constants";
import * as Q from "../../shared/constants/queries";
import { CheckStatus, VerifyFlag } from "../../shared/enums";
import type {
  LogCorrelation,
  PublishedMetric,
  SignalCount,
  TraceSpanRow,
} from "../../shared/interfaces";
import { flagValue, fmt, runScript } from "../../shared/utils/common.utils";
import { log } from "../../shared/utils/telemetryUtils";

/**
 * Which service to check. Each entry point publishes under its own name (the API runs as
 * `clickhouse-inmobi-api`, the ingest scripts as `clickhouse-inmobi-ingest`), so verifying the
 * wrong one reports an empty pipeline that is actually working fine.
 */
const service = flagValue(process.argv.slice(2), VerifyFlag.Service) ?? SERVICE_NAME;

let failures = 0;

const check = (name: string, ok: boolean, detail: string): void => {
  const status = ok ? CheckStatus.Pass : CheckStatus.Fail;
  log.info(`  ${status}  ${name.padEnd(40)} ${detail}`);
  if (!ok) failures++;
};

/**
 * Deliberately uninstrumented, unlike every other entry point in this repo.
 *
 * This script's job is to read `otel_traces` and assert things about what the *application* wrote —
 * including "the latest trace has exactly one root". Calling `initObservability()` here would make
 * this process write spans into the very table it is inspecting, under the same service name, so the
 * latest trace would be the verifier's own and the check would be grading itself. An observability
 * check that observes itself is not a check. `log` still prints to the console; with no provider
 * registered the OTLP half is a no-op, which is the intent.
 */
const main = async (): Promise<void> => {
  const client = makeTelemetryClient();

  log.info(`service "${service}"  ingest ${OTEL_ENDPOINT}  store ${CLICKSTACK_URL}\n`);

  try {
    // 1. every signal arrived -------------------------------------------------
    log.info("== signals ==");
    const signals = await select<SignalCount>(client, Q.signalCounts(service));

    for (const { signal, rows, latest } of signals) {
      const n = Number(rows);
      check(signal, n > 0, n > 0 ? `${fmt(n)} rows, latest ${latest}` : "no rows");
    }
    console.log();

    // 2. logs point back at their span ---------------------------------------
    log.info("== trace <-> log correlation ==");
    const correlation = await selectOne<LogCorrelation>(client, Q.logTraceCorrelation(service));

    const logs = Number(correlation.logs);
    const correlated = Number(correlation.correlated);
    check("logs present", logs > 0, `${fmt(logs)} records`);
    check(
      "logs carry a trace_id",
      logs > 0 && correlated === logs,
      `${fmt(correlated)}/${fmt(logs)} across ${fmt(Number(correlation.traces))} traces`,
    );
    console.log();

    // 3. the trace is a tree --------------------------------------------------
    log.info("== latest trace ==");
    const spans = await select<TraceSpanRow>(client, Q.latestTraceTree(service));

    for (const span of spans) {
      log.info(
        `  ${span.nested ? "  +-" : ""}${span.span.padEnd(30)} ${String(span.ms).padStart(8)}ms`,
      );
    }

    // Exactly one root is the property that matters. A single-span trace (/health touches no
    // dependency) is legitimately one root; broken context propagation shows up as N spans with
    // N roots, which is what this catches.
    const roots = spans.filter((span) => span.nested === 0).length;
    check(
      "trace has exactly one root",
      spans.length > 0 && roots === 1,
      `${spans.length} spans, ${spans.length - roots} nested under ${roots} root`,
    );
    console.log();

    // 4. what the dashboards can plot ----------------------------------------
    log.info("== published metrics ==");
    const published = await select<PublishedMetric>(client, Q.publishedMetrics(service));

    for (const metric of published) {
      log.info(
        `  ${metric.metric.padEnd(30)} ${fmt(Number(metric.points)).padStart(8)} points  latest ${metric.latest}`,
      );
    }
    check("metrics published", published.length > 0, `${published.length} names`);
    console.log();
  } finally {
    await client.close();
  }

  if (failures > 0) {
    console.error(
      `${failures} check(s) FAILED. If the app only just ran, give the batch exporters ` +
        `a few seconds and retry.`,
    );
    process.exit(1);
  }
  log.info("ClickStack pipeline verified. UI: http://localhost:8080");
};

if (import.meta.main) await runScript(main);
