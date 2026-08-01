/**
 * Stage 0 — detect.
 *
 * Did the metric actually move? Two gates, both required: a relative-size gate and a sigma gate.
 * Either alone misfires. Sigma alone on 3-4 baseline days calls noise significant; relative size
 * alone flags every weekend. Requiring both is what keeps `/scan` quiet enough to be read.
 */
import type { Ledger } from "../ledger";
import { METRICS, metricExpr } from "../metrics";
import {
  MIN_BASELINE_DAYS,
  baselineDates,
  estimateWeeklyGrowth,
  mean,
  sqlDateList,
  trendAwareBaseline,
} from "../baseline";
import { type Mask, NO_MASK } from "../types";
import { RAW_SOURCE, planRollup, sourceLabel } from "../../clickhouse/rollup";
import { withSpan } from "../../../shared/utils/telemetryUtils";
import type { Span } from "@opentelemetry/api";

export interface Detection {
  metric: string;
  from: string;
  to: string;
  incidentValue: number;
  baselineMean: number;
  baselineStd: number;
  baselineDays: number;
  deltaAbs: number;
  deltaPct: number;
  /** Percentage points, for ratio metrics only. */
  deltaPp: number | null;
  sigma: number;
  /**
   * The spread was the MIN_COEFF_VARIATION floor, not the observed MAD — so `sigma` above is
   * `deltaPct / 0.5` by construction and carries no information the size gate did not already have.
   * See the `floored` note in baseline.ts. A caller deciding how much to trust a bare platform move
   * must read this: a floored detection passed one gate twice, not two gates once.
   */
  spreadFloored: boolean;
  anomalous: boolean;
  reason: string;
  evidenceIds: string[];
}

/** Gates. Deliberately conservative: crying wolf is scored against us harder than a near miss. */
export const MIN_ABS_PCT = 3;
export const MIN_SIGMA = 2.5;

interface DailyRow {
  d: string;
  v: number | null;
}

export async function detect(
  ledger: Ledger,
  metric: string,
  from: string,
  to: string,
  mask: Mask = NO_MASK,
): Promise<Detection> {
  return withSpan(
    "stage.detect",
    {
      "app.stage": "detect",
      "app.metric": metric,
      "app.window.from": from,
      "app.window.to": to,
      "app.mask": mask.description,
    },
    (span) => detectInner(ledger, metric, from, to, mask, span),
  );
}

/**
 * The stage body. Split out so the span wrapper above stays readable; the verdict is stamped onto
 * the span on the way out, which is what makes "which stage decided nothing happened?" answerable
 * from a trace search rather than from the console output of a run nobody kept.
 */
