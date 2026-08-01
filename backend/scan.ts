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
import { MIN_BASELINE_DAYS, robustBaseline, DATASET_START, DATASET_END, datesBetween } from "./baseline";
import { MIN_ABS_PCT, MIN_SIGMA } from "./stages/detect";

/** Known planted incidents, for scoring the scan. See pitch/incident-dossier.md. */
const KNOWN: Array<{ dates: string[]; metric: string; label: string }> = [
  { dates: ["2026-06-23", "2026-06-24", "2026-06-25"], metric: "fill_rate", label: "A Android 15 fill collapse" },
  { dates: ["2026-06-21"], metric: "requests", label: "B global volume collapse" },
  { dates: ["2026-06-19", "2026-06-20", "2026-06-21", "2026-06-22"], metric: "ecpm", label: "C finance eCPM" },
  { dates: ["2026-06-28", "2026-06-29", "2026-06-30"], metric: "fill_rate", label: "D mild fill dip" },
];

interface Row { d: string; v: number | null }

async function seriesFor(ledger: Ledger, metric: string): Promise<Map<string, number>> {
  const def = METRICS[metric]!;
  const sql = `
SELECT toString(event_date) AS d, ${metricExpr(def)} AS v
FROM ad_events_enriched
GROUP BY event_date ORDER BY event_date`.trim();
  const rows = await ledger.run<Row>(sql);
  return new Map(rows.map((r) => [r.d, Number(r.v ?? 0)]));
}

function evaluate(series: Map<string, number>, day: string): { pct: number; sigma: number; fired: boolean; n: number } {
  const t = Date.parse(`${day}T00:00:00Z`);
  const base: number[] = [];
  for (let k = 1; k <= 4; k++) {
    const prior = new Date(t - k * 7 * 86_400_000).toISOString().slice(0, 10);
    const v = series.get(prior);
    if (v !== undefined) base.push(v);
  }
  const actual = series.get(day);
  if (actual === undefined || base.length < MIN_BASELINE_DAYS) {
    return { pct: 0, sigma: 0, fired: false, n: base.length };
  }
  const { centre, spread } = robustBaseline(base);
  const pct = centre === 0 ? 0 : ((actual - centre) / centre) * 100;
  const sigma = spread === 0 ? 0 : (actual - centre) / spread;
  return { pct, sigma, fired: Math.abs(pct) >= MIN_ABS_PCT && Math.abs(sigma) >= MIN_SIGMA, n: base.length };
}

async function main(): Promise<void> {
  const only = process.argv.indexOf("--metric");
  const metrics = only >= 0 ? [process.argv[only + 1]!] : ["revenue", "requests", "fill_rate", "ecpm", "ctr"];
  const ledger = new Ledger();
  const fired: Array<{ metric: string; day: string; pct: number; sigma: number }> = [];

  try {
    for (const metric of metrics) {
      const series = await seriesFor(ledger, metric);
      for (const day of datesBetween(DATASET_START, DATASET_END)) {
        const r = evaluate(series, day);
        if (r.fired) fired.push({ metric, day, pct: r.pct, sigma: r.sigma });
      }
    }

    console.log(`\nFIRED (${fired.length})`);
    for (const f of fired.sort((a, b) => a.day.localeCompare(b.day))) {
      console.log(`  ${f.day}  ${f.metric.padEnd(10)} ${f.pct >= 0 ? "+" : ""}${f.pct.toFixed(1)}%  ${f.sigma.toFixed(1)} sigma`);
    }

    console.log(`\nAGAINST KNOWN INCIDENTS`);
    for (const k of KNOWN) {
      const hit = fired.some((f) => f.metric === k.metric && k.dates.includes(f.day));
      console.log(`  ${hit ? "FOUND " : "MISSED"}  ${k.label}  (${k.metric})`);
    }

    const knownDays = new Set(KNOWN.flatMap((k) => k.dates.map((d) => `${k.metric}|${d}`)));
    const extra = fired.filter((f) => !knownDays.has(`${f.metric}|${f.day}`));
    console.log(`\nNOT IN THE KNOWN LIST (${extra.length}) — either undiscovered incidents or false alarms`);
    for (const f of extra.slice(0, 20)) {
      console.log(`  ${f.day}  ${f.metric.padEnd(10)} ${f.pct >= 0 ? "+" : ""}${f.pct.toFixed(1)}%  ${f.sigma.toFixed(1)} sigma`);
    }
    console.log("");
  } finally {
    await ledger.close();
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
