/**
 * The detection sweep, read from the rollup instead of the fact table.
 *
 * WHY THIS FILE EXISTS. `find_incidents` is the most expensive thing the server does — 135M of the
 * 344M rows one full `diagnose` run reads (measured, `pitch/example-report/report.json`) — and the
 * cost is structural, not accidental. `backend/segments.ts` fans every one of 9M events out into 17
 * `(dimension, value)` rows with `arrayJoin` and then groups them, **per metric**, across the whole
 * history, because the baseline needs the whole history. That is 153M intermediate rows per metric to
 * produce a few dozen firings.
 *
 * The rollup already holds the result of that fan-out: `rollup_segment_daily` IS `(day, dim, val) ->
 * five sums`, maintained incrementally on insert. So the same sweep becomes a ~99k-row read.
 *
 * WHY IT IS A SEPARATE FILE RATHER THAN A PATCH TO `backend/segments.ts`. Ownership — `backend/` is
 * Lane A's (AGENTS.md § 2), and the sweep is load-bearing for their orchestrator. The SQL below is a
 * transcription of theirs with the row source swapped, nothing else: same gates, same floors, same
 * median/MAD baseline, same growth adjustment, same output shape. `scripts/verify-rollup.ts` asserts
 * the two produce identical firings, firing for firing, over every default metric — which is what
 * makes the swap a performance change rather than a behaviour change. The three-line version of this
 * patch is in the BROADCAST entry for Lane A to take when they want it (T-043).
 */
import type { Ledger } from "../engine/ledger";
import { DATASET_END, DATASET_START } from "../engine/baseline";
import { DIMENSION_PAIRS, METRICS, dimensionsFor, metricExpr } from "../engine/metrics";
import {
  MIN_BASELINE_POINTS,
  SEGMENT_MIN_PCT,
  SEGMENT_MIN_REQUESTS,
  SEGMENT_MIN_SIGMA,
  type SegmentFiring,
} from "../engine/segments";
import { ROLLUP_TABLES, assertPairOrder, rollupDimKey, toRollupExpr } from "../clickhouse/rollup";
import { withSpan } from "../../shared/utils/telemetryUtils";

/**
 * Fail at import time if Lane A's pair list and the rollup's canonical pair order ever disagree.
 *
 * A pair stored as `region|os_version` but swept as `os_version|region` would not error — it would
 * match zero rollup rows, and the sweep would quietly stop finding paired incidents. Cheap to check
 * once; invisible if it ever happened.
 */
assertPairOrder(DIMENSION_PAIRS);

/** The `dim` keys this sweep reads, for one metric. Exactly the cuts the raw sweep fans out to. */
function sweptDimKeys(metric: string): string[] {
  const dims = dimensionsFor(metric);
  const pairs = DIMENSION_PAIRS.filter(([a, b]) => dims.includes(a) && dims.includes(b)).map(
    ([a, b]) => `${a}|${b}`,
  );
  const keys = [...dims, ...pairs];

  // Every key must be one the rollup actually materialises. If a dimension were added to
  // backend/metrics.ts without being added to the rollup registry, this is where it surfaces --
  // loudly, rather than as a dimension that silently stops being checked for incidents.
  for (const key of keys) {
    const parts = key.split("|");
    if (!rollupDimKey(parts)) {
      throw new Error(
        `The sweep wants dim='${key}' but the rollup does not carry it. Add it to DIM_ORDER or ` +
          `ROLLUP_ENTITY_DIMS in clickhouse/rollup.ts and re-run bun run ch:schema && bun run ch:rollup.`,
      );
    }
  }
  return keys;
}

interface Row {
  dim: string;
  val: string;
  day: string;
  actual: number;
  baseline: number;
  pct: number;
  sigma: number;
  reqs: string | number;
}

/**
 * Detection in SQL, against the daily rollup.
 *
 * Line-for-line the same statistics as `backend/segments.ts`: aggregate each segment per day, attach
 * the same-weekday values from 1-4 weeks back, carry each forward by the global growth rate, centre
 * on a median and spread on a MAD (both resistant to a prior incident sitting inside the baseline --
 * the failure that once produced a 427-sigma phantom), then apply both gates.
 *
 * The only difference is the `daily` CTE's source: one filtered read of a 148k-row table where the
 * original re-derives it from 9M events every call.
 */
