/**
 * Post-load verification: does ClickHouse hold exactly what the source files hold?
 *
 *   bun run ch:verify
 *
 * Exits non-zero on any mismatch, so it can gate a load in CI or a pre-demo checklist.
 *
 * Why this exists: we are judged on "every number in the diagnosis must be reproducible from the
 * data", and a single fabricated figure costs more than a missed anomaly. The cheapest way to
 * fabricate a figure is to quietly lose rows at ingest and never notice. So we recompute the funnel
 * totals in DuckDB straight off the source Parquet and assert ClickHouse agrees -- globally, then
 * day by day.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { DATABASE, makeClient, select, selectOne } from "../clickhouse/client";
import { DIMENSION_EXPECTATIONS, FACT_FILE, RATIO_UPPER_BOUND } from "../../shared/constants";
import * as Q from "../../shared/constants/queries";
import { CheckStatus, View } from "../../shared/enums";
import type {
  DayAggregate,
  DayAggregateRaw,
  EnrichmentGaps,
  FunnelIntegrity,
  FunnelTotals,
  MetricSnapshot,
  PartStats,
  RevenueIdentity,
  UniquenessRow,
  VersionRow,
} from "../../shared/interfaces";
import {
  closeEnough,
  duckdbJson,
  fmt,
  runScript,
  secondsSince,
} from "../../shared/utils/common.utils";
import {
  counter,
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

let failures = 0;

const verifyChecks = counter("verify.checks", "Verification assertions, by outcome");

const check = (name: string, ok: boolean, detail: string): void => {
  const status = ok ? CheckStatus.Pass : CheckStatus.Fail;
  verifyChecks().add(1, { "verify.outcome": ok ? "pass" : "fail" });
  log.info(`  ${status}  ${name.padEnd(44)} ${detail}`);
  if (!ok) failures++;
};

const checkEqual = (name: string, expected: unknown, actual: unknown): void => {
  const ok = String(expected) === String(actual);
  check(name, ok, ok ? String(actual) : `expected ${expected}, got ${actual}`);
};

const checkClose = (name: string, expected: number, actual: number): void => {
  const ok = closeEnough(expected, actual);
  check(
    name,
    ok,
    ok ? actual.toFixed(4) : `expected ${expected.toFixed(6)}, got ${actual.toFixed(6)}`,
  );
};

const checkInRange = (name: string, value: number, low: number, high: number): void => {
  check(name, value > low && value < high, value.toFixed(4));
};

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

const verifyDimensions = async (client: ClickHouseClient): Promise<void> => {
  log.info("== dimension tables ==");

  for (const { table, key, rows } of DIMENSION_EXPECTATIONS) {
    const row = await selectOne<UniquenessRow>(client, Q.dimensionUniqueness(table, key));
    checkEqual(`${table} row count`, rows, row.n);

    // A duplicated key would make dictGet return an arbitrary one of the duplicates, silently
    // mislabelling a slice of the drill-down.
    const unique = row.n === row.distinct;
    check(
      `${table} keys unique`,
      unique,
      unique ? `${fmt(Number(row.distinct))} distinct` : `${row.n} rows, ${row.distinct} distinct`,
    );
  }
  console.log();
};

const verifyTotals = async (client: ClickHouseClient): Promise<void> => {
  log.info("== fact totals: ClickHouse vs source Parquet ==");

  const [source] = await duckdbJson<FunnelTotals>(Q.srcFunnelTotals(FACT_FILE));
  const loaded = await selectOne<Record<keyof FunnelTotals, string>>(client, Q.funnelTotals);

  checkEqual("requests (count)", source!.rows, loaded.rows);
  checkEqual("fills", source!.fills, loaded.fills);
  checkEqual("impressions", source!.impressions, loaded.impressions);
  checkEqual("clicks", source!.clicks, loaded.clicks);
  checkClose("revenue", Number(source!.revenue), Number(loaded.revenue));
  // DuckDB renders a fractional part; ClickHouse DateTime is second-granularity.
  checkEqual("min event_time", source!.min_time.replace(/\.\d+$/, ""), loaded.min_time);
  checkEqual("max event_time", source!.max_time.replace(/\.\d+$/, ""), loaded.max_time);
  console.log();
};

const verifyPerDay = async (client: ClickHouseClient): Promise<void> => {
  log.info("== per-day reconciliation ==");

  const source = await duckdbJson<DayAggregate>(Q.srcDailyTotals(FACT_FILE));
  const loaded = await select<DayAggregateRaw>(client, Q.dailyTotals);
  checkEqual("day count", source.length, loaded.length);

  const loadedByDay = new Map(loaded.map((row) => [row.d, row]));
  const badRows: string[] = [];
  const badRevenue: string[] = [];

  for (const day of source) {
    const found = loadedByDay.get(day.d);
    if (!found || Number(found.rows) !== Number(day.rows)) badRows.push(day.d);
    else if (!closeEnough(day.revenue, Number(found.revenue))) badRevenue.push(day.d);
  }

  check(
    "every day has matching row count",
    badRows.length === 0,
    badRows.length === 0 ? `${source.length} days` : `mismatched: ${badRows.join(", ")}`,
  );
  check(
    "every day has matching revenue",
    badRevenue.length === 0,
    badRevenue.length === 0 ? `${source.length} days` : `mismatched: ${badRevenue.join(", ")}`,
  );

  // Total rows must equal the sum of the per-day source counts. This catches a double-loaded
  // partition -- exactly what drop-then-insert is designed to prevent.
  const sumRows = (rows: { rows: string | number }[]): number =>
    rows.reduce((sum, row) => sum + Number(row.rows), 0);
  checkEqual("no duplicated rows", sumRows(source), sumRows(loaded));
  console.log();
};

const verifyEnrichment = async (client: ClickHouseClient): Promise<void> => {
  log.info(`== ${View.AdEventsEnriched} (dictionary lookups) ==`);

  const gaps = await selectOne<EnrichmentGaps>(client, Q.enrichmentGaps);

  checkEqual("every event resolves an app", "0", gaps.no_app);
  checkEqual("every event resolves a geo/device", "0", gaps.no_geo);
  checkEqual("every filled event resolves an advertiser", "0", gaps.no_adv_on_filled);
  // Unfilled requests carry an empty advertiser_id by design (no ad was served), so these SHOULD
  // be unresolved. Asserting it keeps the two cases from being confused downstream.
  check(
    "unfilled events have no advertiser (expected)",
    Number(gaps.no_adv_on_unfilled) > 0,
    `${fmt(Number(gaps.no_adv_on_unfilled))} unfilled requests`,
  );
  console.log();
};

const verifyMetrics = async (client: ClickHouseClient): Promise<void> => {
  log.info("== glossary metrics ==");

  const metrics = await selectOne<MetricSnapshot>(client, Q.glossaryMetrics);
  checkInRange("fill rate in (0,1)", metrics.fill_rate, 0, 1);
  checkInRange("render rate in (0,1]", metrics.render_rate, 0, RATIO_UPPER_BOUND);
  checkInRange("CTR in (0,1)", metrics.ctr, 0, 1);
  check("eCPM > 0", metrics.ecpm > 0, metrics.ecpm.toFixed(4));
  check("RPR > 0", metrics.rpr > 0, metrics.rpr.toFixed(6));

  const funnel = await selectOne<FunnelIntegrity>(client, Q.funnelIntegrity);
  checkEqual("no revenue without an impression", "0", funnel.revenue_without_impression);
  checkEqual("no impression without a fill", "0", funnel.impression_without_fill);
  checkEqual("no click without an impression", "0", funnel.click_without_impression);

  const identity = await selectOne<RevenueIdentity>(client, Q.revenueIdentity);
  checkClose("revenue identity holds", identity.lhs, identity.rhs);
  console.log();
};

const reportStorage = async (client: ClickHouseClient): Promise<void> => {
  log.info("== storage ==");

  for (const part of await select<PartStats>(client, Q.storageStats(DATABASE))) {
    log.info(
      `  ${part.table.padEnd(14)} ${fmt(Number(part.total_rows)).padStart(10)} rows  ` +
        `${part.compressed.padStart(10)} on disk (${part.uncompressed} raw, ${part.ratio}x)  ` +
        `${part.parts} parts`,
    );
  }
  console.log();
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  initObservability();
  const client = makeClient();
  const startedAt = performance.now();

  try {
    await withSpan("verify.run", {}, async () => {
      const { version } = await selectOne<VersionRow>(client, Q.VERSION);
      log.info(`ClickHouse ${version}, database "${DATABASE}"\n`);

      // One span per check rather than one for the lot: these are independent assertions with very
      // different costs (the per-day cross-check against DuckDB dominates), and a single
      // `verify.run` span hides which one is slow or which one hung.
      const checks: Array<[string, (c: ClickHouseClient) => Promise<void>]> = [
        ["dimensions", verifyDimensions],
        ["totals", verifyTotals],
        ["per_day", verifyPerDay],
        ["enrichment", verifyEnrichment],
        ["metrics", verifyMetrics],
        ["storage", reportStorage],
      ];
      for (const [name, fn] of checks) {
        await withSpan(`verify.${name}`, { "verify.check": name }, () => fn(client));
      }
    });
  } finally {
    await client.close();
    await shutdownObservability();
  }

  if (failures > 0) {
    console.error(`${failures} check(s) FAILED in ${secondsSince(startedAt)}`);
    process.exit(1);
  }
  log.info(`All checks passed in ${secondsSince(startedAt)}.`);
};

if (import.meta.main) await runScript(main);
