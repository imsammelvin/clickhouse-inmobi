/**
 * The gate on T-013: prove the rollup answers every question exactly as the raw scan does.
 *
 *   bun run ch:verify-rollup
 *
 * WHY THIS SCRIPT IS THE POINT. A rollup is an optimisation whose failure mode is a wrong number,
 * not a slow one, and a wrong number costs more here than a missed anomaly (R-001). Every hazard in
 * the design is silent: a dimension summed away by a cut that does not carry it, a filter applied to
 * the wrong side of a pair, a float sum that drifts, a day the materialized view never saw. None of
 * them throw. All of them return plausible rows.
 *
 * So the check is not "does the rollup look right". It runs **the real query path** — `mcp/query.ts`,
 * unmodified — twice over the same arguments: once with the rollup forced off, once with it on, and
 * asserts the two agree. Anything that disagrees is a defect in the rollup, by construction, because
 * the raw path is the one already shipped and evaluated.
 *
 * It also asserts which surface served each probe. Without that, a probe whose plan silently fell
 * back to raw would pass by comparing the raw path against itself — a green test that checks
 * nothing, which is worse than a red one.
 */
import { Ledger } from "../engine/ledger";
import { DIMENSIONS, FILLED_ONLY_DIMENSIONS, METRICS, metricExpr } from "../engine/metrics";
import { detect } from "../engine/stages/detect";
import { type Mask, NO_MASK, andMask, exclusionMask, segmentMask } from "../engine/types";
import { DATASET_END, DATASET_START, ensureDatasetBounds } from "../engine/baseline";
import {
  disableRollup,
  ensureRollupReady,
  planRollup,
  resetRollupReady,
  rollupHealth,
  sourceLabel,
} from "../clickhouse/rollup";
import { makeClient } from "../clickhouse/client";
import {
  comparePeriods,
  datasetOverview,
  dimensionValues,
  measure,
  rankSegments,
  weeklyGrowthFor,
  type FilterValue,
} from "../mcp/query";
import { scanSegmentsRollup } from "../mcp/sweep";
import { scanSegments } from "../engine/segments";
import { DEFAULT_METRICS } from "../engine/scan";
import { fmt, runScript, secondsSince } from "../../shared/utils/common.utils";
import type { Span } from "@opentelemetry/api";
import {
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

/** A comparable, provenance-free extract of a tool result. */
interface Snapshot {
  servedFrom: string;
  /** Flat label -> number/string map, so a mismatch names the exact field. */
  values: Record<string, number | string | null>;
}

interface Probe {
  id: string;
  /** The surface this probe MUST be served from on the rollup pass. */
  expect: "rollup" | "raw";
  run: (ledger: Ledger) => Promise<Snapshot>;
}

// A short window keeps the raw side of each comparison cheap; a handful of probes below deliberately
// span the whole dataset because the full-range scan is the one the sweep actually pays.
const W = { from: "2026-06-23", to: "2026-06-25" };

/** Rows -> flat map, dropping evidence ids and SQL: those differ by design between the two paths. */
const rowsSnapshot = (
  servedFrom: string,
  rows: ReadonlyArray<{ group: Record<string, string> }>,
  fields: readonly string[],
): Snapshot => {
  const values: Record<string, number | string | null> = {};
  // Sorted by group key so a tie in the ORDER BY cannot make two correct results look different.
  const sorted = [...rows].sort((a, b) =>
    JSON.stringify(a.group).localeCompare(JSON.stringify(b.group)),
  );
  for (const row of sorted) {
    const key = Object.entries(row.group)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    for (const field of fields) {
      const v = (row as Record<string, unknown>)[field];
      values[`${key}.${field}`] = typeof v === "number" || v === null ? v : String(v);
    }
  }
  values["__rows"] = rows.length;
  return { servedFrom, values };
};

const MEASURE_FIELDS = ["value", "requests", "numerator", "denominator", "sharePct", "reliable"];
const COMPARE_FIELDS = ["current", "baseline", "deltaPct", "deltaPp", "requests", "sharePct"];

function buildProbes(): Probe[] {
  const probes: Probe[] = [];

  // --- totals and series ------------------------------------------------------------------------
  probes.push({
    id: "describe_data/overview",
    expect: "rollup",
    run: async (ledger) => {
      const o = await datasetOverview(ledger);
      return {
        servedFrom: o.servedFrom,
        values: {
          from: o.from,
          to: o.to,
          days: o.days,
          requests: o.requests,
          filled: o.filled,
          impressions: o.impressions,
          clicks: o.clicks,
          revenue: o.revenue,
        },
      };
    },
  });

  for (const metric of Object.keys(METRICS)) {
    // The growth estimate reads the whole 35-day series -- one of the full-range scans.
    probes.push({
      id: `weekly_growth/${metric}`,
      expect: "rollup",
      run: async (ledger) => ({
        servedFrom: "n/a",
        values: { growth: await weeklyGrowthFor(ledger, metric) },
      }),
    });
  }

  // --- get_metric -------------------------------------------------------------------------------
  for (const metric of Object.keys(METRICS)) {
    probes.push({
      id: `get_metric/${metric}/total`,
      expect: "rollup",
      run: async (ledger) => {
        const r = await measure(ledger, { metric, ...W });
        return rowsSnapshot(r.servedFrom, r.rows, MEASURE_FIELDS);
      },
    });

    for (const granularity of ["day", "hour"] as const) {
      probes.push({
        id: `get_metric/${metric}/by_${granularity}`,
        expect: "rollup",
        run: async (ledger) => {
          const r = await measure(ledger, { metric, ...W, granularity, limit: 200 });
          return rowsSnapshot(r.servedFrom, r.rows, MEASURE_FIELDS);
        },
      });
    }

    // Every dimension the metric allows, singly. This is the bulk of the coverage: 7 metrics x
    // 8-11 dimensions, and it is where a mis-summed cut would show up first.
    const dims =
      metric === "fill_rate" || metric === "requests"
        ? DIMENSIONS
        : [...DIMENSIONS, ...FILLED_ONLY_DIMENSIONS];
    for (const dimension of dims) {
      probes.push({
        id: `get_metric/${metric}/by_${dimension}`,
        expect: "rollup",
        run: async (ledger) => {
          const r = await measure(ledger, { metric, ...W, group_by: [dimension], limit: 200 });
          return rowsSnapshot(r.servedFrom, r.rows, MEASURE_FIELDS);
        },
      });

      probes.push({
        id: `rank_segments/${metric}/${dimension}`,
        expect: "rollup",
        run: async (ledger) => {
          const r = await rankSegments(ledger, { metric, dimension, ...W, limit: 200 });
          return rowsSnapshot(r.servedFrom, r.rows, MEASURE_FIELDS);
        },
      });
    }
  }

  // --- the two-dimension cuts, which is what the 36 pairs exist for -----------------------------
  const pairCases: Array<{
    metric: string;
    group_by: string[];
    filters?: Record<string, FilterValue>;
  }> = [
    { metric: "fill_rate", group_by: ["region", "os_version"] },
    { metric: "fill_rate", group_by: ["publisher_tier", "os_version"] },
    { metric: "fill_rate", group_by: ["app_category", "ad_format"] },
    { metric: "ecpm", group_by: ["country", "ad_format"] },
    { metric: "revenue", group_by: ["os_version", "region"] }, // reversed order -> same stored pair
    { metric: "ctr", group_by: ["device_model", "advertiser_vertical"] },
    // Filter + group-by is the combination that must consume the pair budget. If a filter dimension
    // were ever left out of the plan, this is the probe that catches it: the rollup would answer
    // with the UNFILTERED number, which is plausible and wrong.
    { metric: "fill_rate", group_by: ["region"], filters: { os_version: "Android 15" } },
    { metric: "revenue", group_by: ["ad_format"], filters: { region: "EU" } },
    { metric: "ecpm", group_by: ["app_category"], filters: { campaign_type: "cpm" } },
    // Prefix and list filters resolve to startsWith / IN against the projected column.
    { metric: "fill_rate", group_by: ["region"], filters: { os_version: "Android*" } },
    {
      metric: "fill_rate",
      group_by: ["publisher_tier"],
      filters: { os_version: ["Android 15", "iOS 18.1"] },
    },
    // Filter only, no group-by: one dimension, so a single-dim cut serves it.
    { metric: "fill_rate", group_by: [], filters: { os_version: "Android 15" } },
  ];

  /**
   * Every cut above is run at BOTH grains, because they are two different tables.
   *
   * The first version of this file only exercised `granularity: "hour"` without a group-by, so the
   * hourly rollup was verified for platform totals and nothing else — a mis-projected dimension or a
   * mis-split pair in `rollup_segment_hourly` would have passed. Two tables, two sets of rows, two
   * chances to be wrong: both get the full matrix. The daily pass also pins that `granularity: "day"`
   * groups the daily table by its own `event_date` rather than quietly reaching for hours.
   */
  for (const [i, c] of pairCases.entries()) {
    const label = `${c.metric}/${c.group_by.join("+") || "total"}${c.filters ? `/filtered` : ""}`;
    for (const granularity of [undefined, "day", "hour"] as const) {
      probes.push({
        id: `get_metric/pair${i}/${label}/${granularity ?? "window"}`,
        expect: "rollup",
        run: async (ledger) => {
          const r = await measure(ledger, {
            metric: c.metric,
            ...W,
            group_by: c.group_by,
            filters: c.filters,
            granularity,
            limit: 200,
          });
          // The grain is part of what is being asserted: an `hour` request that silently landed on
          // the daily table (or the reverse) would still return plausible rows. Only meaningful on
          // the rollup pass — the reference pass is raw by construction.
          const expectedGrain = granularity === "hour" ? "hourly" : "daily";
          if (rollupOn && !r.servedFrom.startsWith(`rollup:${expectedGrain}:`)) {
            return {
              servedFrom: `WRONG-GRAIN(${r.servedFrom}, wanted rollup:${expectedGrain})`,
              values: {},
            };
          }
          return rowsSnapshot(r.servedFrom, r.rows, MEASURE_FIELDS);
        },
      });
    }
  }

  // --- the fallback path, asserted rather than assumed ------------------------------------------
  // Three dimensions at once, and an entity dimension paired with another: neither is materialised,
  // and both must go to the raw view rather than being approximated.
  probes.push({
    id: "fallback/three_dimensions",
    expect: "raw",
    run: async (ledger) => {
      const r = await measure(ledger, {
        metric: "fill_rate",
        ...W,
        group_by: ["region", "os_version"],
        filters: { ad_format: "banner" },
        limit: 200,
      });
      return rowsSnapshot(r.servedFrom, r.rows, MEASURE_FIELDS);
    },
  });
  probes.push({
    id: "fallback/entity_pair",
    expect: "raw",
    run: async (ledger) => {
      const r = await measure(ledger, {
        metric: "revenue",
        ...W,
        group_by: ["app_id", "os_version"],
        limit: 200,
      });
      return rowsSnapshot(r.servedFrom, r.rows, MEASURE_FIELDS);
    },
  });

  // --- compare_periods --------------------------------------------------------------------------
  for (const metric of Object.keys(METRICS)) {
    probes.push({
      id: `compare_periods/${metric}/blended`,
      expect: "rollup",
      run: async (ledger) => {
        const r = await comparePeriods(ledger, { metric, ...W });
        return rowsSnapshot(r.servedFrom, r.rows, COMPARE_FIELDS);
      },
    });
  }
  for (const dimension of ["os_version", "region", "app_category", "app_id"]) {
    for (const metric of ["fill_rate", "revenue", "ecpm"]) {
      probes.push({
        id: `compare_periods/${metric}/by_${dimension}`,
        expect: "rollup",
        run: async (ledger) => {
          const r = await comparePeriods(ledger, {
            metric,
            ...W,
            group_by: [dimension],
            limit: 200,
          });
          return rowsSnapshot(r.servedFrom, r.rows, COMPARE_FIELDS);
        },
      });
    }
  }
  probes.push({
    id: "compare_periods/explicit_baseline",
    expect: "rollup",
    run: async (ledger) => {
      const r = await comparePeriods(ledger, {
        metric: "fill_rate",
        ...W,
        baseline_from: "2026-06-16",
        baseline_to: "2026-06-18",
        group_by: ["os_version"],
        limit: 200,
      });
      return rowsSnapshot(r.servedFrom, r.rows, COMPARE_FIELDS);
    },
  });

  // --- list_dimension_values --------------------------------------------------------------------
  for (const dimension of [...DIMENSIONS, ...FILLED_ONLY_DIMENSIONS]) {
    probes.push({
      id: `list_dimension_values/${dimension}`,
      expect: "rollup",
      run: async (ledger) => {
        const r = await dimensionValues(ledger, dimension, "revenue", W, 200);
        const out: Record<string, number | string | null> = { __rows: r.values.length };
        for (const v of [...r.values].sort((a, b) => a.value.localeCompare(b.value))) {
          out[`${v.value}.requests`] = v.requests;
          out[`${v.value}.sharePct`] = v.sharePct;
        }
        return { servedFrom: r.servedFrom, values: out };
      },
    });
  }

  /**
   * --- detect: the stage T-050 put on the rollup, and the largest one -------------------------
   *
   * `detect` runs once for the platform and then once per candidate in `confirm`, so it was 41.8% of
   * every row the engine read. It is also the stage where a mask that the rollup cannot express would
   * do the most damage: its verdict is a boolean gate, so a filtered query silently answering for the
   * WHOLE platform does not return a wrong-looking number — it returns `anomalous: true` on a segment
   * that never moved, and the investigation names a cause that does not exist.
   *
   * So every mask shape is checked: no mask, a single dimension, a synthetic pair, an entity
   * dimension, an exclusion (residualize's shape), and two exclusions at once — which must fall back,
   * because no single materialised cut can express two dimensions of exclusion.
   */
  const maskCases: Array<{ label: string; metric: string; mask: Mask; expect: "rollup" | "raw" }> =
    [
      { label: "platform", metric: "fill_rate", mask: NO_MASK, expect: "rollup" },
      {
        label: "single-dim",
        metric: "fill_rate",
        mask: segmentMask("os_version", "Android 15"),
        expect: "rollup",
      },
      {
        label: "pair",
        metric: "fill_rate",
        mask: segmentMask("region|os_version", "EU|Android 15"),
        expect: "rollup",
      },
      {
        label: "app-entity",
        metric: "revenue",
        mask: segmentMask("app_id", "app_00091"),
        expect: "rollup",
      },
      {
        label: "category",
        metric: "ecpm",
        mask: segmentMask("app_category", "finance"),
        expect: "rollup",
      },
      {
        label: "exclusion",
        metric: "fill_rate",
        mask: exclusionMask("os_version", "Android 15"),
        expect: "rollup",
      },
      {
        label: "pair-exclusion",
        metric: "requests",
        mask: exclusionMask("country|ad_format", "IN|banner"),
        expect: "rollup",
      },
      // Two exclusions on two dimensions land on the materialised pair, and this probe is here because
      // I predicted it would fall back and it did not. `NOT(os_version='Android 15') AND
      // NOT(app_category='finance')` is exactly expressible against `app_category|os_version`: every row
      // of that cut names both columns, so the predicate selects the cells that are neither and their
      // sum is the same set of events the raw predicate selects. The values agreed on the first run --
      // it was the expectation that was wrong, not the planner. Residualize's second deflation
      // iteration therefore stays on the rollup, which is a bigger win than the one T-050 was scoped for.
      {
        label: "two-exclusions",
        metric: "fill_rate",
        mask: andMask(
          exclusionMask("os_version", "Android 15"),
          exclusionMask("app_category", "finance"),
        ),
        expect: "rollup",
      },
      // Three dimensions is where it genuinely stops: no cut carries three columns, so the plan must
      // decline and the raw scan must answer. This is the assertion that proves the budget is enforced
      // rather than merely documented.
      {
        label: "three-exclusions",
        metric: "fill_rate",
        mask: andMask(
          andMask(
            exclusionMask("os_version", "Android 15"),
            exclusionMask("app_category", "finance"),
          ),
          exclusionMask("region", "EU"),
        ),
        expect: "raw",
      },
    ];

  for (const c of maskCases) {
    probes.push({
      id: `detect/${c.metric}/${c.label}`,
      expect: c.expect,
      run: async (ledger) => {
        const d = await detect(ledger, c.metric, W.from, W.to, c.mask);
        return {
          // detect has no `servedFrom`; the plan is re-derived here to assert the same decision the
          // stage makes. Identical inputs, so it cannot disagree with what the stage did.
          servedFrom: rollupOn
            ? sourceLabel(
                planRollup({
                  dims: c.mask.dims,
                  grain: "daily",
                  expressions: [metricExpr(METRICS[c.metric]!)],
                }),
              )
            : "raw",
          values: {
            incidentValue: d.incidentValue,
            baselineMean: d.baselineMean,
            baselineStd: d.baselineStd,
            baselineDays: d.baselineDays,
            deltaAbs: d.deltaAbs,
            deltaPct: d.deltaPct,
            deltaPp: d.deltaPp,
            sigma: d.sigma,
            // The verdict itself, not just the numbers behind it: this is what the engine acts on.
            anomalous: String(d.anomalous),
            spreadFloored: String(d.spreadFloored),
            reason: d.reason,
          },
        };
      },
    });
  }

  // --- find_incidents: the sweep, which is the whole latency story ------------------------------
  // Compared against Lane A's raw sweep in backend/segments.ts, firing for firing. This is the
  // probe that licenses swapping the sweep over: the rollup version is only allowed to be faster,
  // never different.
  for (const metric of DEFAULT_METRICS) {
    probes.push({
      id: `find_incidents/sweep/${metric}`,
      expect: "rollup",
      run: async (ledger) => {
        const growth = await weeklyGrowthFor(ledger, metric);
        const firings = rollupOn
          ? await scanSegmentsRollup(ledger, metric, growth)
          : await scanSegments(ledger, metric, growth);
        const out: Record<string, number | string | null> = { __rows: firings.length };
        for (const f of [...firings].sort((a, b) =>
          `${a.day}|${a.dimension}|${a.value}`.localeCompare(`${b.day}|${b.dimension}|${b.value}`),
        )) {
          const key = `${f.day}|${f.dimension}|${f.value}`;
          out[`${key}.actual`] = f.actual;
          out[`${key}.baseline`] = f.baseline;
          out[`${key}.pct`] = f.pct;
          out[`${key}.sigma`] = f.sigma;
          out[`${key}.requests`] = f.requests;
        }
        return { servedFrom: "n/a", values: out };
      },
    });
  }

  return probes;
}

/** Set by the driver so the sweep probe knows which implementation to exercise. */
let rollupOn = false;

// ---------------------------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------------------------

/**
 * Relative tolerance for float comparisons.
 *
 * Not zero, and the reason is arithmetic rather than sloppiness: `revenue` is Float64 and addition
 * is not associative, so summing a day's revenue from 257k events and from 24 hourly subtotals can
 * differ in the last bits. 1e-9 relative is ~7 orders of magnitude tighter than the 6-decimal
 * precision anything is ever printed at, so a real defect cannot hide inside it. Integer counts are
 * compared exactly -- there is no rounding excuse for a request count.
 */
const REL_TOLERANCE = 1e-9;

const close = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * REL_TOLERANCE;
};

