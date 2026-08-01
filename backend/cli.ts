/**
 * CLI entry point.
 *
 *   bun run backend/cli.ts --metric fill_rate --from 2026-06-23 --to 2026-06-25
 *   bun run backend/cli.ts --metric revenue   --from 2026-06-21 --json
 */
import { Ledger } from "./ledger";
import { investigate } from "./orchestrate";
import type { Investigation } from "./types";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

function render(inv: Investigation): string {
  const L: string[] = [];
  L.push("");
  L.push(inv.headline);
  L.push("");

  L.push("SO WHAT");
  const primary = inv.findings[0];
  L.push(`  ${label(inv.primaryChannel)}`);
  if (primary?.note) L.push(`  ${wrap(primary.note, 2)}`);
  L.push("");

  if (inv.findings.some((f) => f.segment)) {
    L.push("WHERE");
    for (const f of inv.findings) {
      if (!f.segment) continue;
      L.push(
        `  ${f.segment.dimension} = '${f.segment.value}'  ` +
          `${f.deltaPp !== null ? `${f.deltaPp.toFixed(2)}pp` : `${f.deltaPct?.toFixed(1)}%`}` +
          `${f.segmentSharePct !== null && f.segmentSharePct !== undefined ? ` on ${f.segmentSharePct.toFixed(1)}% of traffic` : ""}`,
      );
    }
    L.push("");
  }

  const contam = inv.ruledOut.filter((r) => r.status === "cleared_as_contamination");
  const normal = inv.ruledOut.filter((r) => r.status !== "cleared_as_contamination");

  L.push("RULED OUT");
  for (const r of normal) L.push(`  x ${r.note}`);
  if (contam.length) {
    L.push(`  x ${contam.length} segment(s) cleared as contamination:`);
    for (const r of contam.slice(0, 6)) {
      L.push(`      ${r.segment?.dimension} = '${r.segment?.value}'  ${r.note}`);
    }
    if (contam.length > 6) L.push(`      ... and ${contam.length - 6} more`);
  }
  L.push("");

  L.push("PLAN");
  for (const s of inv.planSteps) {
    L.push(`  ${s.stage.padEnd(12)} ${String(s.ms).padStart(6)}ms  ${s.queries} query(s)  ${s.summary}`);
  }
  L.push("");
  L.push(`evidence: ${inv.evidence.length} rows   trace: ${inv.traceId}`);
  L.push("");
  return L.join("\n");
}

const LABELS: Record<string, string> = {
  demand_change: "Demand change. Owner: Sales / account management.",
  supply_change: "Supply change. Owner: Publisher ops.",
  technical_break: "Technical break. Owner: Engineering.",
  mix_shift: "Mix shift — nothing is broken. No action.",
  seasonality: "Seasonality — expected pattern. No action.",
  exogenous_event: "External event. Owner: Planning.",
  not_localizable: "Platform-level, not a segment problem. Owner: Platform / on-call.",
  no_anomaly: "No action.",
};
const label = (c: string): string => LABELS[c] ?? c;

function wrap(s: string, indent: number, width = 92): string {
  const pad = " ".repeat(indent);
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else cur += ` ${w}`;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join(`\n${pad}`);
}

async function main(): Promise<void> {
  const metric = arg("metric", "revenue");
  const from = arg("from");
  const to = arg("to", from);
  const asJson = process.argv.includes("--json");

  const ledger = new Ledger();
  const started = Date.now();
  try {
    const inv = await investigate({ metric, from, to, ledger });
    if (asJson) {
      console.log(JSON.stringify(inv, null, 2));
    } else {
      console.log(render(inv));
      console.log(`total ${Date.now() - started}ms, ${ledger.totalQueries()} queries\n`);
    }
  } finally {
    await ledger.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
