/**
 * The gate runner shared by `bun run verify` and `bun run sanity`.
 *
 * Extracted from `verify-all.ts` when the second runner appeared, rather than copied: two runners that
 * drift produce two different answers to "are we green", and the one you did not run is always the one
 * that was right.
 *
 * A gate is either a subprocess (`cmd`) or an in-process check (`check`). Subprocesses are the default
 * and the honest choice for anything that ships as a command — a gate that only passes when imported is
 * not a gate. `check` exists for the things that have no command of their own: probing a server that
 * this script starts and stops, or reading the git index.
 */
export interface CheckResult {
  state: "pass" | "fail" | "skip";
  summary?: string;
  /** Printed indented under a failure, same as a subprocess tail. */
  detail?: string;
}

export interface Gate {
  name: string;
  what: string;
  /** Grouping header in the output. Gates with the same phase print under one heading. */
  phase?: string;
  /** Run as a subprocess. Mutually exclusive with `check`. */
  cmd?: string[];
  /** Run in-process. Mutually exclusive with `cmd`. */
  check?: () => Promise<CheckResult>;
  /** Slow enough to be worth skipping under --quick. */
  slow?: boolean;
  /** Exit code that means "not applicable here", reported as SKIP rather than FAIL. */
  skipCode?: number;
  /**
   * Recognise a missing tool or absent fixture from the output and report SKIP instead of FAIL.
   *
   * For gates whose command exits 1 for everything, so an exit code cannot tell "this is broken"
   * from "this needs a binary you have not installed". Calling the second one a failure is how a
   * report full of red gets ignored.
   */
  skipWhen?: (out: string) => boolean;
  /**
   * Report but never fail the run.
   *
   * For findings that are real and worth seeing but were not caused by, and cannot be fixed by, the
   * person running this. A gate that is red the day it lands teaches everyone to skim past red.
   */
  advisory?: boolean;
  /** Pull the one line worth showing out of the output. */
  summary?: (out: string) => string | undefined;
}

export const lastMatch = (out: string, re: RegExp): string | undefined => {
  const hits = out.match(re);
  return hits ? hits[hits.length - 1]?.trim() : undefined;
};

export const ms = (n: number): string => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

interface Result {
  gate: Gate;
  state: "pass" | "fail" | "skip" | "warn";
  code: number;
  ms: number;
  summary?: string;
}

export interface RunOptions {
  /** Banner word: "VERIFY" or "SANITY". */
  title: string;
  quick: boolean;
  /** Run only gates whose name contains this string. */
  only?: string;
}

/**
 * Run them all and report at the end.
 *
 * Deliberately does not stop at the first failure. Chaining with `&&` teaches you one thing per run and
 * needs four runs to learn whether the other three were also broken — the wrong trade at 3am before a
 * freeze. Ordered cheapest-first by the caller so an obvious break surfaces in seconds.
 *
 * Returns the failure count; the caller owns the exit code.
 */
export async function runGates(gates: Gate[], opts: RunOptions): Promise<number> {
  const selected = gates.filter((g) => !opts.only || g.name.includes(opts.only));
  const results: Result[] = [];
  const started = Date.now();
  const out = (s: string): void => {
    process.stdout.write(s);
  };

  const willRun = selected.filter((g) => !(opts.quick && g.slow)).length;
  out(
    `\n${opts.title} — ${willRun} gate(s)${opts.quick ? " (quick: slow gates skipped)" : ""}` +
      `${opts.only ? ` matching "${opts.only}"` : ""}\n`,
  );
  if (selected.length === 0) {
    out(`\nNothing matched "${opts.only}". Names: ${gates.map((g) => g.name).join(", ")}\n\n`);
    return 0;
  }

  let phase: string | undefined;
  // One blank line before the first gate when there are no phases to introduce it, not one before
  // every gate — `verify` has no phases and was getting double-spaced.
  let opened = false;
  for (const gate of selected) {
    if (gate.phase && gate.phase !== phase) {
      phase = gate.phase;
      out(`\n  ${phase}\n`);
    } else if (!opened) {
      out(`\n`);
    }
    opened = true;

    if (opts.quick && gate.slow) {
      results.push({ gate, state: "skip", code: 0, ms: 0, summary: "skipped by --quick" });
      out(`SKIP  ${gate.name.padEnd(20)} --quick\n`);
      continue;
    }

    out(`....  ${gate.name.padEnd(20)} ${gate.what}\n`);
    const t0 = Date.now();

    let state: Result["state"];
    let code = 0;
    let summary: string | undefined;
    let detail = "";

    if (gate.check) {
      try {
        const r = await gate.check();
        state = r.state;
        summary = r.summary;
        detail = r.detail ?? "";
        if (state === "fail") code = 1;
      } catch (error) {
        // A check that throws is a failed check, never a crashed run — one broken probe must not
        // cost the report for every gate after it.
        state = "fail";
        code = 1;
        detail = (error as Error).stack ?? String(error);
        summary = (error as Error).message;
      }
    } else if (gate.cmd) {
      const proc = Bun.spawn(gate.cmd, { stdout: "pipe", stderr: "pipe" });
      const [so, se] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      code = await proc.exited;
      const combined = `${so}\n${se}`;
      detail = combined;
      state =
        code === 0
          ? "pass"
          : (gate.skipCode !== undefined && code === gate.skipCode) || gate.skipWhen?.(combined)
            ? "skip"
            : "fail";
      summary = gate.summary?.(combined);
    } else {
      state = "fail";
      code = 1;
      summary = "gate defines neither cmd nor check";
    }

    const elapsed = Date.now() - t0;
    // Downgraded here rather than at the call site so `detail` below still prints: an advisory
    // finding you cannot see the content of is just a number nobody acts on.
    if (state === "fail" && gate.advisory) state = "warn";
    results.push({ gate, state, code, ms: elapsed, summary });

    const label =
      state === "pass" ? "PASS" : state === "skip" ? "SKIP" : state === "warn" ? "WARN" : "FAIL";
    out(
      `${label}  ${gate.name.padEnd(20)} ${ms(elapsed).padStart(7)}  ` +
        `${summary ?? (state === "pass" ? "" : `exit ${code}`)}\n`,
    );

    // Only a real failure is worth printing output for, and only the tail — the passing detail is
    // available by running the gate directly, and burying a failure under it is how it gets missed.
    if ((state === "fail" || state === "warn") && detail.trim()) {
      const tail = detail.trimEnd().split("\n").slice(-14);
      out(tail.map((l) => `        ${l}`).join("\n") + "\n");
    }
  }

  const failed = results.filter((r) => r.state === "fail");
  const skipped = results.filter((r) => r.state === "skip");
  const warned = results.filter((r) => r.state === "warn");

  out(`\n${"-".repeat(72)}\n`);
  out(
    `${results.length - failed.length - skipped.length - warned.length} passed, ` +
      `${failed.length} failed, ${warned.length} advisory, ${skipped.length} skipped ` +
      `in ${ms(Date.now() - started)}\n`,
  );
  for (const s of skipped) {
    if (s.summary && s.summary !== "skipped by --quick") {
      out(`  SKIPPED ${s.gate.name}: ${s.summary}\n`);
    }
  }
  for (const w of warned) out(`  ADVISORY ${w.gate.name}: ${w.summary ?? "see above"}\n`);
  if (failed.length) {
    out(`\nFailed: ${failed.map((f) => f.gate.name).join(", ")}\n`);
    const first = failed[0]!.gate;
    if (first.cmd) out(`Re-run one on its own for full output, e.g. \`${first.cmd.join(" ")}\`\n`);
  }
  out("\n");
  return failed.length;
}
