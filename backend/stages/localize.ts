/**
 * Stage 2 — localize.
 *
 * One scan produces every single-dimension cut at once: `arrayJoin` fans each row out into one row
 * per (dimension, value) pair, so N dimensions cost one pass rather than N queries. This is the
 * `GROUPING SETS` idea expressed in a form that also carries the baseline window in the same query,
 * which matters because incident and baseline must never be computed under different filters.
 */
import type { Ledger } from "../ledger";
import { DIMENSION_PAIRS, METRICS, dimensionsFor, metricExpr } from "../metrics";
import { baselineDates, datesBetween, sqlDateList } from "../baseline";
import { type Mask, NO_MASK } from "../types";

export interface Candidate {
  dimension: string;
  value: string;
  baseValue: number;
  incValue: number;
  deltaAbs: number;
  deltaPct: number;
  deltaPp: number | null;
  /** Share of in-window requests carried by this segment. */
  sharePct: number;
  /**
   * Share of the platform-level delta this segment accounts for, given its size. This — not raw
   * delta — is what ranks candidates: a -60pp move on 0.1% of traffic moves nothing.
   */
  contribution: number;
  sql: string;
}

interface SweepRow {
  dim: string;
  val: string;
  base_v: number | null;
  inc_v: number | null;
  inc_reqs: string | number;
  total_reqs: string | number;
}

/**
 * Rewrite a metric expression into its conditional form, so incident and baseline are aggregated
 * in the same pass: `sum(revenue)` -> `sumIf(revenue, is_inc)`.
 */
function conditional(expr: string, cond: string): string {
  return expr
    .replace(/\bcount\(\)/g, `countIf(${cond})`)
    .replace(/\bsum\(([^)]+)\)/g, `sumIf($1, ${cond})`);
}

export async function localize(
  ledger: Ledger,
  metric: string,
  from: string,
  to: string,
  mask: Mask = NO_MASK,
): Promise<Candidate[]> {
  const def = METRICS[metric]!;
  const expr = metricExpr(def);
  const dims = dimensionsFor(metric);
  const base = baselineDates(from, to);

  // Single dimensions plus the pairwise cuts. A pair is emitted as one synthetic dimension
  // ("region|os_version" -> "EU|Android 15") so the sweep, the ranking and the deflation loop all
  // treat it exactly like any other candidate — no special-casing downstream.
  const single = dims.map((d) => `('${d}', ${d})`);
  const paired = DIMENSION_PAIRS.filter(([a, b]) => dims.includes(a) && dims.includes(b)).map(
    ([a, b]) => `('${a}|${b}', concat(${a}, '|', ${b}))`,
  );
  const pairs = [...single, ...paired].join(", ");

  // Volume floor, applied in SQL rather than after the fact. app_id alone is 2,000 values and the
  // pairs add several hundred more, so without this the client would receive thousands of rows
  // that could never be a cause. Deliberately a floor on VOLUME, never on delta: residualize has
  // to see a segment's small post-exclusion residual to recognise it as contamination, and
  // filtering on delta would hide exactly the rows the differentiator depends on.
  const minRequests = 150;

  const sql = `
SELECT
  dim,
  val,
  ${conditional(expr, "is_base")} AS base_v,
  ${conditional(expr, "is_inc")}  AS inc_v,
  countIf(is_inc)                 AS inc_reqs,
  (SELECT count() FROM ad_events_enriched
    WHERE (${mask.sql}) AND event_date BETWEEN '${from}' AND '${to}') AS total_reqs
FROM (
  SELECT *,
         event_date BETWEEN '${from}' AND '${to}' AS is_inc,
         event_date IN (${sqlDateList(base)})     AS is_base,
         arrayJoin([${pairs}]) AS kv,
         kv.1 AS dim,
         kv.2 AS val
  FROM ad_events_enriched
  WHERE (${mask.sql})
    AND (event_date BETWEEN '${from}' AND '${to}' OR event_date IN (${sqlDateList(base)}))
)
GROUP BY dim, val
HAVING base_v IS NOT NULL AND inc_v IS NOT NULL AND inc_reqs >= ${minRequests}
ORDER BY dim, val`.trim();

  const rows = await ledger.run<SweepRow>(sql);

  // Absolute metrics accumulate across every day in their window, so a 4-day baseline against a
  // 1-day incident bakes in a -75% before anything real is measured. Ratios are self-normalising
  // and must NOT be divided. Getting this wrong reported Jun 21 as -71% when the platform moved
  // -43.5%; the uniformity test still fired, which is exactly how a silent bias survives review.
  const incDays = Math.max(1, datesBetween(from, to).length);
  const baseDays = Math.max(1, base.length);
  const perDay = def.kind === "absolute";

  return rows
    .map((r) => {
      const baseValue = Number(r.base_v ?? 0) / (perDay ? baseDays : 1);
      const incValue = Number(r.inc_v ?? 0) / (perDay ? incDays : 1);
      const deltaAbs = incValue - baseValue;
      const total = Number(r.total_reqs) || 1;
      const sharePct = (Number(r.inc_reqs) / total) * 100;
      return {
        dimension: r.dim,
        value: r.val,
        baseValue,
        incValue,
        deltaAbs,
        deltaPct: baseValue === 0 ? 0 : (deltaAbs / baseValue) * 100,
        deltaPp: def.kind === "ratio" && def.scale === 1 ? deltaAbs * 100 : null,
        sharePct,
        // Weighting by share is what stops a tiny, wildly-swinging segment outranking the cause.
        contribution: Math.abs(deltaAbs) * (sharePct / 100),
        sql,
      } satisfies Candidate;
    })
    .sort((a, b) => b.contribution - a.contribution);
}