async function detectInner(
  ledger: Ledger,
  metric: string,
  from: string,
  to: string,
  mask: Mask,
  span: Span,
): Promise<Detection> {
  const def = METRICS[metric];
  if (!def)
    throw new Error(`Unknown metric "${metric}". Known: ${Object.keys(METRICS).join(", ")}`);

  const expr = metricExpr(def);
  const base = baselineDates(from, to);
  const evidenceIds: string[] = [];

  /**
   * Read the rollup when it can express this mask exactly, the raw view otherwise (T-043/T-050).
   *
   * This stage is the single largest remaining consumer of raw events, and not because it is
   * complicated — the query below is one `GROUP BY event_date`. It is because it runs so often:
   * once for the platform, then once per candidate cause in `confirm`, each time re-deriving daily
   * totals from millions of events to produce ~7 numbers. Measured over one `diagnose` run,
   * `detect` plus the `confirm` loop that calls it accounted for **41.8% of all rows read**
   * (138.6M of 331.7M) — more than every other stage combined.
   *
   * `mask.dims` is what makes the decision possible: 0 dimensions for the platform, 1 or 2 for a
   * segment (a pair counts as two), and `planRollup` declines anything wider so a mask the rollup
   * cannot express falls back rather than being answered approximately. `src.expr` rewrites the
   * metric formula from `backend/metrics.ts` for the rolled-up columns, so there is still exactly
   * one definition of every metric.
   */
  const plan = planRollup({ dims: mask.dims, grain: "daily", expressions: [expr] });
  const src = plan ?? RAW_SOURCE;

  // One query returns both the incident window and every baseline day, so the two can never be
  // computed against different filters or a different mask.
  const sql = `
SELECT toString(event_date) AS d, ${src.expr(expr)} AS v
FROM ${src.from}
WHERE (${mask.sql})
  AND (event_date BETWEEN '${from}' AND '${to}' OR event_date IN (${sqlDateList(base)}))
GROUP BY event_date
ORDER BY event_date`.trim();

  const rows = await ledger.run<DailyRow>(sql);
  const incidentDays = rows.filter((r) => r.d >= from && r.d <= to);
  const baselineDays = rows.filter((r) => !(r.d >= from && r.d <= to));

  const num = (r: DailyRow) => Number(r.v ?? 0);
  // Absolutes are summed across a multi-day window; ratios are averaged across days. Ratios are
  // still sum/sum *within* each day, which is what the glossary requires.
  const agg = (rs: DailyRow[]) =>
    def.kind === "absolute" ? rs.reduce((a, r) => a + num(r), 0) : mean(rs.map(num));

  const incidentValue = agg(incidentDays);
  const perDayIncident =
    def.kind === "absolute" ? incidentValue / incidentDays.length : incidentValue;

  const baseVals = baselineDays.map(num);
  // Same-weekday points tagged with how many weeks back they sit, so the baseline can project the
  // documented growth trend forward instead of averaging behind it.
  const dayMs = 86_400_000;
  const anchor = Date.parse(`${from}T00:00:00Z`);
  const basePoints = baselineDays.map((r) => ({
    weeksAgo: Math.max(1, Math.round((anchor - Date.parse(`${r.d}T00:00:00Z`)) / (7 * dayMs))),
    value: num(r),
  }));
  // Compare per-day against per-day. A 3-day incident total against a 1-day baseline would show a
  // 200% "increase" that is pure arithmetic.
  //
  // Median, not mean: a prior planted incident sitting inside the baseline window would otherwise
  // drag the centre and manufacture an anomaly on a perfectly normal day. See `robustBaseline`.
  // Growth is estimated from every day the query returned, not from the baseline points alone —
  // four points cannot support a trend estimate (see estimateWeeklyGrowth).
  const wholeSeries = new Map(rows.map((r) => [r.d, num(r)]));
  const {
    centre: baselineMean,
    spread: baselineStd,
    floored: spreadFloored,
  } = trendAwareBaseline(basePoints, estimateWeeklyGrowth(wholeSeries));

  const deltaAbs = perDayIncident - baselineMean;
  const deltaPct = baselineMean === 0 ? 0 : (deltaAbs / baselineMean) * 100;
  const deltaPp = def.kind === "ratio" && def.scale === 1 ? deltaAbs * 100 : null;
  const sigma = baselineStd === 0 ? 0 : deltaAbs / baselineStd;

  evidenceIds.push(
    ledger.record({
      label: `${metric}.incident`,
      value: Number(perDayIncident.toFixed(6)),
      unit: def.unit === "usd" ? "usd" : def.unit === "count" ? "count" : "ratio",
      sql,
      window: { from, to },
      filters: mask.sql === "1" ? {} : { mask: mask.description },
    }),
    ledger.record({
      label: `${metric}.baseline.same_weekday_mean`,
      value: Number(baselineMean.toFixed(6)),
      unit: def.unit === "usd" ? "usd" : def.unit === "count" ? "count" : "ratio",
      sql,
      window: { from: base[0] ?? from, to: base[base.length - 1] ?? to },
      filters: { baseline_dates: base.join(",") },
    }),
    ledger.record({
      label: `${metric}.delta_pct`,
      value: Number(deltaPct.toFixed(4)),
      unit: "pct",
      sql,
      window: { from, to },
      filters: {},
    }),
    ledger.record({
      label: `${metric}.sigma`,
      value: Number(sigma.toFixed(3)),
      unit: "sigma",
      sql,
      window: { from, to },
      filters: { baseline_days: String(baseVals.length) },
    }),
    // Gates are configuration, not measurement — but they are printed, so they must still resolve.
    // Recording them keeps the grounding check total rather than carving out exceptions.
    ledger.record({
      label: "gate.min_abs_pct",
      value: MIN_ABS_PCT,
      unit: "pct",
      sql: "configuration: backend/stages/detect.ts MIN_ABS_PCT",
      window: { from, to },
      filters: {},
    }),
    ledger.record({
      label: "gate.min_sigma",
      value: MIN_SIGMA,
      unit: "sigma",
      sql: "configuration: backend/stages/detect.ts MIN_SIGMA",
      window: { from, to },
      filters: {},
    }),
  );
  if (deltaPp !== null) {
    evidenceIds.push(
      ledger.record({
        label: `${metric}.delta_pp`,
        value: Number(deltaPp.toFixed(4)),
        unit: "pp",
        sql,
        window: { from, to },
        filters: {},
      }),
    );
  }

  // Refusing is a legitimate output. Better than a confident answer off two observations.
  if (baseVals.length < MIN_BASELINE_DAYS) {
    span.setAttributes({
      "app.detect.anomalous": false,
      "app.detect.baseline_days": baseVals.length,
      "app.detect.refused": true,
    });
    return {
      metric,
      from,
      to,
      incidentValue: perDayIncident,
      baselineMean,
      baselineStd,
      baselineDays: baseVals.length,
      deltaAbs,
      deltaPct,
      deltaPp,
      sigma,
      spreadFloored,
      anomalous: false,
      reason: `Insufficient baseline: ${baseVals.length} same-weekday observation(s), need ${MIN_BASELINE_DAYS}.`,
      evidenceIds,
    };
  }

  const passesSize = Math.abs(deltaPct) >= MIN_ABS_PCT;
  const passesSigma = Math.abs(sigma) >= MIN_SIGMA;
  const anomalous = passesSize && passesSigma;

  const reason = anomalous
    ? `${deltaPct.toFixed(1)}% move at ${sigma.toFixed(1)} sigma against ${baseVals.length} same-weekday days.`
    : `Within band: ${deltaPct.toFixed(1)}% (gate ${MIN_ABS_PCT}%), ${sigma.toFixed(1)} sigma (gate ${MIN_SIGMA}).`;

  span.setAttributes({
    "app.detect.anomalous": anomalous,
    "app.detect.baseline_days": baseVals.length,
    "app.detect.delta_pct": Number(deltaPct.toFixed(4)),
    "app.detect.sigma": Number(sigma.toFixed(3)),
    // Which surface answered, next to the latency it bought — the same fact `servedFrom` puts in the
    // MCP envelope, for a stage that has no envelope of its own.
    "app.source": sourceLabel(plan),
    // Filterable, because "which of our detections were carried by the floor rather than by a
    // measured spread" is the question that separates a real signal from a restated size gate.
    "app.detect.spread_floored": spreadFloored,
    "app.detect.refused": false,
  });

  return {
    metric,
    from,
    to,
    incidentValue: perDayIncident,
    baselineMean,
    baselineStd,
    baselineDays: baseVals.length,
    deltaAbs,
    deltaPct,
    deltaPp,
    sigma,
    spreadFloored,
    anomalous,
    reason,
    evidenceIds,
  };
}
