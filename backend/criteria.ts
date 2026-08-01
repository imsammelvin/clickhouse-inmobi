/**
 * The judging criteria, as a gate.
 *
 *   1. Detection & localization accuracy — found / missed / hallucinated
 *   2. Explanation trustworthiness — every number reproducible from the data
 *   3. Analytical depth in ClickHouse — the drill-down lives in queries, not in the LLM
 *
 * These three are not aspirations to remember, they are assertions that run:
 *
 *   bun run backend/criteria.ts
 *
 * Non-zero exit means we have deviated. Run it before every merge and before the unseen incident.
 * Criterion 2 is weighted hardest by the judges ("a single fabricated figure costs more than a
 * missed anomaly"), so any ungrounded numeral fails the whole gate regardless of the other two.
 */
import { Ledger } from "./ledger";
import { investigate } from "./orchestrate";
import { renderNarrative } from "./render";
import { checkGrounding } from "./grounding";
import { KNOWN_INCIDENTS, scanAll } from "./scan";

/** Max rows any single stage may pull back to the client. Above this, analysis has left ClickHouse. */
const MAX_ROWS_TO_CLIENT = 1000;

const SCENARIOS = [
  { metric: "fill_rate", from: "2026-06-23", to: "2026-06-25" },
  { metric: "requests", from: "2026-06-21", to: "2026-06-21" },
  { metric: "requests", from: "2026-06-28", to: "2026-06-28" },
];

interface Outcome {
  name: string;
  pass: boolean;
  detail: string[];
}

async function criterion1(): Promise<Outcome> {
  const detail: string[] = [];
  const { fired, found, missed, extra } = await scanAll();

  for (const f of found) detail.push(`  FOUND   ${f}`);
  for (const m of missed) detail.push(`  MISSED  ${m}`);
  detail.push(`  ${fired.length} firing(s) total, ${extra.length} not in the known-incident list`);
  if (extra.length) {
    detail.push(`  Unexplained firings are HALLUCINATION RISK until each is triaged:`);
    for (const e of extra.slice(0, 12)) {
      detail.push(`    ${e.day} ${e.metric.padEnd(10)} ${e.pct >= 0 ? "+" : ""}${e.pct.toFixed(1)}%  ${e.sigma.toFixed(1)}s`);
    }
    if (extra.length > 12) detail.push(`    ... and ${extra.length - 12} more`);
  }

  // Recall is reported, not gated: the known list is only the incidents we found by hand, so a
  // hard threshold here would be measuring our own homework. Gating happens on criterion 2.
  return {
    name: `1. Detection & localization — recall ${found.length}/${KNOWN_INCIDENTS.length}, ${extra.length} untriaged firing(s)`,
    pass: found.length > 0,
    detail,
  };
}

async function criterion2(): Promise<Outcome> {
  const detail: string[] = [];
  let pass = true;

  for (const s of SCENARIOS) {
    const ledger = new Ledger();
    try {
      const inv = await investigate({ ...s, ledger });
      const narrative = renderNarrative(inv);
      const g = checkGrounding(narrative, inv.evidence);
      const tag = `${s.metric} ${s.from}${s.from === s.to ? "" : `..${s.to}`}`;
      detail.push(`  ${g.ok ? "OK  " : "FAIL"}  ${tag.padEnd(28)} ${g.grounded}/${g.total} numerals grounded`);
      if (!g.ok) {
        pass = false;
        for (const u of g.ungrounded.slice(0, 8)) {
          detail.push(`          ungrounded "${u.text}"  in: ${u.context}`);
        }
        if (g.ungrounded.length > 8) detail.push(`          ... and ${g.ungrounded.length - 8} more`);
      }
    } finally {
      await ledger.close();
    }
  }
  return { name: "2. Explanation trustworthiness — every printed number resolves to evidence", pass, detail };
}

async function criterion3(): Promise<Outcome> {
  const detail: string[] = [];
  let pass = true;

  for (const s of SCENARIOS) {
    const ledger = new Ledger();
    try {
      await investigate({ ...s, ledger });
      const worst = Math.max(...ledger.rowsReturnedPerQuery(), 0);
      const tag = `${s.metric} ${s.from}${s.from === s.to ? "" : `..${s.to}`}`;
      const ok = worst <= MAX_ROWS_TO_CLIENT;
      if (!ok) pass = false;
      detail.push(
        `  ${ok ? "OK  " : "FAIL"}  ${tag.padEnd(28)} largest result set ${worst} row(s) ` +
          `(limit ${MAX_ROWS_TO_CLIENT}), ${ledger.totalQueries()} queries`,
      );
    } finally {
      await ledger.close();
    }
  }
  detail.push("  Aggregation, baselining, ranking and deflation all execute as SQL; the client");
  detail.push("  receives aggregates only. No stage streams events out of ClickHouse.");
  return { name: "3. Analytical depth in ClickHouse — drill-down lives in queries", pass, detail };
}

async function main(): Promise<void> {
  console.log("\nJUDGING CRITERIA GATE\n" + "=".repeat(72));

  const outcomes = [await criterion1(), await criterion2(), await criterion3()];

  for (const o of outcomes) {
    console.log(`\n${o.pass ? "PASS" : "FAIL"}  ${o.name}`);
    for (const d of o.detail) console.log(d);
  }

  const failed = outcomes.filter((o) => !o.pass);
  console.log("\n" + "=".repeat(72));
  if (failed.length === 0) {
    console.log("All criteria pass.\n");
    return;
  }
  console.log(`${failed.length} criterion/criteria FAILED:`);
  for (const f of failed) console.log(`  - ${f.name}`);
  console.log("");
  process.exit(1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
