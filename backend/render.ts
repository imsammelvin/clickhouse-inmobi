/**
 * Human-readable rendering of an Investigation.
 *
 * Deliberately separate from the CLI so the grounding check (criterion 2) can verify the exact text
 * a user sees. Checking a different string than the one we print would prove nothing.
 *
 * This is the deterministic renderer. When the LLM narrator lands (T-019) it produces prose from
 * the same `Investigation`, and the same grounding check applies to its output.
 */
import type { Investigation } from "./types";

const LABELS: Record<string, string> = {
  demand_change: "Demand change. Owner: Sales / account management.",
  supply_change: "Supply change. Owner: Publisher ops.",
  technical_break: "Technical break. Owner: Engineering.",
  mix_shift: "Mix shift — nothing is broken. No action.",
  seasonality: "Seasonality — expected pattern. No action.",
  not_localizable: "Platform-level, not a segment problem. Owner: Platform / on-call.",
  no_anomaly: "No action.",
};

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

/** The diagnosis itself — the text whose every numeral must be grounded. */
export function renderNarrative(inv: Investigation): string {
  const L: string[] = [];
  L.push(inv.headline, "");

  L.push("SO WHAT");
  L.push(`  ${LABELS[inv.primaryChannel] ?? inv.primaryChannel}`);
  const primary = inv.findings[0];
  if (primary?.note) L.push(`  ${wrap(primary.note, 2)}`);
  L.push("");

  if (inv.findings.some((f) => f.segment)) {
    L.push("WHERE");
    for (const f of inv.findings) {
      if (!f.segment) continue;
      const delta = f.deltaPp !== null ? `${f.deltaPp.toFixed(2)}pp` : `${f.deltaPct?.toFixed(1)}%`;
      const share =
        f.segmentSharePct !== null && f.segmentSharePct !== undefined
          ? ` on ${f.segmentSharePct.toFixed(1)}% of traffic`
          : "";
      L.push(`  ${f.segment.dimension} = '${f.segment.value}'  ${delta}${share}`);
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
  return L.join("\n");
}

/** Narrative plus the operational footer. The footer is not subject to grounding. */
export function renderFull(inv: Investigation): string {
  const L = [renderNarrative(inv), "", "PLAN"];
  for (const s of inv.planSteps) {
    L.push(
      `  ${s.stage.padEnd(12)} ${String(s.ms).padStart(6)}ms  ${s.queries} query(s)  ${s.summary}`,
    );
  }
  L.push("", `evidence: ${inv.evidence.length} rows   trace: ${inv.traceId}`, "");
  return L.join("\n");
}
