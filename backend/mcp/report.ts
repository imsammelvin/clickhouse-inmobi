/**
 * Rendering for the unattended run: Markdown for humans, JSON for machines, one self-contained HTML
 * file for a judge.
 *
 * The HTML is the point. "No trace, no credit" means the evidence has to be openable by someone who
 * does not have our Docker stack, our ClickHouse credentials, or this repo — so it is a single file
 * with inline CSS, no scripts, no fonts, no network of any kind. What it carries is the part that is
 * hard to fake: every printed number next to the SQL that produced it and that SQL's hash, the
 * per-stage timings and query counts, the measured bytes read where `system.query_log` has flushed,
 * and the segments we checked and cleared.
 */
import type { ActionRecommendation } from "./action";
import type { CostReport } from "./cost";
import type { SessionTrace } from "./trace";
import type { Evidence } from "../engine/types";

/**
 * Channel -> what it means for a reader. Mirrors the table in backend/render.ts, which is not
 * exported; seven duplicated lines beat editing another lane's file to share them.
 */
const CHANNEL: Record<string, string> = {
  demand_change: "Demand change — Sales / account management",
  supply_change: "Supply change — Publisher ops",
  technical_break: "Technical break — Engineering",
  mix_shift: "Mix shift — nothing is broken, no action",
  seasonality: "Seasonality — expected pattern, no action",
  not_localizable: "Platform-level, not a segment problem — Platform / on-call",
  no_anomaly: "No anomaly — no action",
};

export interface DiagnosedIncident {
  rank: number;
  metric: string;
  from: string;
  to: string;
  corroboratingMetrics: string[];
  leadSegment: { dimension: string; value: string } | null;
  worstPct: number;
  sharePct: number | null;
  channel: string;
  headline: string;
  narrative: string;
  grounding: { ok: boolean; grounded: number; numeralsChecked: number };
  revenueUsdPerDay: number | null;
  ruledOutContamination: number;
  ruledOutChecks: string[];
  planSteps: Array<{ stage: string; ms: number; queries: number; summary: string }>;
  evidence: Array<Evidence & { qualifiedId: string }>;
  evidenceTotal: number;
  action: ActionRecommendation;
  callId: string;
  ms: number;
  queries: number;
  otelTraceId?: string;
}

export interface SkippedWindow {
  metric: string;
  from: string;
  to: string;
  leadSegment: { dimension: string; value: string };
  worstPct: number;
  sharePct: number | null;
  reason: string;
}

export interface Digest {
  runId: string;
  generatedAt: string;
  wallMs: number;
  dataset: { from: string; to: string; days: number; requests: number; revenueUsd: number };
  sweep: {
    metrics: string[];
    reportedWindow: { from: string; to: string };
    windowsFound: number;
    incidentsAfterJoin: number;
    investigated: number;
    gates: string;
  };
  incidents: DiagnosedIncident[];
  skipped: SkippedWindow[];
  cost: CostReport;
  trace: SessionTrace;
}

// -------------------------------------------------------------------------------------------------

const usd = (n: number | null): string =>
  n === null ? "n/a" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const int = (n: number): string => Math.round(n).toLocaleString("en-US");
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const span = (from: string, to: string): string => (from === to ? from : `${from} to ${to}`);

// -------------------------------------------------------------------------------------------------
// Markdown
// -------------------------------------------------------------------------------------------------

