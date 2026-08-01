/**
 * Stage 1 — decompose the revenue identity.
 *
 *   Revenue = Requests x Fill rate x (Impressions/Fills) x eCPM/1000
 *
 * Fixed in metrics_glossary.md; do not re-derive it. Walking the identity first is cheap and it
 * prunes the search space by roughly two thirds before any expensive sweep runs — if fill rate
 * carries the whole move, there is no reason to sweep dimensions for eCPM.
 *
 * Factor attribution is sequential (chain-rule style): each factor is swapped from baseline to
 * incident in turn while the others are held at their prior state. The parts therefore sum to the
 * total by construction, with the residual carrying the interaction terms.
 */
import type { Ledger } from "../ledger";
import { baselineDates, datesBetween, median, sqlDateList } from "../baseline";
import { type Mask, NO_MASK } from "../types";
import { planRollup, RAW_SOURCE, sourceLabel } from "../../clickhouse/rollup";
import { withSpan } from "../../../shared/utils/telemetryUtils";

export interface Factor {
  name: "requests" | "fill_rate" | "render_rate" | "ecpm";
  baseValue: number;
  incValue: number;
  deltaPct: number;
  /** Revenue dollars/day attributable to this factor alone. */
  revenueEffect: number;
  isDriver: boolean;
  evidenceId: string;
  evidenceIdPct: string;
  evidenceIdUsd: string;
}

export interface Decomposition {
  factors: Factor[];
  baselineRevenuePerDay: number;
  incidentRevenuePerDay: number;
  revenueDelta: number;
  residual: number;
  driver: Factor | null;
  /** `rollup:<grain>:<dim>` or `raw` -- which surface answered. */
  servedFrom: string;
}

interface FunnelRow {
  d: string;
  reqs: string | number;
  fills: string | number;
  imps: string | number;
  rev: number;
}

/** One day's summed funnel counters. */
interface Totals {
  reqs: number;
  fills: number;
  imps: number;
  rev: number;
}

/** Componentwise median across days -- robust to a single contaminated day on either side. */
const centre = (series: Totals[]): Totals => ({
  reqs: median(series.map((t) => t.reqs)),
  fills: median(series.map((t) => t.fills)),
  imps: median(series.map((t) => t.imps)),
  rev: median(series.map((t) => t.rev)),
});

/**
 * Per-day funnel totals. Deliberately NOT pre-aggregated across the window.
 *
 * This used to sum the whole window and divide by the day count -- a mean on both sides -- and a
 * mean is exactly what a neighbouring incident poisons. Two live cases, from opposite directions:
 *
 *   Incident C (Jun 19-22) CONTAINS Jun 21, the global volume collapse. The mean read requests at
 *   -8.2%, so a finance eCPM crash was classified `supply_change` and routed to Publisher ops.
 *
 *   Incident D (Jun 28-30) has Jun 21 sitting in its same-weekday BASELINE. The mean read requests
 *   at +7.9%, so a 10pp fill collapse on one OS was also classified `supply_change`.
 *
 * `detect` and `localize` were both hardened against this with a median; this stage never was.
 * Same bug, third stage. Totals stay summed *within* each day, so ratios remain sum/sum as the
 * glossary requires -- the median is only ever taken across days.
 */
const funnelSql = (
  where: string,
  mask: Mask,
  src: { from: string; expr: (e: string) => string },
): string =>
  `
SELECT
  toString(event_date)     AS d,
  ${src.expr("count()")}          AS reqs,
  ${src.expr("sum(is_filled)")}     AS fills,
  ${src.expr("sum(is_impression)")} AS imps,
  ${src.expr("sum(revenue)")}       AS rev
FROM ${src.from}
WHERE (${mask.sql}) AND ${where}
GROUP BY d
ORDER BY d`.trim();

export async function decompose(
  ledger: Ledger,
  from: string,
  to: string,
  mask: Mask = NO_MASK,
): Promise<Decomposition> {
  return withSpan(
    "stage.decompose",
    {
      "app.stage": "decompose",
      "app.window.from": from,
      "app.window.to": to,
      "app.mask": mask.description,
    },
    async (span) => {
      const result = await decomposeInner(ledger, from, to, mask);
      span.setAttributes({
        "app.decompose.driver": result.driver?.name ?? "none",
        "app.decompose.revenue_delta": Number(result.revenueDelta.toFixed(2)),
        "app.decompose.factors": result.factors.length,
        "app.decompose.served_from": result.servedFrom,
      });
      return result;
    },
  );
}

