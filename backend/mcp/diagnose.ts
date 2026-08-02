/**
 * The unattended path. One command, no arguments required, no human in the loop.
 *
 *   bun run diagnose
 *   bun run diagnose -- --from 2026-06-20 --to 2026-06-30 --top 3
 *   bun run diagnose -- --out pitch/day2
 *
 * This is the submission artifact for the unseen incident, and it exists because nobody will hand us
 * a metric and a window on Day 2. Without it the sweep produces dozens of firing windows and
 * `investigate` takes exactly one metric and one window, so the join between them is a human piping
 * results into a CLI under time pressure. Here it is code:
 *
 *   describe_data -> find_incidents -> rank -> group -> investigate every one -> report
 *
 * Two steps in the middle are the ones that turn a sweep into a digest:
 *
 *   RANK. Dozens of firing windows is not a digest, so each is scored by a stated severity proxy —
 *   size of move x share of traffic x capped duration — and the report is ordered by it. Ranking
 *   decides the ORDER only. Everything the sweep fired on is investigated, because the ranking is a
 *   heuristic and the window it demotes can be the expensive one. `--top N` cuts for a fast pass.
 *
 *   GROUP. One incident lights up several metrics — the Jun 21 collapse fires on requests *and*
 *   revenue, a fill break drags CTR with it — so the weaker views are attached to the strongest and
 *   the report says "one incident, not three". Grouping changes only what the report says: each
 *   incident is still investigated over its own detected window, never a union. `rankAndGroup` has
 *   the full reasoning, and the eight-day window that taught me the difference.
 *
 * Everything runs through `callTool`, so the trace, the evidence and the per-call cost attribution
 * come for free and the artifact is a by-product of doing the work rather than a summary written
 * afterwards.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "./tools";
import { Session } from "./trace";
import { readCost } from "./cost";
import {
  type Digest,
  type DiagnosedIncident,
  type SkippedWindow,
  renderHtml,
  renderMarkdown,
} from "./report";
import type { Span } from "@opentelemetry/api";
import {
  initObservability,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

/**
 * Investigate EVERYTHING the sweep fires on. No cut by default.
 *
 * This used to default to 6 for readability, on the reasoning that a digest a person actually reads
 * is short and anything below the cut still gets listed with its numbers. That reasoning is fine for
 * a human skimming a morning digest and wrong for the job this command actually does, which is to be
 * the unattended pass that nobody is watching.
 *
 * What it costs to be wrong is asymmetric. An extra investigated window costs about thirteen seconds
 * and one more section in a report. A missed one is an incident nobody hears about — and the ranking
 * that decides the cut is a stated heuristic (move x share x capped duration), not a measurement, so
 * the thing it demotes can be the expensive one. On the 6-10 July slice a -$84/day repricing sat
 * below a cut that had already spent slots on two windows that turned out to be no_anomaly.
 *
 * Ranking still decides the ORDER, which is what makes the report readable. It no longer decides
 * what gets looked at. `--top N` is there when someone wants a fast partial pass.
 */
const DEFAULT_TOP = Number.POSITIVE_INFINITY;
const DEFAULT_OUT = "backend/mcp/reports";

/** Receipts shown per incident in the report. The rest stay in report.json. */
const MAX_RECEIPTS = 30;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const say = (s = ""): void => {
  process.stderr.write(`${s}\n`);
};

interface SweepWindow {
  metric: string;
  from: string;
  to: string;
  leadSegment: { dimension: string; value: string };
  worstPct: number;
  worstSigma: number;
  days: number;
  requestsPerDay: number;
  correlatedSegments: number;
}

interface JoinedIncident {
  primary: SweepWindow;
  corroborating: SweepWindow[];
  /** drop% x effective share x capped duration. A stated triage proxy, not a dollar figure. */
  severity: number;
  sharePct: number | null;
  /** The metric moved UP. Reported, never escalated — a rise is not an incident here. */
  improved: boolean;
}

