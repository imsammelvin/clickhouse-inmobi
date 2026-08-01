/**
 * Self-test for detection accuracy.
 *
 * Replays Stage 0 across every day in the dataset for every metric and prints what would have
 * fired. This is the closest thing we have to the private answer key: the training incidents are
 * known (pitch/incident-dossier.md), so anything we miss here we would also miss on the unseen set,
 * and anything extra that fires is a false alarm.
 *
 *   bun run backend/scan.ts
 *   bun run backend/scan.ts --metric fill_rate
 *
 * One query per metric, not one per day: the whole daily series is fetched once and the detection
 * rule is evaluated in TypeScript against it.
 */
import { Ledger } from "./ledger";
import { METRICS, metricExpr } from "./metrics";
import {
  MIN_BASELINE_DAYS,
  estimateWeeklyGrowth,
  trendAwareBaseline,
  DATASET_START,
  DATASET_END,
  datesBetween,
} from "./baseline";
import { MIN_ABS_PCT, MIN_SIGMA } from "./stages/detect";
import { log } from "../utils/telemetryUtils";
import { type IncidentWindow, clusterWindows, groupIntoIncidents, scanSegments } from "./segments";

/**
 * Incidents we located by hand (pitch/incident-dossier.md). This is NOT the answer key — it is our
 * own homework, so recall against it is a floor, not a score. The private key may contain planted
 * anomalies we never spotted, which would make real recall lower than this reports, never higher.
 */
export const KNOWN_INCIDENTS: Array<{ dates: string[]; metric: string; label: string }> = [
  {
    dates: ["2026-06-23", "2026-06-24", "2026-06-25"],
    metric: "fill_rate",
    label: "A Android 15 fill collapse",
  },
  { dates: ["2026-06-21"], metric: "requests", label: "B global volume collapse" },
  {
    dates: ["2026-06-19", "2026-06-20", "2026-06-21", "2026-06-22"],
    metric: "ecpm",
    label: "C finance eCPM",
  },
  {
    dates: ["2026-06-28", "2026-06-29", "2026-06-30"],
    metric: "fill_rate",
    label: "D mild fill dip",
  },
];

interface Row {
  d: string;
  v: number | null;
}

async function seriesFor(ledger: Ledger, metric: string): Promise<Map<string, number>> {
  const def = METRICS[metric]!;
  const sql = `
SELECT toString(event_date) AS d, ${metricExpr(def)} AS v
FROM ad_events_enriched
WHERE event_date BETWEEN '${DATASET_START}' AND '${DATASET_END}'
GROUP BY event_date ORDER BY event_date`.trim();
  const rows = await ledger.run<Row>(sql);
  return new Map(rows.map((r) => [r.d, Number(r.v ?? 0)]));
}

function evaluate(
  series: Map<string, number>,
  day: string,
  weeklyGrowth: number,
): { pct: number; sigma: number; fired: boolean; n: number } {
  const t = Date.parse(`${day}T00:00:00Z`);
  const base: Array<{ weeksAgo: number; value: number }> = [];
  for (let k = 1; k <= 4; k++) {
    const prior = new Date(t - k * 7 * 86_400_000).toISOString().slice(0, 10);
    const v = series.get(prior);
    if (v !== undefined) base.push({ weeksAgo: k, value: v });
  }
  const actual = series.get(day);
  if (actual === undefined || base.length < MIN_BASELINE_DAYS) {
    return { pct: 0, sigma: 0, fired: false, n: base.length };
  }
  const { centre, spread } = trendAwareBaseline(base, weeklyGrowth);
  const pct = centre === 0 ? 0 : ((actual - centre) / centre) * 100;
  const sigma = spread === 0 ? 0 : (actual - centre) / spread;
  return {
    pct,
    sigma,
    fired: Math.abs(pct) >= MIN_ABS_PCT && Math.abs(sigma) >= MIN_SIGMA,
    n: base.length,
  };
}

export interface Firing {
  metric: string;
  day: string;
  pct: number;
  sigma: number;
}

export interface ScanResult {
  fired: Firing[];
  found: string[];
  missed: string[];
  /** Fired but not attributable to a known incident — hallucination risk until triaged. */
  extra: Firing[];
  /** Distinct incident windows found below the platform number. One per event, not per segment. */
  segments: IncidentWindow[];
}

export const DEFAULT_METRICS = ["revenue", "requests", "fill_rate", "ecpm", "ctr"];

