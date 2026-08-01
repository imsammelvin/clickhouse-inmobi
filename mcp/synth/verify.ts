/**
 * Score the engine against a dataset whose deviations we planted.
 *
 *   bun run synth:verify
 *
 * This measures the two things `mcp/eval` structurally cannot.
 *
 * RECALL THAT GENERALISES. `mcp/eval` scores against `KNOWN_INCIDENTS`, which we wrote by reading the
 * training data — it measures agreement with our own homework, using the same intuitions we then
 * encoded. Here the deviations are declared before the data exists, on a different metric mix, on
 * different dimension values, on different days. Finding them is evidence about the algorithm rather
 * than about our memory of June 2026.
 *
 * PRECISION, WHICH WE HAVE NEVER BEEN ABLE TO MEASURE AT ALL. On the training data a firing we cannot
 * explain might be a real planted anomaly nobody spotted, so `scan` can only call it "untriaged" and
 * hope. Here every deviation in the data is in `spec.ts`, so a window that matches none of them is a
 * false positive, definitionally. That number is the one a judge cares about most — the rubric
 * punishes a hallucinated segment harder than a missed one.
 *
 * The engine runs unmodified: `CLICKHOUSE_DATABASE` points at the synthetic database and every query in
 * the system follows. What is under test is the shipping code.
 */
import { callTool } from "../tools";
import { Session } from "../trace";
import { CLEAN_DAYS, DIMS, PLANTED, SHAPE, dateOf, weekendOffsets } from "./spec";
import { initObservability, shutdownObservability } from "../../utils/telemetryUtils";

const say = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};

interface Window {
  metric: string;
  from: string;
  to: string;
  leadSegment: { dimension: string; value: string };
  worstPct: number;
  days: number;
  correlatedSegments: number;
}

const overlaps = (aFrom: string, aTo: string, bFrom: string, bTo: string): boolean =>
  aFrom <= bTo && bFrom <= aTo;