export function renderMarkdown(d: Digest): string {
  const L: string[] = [];
  L.push(`# Automated diagnosis — ${span(d.sweep.reportedWindow.from, d.sweep.reportedWindow.to)}`);
  L.push("");
  L.push(
    `Produced unattended by \`bun run diagnose\` in ${(d.wallMs / 1000).toFixed(1)}s. Nobody supplied ` +
      `a metric or a window: the sweep found the incidents, ranked them, and investigated the top ` +
      `${d.sweep.investigated}.`,
  );
  L.push("");
  L.push(
    `**Data:** ${span(d.dataset.from, d.dataset.to)} · ${int(d.dataset.days)} days · ` +
      `${int(d.dataset.requests)} requests · $${int(d.dataset.revenueUsd)} revenue.`,
  );
  L.push(
    `**Sweep:** ${d.sweep.metrics.join(", ")} · ${d.sweep.windowsFound} firing window(s) → ` +
      `${d.sweep.incidentsAfterJoin} distinct incident(s) after joining across metrics → ` +
      `${d.sweep.investigated} investigated.`,
  );
  L.push(`**Gates:** ${d.sweep.gates}`);
  L.push(`**Run:** \`${d.runId}\``);
  L.push("");

  if (d.incidents.length === 0) {
    L.push("## Nothing cleared the gates");
    L.push("");
    L.push(
      "No segment moved far enough, for long enough, on enough traffic to be worth an operator's " +
        "attention. That is a result, not a failure to find one.",
    );
    return `${L.join("\n")}\n`;
  }

  L.push("## Summary");
  L.push("");
  L.push("| # | Metric | Window | Cause | Channel | $/day | Status | Priority | Grounded |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const i of d.incidents) {
    const cause = i.leadSegment
      ? `\`${i.leadSegment.dimension}='${i.leadSegment.value}'\``
      : "platform-wide";
    L.push(
      `| ${i.rank} | ${i.metric} | ${span(i.from, i.to)} | ${cause} | ${i.channel} | ` +
        `${usd(i.revenueUsdPerDay)} | ${i.action.status} | ${i.action.priority} | ` +
        `${i.grounding.grounded}/${i.grounding.numeralsChecked} |`,
    );
  }
  L.push("");

  for (const i of d.incidents) {
    L.push(`## ${i.rank}. ${i.metric} — ${span(i.from, i.to)}`);
    L.push("");
    L.push(`**${CHANNEL[i.channel] ?? i.channel}**`);
    if (i.corroboratingMetrics.length) {
      L.push("");
      L.push(
        `Also visible in ${i.corroboratingMetrics.join(", ")} over the same days — one incident, ` +
          `not ${i.corroboratingMetrics.length + 1}.`,
      );
    }
    L.push("");
    L.push("```");
    L.push(i.narrative);
    L.push("```");
    L.push("");
    L.push(
      `Diagnosed in ${(i.ms / 1000).toFixed(1)}s across ${i.queries} queries. ` +
        `${i.grounding.grounded}/${i.grounding.numeralsChecked} numerals in the text above resolve to ` +
        `a recorded evidence row` +
        (i.grounding.ok
          ? "."
          : " — **this answer failed the grounding check and must not be quoted.**"),
    );
    L.push("");
    L.push("### What to do");
    L.push("");
    L.push(`**${i.action.priority.replace(/_/g, " ")}** — ${i.action.priorityBasis}`);
    L.push("");
    L.push(`- **Status:** ${i.action.statusDetail}`);
    L.push(`- **Owner:** ${i.action.owner}`);
    if (i.action.lostSoFarUsd !== null) {
      L.push(
        `- **Cost:** ${usd(i.action.moneyUsdPerDay)}/day over ${i.action.daysRunning} day(s) = ` +
          `${usd(i.action.lostSoFarUsd)}; ${usd(i.action.recoverableUsdPerDay)}/day recoverable now.`,
      );
    }
    for (const l of i.action.whereToLook) L.push(`- ${l}`);
    if (i.action.doNotChase.length) {
      L.push(
        `- **Do not chase:** ${i.action.doNotChase.length} slice(s) look affected and are not.`,
      );
    }
    if (i.action.nextQuestion) L.push(`- **Next question:** ${i.action.nextQuestion}`);
    L.push("");
    L.push(`_${i.action.boundary}_`);
    L.push("");
    L.push(`### Receipts (${i.evidence.length} of ${i.evidenceTotal} rows)`);
    L.push("");
    L.push("| Evidence | Value | Unit | SQL hash |");
    L.push("| --- | --- | --- | --- |");
    for (const e of i.evidence) {
      L.push(
        `| \`${e.qualifiedId}\` ${e.label} | ${e.value === null ? "null" : e.value} | ${e.unit} | \`${e.sqlHash}\` |`,
      );
    }
    L.push("");
    L.push("### Plan");
    L.push("");
    L.push("| Stage | ms | Queries | Result |");
    L.push("| --- | --- | --- | --- |");
    for (const s of i.planSteps) L.push(`| ${s.stage} | ${s.ms} | ${s.queries} | ${s.summary} |`);
    L.push("");
  }

  if (d.skipped.length) {
    L.push("## Seen and not escalated");
    L.push("");
    L.push(
      "These fired the detector but were not worth an investigation. Listed rather than dropped, so " +
        "the digest cannot be accused of hiding what it saw.",
    );
    L.push("");
    L.push("| Metric | Window | Segment | Move | Traffic | Why not escalated |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const s of d.skipped) {
      L.push(
        `| ${s.metric} | ${span(s.from, s.to)} | \`${s.leadSegment.dimension}='${s.leadSegment.value}'\` | ` +
          `${pct(s.worstPct)} | ${s.sharePct === null ? "n/a" : `${s.sharePct.toFixed(2)}%`} | ${s.reason} |`,
      );
    }
    L.push("");
  }

  L.push("## Cost");
  L.push("");
  if (d.cost.available) {
    L.push(
      `Measured from \`system.query_log\`: ${int(d.cost.totals.readRows)} rows read, ` +
        `${mib(d.cost.totals.readBytes)}, ${int(d.cost.totals.serverMs)}ms server time, ` +
        `${mib(d.cost.totals.peakMemoryBytes)} peak memory across ${d.cost.totals.queries} queries.`,
    );
  } else {
    L.push(`Not available: ${d.cost.reason}`);
  }
  L.push("");
  L.push(
    `Full trace: ${d.trace.totals.calls} tool call(s), ${d.trace.totals.queries} queries, ` +
      `${d.trace.totals.evidence} evidence rows. See \`report.json\` for the complete record.`,
  );
  return `${L.join("\n")}\n`;
}

