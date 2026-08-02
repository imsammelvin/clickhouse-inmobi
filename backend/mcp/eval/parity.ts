/**
 * Prove that routing a stage through the rollup changes no number in the diagnosis.
 *
 *   bun run parity
 *
 * T-043 says it plainly: "Numbers must match the raw-scan results exactly — assert it, do not eyeball
 * it." This is that assertion, and it has to exist BEFORE the engine is repointed, because the failure
 * mode of a rollup is not a crash. A pre-aggregated table that is subtly wrong — a mask that cannot be
 * applied after summing, a metric that is not additive, a pair split the wrong way round — returns a
 * plausible number, and a plausible number goes into a narrative and out to a judge.
 *
 * `ch:verify-rollup` does not cover this. It probes the MCP tool layer, which already reads the rollup.
 * The six investigation stages still scan `ad_events_enriched`, so nothing currently checks them at
 * all: measured from `system.query_log`, residualize alone is 274M rows and 97s of server time across
 * 73 queries, with 0 of them rollup-served.
 *
 * HOW IT WORKS. Run the same investigation twice in one process — once normally, once with
 * `disableRollup()` forcing every plan to null — and compare the two evidence ledgers by LABEL. Labels
 * are stable (`fill_rate.incident`, `cause.os_version.Android 15.delta`); evidence *ids* are not, since
 * a rollup-served stage may issue a different number of queries. Every label present on both sides must
 * carry a bit-identical value, and a label appearing on only one side is itself a failure: it means one
 * path found something the other did not.
 *
 * This is deliberately stricter than "the headline matches". Every recorded number is compared,
 * including the ones that never reach the narrative, because a cleared-segment residual that drifts
 * today is a cause that drifts tomorrow.
 */
import { Ledger } from "../../engine/ledger";
import { investigate } from "../../engine/orchestrate";
import { disableRollup, resetRollupReady, rollupHealth } from "../../clickhouse/rollup";
import { ensureRollupReady } from "../../clickhouse/rollup";
import type { Evidence, Investigation } from "../../engine/types";
import type { Span } from "@opentelemetry/api";
import {
  initObservability,
  shutdownObservability,
  withSpan,
} from "../../../shared/utils/telemetryUtils";

const say = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};

/** The scenarios worth proving. One per cause channel the engine can reach. */
const SCENARIOS = [
  { name: "A technical_break", metric: "fill_rate", from: "2026-06-23", to: "2026-06-25" },
  { name: "B not_localizable", metric: "requests", from: "2026-06-21", to: "2026-06-21" },
  { name: "C demand_change", metric: "ecpm", from: "2026-06-19", to: "2026-06-22" },
  { name: "D segment fill dip", metric: "fill_rate", from: "2026-06-28", to: "2026-06-30" },
  { name: "E no_anomaly decoy", metric: "revenue", from: "2026-06-27", to: "2026-06-27" },
] as const;

interface Run {
  inv: Investigation;
  queries: number;
  rows: number;
  ms: number;
}

async function runOnce(s: (typeof SCENARIOS)[number]): Promise<Run> {
  const ledger = new Ledger();
  const started = Date.now();
  try {
    const inv = await investigate({ metric: s.metric, from: s.from, to: s.to, ledger });
    return {
      inv,
      queries: ledger.totalQueries(),
      rows: ledger.rowsReturnedPerQuery().reduce((a, b) => a + b, 0),
      ms: Date.now() - started,
    };
  } finally {
    await ledger.close();
  }
}

/** Values keyed by label. A duplicated label keeps the first, which is stable within a run. */
const byLabel = (evidence: Evidence[]): Map<string, number | null> => {
  const m = new Map<string, number | null>();
  for (const e of evidence) if (!m.has(e.label)) m.set(e.label, e.value);
  return m;
};

async function main(): Promise<void> {
  initObservability();
  try {
    const code = await withSpan("parity.run", { "app.scenarios": SCENARIOS.length }, runParity);
    await shutdownObservability();
    process.exit(code);
  } catch (error) {
    await shutdownObservability();
    throw error;
  }
}