async function decomposeInner(
  ledger: Ledger,
  from: string,
  to: string,
  mask: Mask,
): Promise<Decomposition> {
  const base = baselineDates(from, to);

  // Dimensionless (grouped only by day), so the plan's whole budget is whatever the mask already
  // spent -- an unmasked call gets the cheapest carrier dimension for free (see planRollup).
  const plan = planRollup({
    dims: mask.dims ?? [],
    grain: "daily",
    expressions: ["count()", "sum(is_filled)", "sum(is_impression)", "sum(revenue)"],
  });
  const src = plan ?? RAW_SOURCE;
  const servedFrom = sourceLabel(plan);

  const incSql = funnelSql(`event_date BETWEEN '${from}' AND '${to}'`, mask, src);
  const baseSql = funnelSql(`event_date IN (${sqlDateList(base)})`, mask, src);

  const incRows = await ledger.run<FunnelRow>(incSql);
  const basRows = await ledger.run<FunnelRow>(baseSql);
  if (incRows.length === 0 || basRows.length === 0) {
    throw new Error("decompose: funnel query returned no rows");
  }

  const totals = (r: FunnelRow): Totals => ({
    reqs: Number(r.reqs),
    fills: Number(r.fills),
    imps: Number(r.imps),
    rev: Number(r.rev),
  });
  const basByDate = new Map(basRows.map((r) => [r.d, totals(r)]));
  const incByDate = new Map(incRows.map((r) => [r.d, totals(r)]));
  const incidentDays = datesBetween(from, to);

  /**
   * Baseline aligned day-for-day with the incident window, matched on weekday.
   *
   * Pooling every baseline day and taking one centre is not like-for-like when the two sets have
   * different weekday mixes. Incident C spans Fri-Mon (4 days); its baseline pool is 9 days with
   * three Mondays. Mondays run ~270k requests and Saturdays ~215k, so the pooled baseline centre
   * lands on a Friday while the incident centre lands between Friday and Saturday -- and requests
   * read -3.6% purely from that mismatch. Matched per weekday they read:
   *
   *     Fri +3.2%   Sat +3.4%   Sun -43.5%   Mon +4.2%
   *
   * Request volume was normal; one day inside the window (Jun 21, incident B) collapsed. The
   * pooled comparison turned that into "requests are the driver", which routed a finance eCPM
   * crash to Publisher ops as a supply change.
   */
  const matchedBaseline = (day: string): Totals | null => {
    const matched = baselineDates(day, day)
      .filter((b) => !incidentDays.includes(b))
      .map((b) => basByDate.get(b))
      .filter((t): t is Totals => t !== undefined);
    return matched.length ? centre(matched) : null;
  };

  const incSeries = incidentDays
    .map((d) => incByDate.get(d))
    .filter((t): t is Totals => t !== undefined);
  const baseSeries = incidentDays.map(matchedBaseline).filter((t): t is Totals => t !== null);

  if (incSeries.length === 0 || baseSeries.length === 0) {
    throw new Error("decompose: no weekday-matched baseline for this window");
  }

  /** Ratios stay sum/sum within a day; the median is only ever taken across days. */
  const per = (series: Totals[]) => {
    const { reqs, fills, imps, rev } = centre(series);
    return {
      requests: reqs,
      fill_rate: reqs === 0 ? 0 : fills / reqs,
      render_rate: fills === 0 ? 0 : imps / fills,
      ecpm: imps === 0 ? 0 : (rev / imps) * 1000,
      revenue: rev,
    };
  };

  const b = per(baseSeries);
  const i = per(incSeries);

  // Revenue rebuilt from the four factors. Swap them one at a time, baseline -> incident.
  const rev = (f: { requests: number; fill_rate: number; render_rate: number; ecpm: number }) =>
    f.requests * f.fill_rate * f.render_rate * (f.ecpm / 1000);

  const order = ["requests", "fill_rate", "render_rate", "ecpm"] as const;
  const state = { ...b };
  let prev = rev(state);
  const factors: Factor[] = [];

  for (const name of order) {
    state[name] = i[name];
    const next = rev(state);
    const effect = next - prev;
    prev = next;

    const sql = name === "requests" || name === "fill_rate" ? incSql : incSql;
    factors.push({
      name,
      baseValue: b[name],
      incValue: i[name],
      deltaPct: b[name] === 0 ? 0 : ((i[name] - b[name]) / b[name]) * 100,
      revenueEffect: effect,
      isDriver: false,
      evidenceIdPct: ledger.record({
        label: `decompose.${name}.delta_pct`,
        value: Number((b[name] === 0 ? 0 : ((i[name] - b[name]) / b[name]) * 100).toFixed(4)),
        unit: "pct",
        sql,
        window: { from, to },
        filters: {},
      }),
      evidenceIdUsd: ledger.record({
        label: `decompose.${name}.revenue_effect_usd`,
        value: Number(effect.toFixed(4)),
        unit: "usd",
        sql,
        window: { from, to },
        filters: {},
      }),
      evidenceId: ledger.record({
        label: `decompose.${name}`,
        value: Number(i[name].toFixed(6)),
        unit: name === "ecpm" ? "usd" : name === "requests" ? "count" : "ratio",
        sql,
        window: { from, to },
        filters: mask.sql === "1" ? {} : { mask: mask.description },
      }),
    });
  }

  const revenueDelta = i.revenue - b.revenue;
  const explained = factors.reduce((a, f) => a + f.revenueEffect, 0);

  // The driver is the factor with the largest absolute revenue effect — not the largest percentage
  // move. A 40% swing on a factor worth $2 is not the story.
  const driver = factors.reduce<Factor | null>(
    (best, f) => (!best || Math.abs(f.revenueEffect) > Math.abs(best.revenueEffect) ? f : best),
    null,
  );
  if (driver) driver.isDriver = true;

  return {
    factors,
    baselineRevenuePerDay: b.revenue,
    incidentRevenuePerDay: i.revenue,
    revenueDelta,
    residual: revenueDelta - explained,
    driver,
    servedFrom,
  };
}
