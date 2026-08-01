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
import { baselineDates, sqlDateList } from "../baseline";
import { type Mask, NO_MASK } from "../types";

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
}

interface FunnelRow {
  days: string | number;
  reqs: string | number;
  fills: string | number;
  imps: string | number;
  rev: number;
}

const funnelSql = (where: string, mask: Mask): string =>
  `
SELECT
  uniqExact(event_date) AS days,
  count()               AS reqs,
  sum(is_filled)        AS fills,
  sum(is_impression)    AS imps,
  sum(revenue)          AS rev
FROM ad_events_enriched
WHERE (${mask.sql}) AND ${where}`.trim();

export async function decompose(
  ledger: Ledger,
  from: string,
  to: string,
  mask: Mask = NO_MASK,
): Promise<Decomposition> {
  const base = baselineDates(from, to);

  const incSql = funnelSql(`event_date BETWEEN '${from}' AND '${to}'`, mask);
  const baseSql = funnelSql(`event_date IN (${sqlDateList(base)})`, mask);

  const [inc] = await ledger.run<FunnelRow>(incSql);
  const [bas] = await ledger.run<FunnelRow>(baseSql);
  if (!inc || !bas) throw new Error("decompose: funnel query returned no rows");

  const per = (r: FunnelRow) => {
    const days = Number(r.days) || 1;
    const reqs = Number(r.reqs);
    const fills = Number(r.fills);
    const imps = Number(r.imps);
    const rev = Number(r.rev);
    return {
      requests: reqs / days,
      fill_rate: reqs === 0 ? 0 : fills / reqs,
      render_rate: fills === 0 ? 0 : imps / fills,
      ecpm: imps === 0 ? 0 : (rev / imps) * 1000,
      revenue: rev / days,
    };
  };

  const b = per(bas);
  const i = per(inc);

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
  };
}