/** Returns the exit code; `main` owns the exit so the root span ends and flushes first. */
async function runParity(span: Span): Promise<number> {
  let failures = 0;
  let vacuous = 0;

  // Establish whether the rollup is even available. With no rollup there is nothing to compare and
  // the honest answer is to say so rather than pass vacuously — a green run here would otherwise mean
  // "both paths read raw", which proves nothing at all.
  const probe = new Ledger();
  probe.beginStage("parity_probe");
  const health = await ensureRollupReady((sql) => probe.run(sql));
  await probe.close();

  say(`\nPARITY — the same investigation, rollup vs raw, every recorded number compared`);
  say(
    `  rollup: ${health.ready ? `ready (${health.factEvents.toLocaleString()} events)` : `NOT ready — ${health.reason}`}`,
  );
  if (!health.ready) {
    say(``);
    say(
      `  Nothing to compare: with the rollup unavailable both passes read the raw view, so a pass`,
    );
    say(`  here would be vacuous. Run \`bun run ch:rollup\` first.`);
    span.setAttribute("app.parity.outcome", "no_rollup");
    return 2;
  }

  for (const s of SCENARIOS) {
    // Rollup pass first, then force raw. Order matters only in that the raw pass must not inherit a
    // cached plan, which `resetRollupReady` + `disableRollup` together guarantee.
    //
    // `resetRollupReady` clears the module-level flag to `null` ("unchecked"), which is exactly what
    // a fresh process has -- but nothing inside `investigate()` ever calls `ensureRollupReady` itself
    // (only the MCP tool layer does, via a Session). Left alone, EVERY `planRollup()` call in this
    // "rollup" pass would see `ready !== true` and silently return null, so this pass would read raw
    // too -- indistinguishable from the real VACUOUS case, but for the wrong reason: not "no stage
    // reads the rollup" but "this harness never told the rollup module it may". Re-probe readiness
    // the same way `main()` does above, so the pass this loop calls "rollup" actually can be one.
    resetRollupReady();
    const primer = new Ledger();
    primer.beginStage("parity_probe");
    await ensureRollupReady((sql) => primer.run(sql));
    await primer.close();
    const withRollup = await runOnce(s);
    const eligible = rollupHealth()?.ready === true;

    disableRollup("parity: forcing the raw path for comparison");
    const withRaw = await runOnce(s);
    resetRollupReady();

    /**
     * Did the rollup pass actually read a rollup table?
     *
     * Without this the gate is vacuous in the exact situation it exists for. Before any stage is
     * repointed, both passes scan the raw view, every number matches trivially, and the summary would
     * announce that repointing is safe on the strength of a comparison it never made. A gate that reads
     * green having compared nothing is worse than no gate, because someone believes it.
     */
    const servedByRollup = withRollup.inv.evidence.some((e) => e.sql.includes("rollup_segment"));
    if (!servedByRollup) vacuous++;

    const a = byLabel(withRollup.inv.evidence);
    const b = byLabel(withRaw.inv.evidence);
    const labels = [...new Set([...a.keys(), ...b.keys()])].sort();

    const mismatched: string[] = [];
    const onlyOne: string[] = [];
    for (const label of labels) {
      if (!a.has(label) || !b.has(label)) {
        onlyOne.push(`${label} (only in ${a.has(label) ? "rollup" : "raw"} pass)`);
        continue;
      }
      const va = a.get(label) ?? null;
      const vb = b.get(label) ?? null;
      if (va !== vb) mismatched.push(`${label}: rollup=${va} raw=${vb}`);
    }

    const ok =
      mismatched.length === 0 &&
      onlyOne.length === 0 &&
      withRollup.inv.primaryChannel === withRaw.inv.primaryChannel &&
      withRollup.inv.headline === withRaw.inv.headline;

    if (!ok) failures++;
    say(``);
    say(
      `${ok ? "PASS" : "FAIL"}  ${s.name.padEnd(20)} ${labels.length} label(s) compared  ` +
        `[${servedByRollup ? "rollup-served" : eligible ? "VACUOUS: no stage read the rollup" : "raw"}]  ` +
        `${(withRollup.ms / 1000).toFixed(1)}s vs ${(withRaw.ms / 1000).toFixed(1)}s raw`,
    );
    say(
      `        channel ${withRollup.inv.primaryChannel}${withRollup.inv.primaryChannel === withRaw.inv.primaryChannel ? "" : ` != ${withRaw.inv.primaryChannel}`}` +
        `   queries ${withRollup.queries} vs ${withRaw.queries}`,
    );
    if (withRollup.inv.headline !== withRaw.inv.headline) {
      say(`        HEADLINE DIFFERS`);
      say(`          rollup: ${withRollup.inv.headline.slice(0, 110)}`);
      say(`          raw   : ${withRaw.inv.headline.slice(0, 110)}`);
    }
    for (const m of mismatched.slice(0, 8)) say(`        MISMATCH ${m}`);
    if (mismatched.length > 8) say(`        ... and ${mismatched.length - 8} more mismatched`);
    for (const m of onlyOne.slice(0, 6)) say(`        MISSING  ${m}`);
    if (onlyOne.length > 6) say(`        ... and ${onlyOne.length - 6} more one-sided`);
  }

  say(``);
  say("-".repeat(72));
  if (failures > 0) {
    say(
      `${failures} of ${SCENARIOS.length} scenario(s) DIFFER. A rollup-served stage is returning a\n` +
        `different number from the raw scan — do not ship it.`,
    );
  } else if (vacuous === SCENARIOS.length) {
    say(
      `VACUOUS — nothing was compared. The rollup is ready, but no investigation stage read it, so\n` +
        `both passes scanned the raw view and matching proves nothing. This is the expected state\n` +
        `until T-043 repoints a stage; it becomes a real assertion the moment one does.`,
    );
  } else if (vacuous > 0) {
    say(
      `${SCENARIOS.length - vacuous} of ${SCENARIOS.length} scenario(s) genuinely compared and identical.\n` +
        `The other ${vacuous} read no rollup table, so they assert nothing yet.`,
    );
  } else {
    say(
      `All ${SCENARIOS.length} scenario(s) read the rollup and every recorded number matched the raw\n` +
        `scan exactly. Safe to ship.`,
    );
  }
  say(``);
  span.setAttributes({
    "app.parity.failures": failures,
    "app.parity.vacuous": vacuous,
    "app.parity.outcome":
      failures > 0 ? "differ" : vacuous === SCENARIOS.length ? "vacuous" : "identical",
  });
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  main().catch((err) => {
    say(`parity failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
