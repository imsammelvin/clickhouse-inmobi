/**
 * Run every gate, in one command.
 *
 *   bun run verify              # everything
 *   bun run verify -- --quick   # skip the two slow ones (rollup equality, synthetic dataset)
 *
 * The seven gates that answer "are the ANSWERS right". For the superset that also checks the database
 * is reachable, the servers serve and no key got committed, use `bun run sanity`.
 *
 * The runner itself lives in `gates.ts`, shared with sanity: two runners that drift produce two
 * different answers to "are we green", and the one you did not run is always the one that was right.
 *
 * Ordered cheapest first so an obvious break surfaces in seconds rather than after a five-minute
 * rollup comparison. Each gate is a separate process, because that is how they are run in anger and
 * a gate that only passes when imported is not a gate.
 *
 * The synthetic dataset gate is SKIPPED, never failed, when its database is absent or stale: it needs
 * `synth:build` first, and a missing scratch database is a setup state rather than a defect. Reporting
 * it as a failure would train everyone to ignore a red line.
 *
 * Deliberately uninstrumented. Every gate below is a separate process that opens its own root span
 * and exports its own trace, so the work is already in ClickStack; a span here would only measure
 * `Bun.spawn` waiting, and it could not parent the children anyway without threading `traceparent`
 * through the environment and teaching each child to read it. Standing up an OTLP exporter to record
 * a duration this script already prints is not worth the process it would run in.
 */
import { type Gate, lastMatch, runGates } from "./gates";

const QUICK = process.argv.includes("--quick");

const GATES: Gate[] = [
  {
    name: "typecheck",
    what: "the whole repo compiles",
    cmd: ["bun", "run", "typecheck"],
  },
  {
    name: "criteria",
    what: "the four judging criteria, as a gate that exits non-zero",
    cmd: ["bun", "run", "criteria"],
    summary: (o) => lastMatch(o, /criteria\.failed=\d+ criteria\.total=\d+/g),
  },
  {
    name: "mcp:eval",
    what: "16 questions answered through the tool layer, scored against expected answers",
    cmd: ["bun", "run", "mcp:eval"],
    summary: (o) => lastMatch(o, /gated accuracy\s+\S+\s+\S+/g),
  },
  {
    name: "narrate",
    what: "the narrating model obeys the contract — every printed number from the ledger",
    cmd: ["bun", "run", "narrate"],
    slow: true,
    // Exit 2 = no API key configured. A setup state, not a defect.
    skipCode: 2,
    summary: (o) =>
      lastMatch(
        o,
        /(Narrator obeys the contract[^\n]*|\d+ narration failure\(s\)[^\n]*|no API key configured[^\n]*)/g,
      ),
  },
  {
    name: "parity",
    what: "the same investigation, rollup vs raw — every recorded number identical",
    cmd: ["bun", "run", "parity"],
    slow: true,
    // Exit 2 = the rollup is unavailable, so there is nothing to compare. Setup state, not a defect.
    skipCode: 2,
    summary: (o) =>
      lastMatch(
        o,
        /(VACUOUS[^\n]*|All \d+ scenario\(s\) read the rollup[^\n]*|\d+ of \d+ scenario\(s\) DIFFER[^\n]*)/g,
      ),
  },
  {
    name: "ch:verify-rollup",
    what: "every rollup-served answer equals the raw-scan answer",
    cmd: ["bun", "run", "ch:verify-rollup"],
    slow: true,
    summary: (o) => lastMatch(o, /\d+ probes compared[^\n]*/g),
  },
  {
    name: "synth:verify",
    what: "10 planted deviations on a dataset the engine has never seen",
    cmd: ["bun", "run", "synth:verify"],
    slow: true,
    // verify.ts exits 2 for "no database / stale build / blank dimensions" — a setup state, not a defect.
    skipCode: 2,
    summary: (o) =>
      lastMatch(o, /gated failures\s+\d+/g) ??
      lastMatch(o, /(STALE DATASET|SETUP ERROR|Refusing to run)[^\n]*/g),
  },
];

const failures = await runGates(GATES, { title: "VERIFY", quick: QUICK });
process.exit(failures ? 1 : 0);
