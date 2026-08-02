/**
 * Run every gate, in one command.
 *
 *   bun run verify              # everything
 *   bun run verify -- --quick   # skip the two slow ones (rollup equality, synthetic dataset)
 *
 * Why a runner rather than `a && b && c`: chaining stops at the first failure, so you learn one thing
 * per run and re-run four times to find out whether the other three were also broken. This runs them
 * all, reports each, and fails at the end — which is what you want at 3am before a freeze.
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
const QUICK = process.argv.includes("--quick");

interface Gate {
  name: string;
  what: string;
  cmd: string[];
  /** Slow enough to be worth skipping under --quick. */
  slow?: boolean;
  /** Exit code that means "not applicable here", reported as SKIP rather than FAIL. */
  skipCode?: number;
  /** Pull the one line worth showing out of the output. */
  summary?: (out: string) => string | undefined;
}

const lastMatch = (out: string, re: RegExp): string | undefined => {
  const hits = out.match(re);
  return hits ? hits[hits.length - 1]?.trim() : undefined;
};

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

const ms = (n: number): string => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

interface Result {
  gate: Gate;
  state: "pass" | "fail" | "skip";
  code: number;
  ms: number;
  summary?: string;
}

const results: Result[] = [];
const started = Date.now();

process.stdout.write(
  `\nVERIFY — ${GATES.filter((g) => !(QUICK && g.slow)).length} gate(s)${QUICK ? " (quick: slow gates skipped)" : ""}\n\n`,
);

for (const gate of GATES) {
  if (QUICK && gate.slow) {
    results.push({ gate, state: "skip", code: 0, ms: 0, summary: "skipped by --quick" });
    process.stdout.write(`SKIP  ${gate.name.padEnd(18)} --quick\n`);
    continue;
  }

  process.stdout.write(`....  ${gate.name.padEnd(18)} ${gate.what}\n`);
  const t0 = Date.now();
  const proc = Bun.spawn(gate.cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const elapsed = Date.now() - t0;
  const combined = `${out}\n${err}`;

  const state: Result["state"] =
    code === 0 ? "pass" : gate.skipCode !== undefined && code === gate.skipCode ? "skip" : "fail";
  const summary = gate.summary?.(combined);
  results.push({ gate, state, code, ms: elapsed, summary });

  const label = state === "pass" ? "PASS" : state === "skip" ? "SKIP" : "FAIL";
  process.stdout.write(
    `${label}  ${gate.name.padEnd(18)} ${ms(elapsed).padStart(7)}  ${summary ?? (state === "pass" ? "" : `exit ${code}`)}\n`,
  );

  // Only a real failure is worth printing output for, and only the tail — the passing detail is
  // available by running the gate directly, and burying a failure under it is how it gets missed.
  if (state === "fail") {
    const tail = combined.trimEnd().split("\n").slice(-14);
    process.stdout.write(tail.map((l) => `        ${l}`).join("\n") + "\n");
  }
}

const failed = results.filter((r) => r.state === "fail");
const skipped = results.filter((r) => r.state === "skip");

process.stdout.write(`\n${"-".repeat(72)}\n`);
process.stdout.write(
  `${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ` +
    `${skipped.length} skipped in ${ms(Date.now() - started)}\n`,
);
for (const s of skipped) {
  if (s.summary && s.summary !== "skipped by --quick") {
    process.stdout.write(`  SKIPPED ${s.gate.name}: ${s.summary}\n`);
  }
}
if (failed.length) {
  process.stdout.write(`\nFailed: ${failed.map((f) => f.gate.name).join(", ")}\n`);
  process.stdout.write(
    `Re-run one on its own for full output, e.g. \`${failed[0]!.gate.cmd.join(" ")}\`\n`,
  );
}
process.stdout.write("\n");
process.exit(failed.length ? 1 : 0);