/**
 * Rank every firing window on its own, then attach the ones that are the same event to the strongest.
 *
 * THE INVESTIGATION WINDOW IS NEVER WIDENED. This is the whole design of this function, and the first
 * version got it wrong in the way this codebase keeps getting it wrong: it merged any two overlapping
 * windows and investigated their union. On the training data that produced an eight-day `ctr` window
 * spanning two separate incidents, which diluted both into `no_anomaly` and lost the Android 15 fill
 * collapse completely. A wide window contaminates its own baseline and its own decomposition — the
 * journal has three separate instances of it. So grouping only ever changes what the report *says*,
 * never what gets investigated: each incident is investigated over its own detected dates.
 *
 * Two windows are the same event when either
 *   - their windows are identical and only the metric differs (the Jun 21 volume collapse fires on
 *     `requests` and on `revenue` over exactly the same day), or
 *   - they are the same metric on the same lead segment with overlapping dates (one break the
 *     detector split into two adjacent runs).
 *
 * Everything else stays distinct, and the second rule is narrower than it looks on purpose. Grouping
 * across metrics on a shared segment alone loses diagnoses: the sweep leads both the Jun 19-26
 * revenue window and the Jun 23-26 fill-rate window with the pair `finance|Android 15`, so that rule
 * folded the Android 15 fill collapse into a revenue window spanning Jun 21 — and the only
 * investigation that ran came back `not_localizable`, having diluted the flagship incident away.
 * A metric and a window are together the question being asked; two different questions get two
 * investigations. The rule deliberately under-groups: a duplicate row costs a reader ten seconds,
 * over-grouping silently drops a real incident.
 */
function rankAndGroup(windows: SweepWindow[], avgRequestsPerDay: number): JoinedIncident[] {
  const scored = windows
    .map((w) => {
      const leadSharePct =
        avgRequestsPerDay > 0 ? (w.requestsPerDay / avgRequestsPerDay) * 100 : null;
      /**
       * Breadth, because the sweep names its strongest segment and that is often a narrow pair.
       *
       * The Jun 21 platform-wide collapse is reported with `app_id=app_00091` leading, on 0.11% of
       * traffic — ranked on its lead alone it lands 6th behind a string of one-app wobbles, which is
       * exactly backwards for a -44% event covering everything. What gives it away is that 425
       * segments moved together; the widest genuinely-narrow incident here moves 27. So a window with
       * many co-moving segments is treated as broad regardless of its lead's size.
       *
       * The 0.05 is a heuristic, not a measurement: the sweep tests roughly 2,800 segments, so ~500
       * co-moving is about a sixth of them and reads as platform-wide. Capped at 25% so breadth can
       * order the digest without swamping the size of the move. This only decides *triage order* —
       * every number in the diagnosis itself is computed exactly, downstream of this.
       */
      const breadthPct = Math.min(25, w.correlatedSegments * 0.05);
      const effectiveSharePct = Math.max(leadSharePct ?? 0, breadthPct);
      // Only losses are escalated. Every metric here is one where higher is better, so a rise is
      // not an incident: three of the top six windows by raw movement are CTR *up* 30-58%, which is
      // nothing to page an operator about, and ranking on absolute movement buries real losses
      // beneath them.
      const dropPct = Math.max(0, -w.worstPct);
      return {
        w,
        sharePct: leadSharePct,
        // Duration capped at 4 days: every planted incident here runs 1-4, so a longer run is
        // usually several events chained rather than a proportionally worse one.
        severity: dropPct * effectiveSharePct * Math.min(w.days, 4),
        improved: w.worstPct > 0,
      };
    })
    .sort((a, b) => b.severity - a.severity);

  const out: JoinedIncident[] = [];
  const overlaps = (a: SweepWindow, b: SweepWindow): boolean => a.from <= b.to && b.from <= a.to;
  const sameSegment = (a: SweepWindow, b: SweepWindow): boolean =>
    a.leadSegment.dimension === b.leadSegment.dimension &&
    a.leadSegment.value === b.leadSegment.value;
  const sameWindow = (a: SweepWindow, b: SweepWindow): boolean =>
    a.from === b.from && a.to === b.to;

  /**
   * Same dates is NOT enough to call two windows the same incident. The lead has to agree on which
   * dimension is responsible.
   *
   * `sameWindow` alone used to be the whole first clause, and it merged on dates while ignoring both
   * the metric and the segment. On the 6-10 July slice that collapsed two unrelated events into one:
   * a fill_rate break led by `publisher_tier = tier_3` (-$31.68/day) absorbed an eCPM repricing led
   * by region (-$84.47/day), and the report announced "one incident, not four". The larger of the two
   * was never investigated and never appeared — the digest said the platform was fine.
   *
   * Two incidents genuinely can share a window. What makes them ONE is a shared cause, and the lead
   * dimension is the cheapest honest proxy for that: a requests collapse dragging revenue down with
   * it leads on the same dimension in both metrics, because it is the same segment failing.
   *
   * Comparing the dimension rather than the exact value is deliberate. The same underlying break
   * often surfaces as `country = ID` in one metric and `country|ad_format = ID|rewarded` in another;
   * demanding an identical value would split those, and over-splitting a digest is a nuisance where
   * under-splitting hides an incident.
   */
  const sameLeadDimension = (a: SweepWindow, b: SweepWindow): boolean =>
    a.leadSegment.dimension === b.leadSegment.dimension;

  for (const s of scored) {
    // Descending severity, so the first match is always the strongest view of the event.
    const host = out.find(
      (o) =>
        (sameWindow(o.primary, s.w) && sameLeadDimension(o.primary, s.w)) ||
        (o.primary.metric === s.w.metric &&
          sameSegment(o.primary, s.w) &&
          overlaps(o.primary, s.w)),
    );
    if (host) {
      host.corroborating.push(s.w);
      continue;
    }
    out.push({
      primary: s.w,
      corroborating: [],
      severity: s.severity,
      sharePct: s.sharePct,
      improved: s.improved,
    });
  }
  return out;
}