async function call(
  session: Session,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const { isError, text } = await callTool(session, tool, args);
  try {
    return { ok: !isError, data: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { ok: false, data: { error: "unparseable" } };
  }
}

async function main(): Promise<void> {
  const db = process.env.CLICKHOUSE_DATABASE ?? "";
  if (!db.includes("synth")) {
    say(
      `Refusing to run: CLICKHOUSE_DATABASE is "${db || "(unset)"}". This scores against planted ` +
        `deviations, so pointing it at the real dataset would produce a meaningless report. Use ` +
        `\`bun run synth:verify\`.`,
    );
    process.exit(2);
  }

  initObservability();
  const session = new Session();
  let failures = 0;
  const fail = (msg: string): void => {
    failures++;
    say(`  MISS  ${msg}`);
  };

  try {
    // ---- the data is what we think it is -------------------------------------------------
    const overview = await call(session, "describe_data", {});
    if (!overview.ok) throw new Error(`describe_data failed: ${String(overview.data.error)}`);
    const w = overview.data.window as { from: string; to: string; days: number };
    const vol = overview.data.volumes as { requests: number; revenueUsd: number };
    say(`\nSYNTHETIC DATASET  ${db}`);
    say(`  ${w.from}..${w.to}, ${w.days} days, ${vol.requests.toLocaleString()} requests, $${vol.revenueUsd.toLocaleString()}`);
    if (w.from !== SHAPE.from) {
      fail(`dataset starts ${w.from}, spec says ${SHAPE.from} — rebuild with \`bun run synth:build --reset\``);
    }

    /**
     * PREFLIGHT. Refuse to score anything if the dictionary-derived dimensions are blank.
     *
     * This guard exists because its absence produced a wrong bug report. `schema.sql` declares the
     * dictionaries LIFETIME(0), so a node that loaded one before the dimension rows existed serves ''
     * forever, and a multi-node service load-balances — so `dictGet` returns real values or '' depending
     * on which node answers. Every dimension then collapses to a single blank value.
     *
     * The scores that come out of that are not just wrong, they are INVERTED in the most misleading
     * possible way: P1 and P2 fail (nothing can be localized when there is only one value to localize
     * to), while P3 and P4 pass for the wrong reason (declining to name a segment looks correct when
     * there were never any segments to name). A run in that state reads as "the engine cannot localize
     * but correctly refuses to fabricate" — the exact opposite of the truth on both counts.
     *
     * So: check first, and if the dimensions are blank say so and stop rather than reporting a
     * meaningless scorecard as an engine defect.
     */
    const probe = await call(session, "get_metric", {
      metric: "fill_rate",
      from: SHAPE.from,
      to: SHAPE.from,
      group_by: ["os_version"],
      limit: 10,
    });
    const probeRows = (probe.data.rows ?? []) as Array<{ group: Record<string, string> }>;
    const distinct = new Set(probeRows.map((r) => r.group.os_version ?? ""));
    if (distinct.size <= 1 || [...distinct].every((v) => v === "")) {
      say(``);
      say(`SETUP ERROR — dimensions are blank, refusing to score.`);
      say(``);
      say(`  \`os_version\` returned ${distinct.size} distinct value(s): ${JSON.stringify([...distinct])}`);
      say(`  Expected ${DIMS.os_version.length}. The dictionaries are serving empty strings, so every`);
      say(`  dimension in ad_events_enriched collapses to one blank value.`);
      say(``);
      say(`  Cause: schema.sql declares the dictionaries LIFETIME(0) — never refresh. A node that`);
      say(`  loaded one before the dimension rows existed serves '' for the life of the process, and a`);
      say(`  multi-node service load-balances, so this comes and goes between runs.`);
      say(``);
      say(`  Fix:  bun run synth:build -- --reset`);
      say(`  That recreates the dictionaries with a refreshing lifetime and reloads them.`);
      say(``);
      say(`  Scoring in this state would be actively misleading, not merely wrong: P1/P2 fail because`);
      say(`  there is nothing to localize to, while P3/P4 pass because refusing to name a segment looks`);
      say(`  correct when no segments exist. Both readings invert.`);
      process.exitCode = 2;
      return;
    }
    say(`  dimensions OK — os_version has ${distinct.size} distinct value(s)`);

    // ---- one sweep, then score everything against it -------------------------------------
    say(`\nSWEEP`);
    const sweep = await call(session, "find_incidents", { limit: 50 });
    if (!sweep.ok) throw new Error(`find_incidents failed: ${String(sweep.data.error)}`);
    const windows = (sweep.data.windows ?? []) as Window[];
    say(`  ${sweep.data.windowCount} window(s) reported across ${(sweep.data.metricsSwept as string[]).join(", ")}`);

    // ---- recall: was each planted deviation found? ----------------------------------------
    say(`\nRECALL — did it find what we planted?`);
    const attributed = new Set<number>();
    for (const p of PLANTED) {
      const from = dateOf(p.fromDay);
      const to = dateOf(p.toDay);
      const hits = windows.filter((win, idx) => {
        if (!overlaps(win.from, win.to, from, to)) return false;
        attributed.add(idx);
        return true;
      });
      const onMetric = hits.some((h) => h.metric === p.metric);
      const ok = p.expect.detected ? hits.length > 0 : hits.length === 0;
      say(
        `  ${ok ? "ok  " : "MISS"} ${p.id.padEnd(28)} ${from}..${to}  ` +
          `${hits.length} window(s)${onMetric ? `, incl. ${p.metric}` : hits.length ? ` (not on ${p.metric})` : ""}`,
      );
      if (!ok) {
        failures++;
        say(`        ${p.what}`);
        say(`        ${p.expect.why}`);
      }
    }

    // ---- precision: what fired that we did NOT plant? ------------------------------------
    // Only possible on synthetic data. On the training set an unexplained firing might be a real
    // anomaly nobody noticed; here the spec is exhaustive, so anything unattributed is a false alarm.
    say(`\nPRECISION — what fired that we did not plant?`);
    const spurious = windows.filter((_, idx) => !attributed.has(idx));
    say(`  ${windows.length - spurious.length}/${windows.length} reported window(s) attributable to a planted deviation`);
    for (const s of spurious.slice(0, 8)) {
      say(
        `  note  ${s.metric.padEnd(10)} ${s.from}..${s.to}  ${s.leadSegment.dimension}='${s.leadSegment.value}'  ` +
          `${s.worstPct >= 0 ? "+" : ""}${s.worstPct.toFixed(0)}%  (${s.correlatedSegments} correlated)`,
      );
    }
    if (spurious.length > 8) say(`  note  ... and ${spurious.length - 8} more`);

    // ---- localization: does it name the right segment? ------------------------------------
    say(`\nLOCALIZATION — investigating each planted window`);
    for (const p of PLANTED) {
      const res = await call(session, "investigate", {
        metric: p.metric,
        from: dateOf(p.fromDay),
        to: dateOf(p.toDay),
      });
      if (!res.ok) {
        fail(`${p.id}: investigate failed — ${String(res.data.error).slice(0, 120)}`);
        continue;
      }
      const d = res.data;
      const findings = (d.findings ?? []) as Array<{ segment: { dimension: string; value: string } | null }>;
      const named = findings.find((f) => f.segment)?.segment ?? null;
      const grounding = d.grounding as { ok: boolean; grounded: number; numeralsChecked: number };
      const channel = String(d.channel ?? "");
      const action = (d.action ?? {}) as Record<string, unknown>;

      const label = `${p.id.padEnd(28)} ${channel.padEnd(16)}`;
      if (p.expect.localizes && p.segment) {
        const hit = named?.dimension === p.segment.dimension && named?.value === p.segment.value;
        say(
          `  ${hit ? "ok  " : "MISS"} ${label} ${hit ? `${named!.dimension}='${named!.value}'` : `got ${named ? `${named.dimension}='${named.value}'` : "no segment"}, planted ${p.segment.dimension}='${p.segment.value}'`}`,
        );
        if (!hit) {
          failures++;
          say(`        ${p.expect.why}`);
        }
      } else {
        const hit = named === null;
        say(`  ${hit ? "ok  " : "MISS"} ${label} ${hit ? "named no segment, as planted" : `FABRICATED ${named!.dimension}='${named!.value}'`}`);
        if (!hit) {
          failures++;
          say(`        ${p.expect.why}`);
        }
      }

      if (!grounding.ok) {
        fail(`${p.id}: ${grounding.numeralsChecked - grounding.grounded} ungrounded numeral(s) in the narrative`);
      }
      if (p.expect.channel && channel !== p.expect.channel) {
        // Reported, not gated — same policy as mcp/eval: channel assignment is Lane A's open question.
        say(`  note  ${p.id}: channel ${channel}, expected ${p.expect.channel}`);
      }
      say(
        `        action: ${String(action.priority)} / ${String(action.status)} — ${String(action.statusDetail).slice(0, 90)}`,
      );
    }

    // ---- no false alarms on days where nothing was planted --------------------------------
    say(`\nQUIET DAYS — nothing was planted here, so nothing may be reported`);
    for (const offset of CLEAN_DAYS) {
      const d = dateOf(offset);
      const res = await call(session, "investigate", { metric: "revenue", from: d, to: d });
      const channel = String(res.data.channel ?? "");
      const findings = (res.data.findings ?? []) as Array<{ segment: unknown | null }>;
      const named = findings.some((f) => f.segment);
      const quiet = (channel === "no_anomaly" || channel === "seasonality") && !named;
      say(`  ${quiet ? "ok  " : "MISS"} ${d}  revenue -> ${channel}${named ? " AND named a cause" : ""}`);
      if (!quiet) {
        failures++;
        say(`        Nothing was planted on this day. A cause here is invented.`);
      }
    }

    // ---- weekends are seasonality, not incidents ------------------------------------------
    const weekends = weekendOffsets().map(dateOf);
    const weekendWindows = windows.filter((win) =>
      weekends.some((d) => overlaps(win.from, win.to, d, d)) &&
      !PLANTED.some((p) => overlaps(win.from, win.to, dateOf(p.fromDay), dateOf(p.toDay))),
    );
    say(`\nSEASONALITY — weekends run at ${(SHAPE.weekendVolumeFactor * 100).toFixed(0)}% of weekday volume by design`);
    say(
      `  ${weekendWindows.length === 0 ? "ok  " : "note"} ${weekendWindows.length} unplanted window(s) ` +
        `touching a weekend — the same-weekday baseline should absorb the cycle entirely`,
    );

    // ---- scorecard -------------------------------------------------------------------------
    const planted = PLANTED.length;
    say(`\nSCORECARD`);
    say(`  planted deviations   ${planted}`);
    say(`  windows reported     ${windows.length}  (${spurious.length} not attributable to a planted deviation)`);
    say(`  gated failures       ${failures}`);
    say(`  seed                 ${SHAPE.seed}  — rebuild reproduces this dataset exactly`);
    say(
      failures === 0
        ? `\nEvery planted deviation was found and localized, nothing was invented on a quiet day.\n`
        : `\n${failures} gated failure(s) above. This is a dataset the engine has never seen.\n`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    session.export();
    await session.close();
    await shutdownObservability();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    say(`verify failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
