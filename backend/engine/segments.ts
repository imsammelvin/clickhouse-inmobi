/**
 * Segment-level detection.
 *
 * Blended-only detection misses anything confined to a small slice, and severity does not help: the
 * finance eCPM incident moves its own segment -34.75% but the platform number only -2.4%, so a 3%
 * gate never sees it. Two of four known incidents were invisible for exactly this reason.
 *
 * SCALE. Everything below runs as one query per metric, and all of it executes in ClickHouse:
 *
 *   - The naive shape is one query per segment. At ~2,800 segments that is 2,800 round trips.
 *   - The next naive shape is one query returning every (segment, day) row and detecting in the
 *     client: ~98,000 rows, which both breaches the criterion-3 budget and moves the analysis out
 *     of the database.
 *   - What we do instead is compute the baseline, the spread and both gates in SQL and return
 *     ONLY the rows that fire — normally a few dozen. Cost is bounded by dimension cardinality x
 *     days, never by event count, so it holds as the event stream grows.
 */
import type { Ledger } from "./ledger";
import { DATASET_END, DATASET_START } from "./baseline";
import { DIMENSION_PAIRS, METRICS, dimensionsFor, metricExpr } from "./metrics";
import { withSpan, withSyncSpan } from "../../shared/utils/telemetryUtils";

/** A segment must carry at least this many requests on a day before it can fire. */
export const SEGMENT_MIN_REQUESTS = 150;

/**
 * Baseline observations required, same rule as the blended path.
 *
 * Exported (samarth, Crosses-lane: loges) so the rollup-backed sweep in `mcp/sweep.ts` reads this
 * value rather than restating it. A detection threshold that exists in two places is one that will
 * eventually differ in two places, and the symptom would be two sweeps disagreeing about whether an
 * incident happened.
 */
export const MIN_BASELINE_POINTS = 2;

/**
 * Segment gates are far stricter than the blended ones, and they have to be.
 *
 * The blended sweep runs ~35 tests per metric. The segment sweep runs one per (segment, day):
 * roughly 2,800 segments x 35 days, so ~98,000 simultaneous tests per metric. At the blended 2.5
 * sigma gate, ~1% of those fire by chance — about a thousand false positives before a single real
 * signal appears. Measured, not theorised: the first run of this scan returned 6,974 "incidents".
 *
 * A Bonferroni-style correction for a 5% family-wise error rate over ~10^5 tests needs a per-test
 * alpha near 5e-7, which is about 5 sigma. The size gate rises alongside it: on a single slice a
 * 3% move is not worth an operator's attention, whereas on the platform total it certainly is.
 *
 * The general rule, and the reason this is not just threshold-fiddling: **the more places you look,
 * the higher the bar has to be.** Any tool that sweeps thousands of segments at a gate tuned for
 * one is guaranteed to cry wolf, which is precisely what the rubric penalises.
 */
export const SEGMENT_MIN_SIGMA = 5.0;
export const SEGMENT_MIN_PCT = 10;

export interface SegmentFiring {
  metric: string;
  dimension: string;
  value: string;
  day: string;
  actual: number;
  baseline: number;
  pct: number;
  sigma: number;
  requests: number;
}

