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
  mean,
  robustBaseline,
  sqlDateList,
} from "../baseline";
import { type Mask, NO_MASK } from "../types";

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
  const def = METRICS[metric];
  if (!def) throw new Error(`Unknown metric "${metric}". Known: ${Object.keys(METRICS).join(", ")}`);

  const expr = metricExpr(def);
  const base = baselineDates(from, to);
  const evidenceIds: string[] = [];

  // One query returns both the incident window and every baseline day, so the two can never be
  // computed against different filters or a different mask.
  const sql = `
SELECT toString(event_date) AS d, ${expr} AS v
FROM ad_events_enriched
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
  const perDayIncident = def.kind === "absolute" ? incidentValue / incidentDays.length : incidentValue;

  const baseVals = baselineDays.map(num);
  // Compare per-day against per-day. A 3-day incident total against a 1-day baseline would show a
  // 200% "increase" that is pure arithmetic.
  //
  // Median, not mean: a prior planted incident sitting inside the baseline window would otherwise
  // drag the centre and manufacture an anomaly on a perfectly normal day. See `robustBaseline`.
  const { centre: baselineMean, spread: baselineStd } = robustBaseline(baseVals);

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
      label: "gate.min_abs_pct", value: MIN_ABS_PCT, unit: "pct",
      sql: "configuration: backend/stages/detect.ts MIN_ABS_PCT",
      window: { from, to }, filters: {},
    }),
    ledger.record({
      label: "gate.min_sigma", value: MIN_SIGMA, unit: "sigma",
      sql: "configuration: backend/stages/detect.ts MIN_SIGMA",
      window: { from, to }, filters: {},
    }),
  );
  if (deltaPp !== null) {
    evidenceIds.push(ledger.record({
      label: `${metric}.delta_pp`, value: Number(deltaPp.toFixed(4)), unit: "pp",
      sql, window: { from, to }, filters: {},
    }));
  }

  // Refusing is a legitimate output. Better than a confident answer off two observations.
  if (baseVals.length < MIN_BASELINE_DAYS) {
    return {
      metric, from, to, incidentValue: perDayIncident, baselineMean, baselineStd,
      baselineDays: baseVals.length, deltaAbs, deltaPct, deltaPp, sigma,
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

  return {
    metric, from, to, incidentValue: perDayIncident, baselineMean, baselineStd,
    baselineDays: baseVals.length, deltaAbs, deltaPct, deltaPp, sigma, anomalous, reason,
    evidenceIds,
  };
}