// -------------------------------------------------------------------------------------------------
// HTML — one self-contained file, no external requests of any kind
// -------------------------------------------------------------------------------------------------

const esc = (s: unknown): string =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const CSS = `
:root{--bg:#fbfaf7;--fg:#1a1a19;--dim:#6b6a65;--line:#e2ded4;--card:#fff;--accent:#9c4221;--ok:#2f6f4f;--bad:#a02c2c;--code:#f4f1ea}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#eceae4;--dim:#a3a099;--line:#2e2d2a;--card:#1e1e1c;--accent:#e0855c;--ok:#79c39b;--bad:#e8807c;--code:#232320}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 Georgia,'Times New Roman',serif;padding:0 20px 80px}
.wrap{max-width:1000px;margin:0 auto}
header{padding:48px 0 24px;border-bottom:2px solid var(--fg)}
h1{font-size:30px;line-height:1.2;margin:0 0 10px;letter-spacing:-.01em}
h2{font-size:21px;margin:44px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:15px;margin:26px 0 8px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim)}
p{margin:10px 0}
.sub{color:var(--dim);font-size:14px}
.meta{display:flex;flex-wrap:wrap;gap:8px 28px;margin:16px 0 0;font-size:13.5px;color:var(--dim)}
.meta b{color:var(--fg);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);padding:18px 22px;margin:18px 0;border-radius:2px}
.verdict{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:0 0 8px}
pre{background:var(--code);border:1px solid var(--line);padding:14px 16px;overflow-x:auto;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;border-radius:2px;margin:12px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:var(--code);padding:1px 5px;border-radius:2px}
.scroll{overflow-x:auto;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:520px}
th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);font-weight:600;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;white-space:nowrap}
.ok{color:var(--ok);font-weight:600}
.bad{color:var(--bad);font-weight:600}
.pill{display:inline-block;font-size:11.5px;padding:2px 9px;border:1px solid var(--line);border-radius:11px;color:var(--dim);margin-right:6px}
.sqlcell{max-width:none}
details{margin:10px 0}
summary{cursor:pointer;font-size:13.5px;color:var(--accent)}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--dim)}
`.trim();

function htmlTable(headers: string[], rows: string[][], numeric: number[] = []): string {
  const th = headers
    .map((h, i) => `<th${numeric.includes(i) ? ' class="n"' : ""}>${esc(h)}</th>`)
    .join("");
  const tb = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ""}>${c}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