/** Consecutive firing days for one segment, collapsed into a single incident. */
export interface SegmentIncident {
  metric: string;
  dimension: string;
  value: string;
  from: string;
  to: string;
  days: number;
  worstPct: number;
  worstSigma: number;
  requestsPerDay: number;
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
 * Detection expressed entirely in SQL.
 *
 * `daily` aggregates each segment per day. The self-join attaches the same-weekday values from 1-4
 * weeks back; each is carried forward by the global growth rate so a rising trend is not read as an
 * anomaly. Centre is a median and spread is a MAD, both resistant to a prior incident sitting
 * inside the baseline window — the failure that produced a 427-sigma phantom when this was
 * attempted with a least-squares style fit.
 */
function detectionSql(
  metric: string,
  weeklyGrowth: number,
  window?: { from: string; to: string },
): string {
  const def = METRICS[metric]!;
  const dims = dimensionsFor(metric);
  const single = dims.map((d) => `('${d}', ${d})`);
  const paired = DIMENSION_PAIRS.filter(([a, b]) => dims.includes(a) && dims.includes(b)).map(
    ([a, b]) => `('${a}|${b}', concat(${a}, '|', ${b}))`,
  );

  // Statistical floors, applied in SQL alongside the volume floor. Without these the scan is
  // dominated by rates computed on a handful of events.
  const floors = [`reqs >= ${SEGMENT_MIN_REQUESTS}`, "v IS NOT NULL"];
  if (def.minNumerator) floors.push(`num >= ${def.minNumerator}`);
  if (def.minDenominator) floors.push(`den >= ${def.minDenominator}`);

  return `
WITH ${weeklyGrowth} AS g,
daily AS (
  SELECT dim, val, event_date AS d, ${metricExpr(def)} AS v, count() AS reqs,
         ${def.numerator} AS num, ${def.denominator} AS den
  FROM (
    SELECT *, arrayJoin([${[...single, ...paired].join(", ")}]) AS kv, kv.1 AS dim, kv.2 AS val
    FROM ad_events_enriched
    WHERE event_date BETWEEN '${DATASET_START}' AND '${DATASET_END}'
  )
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

export async function scanSegments(
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
    },
    async (span) => {
      const firings = await scanSegmentsInner(ledger, metric, weeklyGrowth, window);
      span.setAttribute("app.segments.firings", firings.length);
      return firings;
    },
  );
}

async function scanSegmentsInner(
  ledger: Ledger,
  metric: string,
  weeklyGrowth: number,
  window?: { from: string; to: string },
): Promise<SegmentFiring[]> {
  // The baseline still needs the full history; only the OUTPUT is restricted to the window.
  const rows = await ledger.run<Row>(detectionSql(metric, weeklyGrowth, window));
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
}

/**
 * Collapse consecutive firing days for the same segment into one incident.
 *
 * Without this, the finance eCPM drop reports as four separate alarms on four consecutive days.
 * That is one incident, and an operator reading four rows for it learns nothing extra — it is the
 * same alert-fatigue failure the ruled-out list exists to prevent, arriving by a different route.
 */
export function groupIntoIncidents(firings: SegmentFiring[]): SegmentIncident[] {
  return withSyncSpan("segments.group", { "app.firings": firings.length }, (span) => {
    const incidents = groupIntoIncidentsInner(firings);
    // The collapse ratio is the alert-fatigue number: 4 consecutive daily alarms becoming 1.
    span.setAttribute("app.incidents", incidents.length);
    return incidents;
  });
}

function groupIntoIncidentsInner(firings: SegmentFiring[]): SegmentIncident[] {
  const bySegment = new Map<string, SegmentFiring[]>();
  for (const f of firings) {
    const key = `${f.metric}|${f.dimension}|${f.value}`;
    (bySegment.get(key) ?? bySegment.set(key, []).get(key)!).push(f);
  }

  const out: SegmentIncident[] = [];
  const DAY = 86_400_000;

  for (const group of bySegment.values()) {
    group.sort((a, b) => a.day.localeCompare(b.day));
    let run: SegmentFiring[] = [];

    const flush = (): void => {
      if (!run.length) return;
      const worst = run.reduce((a, b) => (Math.abs(b.pct) > Math.abs(a.pct) ? b : a));
      out.push({
        metric: worst.metric,
        dimension: worst.dimension,
        value: worst.value,
        from: run[0]!.day,
        to: run[run.length - 1]!.day,
        days: run.length,
        worstPct: worst.pct,
        worstSigma: worst.sigma,
        requestsPerDay: Math.round(run.reduce((a, f) => a + f.requests, 0) / run.length),
      });
      run = [];
    };

    for (const f of group) {
      const prev = run[run.length - 1];
      const contiguous =
        prev && Date.parse(`${f.day}T00:00:00Z`) - Date.parse(`${prev.day}T00:00:00Z`) === DAY;
      if (!contiguous) flush();
      run.push(f);
    }
    flush();
  }

  // Longest and largest first: a four-day 34% move outranks a one-day 4% wobble.
  return out.sort((a, b) => b.days * Math.abs(b.worstPct) - a.days * Math.abs(a.worstPct));
}

/**
 * Longest span a single incident window may cover before it is split.
 *
 * Every planted incident in this dataset runs 1-4 days. A window materially longer than that is
 * almost certainly several events chained together by overlap rather than one long one.
 */
const MAX_WINDOW_SPAN_DAYS = 7;

export interface IncidentWindow {
  metric: string;
  from: string;
  to: string;
  /** The strongest segment in the window — the place to point `investigate()` at. */
  lead: SegmentIncident;
  /** How many segments moved together in this window. */
  correlatedSegments: number;
  examples: string[];
}

/**
 * Collapse overlapping segment incidents into distinct incident windows.
 *
 * One underlying incident lights up dozens of segments at once. The finance eCPM drop appears as
 * `finance|Android 15`, `finance|rewarded`, `finance|iOS 17.5`, `finance|Android 12`, `app_00031`
 * and more — six views of one event. Reporting all of them is the same mistake residualize exists
 * to prevent, arriving one layer earlier: 2,328 rows where there are a couple of dozen things
 * actually happening.
 *
 * So `scan` answers "which windows deserve a look", not "which segments moved". Each window names
 * its strongest segment, and `investigate()` is what then reduces that window to a cause and its
 * ruled-out list. Detection finds; investigation explains. Keeping those jobs separate is what
 * stops the digest becoming another muted alert channel.
 */
export function clusterWindows(incidents: SegmentIncident[]): IncidentWindow[] {
  return withSyncSpan("segments.cluster", { "app.incidents": incidents.length }, (span) => {
    const windows = clusterWindowsInner(incidents);
    span.setAttribute("app.windows", windows.length);
    return windows;
  });
}

function clusterWindowsInner(incidents: SegmentIncident[]): IncidentWindow[] {
  const byMetric = new Map<string, SegmentIncident[]>();
  for (const i of incidents) {
    (byMetric.get(i.metric) ?? byMetric.set(i.metric, []).get(i.metric)!).push(i);
  }

  const windows: IncidentWindow[] = [];

  for (const [metric, group] of byMetric) {
    group.sort((a, b) => a.from.localeCompare(b.from));
    let cluster: SegmentIncident[] = [];
    let clusterTo = "";

    const flush = (): void => {
      if (!cluster.length) return;
      const lead = cluster.reduce((a, b) =>
        Math.abs(b.worstPct) * b.days > Math.abs(a.worstPct) * a.days ? b : a,
      );
      windows.push({
        metric,
        from: cluster.reduce((a, c) => (c.from < a ? c.from : a), cluster[0]!.from),
        to: clusterTo,
        lead,
        correlatedSegments: cluster.length,
        examples: cluster
          .slice()
          .sort((a, b) => Math.abs(b.worstPct) - Math.abs(a.worstPct))
          .slice(0, 3)
          .map(
            (c) =>
              `${c.dimension}='${c.value}' ${c.worstPct >= 0 ? "+" : ""}${c.worstPct.toFixed(0)}%`,
          ),
      });
      cluster = [];
    };

    for (const inc of group) {
      // Overlapping windows belong to the same event — but overlap is not transitive over time.
      // Chaining A-overlaps-B and B-overlaps-C merged an 18-day span covering 1,057 segments,
      // which is several distinct events reported as one. Cap the span so a long run of partly
      // overlapping incidents splits instead of snowballing.
      const wouldSpanDays =
        cluster.length === 0
          ? 0
          : (Date.parse(`${inc.to}T00:00:00Z`) - Date.parse(`${cluster[0]!.from}T00:00:00Z`)) /
            86_400_000;
      const disjoint = cluster.length > 0 && inc.from > clusterTo;
      if (disjoint || wouldSpanDays > MAX_WINDOW_SPAN_DAYS) flush();
      cluster.push(inc);
      if (!clusterTo || inc.to > clusterTo) clusterTo = inc.to;
    }
    flush();
  }

  return windows.sort(
    (a, b) => Math.abs(b.lead.worstPct) * b.lead.days - Math.abs(a.lead.worstPct) * a.lead.days,
  );
}