interface Failure {
  probe: string;
  detail: string;
}

const compare = (probe: string, raw: Snapshot, roll: Snapshot): Failure[] => {
  const failures: Failure[] = [];
  const keys = new Set([...Object.keys(raw.values), ...Object.keys(roll.values)]);
  let shown = 0;
  for (const key of [...keys].sort()) {
    const a = raw.values[key];
    const b = roll.values[key];
    if (!close(a, b)) {
      if (shown++ < 4) {
        failures.push({
          probe,
          detail: `${key}: raw=${JSON.stringify(a)} rollup=${JSON.stringify(b)}`,
        });
      }
    }
  }
  if (shown > 4) {
    failures.push({ probe, detail: `... and ${shown - 4} further field(s)` });
  }
  return failures;
};

// ---------------------------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------------------------

const main = async (): Promise<void> => {
  initObservability();
  try {
    await withSpan("verify_rollup.run", {}, runVerifyRollup);
  } finally {
    await shutdownObservability();
  }
};

const runVerifyRollup = async (span: Span): Promise<void> => {
  const client = makeClient();
  const startedAt = performance.now();
  const failures: Failure[] = [];

  try {
    const bootstrap = new Ledger(client, "verify-bounds");
    bootstrap.beginStage("bounds");
    await ensureDatasetBounds((sql) => bootstrap.run(sql));

    const health = await ensureRollupReady((sql) => bootstrap.run(sql));
    log.info(
      `dataset ${DATASET_START}..${DATASET_END}\n` +
        `rollup   ready=${health.ready} events=${fmt(health.rollupEvents)}/${fmt(health.factEvents)} ` +
        `daily=${fmt(health.dailyRows)} hourly=${fmt(health.hourlyRows)}` +
        (health.reason ? `\n         ${health.reason}` : ""),
    );
    if (!health.ready) {
      throw new Error(
        `the rollup is not ready, so there is nothing to verify. ${health.reason ?? ""}`.trim(),
      );
    }

    const probes = buildProbes();
    log.info(`\n${probes.length} probes, each run twice (raw then rollup)\n`);

    // Pass 1: raw. Forcing the rollup off runs exactly the code path that shipped, which is what
    // makes it the reference rather than a second opinion.
    rollupOn = false;
    disableRollup("verify-rollup: raw reference pass");
    const raw = new Map<string, Snapshot>();
    for (const probe of probes) {
      const ledger = new Ledger(client, "verify-raw");
      ledger.beginStage(probe.id);
      raw.set(probe.id, await probe.run(ledger));
    }
    log.info(`  raw pass done (${secondsSince(startedAt)})`);

    // Pass 2: rollup.
    rollupOn = true;
    resetRollupReady();
    await ensureRollupReady((sql) => bootstrap.run(sql));
    const rollupStartedAt = performance.now();
    const roll = new Map<string, Snapshot>();
    for (const probe of probes) {
      const ledger = new Ledger(client, "verify-rollup");
      ledger.beginStage(probe.id);
      roll.set(probe.id, await probe.run(ledger));
    }
    log.info(`  rollup pass done (${secondsSince(rollupStartedAt)})\n`);

    let servedByRollup = 0;
    for (const probe of probes) {
      const a = raw.get(probe.id)!;
      const b = roll.get(probe.id)!;

      // Surface assertion first: a probe that fell back would otherwise "pass" trivially.
      if (b.servedFrom !== "n/a") {
        const isRollup = b.servedFrom.startsWith("rollup:");
        if (isRollup) servedByRollup++;
        if (probe.expect === "rollup" && !isRollup) {
          failures.push({
            probe: probe.id,
            detail: `expected the rollup to serve this, was served from '${b.servedFrom}'`,
          });
        }
        if (probe.expect === "raw" && isRollup) {
          failures.push({
            probe: probe.id,
            detail: `expected a fallback to the raw view, was served from '${b.servedFrom}'`,
          });
        }
        if (a.servedFrom !== "raw") {
          failures.push({
            probe: probe.id,
            detail: `reference pass was not raw ('${a.servedFrom}') — disableRollup did not hold`,
          });
        }
      }

      failures.push(...compare(probe.id, a, b));
    }

    const health2 = rollupHealth();
    log.info(
      `${probes.length} probes compared, ${servedByRollup} served from the rollup, ` +
        `${health2?.dailyRows ?? 0} daily rollup rows\n`,
    );

    span.setAttributes({
      "app.probes": probes.length,
      "app.probes.rollup_served": servedByRollup,
      "app.failures": failures.length,
    });

    if (failures.length > 0) {
      for (const f of failures.slice(0, 60)) log.info(`  FAIL ${f.probe}  ${f.detail}`);
      if (failures.length > 60) log.info(`  ... ${failures.length - 60} more`);
      throw new Error(
        `${failures.length} rollup/raw mismatch(es). The rollup is NOT safe to read until these ` +
          `are explained — a wrong number costs more than a slow one.`,
      );
    }

    log.info(`PASS — rollup and raw agree on every probe. ${secondsSince(startedAt)}`);
  } finally {
    await client.close();
  }
};

if (import.meta.main) await runScript(main);
