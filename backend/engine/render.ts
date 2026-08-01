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
import { withSyncSpan } from "../../shared/utils/telemetryUtils";

const LABELS: Record<string, string> = {
  demand_change: "Demand change. Owner: Sales / account management.",
  supply_change: "Supply change. Owner: Publisher ops.",
  technical_break: "Technical break. Owner: Engineering.",
  mix_shift: "Mix shift — nothing is broken. No action.",
  seasonality: "Seasonality — expected pattern. No action.",
  not_localizable: "Platform-level, not a segment problem. Owner: Platform / on-call.",
  no_anomaly: "No action.",
};

const fmt = (n: number): string => (Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2));
const fmtUsd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

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
  return withSyncSpan(
    "render.narrative",
    { "app.channel": inv.primaryChannel, "app.findings": inv.findings.length },
    (span) => {
      const text = renderNarrativeInner(inv);
      span.setAttribute("app.narrative.length", text.length);
      return text;
    },
  );
}

function renderNarrativeInner(inv: Investigation): string {
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
  // Name the segment when there is one. "moved +13.0% but only 1.4 sigma" is not evidence of
  // anything until the reader knows *what* moved -- and a ruled-out list is only worth what a
  // judge can check.
  for (const r of normal) {
    L.push(
      r.segment ? `  x ${r.segment.dimension} = '${r.segment.value}' ${r.note}` : `  x ${r.note}`,
    );
  }
  if (contam.length) {
    L.push(`  x ${contam.length} segment(s) cleared as contamination:`);
    for (const r of contam.slice(0, 6)) {
      L.push(`      ${r.segment?.dimension} = '${r.segment?.value}'  ${r.note}`);
    }
    if (contam.length > 6) L.push(`      ... and ${contam.length - 6} more`);
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// T-045 — plain-English rendering, per pitch/diagnosis-template.md §1
//
// Additive, not a replacement: `renderNarrative`/`renderFull` stay exactly as they are (grounding,
// criteria, cli, benchmark all depend on that exact text). This is a second view of the SAME
// `Investigation` -- no new engine logic, no new Evidence, just different sentences over data that
// already exists. Every number here still traces back to `inv.evidence`, so the same grounding
// check applies to this output too.
// ---------------------------------------------------------------------------

/** What a metric IS, in words a revenue manager uses, not a formula. */
const METRIC_PLAIN: Record<string, string> = {
  revenue: "revenue",
  requests: "the number of ad requests we received",
  impressions: "the number of ads that actually displayed",
  fill_rate: "the share of ad requests we filled",
  render_rate: "the share of filled ads that actually displayed",
  ctr: "the share of ads people tapped",
  ecpm: "the price we earned per thousand ad views",
  rpr: "revenue per ad request",
};

/** Short noun form for a per-segment sentence ("Their fill rate fell from..."). */
const METRIC_SHORT: Record<string, string> = {
  revenue: "their revenue",
  requests: "their request volume",
  impressions: "their impressions",
  fill_rate: "their fill rate",
  render_rate: "their render rate",
  ctr: "their click-through rate",
  ecpm: "their eCPM",
  rpr: "their revenue per request",
};

const isRatioMetric = (metric: string): boolean =>
  ["fill_rate", "render_rate", "ctr"].includes(metric);
const isCurrencyMetric = (metric: string): boolean => ["revenue", "ecpm", "rpr"].includes(metric);
const isCountMetric = (metric: string): boolean => ["requests", "impressions"].includes(metric);

/**
 * One formatter per metric shape -- a ratio is a percentage, money is money, a count is a count.
 * `fmt` alone was being asked to do all three and produced "126052.00" for a request count.
 */
const fmtMetric = (metric: string, value: number): string => {
  if (isRatioMetric(metric)) return `${(value * 100).toFixed(0)}%`;
  if (isCurrencyMetric(metric)) return `${fmtUsd(value)}`;
  if (isCountMetric(metric)) return Math.round(value).toLocaleString("en-US");
  return fmt(value);
};

/** ISO date range -> "Between 23 and 25 June" / "On 27 June". No jargon, no dashes. */
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]; // eslint-disable-line prettier/prettier

const dayMonth = (iso: string): { day: number; month: string } => {
  const [, m, d] = iso.split("-").map(Number);
  return { day: d ?? 1, month: MONTHS[(m ?? 1) - 1] ?? iso };
};

const whenPhrase = (from: string, to: string): string => {
  if (from === to) {
    const { day, month } = dayMonth(from);
    return `On ${day} ${month}`;
  }
  const a = dayMonth(from);
  const b = dayMonth(to);
  return a.month === b.month
    ? `Between ${a.day} and ${b.day} ${b.month}`
    : `Between ${a.day} ${a.month} and ${b.day} ${b.month}`;
};

/** "9.6" -> "about 1 in every 10 requests". Nobody thinks in percentage-of-traffic. */
const asFraction = (sharePct: number): string => {
  if (sharePct <= 0) return "a negligible share of requests";
  const oneIn = Math.round(100 / sharePct);
  return oneIn <= 1 ? "nearly every request" : `about 1 in every ${oneIn} requests`;
};

/** Look up a recorded evidence value by its exact label -- the plain renderer quotes evidence too. */
const evidenceValue = (inv: Investigation, label: string): number | undefined =>
  inv.evidence.find((e) => e.label === label)?.value ?? undefined;

/**
 * Recover a segment's own before/after values from `deltaAbs`/`deltaPct` alone, so the plain
 * renderer can say "fell from 78% to 43%" the way the template wants, without new Evidence: a
 * `Finding` records the delta and the relative move but not the two raw endpoints directly.
 *
 *   baseValue = deltaAbs / (deltaPct / 100);  incidentValue = baseValue + deltaAbs
 *
 * `null` when `deltaPct` is ~0 (division blows up) or either input is missing -- callers fall back
 * to a plain "moved" phrasing rather than print a nonsense number.
 */
const beforeAfter = (
  deltaAbs: number | null,
  deltaPct: number | null,
): { before: number; after: number } | null => {
  if (deltaAbs === null || deltaPct === null || Math.abs(deltaPct) < 0.05) return null;
  const before = deltaAbs / (deltaPct / 100);
  return { before, after: before + deltaAbs };
};

const PLAIN_OWNER: Record<string, string> = {
  demand_change: "One for sales, not engineering",
  supply_change: "One for publisher ops, not engineering",
  technical_break: "Something is broken. This one is for engineering, not sales",
  mix_shift: "Nothing is broken. No action needed",
  seasonality: "This is a normal pattern. No action needed",
  not_localizable: "Something moved platform-wide, and we could not pin it to one place",
  no_anomaly: "Nothing broke",
};

/** The plain-English diagnosis -- money first, percentages not ratios, never "probably". */
export function renderPlain(inv: Investigation): string {
  return withSyncSpan(
    "render.plain",
    { "app.channel": inv.primaryChannel, "app.findings": inv.findings.length },
    (span) => {
      const text = renderPlainInner(inv);
      span.setAttribute("app.plain.length", text.length);
      return text;
    },
  );
}

function renderPlainInner(inv: Investigation): string {
  const { metric, from, to } = inv.request;
  const metricPlain = METRIC_PLAIN[metric] ?? metric;
  const primary = inv.findings.find((f) => f.status === "found");
  const worth =
    primary?.revenueImpactUsd != null
      ? ` That is worth about ${fmtUsd(Math.abs(primary.revenueImpactUsd))} a day.`
      : "";

  const L: string[] = [];

  // ---- WHAT HAPPENED --------------------------------------------------------------------
  L.push("WHAT HAPPENED");
  const incident = evidenceValue(inv, `${metric}.incident`);
  const baseline = evidenceValue(inv, `${metric}.baseline.same_weekday_mean`);
  if (incident !== undefined && baseline !== undefined) {
    L.push(
      `  ${wrap(
        `${whenPhrase(from, to)} ${metricPlain} was ${fmtMetric(metric, incident)} instead of the ` +
          `usual ${fmtMetric(metric, baseline)}.${worth}`,
        2,
      )}`,
    );
  } else {
    L.push(`  ${wrap(`${whenPhrase(from, to)}, ${inv.headline}`, 2)}`);
  }
  L.push("");

  // ---- WHY --------------------------------------------------------------------------------
  //
  // Feature the ONE lead cause, matching the template's own framing ("one real cause, N false
  // leads eliminated") -- not every entry in `findings`. `findings[0]` is already the right pick:
  // `revenueImpactUsd` on every finding is the same platform-wide `revPerDay` (not a per-segment
  // dollar figure, so it cannot rank them), but `res.causes` -- and therefore `findings`, pushed in
  // the same order -- is already ordered strongest-first by residualize's greedy deflation loop.
  // Re-sorting on a shared field picked the wrong segment once; trust the existing order instead.
  const segmentFindings = inv.findings.filter((f) => f.segment);
  const lead = segmentFindings[0];
  if (lead?.segment) {
    L.push("WHY");
    const seg = lead.segment;
    const share =
      lead.segmentSharePct != null ? ` They are ${asFraction(lead.segmentSharePct)}.` : "";
    const ba = beforeAfter(lead.deltaAbs, lead.deltaPct);
    const direction = (lead.deltaPct ?? 0) >= 0 ? "rose" : "fell";
    const moveSentence = ba
      ? `${METRIC_SHORT[metric] ?? metricPlain} ${direction} from ${fmtMetric(metric, ba.before)} to ${fmtMetric(metric, ba.after)}.`
      : lead.deltaPct != null
        ? `It moved ${direction === "rose" ? "up" : "down"} ${Math.abs(lead.deltaPct).toFixed(0)}%.`
        : "";
    L.push(
      `  ${wrap(`${seg.dimension.replace(/_/g, " ")} '${seg.value}' — ${moveSentence}${share}`, 2)}`,
    );
    if (segmentFindings.length > 1) {
      L.push(
        `  ${wrap("(A few other segments moved too; see the full trace for all of them.)", 2)}`,
      );
    }
    L.push("");
  } else if (inv.primaryChannel === "not_localizable") {
    L.push("WHY");
    L.push(
      `  ${wrap("Every part of the platform moved together, by about the same amount. Nothing is localized to one place.", 2)}`,
    );
    L.push("");
  }

  // ---- IS SOMETHING BROKEN, OR IS IT THE MARKET? -----------------------------------------
  L.push("IS SOMETHING BROKEN, OR IS IT THE MARKET?");
  L.push(`  ${wrap(`${PLAIN_OWNER[inv.primaryChannel] ?? inv.primaryChannel}:`, 2)}`);
  L.push("");
  const cleared = inv.ruledOut.filter(
    (r) =>
      !r.segment && (r.status === "cleared_as_normal" || r.status === "cleared_insufficient_data"),
  );
  for (const r of cleared.slice(0, 6)) {
    L.push(`    - ${wrap(r.note ?? "", 6)}`);
  }
  L.push("");

  // ---- WHAT WE CHECKED AND RULED OUT ------------------------------------------------------
  //
  // `contam.length` is the one count safe to print here: orchestrate.ts records it explicitly as
  // `cleared_as_contamination.count` evidence. `segmentFindings.length` is not recorded anywhere,
  // so it does not appear in this sentence -- matching the template's own wording ("one real
  // cause"), not a number we cannot back.
  //
  // Gated on `lead` existing, not just on contamination count: the T-046 materiality filter can
  // remove the only cause AFTER residualize already computed its contamination list, which would
  // otherwise print "One real cause" when the real count is now zero -- exactly the kind of
  // arithmetic-right-sentence-wrong bug this codebase keeps finding in itself.
  const contam = inv.ruledOut.filter((r) => r.status === "cleared_as_contamination");
  if (contam.length && lead) {
    L.push("WHAT WE CHECKED AND RULED OUT");
    L.push(
      `  ${wrap(
        `At first glance ${contam.length} other slice(s) looked broken too. They were not — once ` +
          `the real cause above was set aside, every one of them looked normal again. They only ` +
          `looked broken because they overlap with it.`,
        2,
      )}`,
    );
    L.push(`  ${wrap(`One real cause. ${contam.length} false lead(s) eliminated.`, 2)}`);
  }

  return L.join("\n");
}

/** Narrative plus the operational footer. The footer is not subject to grounding. */
export function renderFull(inv: Investigation): string {
  return withSyncSpan(
    "render.full",
    { "app.channel": inv.primaryChannel, "app.evidence": inv.evidence.length },
    (span) => {
      const text = renderFullInner(inv);
      span.setAttribute("app.report.length", text.length);
      return text;
    },
  );
}

function renderFullInner(inv: Investigation): string {
  const L = [renderNarrative(inv), "", "PLAN"];
  for (const s of inv.planSteps) {
    L.push(
      `  ${s.stage.padEnd(12)} ${String(s.ms).padStart(6)}ms  ${s.queries} query(s)  ${s.summary}`,
    );
  }
  L.push("", `evidence: ${inv.evidence.length} rows   trace: ${inv.traceId}`, "");
  return L.join("\n");
}