function detectionSql(
  metric: string,
  weeklyGrowth: number,
  window?: { from: string; to: string },
): string {
  const def = METRICS[metric]!;
  const keys = sweptDimKeys(metric);

  const floors = [`reqs >= ${SEGMENT_MIN_REQUESTS}`, "v IS NOT NULL"];
  if (def.minNumerator) floors.push(`num >= ${def.minNumerator}`);
  if (def.minDenominator) floors.push(`den >= ${def.minDenominator}`);

  return `
WITH ${weeklyGrowth} AS g,
daily AS (
  SELECT dim, val, event_date AS d,
         ${toRollupExpr(metricExpr(def))} AS v,
         ${toRollupExpr("count()")}       AS reqs,
         ${toRollupExpr(def.numerator)}   AS num,
         ${toRollupExpr(def.denominator)} AS den
  FROM ${ROLLUP_TABLES.daily}
  WHERE dim IN (${keys.map((k) => `'${k}'`).join(", ")})
    AND event_date BETWEEN '${DATASET_START}' AND '${DATASET_END}'
  GROUP BY dim, val, d
  HAVING ${floors.join(" AND ")}
)
SELECT dim, val, day, actual, baseline, pct, sigma, reqs
FROM (
  SELECT dim, val, day, actual, reqs,
    arrayReduce('median', adj) AS baseline,
    greatest(
      arrayReduce('median', arrayMap(x -> abs(x - baseline), adj)) * 1.4826,
      abs(baseline) * 0.005
    ) AS spread,
    (actual - baseline) / nullIf(baseline, 0) * 100 AS pct,
    (actual - baseline) / nullIf(spread, 0)        AS sigma
  FROM (
    SELECT c.dim AS dim, c.val AS val, toString(c.d) AS day,
           any(c.v) AS actual, any(c.reqs) AS reqs,
           arrayMap(t -> t.2 * pow(1 + g, t.1 / 7), groupArray(tuple(lag, b.v))) AS adj
    FROM daily AS c
    ARRAY JOIN [7, 14, 21, 28] AS lag
    LEFT JOIN daily AS b ON b.dim = c.dim AND b.val = c.val AND b.d = c.d - lag
    WHERE b.d != toDate(0)
    GROUP BY c.dim, c.val, c.d
    HAVING length(adj) >= ${MIN_BASELINE_POINTS}
  )
)
WHERE abs(pct) >= ${SEGMENT_MIN_PCT} AND abs(sigma) >= ${SEGMENT_MIN_SIGMA}
${window ? `  AND day BETWEEN '${window.from}' AND '${window.to}'` : ""}
ORDER BY day, abs(pct) DESC`.trim();
}

/**
 * Drop-in replacement for `scanSegments` from backend/segments.ts.
 *
 * Same signature, same return type, so `groupIntoIncidents` and `clusterWindows` consume its output
 * unchanged — the sweep gets faster and nothing downstream knows.
 */
export async function scanSegmentsRollup(
  ledger: Ledger,
  metric: string,
  weeklyGrowth: number,
  window?: { from: string; to: string },
): Promise<SegmentFiring[]> {
  return withSpan(
    "segments.scan",
    {
      "app.metric": metric,
      "app.weekly_growth": Number(weeklyGrowth.toFixed(6)),
      "app.window.from": window?.from ?? "(full history)",
      "app.window.to": window?.to ?? "(full history)",
      // On the span so a trace shows which surface answered, next to the latency it bought.
      "app.source": `rollup:daily`,
    },
    async (span) => {
      const rows = await ledger.run<Row>(detectionSql(metric, weeklyGrowth, window));
      span.setAttribute("app.segments.firings", rows.length);
      return rows.map((r) => ({
        metric,
        dimension: r.dim,
        value: r.val,
        day: r.day,
        actual: Number(r.actual),
        baseline: Number(r.baseline),
        pct: Number(r.pct),
        sigma: Number(r.sigma),
        requests: Number(r.reqs),
      }));
    },
  );
}