export function renderHtml(d: Digest): string {
  const P: string[] = [];

  P.push(`<header><h1>Automated diagnosis</h1>`);
  P.push(
    `<p class="sub">${esc(span(d.sweep.reportedWindow.from, d.sweep.reportedWindow.to))} — produced ` +
      `unattended in ${(d.wallMs / 1000).toFixed(1)}s. No metric and no window were supplied: the ` +
      `sweep found the incidents, joined them across metrics, ranked them, and investigated the top ` +
      `${d.sweep.investigated}.</p>`,
  );
  P.push(
    `<div class="meta"><span><b>${esc(int(d.dataset.requests))}</b> requests</span>` +
      `<span><b>$${esc(int(d.dataset.revenueUsd))}</b> revenue</span>` +
      `<span><b>${esc(int(d.dataset.days))}</b> days loaded</span>` +
      `<span><b>${d.sweep.windowsFound}</b> firing windows → <b>${d.sweep.incidentsAfterJoin}</b> incidents</span>` +
      `<span>run <b>${esc(d.runId)}</b></span></div>`,
  );
  P.push(`<div class="meta"><span>gates: ${esc(d.sweep.gates)}</span></div></header>`);

  if (d.incidents.length === 0) {
    P.push(
      `<h2>Nothing cleared the gates</h2><p>No segment moved far enough, for long enough, on enough ` +
        `traffic to be worth an operator's attention. That is a result, not a failure to find one.</p>`,
    );
  } else {
    P.push(`<h2>Summary</h2>`);
    P.push(
      htmlTable(
        ["#", "Metric", "Window", "Cause", "Channel", "$/day", "Status", "Priority", "Grounded"],
        d.incidents.map((i) => [
          String(i.rank),
          esc(i.metric),
          esc(span(i.from, i.to)),
          i.leadSegment
            ? `<code>${esc(i.leadSegment.dimension)}='${esc(i.leadSegment.value)}'</code>`
            : "platform-wide",
          esc(CHANNEL[i.channel] ?? i.channel),
          esc(usd(i.revenueUsdPerDay)),
          `<span class="${i.action.status === "ongoing" ? "bad" : ""}">${esc(i.action.status)}</span>`,
          esc(i.action.priority.replace(/_/g, " ")),
          `<span class="${i.grounding.ok ? "ok" : "bad"}">${i.grounding.grounded}/${i.grounding.numeralsChecked}</span>`,
        ]),
        [0, 5, 8],
      ),
    );

    for (const i of d.incidents) {
      P.push(`<h2>${i.rank}. ${esc(i.metric)} — ${esc(span(i.from, i.to))}</h2>`);
      P.push(`<div class="card"><p class="verdict">${esc(CHANNEL[i.channel] ?? i.channel)}</p>`);
      if (i.corroboratingMetrics.length) {
        P.push(
          `<p class="sub">Also visible in ${esc(i.corroboratingMetrics.join(", "))} over the same ` +
            `days — one incident, not ${i.corroboratingMetrics.length + 1}.</p>`,
        );
      }
      P.push(`<pre>${esc(i.narrative)}</pre>`);
      P.push(
        `<p class="sub">Diagnosed in ${(i.ms / 1000).toFixed(1)}s across ${i.queries} queries. ` +
          `<span class="${i.grounding.ok ? "ok" : "bad"}">${i.grounding.grounded}/${i.grounding.numeralsChecked}</span> ` +
          `numerals above resolve to a recorded evidence row` +
          (i.grounding.ok
            ? "."
            : ` — <span class="bad">this answer failed the grounding check and must not be quoted.</span>`) +
          `</p></div>`,
      );

      P.push(`<h3>What to do</h3>`);
      P.push(
        `<div class="card"><p class="verdict">${esc(i.action.priority.replace(/_/g, " "))}</p>` +
          `<p>${esc(i.action.priorityBasis)}</p>` +
          `<p class="sub"><b>Status:</b> ${esc(i.action.statusDetail)}<br>` +
          `<b>Owner:</b> ${esc(i.action.owner)}` +
          (i.action.lostSoFarUsd !== null
            ? `<br><b>Cost:</b> ${esc(usd(i.action.moneyUsdPerDay))}/day over ${i.action.daysRunning} ` +
              `day(s) = ${esc(usd(i.action.lostSoFarUsd))}, ${esc(usd(i.action.recoverableUsdPerDay))}/day recoverable now`
            : "") +
          `</p><ul class="sub">${i.action.whereToLook.map((l) => `<li>${esc(l)}</li>`).join("")}` +
          (i.action.doNotChase.length
            ? `<li><b>Do not chase:</b> ${i.action.doNotChase.length} slice(s) look affected and are not — listed under "checked and cleared" below.</li>`
            : "") +
          (i.action.nextQuestion
            ? `<li><b>Next question:</b> ${esc(i.action.nextQuestion)}</li>`
            : "") +
          `</ul><p class="sub"><em>${esc(i.action.boundary)}</em></p></div>`,
      );
      P.push(`<h3>Receipts — every number, and the query behind it</h3>`);
      P.push(
        `<p class="sub">${i.evidence.length} of ${i.evidenceTotal} recorded rows. Each hash is the ` +
          `SHA-256 prefix of the exact SQL sent to ClickHouse.</p>`,
      );
      P.push(
        htmlTable(
          ["Id", "Label", "Value", "Unit", "Hash", "SQL"],
          i.evidence.map((e) => [
            `<code>${esc(e.qualifiedId)}</code>`,
            esc(e.label),
            e.value === null ? "null" : esc(e.value),
            esc(e.unit),
            `<code>${esc(e.sqlHash)}</code>`,
            `<details><summary>show</summary><pre class="sqlcell">${esc(e.sql)}</pre></details>`,
          ]),
          [2],
        ),
      );

      P.push(`<h3>Plan — where the time went</h3>`);
      P.push(
        htmlTable(
          ["Stage", "ms", "Queries", "Result"],
          i.planSteps.map((s) => [esc(s.stage), String(s.ms), String(s.queries), esc(s.summary)]),
          [1, 2],
        ),
      );

      if (i.ruledOutChecks.length) {
        P.push(`<h3>Checked and cleared</h3>`);
        P.push(
          `<p class="sub">${i.ruledOutContamination} segment(s) looked anomalous and were cleared as ` +
            `dilution of the real cause — a ranked drill-down would have reported them as findings.</p>`,
        );
        P.push(
          `<ul class="sub">${i.ruledOutChecks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`,
        );
      }
    }
  }

  if (d.skipped.length) {
    P.push(`<h2>Seen and not escalated</h2>`);
    P.push(
      `<p class="sub">These fired the detector but were not worth an investigation. Listed rather ` +
        `than dropped, so the digest cannot be accused of hiding what it saw.</p>`,
    );
    P.push(
      htmlTable(
        ["Metric", "Window", "Segment", "Move", "Traffic", "Why not escalated"],
        d.skipped.map((s) => [
          esc(s.metric),
          esc(span(s.from, s.to)),
          `<code>${esc(s.leadSegment.dimension)}='${esc(s.leadSegment.value)}'</code>`,
          esc(pct(s.worstPct)),
          s.sharePct === null ? "n/a" : `${s.sharePct.toFixed(2)}%`,
          esc(s.reason),
        ]),
        [3, 4],
      ),
    );
  }

  P.push(`<h2>What this cost</h2>`);
  if (d.cost.available) {
    P.push(
      `<p class="sub">Measured from <code>system.query_log</code>, attributed per tool call by the ` +
        `<code>run=</code>/<code>stage=</code> tag every query carries.</p>`,
    );
    P.push(
      htmlTable(
        ["Call", "Stage", "Queries", "Server ms", "Rows read", "Bytes read", "Peak memory"],
        d.cost.stages.map((s) => [
          esc(s.callId),
          esc(s.stage),
          String(s.queries),
          int(s.serverMs),
          int(s.readRows),
          mib(s.readBytes),
          mib(s.peakMemoryBytes),
        ]),
        [2, 3, 4, 5, 6],
      ),
    );
    P.push(
      `<p class="sub"><b>Total:</b> ${esc(int(d.cost.totals.readRows))} rows read, ` +
        `${esc(mib(d.cost.totals.readBytes))}, ${esc(int(d.cost.totals.serverMs))}ms server time, ` +
        `${esc(mib(d.cost.totals.peakMemoryBytes))} peak memory across ${d.cost.totals.queries} queries.</p>`,
    );
  } else {
    P.push(`<p class="sub">${esc(d.cost.reason ?? "unavailable")}</p>`);
  }

  P.push(`<h2>Every tool call in this run</h2>`);
  P.push(
    htmlTable(
      ["Call", "Tool", "ms", "Queries", "Rows back", "Outcome", "OTel trace"],
      d.trace.calls.map((c) => [
        esc(c.callId),
        esc(c.tool),
        String(c.ms),
        String(c.queries),
        esc(c.rowsReturned.join(", ") || "-"),
        c.ok ? esc(c.summary) : `<span class="bad">${esc(c.error ?? "failed")}</span>`,
        `<code>${esc(c.otelTraceId ?? "-")}</code>`,
      ]),
      [2, 3],
    ),
  );

  P.push(
    `<footer>Run <code>${esc(d.runId)}</code> · generated ${esc(d.generatedAt)} · ` +
      `${d.trace.totals.calls} tool calls · ${d.trace.totals.queries} queries · ` +
      `${int(d.trace.totals.evidence)} evidence rows recorded. This file is self-contained: no ` +
      `scripts, no external requests, nothing to install. The complete machine-readable record, ` +
      `including every evidence row, is in <code>report.json</code>.</footer>`,
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Automated diagnosis — ${esc(span(d.sweep.reportedWindow.from, d.sweep.reportedWindow.to))}</title>
<style>${CSS}</style></head>
<body><div class="wrap">${P.join("\n")}</div></body></html>
`;
}