async function call(
  session: Session,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const { isError, text } = await callTool(session, tool, args);
  try {
    return { ok: !isError, data: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { ok: false, data: { error: "unparseable tool output" } };
  }
}

async function runDiagnose(span: Span): Promise<void> {
  const started = Date.now();

  const top = Number(arg("top") ?? DEFAULT_TOP);
  const outDir = arg("out") ?? DEFAULT_OUT;
  const metrics = arg("metrics")
    ?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const from = arg("from");
  const to = arg("to");

  const session = new Session();
  say(`[diagnose] run ${session.runId} — sweeping, nothing supplied by a human`);

  span.setAttributes({
    "app.run_id": session.runId,
    "app.top": top,
    ...(metrics ? { "app.metrics": metrics.join(",") } : {}),
    ...(from ? { "app.window.from": from } : {}),
    ...(to ? { "app.window.to": to } : {}),
  });

  try {
    // ---- 1. what have we got --------------------------------------------------------------
    const overview = await call(session, "describe_data", {});
    if (!overview.ok) throw new Error(`describe_data failed: ${String(overview.data.error)}`);
    const window = overview.data.window as { from: string; to: string; days: number };
    const volumes = overview.data.volumes as { requests: number; revenueUsd: number };
    const avgRequestsPerDay = window.days > 0 ? volumes.requests / window.days : 0;
    say(`[diagnose] data ${window.from}..${window.to}, ${window.days} days`);

    // ---- 2. find, unprompted -------------------------------------------------------------
    const sweepArgs: Record<string, unknown> = { limit: 50 };
    if (metrics) sweepArgs.metrics = metrics;
    if (from) sweepArgs.from = from;
    if (to) sweepArgs.to = to;
    const sweep = await call(session, "find_incidents", sweepArgs);
    if (!sweep.ok) throw new Error(`find_incidents failed: ${String(sweep.data.error)}`);

    const rawWindows = (sweep.data.windows ?? []) as SweepWindow[];
    const windowsFound = Number(sweep.data.windowCount ?? rawWindows.length);
    say(`[diagnose] ${windowsFound} firing window(s)`);

    // ---- 3. join and rank ----------------------------------------------------------------
    const joined = rankAndGroup(rawWindows, avgRequestsPerDay);
    say(`[diagnose] ${joined.length} distinct incident(s) after joining across metrics`);

    const selected = joined.slice(0, Math.max(1, top));
    const skipped: SkippedWindow[] = joined.slice(Math.max(1, top)).map((j, idx) => ({
      metric: j.primary.metric,
      from: j.primary.from,
      to: j.primary.to,
      leadSegment: j.primary.leadSegment,
      worstPct: j.primary.worstPct,
      sharePct: j.sharePct,
      reason: j.improved
        ? `moved up ${j.primary.worstPct.toFixed(0)}%, not a loss — not escalated`
        : `ranked ${idx + 1 + selected.length} of ${joined.length} by severity (drop x traffic share x duration)`,
    }));

    // ---- 4. investigate the shortlist ----------------------------------------------------
    const diagnosed: DiagnosedIncident[] = [];
    for (const j of selected) {
      say(`[diagnose] investigating ${j.primary.metric} ${j.primary.from}..${j.primary.to}`);
      /**
       * Retried, because a dropped socket is not a verdict.
       *
       * Observed on the 6-10 July run: ClickHouse Cloud closed the connection mid-`residualize` and
       * a real `fill_rate` technical break worth -$31.68/day dropped straight out of the digest into
       * the skipped list. Nothing about that incident was uncertain — the database blinked.
       *
       * This is the unattended pass, so there is no human to notice a missing section and re-run it.
       * Three attempts with a short backoff, and only then is it recorded as failed. Investigations
       * are read-only, so retrying one cannot corrupt anything; the cost of a spare attempt is
       * seconds, and the cost of not retrying is an incident nobody hears about.
       */
      let res = await call(session, "investigate", {
        metric: j.primary.metric,
        from: j.primary.from,
        to: j.primary.to,
      });
      for (let attempt = 2; !res.ok && attempt <= 3; attempt++) {
        say(
          `[diagnose]   attempt ${attempt - 1} failed, retrying — ${String(res.data.error).slice(0, 90)}`,
        );
        await Bun.sleep(1500 * (attempt - 1));
        res = await call(session, "investigate", {
          metric: j.primary.metric,
          from: j.primary.from,
          to: j.primary.to,
        });
      }
      if (!res.ok) {
        say(`[diagnose]   FAILED after 3 attempts: ${String(res.data.error)}`);
        skipped.push({
          metric: j.primary.metric,
          from: j.primary.from,
          to: j.primary.to,
          leadSegment: j.primary.leadSegment,
          worstPct: j.primary.worstPct,
          sharePct: j.sharePct,
          reason: `investigation failed after 3 attempts: ${String(res.data.error).slice(0, 120)}`,
        });
        continue;
      }

      const d = res.data;
      const trace = d.trace as { callId: string; elapsedMs: number; queries: number };
      const findings = (d.findings ?? []) as Array<{
        segment: { dimension: string; value: string } | null;
        revenueImpactUsd: number | null;
        evidenceIds: string[];
      }>;
      const ruledOut = (d.ruledOut ?? []) as Array<{
        status: string;
        note?: string;
        evidenceIds: string[];
      }>;
      const grounding = d.grounding as { ok: boolean; grounded: number; numeralsChecked: number };

      // Receipts: the rows actually behind the printed answer, not all ~1,700 candidates.
      const referenced = new Set(
        [...findings, ...ruledOut]
          .flatMap((f) => f.evidenceIds ?? [])
          .map((e) => `${trace.callId}/${e}`),
      );
      const KEY_LABEL = /^(price\.|cause\.|cleared_as_contamination\.|decompose\.)/;
      const all = session.evidenceFor(trace.callId);
      const receipts = all
        .filter((e) => referenced.has(e.qualifiedId) || KEY_LABEL.test(e.label))
        .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
        .slice(0, MAX_RECEIPTS);

      diagnosed.push({
        rank: 0, // assigned after the dollar sort below
        metric: j.primary.metric,
        from: j.primary.from,
        to: j.primary.to,
        corroboratingMetrics: [...new Set(j.corroborating.map((c) => c.metric))].filter(
          (m) => m !== j.primary.metric,
        ),
        leadSegment: findings.find((f) => f.segment)?.segment ?? null,
        worstPct: j.primary.worstPct,
        sharePct: j.sharePct,
        channel: String(d.channel ?? "unknown"),
        headline: String(d.headline ?? ""),
        narrative: String(d.narrative ?? ""),
        grounding,
        revenueUsdPerDay:
          findings.find((f) => f.revenueImpactUsd !== null)?.revenueImpactUsd ?? null,
        ruledOutContamination: ruledOut.filter((r) => r.status === "cleared_as_contamination")
          .length,
        ruledOutChecks: ruledOut
          .filter((r) => r.status !== "cleared_as_contamination" && r.note)
          .map((r) => r.note!)
          .slice(0, 8),
        action: d.action as DiagnosedIncident["action"],
        planSteps: (d.planSteps ?? []) as DiagnosedIncident["planSteps"],
        evidence: receipts,
        evidenceTotal: all.length,
        callId: trace.callId,
        ms: trace.elapsedMs,
        queries: trace.queries,
        otelTraceId: session.snapshot().calls.find((c) => c.callId === trace.callId)?.otelTraceId,
      });
    }

    // Selection was by severity proxy; presentation is by measured impact, which is the number an
    // operator actually triages on. Both orders are stated in the report so neither is implied.
    // Still-bleeding first, then by size. An incident that is over and one that is running right now
    // are not comparable on dollars alone, and a digest that buries the live one has failed.
    const live = (d: DiagnosedIncident): number => (d.action?.status === "ongoing" ? 1 : 0);
    diagnosed.sort(
      (a, b) =>
        live(b) - live(a) || Math.abs(b.revenueUsdPerDay ?? 0) - Math.abs(a.revenueUsdPerDay ?? 0),
    );
    diagnosed.forEach((d, i) => (d.rank = i + 1));

    // ---- 5. what did it cost -------------------------------------------------------------
    const costLedger = session.costLedger();
    const cost = await readCost(costLedger, session.runId, {
      expectedQueries: session.snapshot().totals.queries,
      timeoutMs: Number(arg("cost-timeout") ?? 8_000),
    });

    // ---- 6. write it out -----------------------------------------------------------------
    const digest: Digest = {
      runId: session.runId,
      generatedAt: new Date().toISOString(),
      wallMs: Date.now() - started,
      dataset: {
        from: window.from,
        to: window.to,
        days: window.days,
        requests: volumes.requests,
        revenueUsd: volumes.revenueUsd,
      },
      sweep: {
        metrics: (sweep.data.metricsSwept ?? []) as string[],
        reportedWindow: (sweep.data.reportedWindow ?? { from: window.from, to: window.to }) as {
          from: string;
          to: string;
        },
        windowsFound,
        incidentsAfterJoin: joined.length,
        investigated: diagnosed.length,
        gates: String(sweep.data.gates ?? ""),
      },
      incidents: diagnosed,
      skipped,
      cost,
      trace: session.snapshot(),
    };

    mkdirSync(outDir, { recursive: true });
    const paths = {
      md: join(outDir, "report.md"),
      json: join(outDir, "report.json"),
      html: join(outDir, "report.html"),
    };
    writeFileSync(paths.md, renderMarkdown(digest));
    writeFileSync(paths.html, renderHtml(digest));
    writeFileSync(
      paths.json,
      `${JSON.stringify({ ...digest, evidenceIndex: session.evidenceIndex() }, null, 2)}\n`,
    );

    say("");
    say(
      `[diagnose] ${diagnosed.length} incident(s) diagnosed in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    /**
     * A crashed investigation must never read as a clean sweep.
     *
     * `skipped` holds two very different things: a window that was looked at and not escalated, and
     * a window that could not be looked at. Both used to land in the same quiet list, so a failed
     * investigation appeared only as a line in report.json that nobody opens — and on this window
     * that hid a real -$31.68/day technical break. Said out loud, before the digest.
     */
    const failed = skipped.filter((x) => x.reason.startsWith("investigation failed"));
    if (failed.length) {
      say(`[diagnose] !! ${failed.length} investigation(s) FAILED — NOT in the digest below:`);
      for (const f of failed) say(`[diagnose]    ${f.metric} ${f.from}..${f.to} — ${f.reason}`);
      say("");
    }
    for (const d of diagnosed) {
      const cause = d.leadSegment
        ? `${d.leadSegment.dimension}='${d.leadSegment.value}'`
        : "platform-wide";
      say(
        `  ${d.rank}. ${d.metric} ${d.from}..${d.to}  ${d.channel}  ${d.action?.priority ?? "?"}  ${cause}  ` +
          `${d.revenueUsdPerDay === null ? "" : `$${d.revenueUsdPerDay.toFixed(2)}/day  `}` +
          `grounded ${d.grounding.grounded}/${d.grounding.numeralsChecked}`,
      );
    }
    say("");
    say(`[diagnose] ${paths.html}   <- open this one`);
    say(`[diagnose] ${paths.md}`);
    say(`[diagnose] ${paths.json}`);

    // A diagnosis whose text is not fully grounded is not a diagnosis we can submit.
    const ungrounded = diagnosed.filter((d) => !d.grounding.ok);
    span.setAttributes({
      "app.incidents.found": windowsFound,
      "app.incidents.diagnosed": diagnosed.length,
      "app.incidents.skipped": skipped.length,
      "app.incidents.ungrounded": ungrounded.length,
      "app.queries": session.snapshot().totals.queries,
    });
    if (ungrounded.length) {
      say("");
      say(`[diagnose] FAILED: ${ungrounded.length} report(s) contain an ungrounded number.`);
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

/**
 * Root span for the whole sweep.
 *
 * `initObservability` runs before the span and `shutdownObservability` after it, in that order and
 * not the other way round: a span opened before the provider exists gets the no-op tracer, and a
 * span still open when the batch processor is torn down is never exported. Between them, every
 * `mcp.tool.*` call this run makes hangs off one trace, so a `bun run diagnose` is a single thing to
 * open in ClickStack rather than a dozen unconnected roots.
 */
async function main(): Promise<void> {
  initObservability();
  try {
    await withSpan("diagnose.run", {}, runDiagnose);
  } finally {
    await shutdownObservability();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    say(`[diagnose] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
