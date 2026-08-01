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
import {
  ROLLUP_DIM_KEYS,
  ROLLUP_TABLES,
  rollupHealth,
  toRollupExpr,
} from "../../clickhouse/rollup";
import { withSpan } from "../../../shared/utils/telemetryUtils";

/**
 * The rollup keys corresponding to the cuts this sweep makes.
 *
 * Intersected with `ROLLUP_DIM_KEYS` rather than assumed: if the sweep gains a dimension the rollup
 * does not store, the intersection silently narrows and the sweep would report fewer candidates than
 * the raw path — so `localize` refuses the rollup entirely unless every key it needs is present.
 */
function sweptRollupKeys(metric: string): string[] {
  const dims = dimensionsFor(metric);
  const wanted = [
    ...dims,
    ...DIMENSION_PAIRS.filter(([a, b]) => dims.includes(a) && dims.includes(b)).map(
      ([a, b]) => `${a}|${b}`,
    ),
  ];
  const available = new Set(ROLLUP_DIM_KEYS);
  return wanted.every((k) => available.has(k)) ? wanted : [];
}

export interface Candidate {
  dimension: string;
  value: string;
  baseValue: number;
  incValue: number;
  deltaAbs: number;
  deltaPct: number;
  deltaPp: number | null;
  /**
   * Share of in-window PLATFORM requests carried by this segment.
   *
   * Deliberately not relative to the current mask. Scoped to a segment, a mask-relative share
   * reported the cause as "on 100.0% of traffic", which is true of the scope and meaningless to a
   * reader. "-39.64pp on 2.1% of traffic" is the fact that matters.
   */
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
  return withSpan(
    "stage.localize",
    {
      "app.stage": "localize",
      "app.metric": metric,
      "app.window.from": from,
      "app.window.to": to,
      "app.mask": mask.description,
    },
    async (span) => {
      const candidates = await localizeInner(ledger, metric, from, to, mask);
      // The candidate count is the thing that moves when a sweep is widened (app_id, pairwise
      // cuts), and it is the input to every downstream claim about "how much was checked".
      span.setAttribute("app.localize.candidates", candidates.length);
      return candidates;
    },
  );
}

async function localizeInner(
  ledger: Ledger,
  metric: string,
  from: string,
  to: string,
  mask: Mask,
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
  const perDay = def.kind === "absolute";

  // Volume floor, applied in SQL rather than after the fact. app_id alone is 2,000 values and the
  // pairs add several hundred more, so without this the client would receive thousands of rows
  // that could never be a cause. Deliberately a floor on VOLUME, never on delta: residualize has
  // to see a segment's small post-exclusion residual to recognise it as contamination, and
  // filtering on delta would hide exactly the rows the differentiator depends on.
  const minRequests = 150;

  /**
   * The rollup already IS this fan-out, so on the unmasked path there is nothing to fan out.
   *
   * `arrayJoin` exists here to turn one event row into one row per (dimension, value). The rollup
   * stores exactly that shape, keyed by `dim`/`val`, so the sweep becomes a read of ~150k
   * pre-aggregated rows instead of a 14-way explosion of 6.6M events.
   *
   * MASKED CALLS STAY ON RAW, and that is not a temporary shortcut. A mask constrains a dimension by
   * name (`os_version = 'Android 15'`), and the rollup projection for a single-dimension key has no
   * such column — the rows already summed that dimension away. Serving it from the rollup would need
   * the matching PAIR key and a sum over the complement, per swept dimension, which is a different
   * query shape (see BROADCAST). Falling back is exact; guessing would not be.
   */
  const keys = sweptRollupKeys(metric);
  const unmasked = mask.sql === "1";
  const useRollup = unmasked && keys.length > 0 && rollupHealth()?.ready === true;

  const rollupSource = `
    SELECT dim, val, event_date AS d,
           ${toRollupExpr(expr)}       AS day_v,
           ${toRollupExpr("count()")}  AS day_reqs,
           event_date BETWEEN toDate('${from}') AND toDate('${to}') AS is_inc,
           event_date IN (${sqlDateList(base)})                     AS is_base
    FROM ${ROLLUP_TABLES.daily}
    WHERE dim IN (${keys.map((k) => `'${k}'`).join(", ")})
      AND (event_date BETWEEN '${from}' AND '${to}' OR event_date IN (${sqlDateList(base)}))
    GROUP BY dim, val, event_date`;

  const rawSource = `
    SELECT dim, val, d,
           ${expr}  AS day_v,
           count()  AS day_reqs,
           d BETWEEN toDate('${from}') AND toDate('${to}') AS is_inc,
           d IN (${sqlDateList(base)})                      AS is_base
    FROM (
      SELECT *, event_date AS d,
             arrayJoin([${pairs}]) AS kv, kv.1 AS dim, kv.2 AS val
      FROM ad_events_enriched
      WHERE (${mask.sql})
        AND (event_date BETWEEN '${from}' AND '${to}' OR event_date IN (${sqlDateList(base)}))
    )
    GROUP BY dim, val, d`;

  // Share of platform traffic must come from the same surface, or the denominator disagrees with the
  // numerator by whatever the two surfaces differ by.
  const totalReqs = useRollup
    ? `(SELECT ${toRollupExpr("count()")} FROM ${ROLLUP_TABLES.daily}
        WHERE dim = 'ad_format' AND event_date BETWEEN '${from}' AND '${to}')`
    : `(SELECT count() FROM ad_events_enriched
        WHERE event_date BETWEEN '${from}' AND '${to}')`;

  const sql = `
SELECT
  dim,
  val,
  arrayReduce('median', base_days) AS base_v,
  inc_v,
  inc_reqs,
  ${totalReqs} AS total_reqs
FROM (
  SELECT dim, val,
         groupArrayIf(day_v, is_base)                       AS base_days,
         ${perDay ? "sumIf(day_v, is_inc) / countIf(is_inc)" : "avgIf(day_v, is_inc)"} AS inc_v,
         sumIf(day_reqs, is_inc)                            AS inc_reqs
  FROM (
    ${useRollup ? rollupSource : rawSource}
  )
  GROUP BY dim, val
  HAVING length(base_days) > 0 AND inc_reqs >= ${minRequests}
)
WHERE base_v IS NOT NULL AND inc_v IS NOT NULL
ORDER BY dim, val`.trim();

  const rows = await ledger.run<SweepRow>(sql);

  // Absolute metrics accumulate across every day in their window, so a 4-day baseline against a
  // 1-day incident bakes in a -75% before anything real is measured. Ratios are self-normalising
  // and must NOT be divided. Getting this wrong reported Jun 21 as -71% when the platform moved
  // -43.5%; the uniformity test still fired, which is exactly how a silent bias survives review.

  return rows
    .map((r) => {
      // Both sides are already per-day and the baseline is a MEDIAN across its days.
      //
      // Summing the baseline window and dividing gave a mean, so a prior incident inside that
      // window poisoned it: Sunday Jun 28's baseline contains Jun 21 (the global collapse), which
      // dragged the mean down far enough that publisher_tier='tier_2' read as +22.9% on a
      // completely normal day and the seasonality decoy became a $39.51/day "finding". detect was
      // fixed for exactly this months-equivalent-ago; localize was not.
      const baseValue = Number(r.base_v ?? 0);
      const incValue = Number(r.inc_v ?? 0);
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