export async function scanAll(metrics: string[] = DEFAULT_METRICS): Promise<ScanResult> {
  const ledger = new Ledger();
  const fired: Firing[] = [];
  const segmentFirings = [];
  try {
    for (const metric of metrics) {
      const series = await seriesFor(ledger, metric);
      // Estimated once per metric from the full series, then applied to every day.
      const weeklyGrowth = estimateWeeklyGrowth(series);
      for (const day of datesBetween(DATASET_START, DATASET_END)) {
        const r = evaluate(series, day, weeklyGrowth);
        if (r.fired) fired.push({ metric, day, pct: r.pct, sigma: r.sigma });
      }
      // One extra query per metric, all detection server-side, only firings returned.
      segmentFirings.push(...(await scanSegments(ledger, metric, weeklyGrowth)));
    }
  } finally {
    await ledger.close();
  }
  const segments = clusterWindows(groupIntoIncidents(segmentFirings));

  const found: string[] = [];
  const missed: string[] = [];
  for (const k of KNOWN_INCIDENTS) {
    // Found if EITHER the blended sweep or the segment sweep saw it. Segment detection is the
    // whole point: two of these four are invisible in the platform-level number.
    const blended = fired.some((f) => f.metric === k.metric && k.dates.includes(f.day));
    const segment = segmentFirings.some((f) => f.metric === k.metric && k.dates.includes(f.day));
    (blended || segment ? found : missed).push(
      `${k.label}  (${k.metric}${!blended && segment ? ", segment-level only" : ""})`,
    );
  }

  // Attribution is by DATE, not by (metric, date).
  //
  // One incident shows up in several metrics at once - the Jun 21 collapse fires on requests AND
  // on revenue, and the Android 15 break drags CTR along with fill rate. Matching metric-exactly
  // counted those echoes as unexplained and inflated "hallucination risk" from 6 to 19, which
  // overstates the problem: an operator seeing two rows for one real incident has a grouping
  // annoyance, not a false alarm. What actually deserves the label is a firing on a date where
  // nothing is known to have happened.
  const knownDates = new Set(KNOWN_INCIDENTS.flatMap((k) => k.dates));
  const extra = fired.filter((f) => !knownDates.has(f.day));

  return {
    fired: fired.sort((a, b) => a.day.localeCompare(b.day)),
    found,
    missed,
    extra,
    segments,
  };
}

async function main(): Promise<void> {
  const only = process.argv.indexOf("--metric");
  const metrics = only >= 0 ? [process.argv[only + 1]!] : DEFAULT_METRICS;
  const { fired, found, missed, extra, segments } = await scanAll(metrics);
  {
    log.info(`\nFIRED (${fired.length})`);
    for (const f of fired) {
      log.info(
        `  ${f.day}  ${f.metric.padEnd(10)} ${f.pct >= 0 ? "+" : ""}${f.pct.toFixed(1)}%  ${f.sigma.toFixed(1)} sigma`,
      );
    }

    log.info(`\nAGAINST KNOWN INCIDENTS`, {
      "scan.fired": fired.length,
      "scan.found": found.length,
      "scan.missed": missed.length,
      "scan.untriaged": extra.length,
      "scan.known_total": KNOWN_INCIDENTS.length,
    });
    for (const f of found) log.info(`  FOUND   ${f}`);
    for (const m of missed) log.info(`  MISSED  ${m}`);

    log.info(`\nNOT IN THE KNOWN LIST (${extra.length}) — undiscovered incidents or false alarms`);
    for (const f of extra.slice(0, 20)) {
      log.info(
        `  ${f.day}  ${f.metric.padEnd(10)} ${f.pct >= 0 ? "+" : ""}${f.pct.toFixed(1)}%  ${f.sigma.toFixed(1)} sigma`,
      );
    }
    log.info(`\nINCIDENT WINDOWS BELOW THE PLATFORM NUMBER (${segments.length})`, {
      "scan.segment_windows": segments.length,
    });
    for (const w of segments.slice(0, 12)) {
      const span = w.from === w.to ? w.from : `${w.from}..${w.to}`;
      log.info(
        `  ${span.padEnd(24)} ${w.metric.padEnd(9)} ${w.lead.dimension}='${w.lead.value}' ` +
          `${w.lead.worstPct >= 0 ? "+" : ""}${w.lead.worstPct.toFixed(0)}%  ` +
          `(+${w.correlatedSegments - 1} correlated)`,
      );
    }
    if (segments.length > 12) log.info(`  ... and ${segments.length - 12} more`);
    log.info("");
  }
}

if (import.meta.main)
  main().catch((e) => {
    log.error(String(e));
    process.exit(1);
  });
