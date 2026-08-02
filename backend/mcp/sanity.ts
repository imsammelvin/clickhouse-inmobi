/**
 * Everything, in one command. The pre-freeze "are we actually good?" run.
 *
 *   bun run sanity                      # all of it, ~8-12 minutes
 *   bun run sanity -- --quick           # skip the slow gates, ~90s
 *   bun run sanity -- --only mcp        # one gate, or a group, by name substring
 *   bun run sanity -- --list            # what it would run, and roughly how long
 *
 * `bun run verify` is the subset a lane runs before pushing: seven gates, all of them about whether the
 * ANSWERS are right. This is the superset, and the extra gates are about everything that has to be true
 * for those answers to reach anyone — the database is reachable, the tool surface boots and exposes what
 * we claim it exposes, the servers serve, no key got committed.
 *
 * Those are the failures that do not show up in an eval and do not show up in a diff. A perfect
 * `mcp:eval` score means nothing if the MCP server does not start, and every gate here exists because
 * something in this list has broken at least once.
 *
 * Ordered cheapest-first inside each phase, and phases ordered so a broken foundation surfaces before
 * anything spends five minutes on top of it. Nothing here mutates data: no `synth:build`, no
 * `ch:load`, no `synth:destroy`. It is safe to run at any point, including mid-demo.
 */
import { existsSync } from "node:fs";
import { type CheckResult, type Gate, lastMatch, runGates } from "./gates";

const QUICK = process.argv.includes("--quick");
const LIST = process.argv.includes("--list");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

// -------------------------------------------------------------------------------------------------
// in-process checks — the things with no command of their own
// -------------------------------------------------------------------------------------------------

/** Wait for a port to accept connections, or give up. Avoids a fixed sleep that is wrong either way. */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(300);
  }
  return false;
}

/**
 * Start the dashboard on its own port and probe every endpoint it serves.
 *
 * On a port of its own so this never collides with the one running for the demo, and never kills it.
 * Every route is checked rather than a single health ping: the routes are registered in one place and
 * a merge has already dropped one of them out of the table without anything noticing.
 */
async function checkDashboard(): Promise<CheckResult> {
  const port = 4590;
  const proc = Bun.spawn(["bun", "run", "backend/dashboard-server/server.ts"], {
    env: { ...process.env, DASHBOARD_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    if (!(await waitForPort(port, 25_000))) {
      const err = await new Response(proc.stderr).text();
      return { state: "fail", summary: "did not come up", detail: err.slice(-1500) };
    }

    const routes = [
      "/api/config",
      "/api/anomalies",
      "/api/watch",
      "/api/rollup-comparison",
      "/api/llm-cost",
      "/api/system-health",
      "/", // the static index
    ];
    const bad: string[] = [];
    for (const r of routes) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${r}`, {
          signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) bad.push(`${r} -> ${res.status}`);
        else if (r.startsWith("/api/")) {
          // A 200 carrying `{"error": ...}` is the failure mode that looks healthy from outside.
          const body = (await res.json()) as { error?: string };
          if (body.error)
            bad.push(`${r} -> 200 but {"error": "${String(body.error).slice(0, 60)}"}`);
        }
      } catch (error) {
        bad.push(`${r} -> ${(error as Error).message}`);
      }
    }
    return bad.length
      ? {
          state: "fail",
          summary: `${bad.length}/${routes.length} route(s) bad`,
          detail: bad.join("\n"),
        }
      : { state: "pass", summary: `${routes.length} routes served` };
  } finally {
    proc.kill();
    await proc.exited;
  }
}

/**
 * Speak MCP to the stdio server the way LibreChat does, and check what it advertises.
 *
 * The tool list is the product's contract with the judge: this asserts the tools are all there AND
 * that nothing resembling a raw-SQL escape hatch has appeared. "The LLM never writes SQL" is the
 * central architectural claim, and a claim nothing tests is a claim someone can add a tool and break
 * without noticing.
 */
async function checkMcpHandshake(): Promise<CheckResult> {
  const proc = Bun.spawn(["bun", "run", "backend/mcp/server.ts", "--transport", "stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const send = (o: unknown): void => {
      proc.stdin.write(`${JSON.stringify(o)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sanity", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await proc.stdin.flush();

    // Read newline-delimited JSON until both ids have answered, or time out.
    const seen = new Map<number, Record<string, unknown>>();
    const deadline = Date.now() + 40_000;
    let buffer = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (seen.size < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === "number") seen.set(msg.id, msg as Record<string, unknown>);
        } catch {
          // Not a JSON-RPC line. The server writes its banner to stderr, so this should not happen —
          // but a stray stdout write would corrupt the stream for a real client, so surface it.
          return { state: "fail", summary: "non-JSON on stdout", detail: line.slice(0, 400) };
        }
      }
    }

    const init = seen.get(1);
    const list = seen.get(2);
    if (!init || !list) {
      const err = await new Response(proc.stderr).text();
      return {
        state: "fail",
        summary: `no reply to ${!init ? "initialize" : "tools/list"}`,
        detail: err.slice(-1500),
      };
    }
    if ("error" in init)
      return {
        state: "fail",
        summary: "initialize returned an error",
        detail: JSON.stringify(init),
      };

    const tools = ((list.result as { tools?: Array<{ name: string }> })?.tools ?? []).map(
      (t) => t.name,
    );
    const problems: string[] = [];

    // The tools the answer layer cannot work without. Not the full list on purpose — this should not
    // need editing every time a tool is added, only when one that matters disappears.
    const required = [
      "describe_data",
      "get_metric",
      "compare_periods",
      "rank_segments",
      "find_incidents",
      "investigate",
      "explain_revenue",
      "get_evidence",
      "export_trace",
      "watch_this",
    ];
    const missing = required.filter((r) => !tools.includes(r));
    if (missing.length) problems.push(`missing tool(s): ${missing.join(", ")}`);

    // The no-SQL guarantee, asserted rather than assumed.
    const sqlish = tools.filter((t) => /sql|query|exec|raw/i.test(t));
    if (sqlish.length) problems.push(`SQL-shaped tool(s) exposed: ${sqlish.join(", ")}`);

    return problems.length
      ? { state: "fail", summary: problems[0], detail: problems.join("\n") }
      : { state: "pass", summary: `${tools.length} tools, no SQL escape hatch` };
  } finally {
    proc.kill();
    await proc.exited;
  }
}

/**
 * No credential in anything git tracks.
 *
 * Earned its place: this repo has been blocked by GitHub push protection twice, and a key that reaches
 * origin is compromised whether or not the history is later rewritten. Scans the index rather than the
 * working tree, because what is tracked is what would be pushed.
 */
async function checkNoSecrets(): Promise<CheckResult> {
  const files = Bun.spawn(["git", "ls-files"], { stdout: "pipe" });
  const list = (await new Response(files.stdout).text()).split("\n").filter(Boolean);
  await files.exited;

  const PATTERNS: Array<[string, RegExp]> = [
    ["OpenAI/DeepSeek-style key", /\bsk-[A-Za-z0-9]{20,}\b/],
    ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
    [
      "Slack/Discord webhook",
      /https:\/\/hooks\.slack\.com\/services\/\S+|https:\/\/discord\.com\/api\/webhooks\/\S+/,
    ],
    /**
     * A real Resend key is `re_` then base62 with no underscores. Requiring a digit and forbidding
     * underscores is what separates it from an identifier that merely starts the same way.
     *
     * The loose version matched `re_everyone_description_var` in 21 of LibreChat's i18n bundles. A
     * scanner that cries wolf on vendored translation files is one nobody reads the output of, which
     * costs more than the pattern was ever worth.
     */
    ["Resend key", /\bre_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}\b/],
    [
      "generic bearer secret",
      /\b(?:api[_-]?key|secret|password)\s*[:=]\s*["'][A-Za-z0-9/+_-]{24,}["']/i,
    ],
  ];
  /**
   * Files whose whole job is to show the SHAPE of a credential, plus vendored upstream code.
   *
   * `frontend/LibreChat` is 3,792 files of someone else's project, and its test fixtures contain
   * exactly the placeholder keys this scanner looks for (`apiKey: 'sk-...'` in an Anthropic spec).
   * Those are not our credentials and we cannot fix them. What this gate exists to catch is a key
   * WE committed; widening it to shout about upstream's test data would bury that signal.
   */
  const ALLOW =
    /(^|\/)(\.env\.example|.*\.example|.*\.sample)$|^frontend\/LibreChat\/|\.spec\.[tj]sx?$|\.test\.[tj]sx?$/;

  const hits: string[] = [];
  for (const f of list) {
    if (ALLOW.test(f) || !existsSync(f)) continue;
    let text: string;
    try {
      text = await Bun.file(f).text();
    } catch {
      continue; // binary or unreadable
    }
    for (const [what, re] of PATTERNS) {
      const m = text.match(re);
      if (m) hits.push(`${f}: ${what} — ${m[0].slice(0, 12)}…`);
    }
  }
  return hits.length
    ? {
        state: "fail",
        summary: `${hits.length} possible secret(s) in tracked files`,
        detail: hits.join("\n"),
      }
    : { state: "pass", summary: `${list.length} tracked files clean` };
}

/**
 * What is wired up, reported rather than judged.
 *
 * Never fails. Every one of these is optional, and a missing DeepSeek key is why `narrate` SKIPs
 * rather than a defect — but "which integrations were live when this ran" is the first question asked
 * of a green report, and it belongs in the report rather than in someone's memory.
 */
async function checkEnvironment(): Promise<CheckResult> {
  const on = (k: string): string => (process.env[k] ? "on" : "off");
  const parts = [
    `deepseek=${on("DEEPSEEK_API_KEY")}`,
    `librechat=${process.env.LIBRECHAT_URL ? "on" : "off"}`,
    `notify=${
      process.env.WATCH_WEBHOOK_URL
        ? "webhook"
        : process.env.RESEND_API_KEY
          ? "resend"
          : process.env.EMAIL_HOST
            ? "smtp"
            : "log-only"
    }`,
    `otel=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? "on" : "off"}`,
    `db=${process.env.CLICKHOUSE_DATABASE ?? "default"}`,
  ];
  return { state: "pass", summary: parts.join("  ") };
}

// -------------------------------------------------------------------------------------------------
// the gate list
// -------------------------------------------------------------------------------------------------

const GATES: Gate[] = [
  // --- foundations: if these are wrong, nothing below means anything ----------------------------
  {
    phase: "Foundations",
    name: "environment",
    what: "which optional integrations are configured for this run",
    check: checkEnvironment,
  },
  {
    phase: "Foundations",
    name: "typecheck",
    what: "the whole repo compiles",
    cmd: ["bun", "run", "typecheck"],
  },
  {
    phase: "Foundations",
    name: "ch:ping",
    what: "ClickHouse is reachable",
    cmd: ["bun", "run", "ch:ping"],
  },

  // --- data ---------------------------------------------------------------------------------------
  {
    phase: "Data",
    name: "ch:verify",
    what: "the loaded dataset is shaped the way the engine assumes",
    cmd: ["bun", "run", "ch:verify"],
    // It cross-checks ClickHouse against the source parquet through duckdb. Without that binary there
    // is nothing to compare, which is a missing tool rather than bad data.
    skipWhen: (o) => /Executable not found in \$PATH: "duckdb"/.test(o),
    summary: (o) =>
      /duckdb/.test(o) && /not found/.test(o)
        ? "duckdb not installed — brew install duckdb"
        : undefined,
  },
  {
    phase: "Data",
    name: "ch:verify-rollup",
    what: "every rollup-served answer equals the raw-scan answer",
    cmd: ["bun", "run", "ch:verify-rollup"],
    slow: true,
    summary: (o) => lastMatch(o, /\d+ probes compared[^\n]*/g),
  },

  // --- the answers --------------------------------------------------------------------------------
  {
    phase: "Answers",
    name: "criteria",
    what: "the four judging criteria, as a gate that exits non-zero",
    cmd: ["bun", "run", "criteria"],
    summary: (o) => lastMatch(o, /criteria\.failed=\d+ criteria\.total=\d+/g),
  },
  {
    phase: "Answers",
    name: "mcp:eval",
    what: "16 questions answered through the tool layer, scored against expected answers",
    cmd: ["bun", "run", "mcp:eval"],
    summary: (o) => lastMatch(o, /gated accuracy\s+\S+\s+\S+/g),
  },
  {
    phase: "Answers",
    name: "narrate",
    what: "the narrating model obeys the contract — every printed number from the ledger",
    cmd: ["bun", "run", "narrate"],
    slow: true,
    skipCode: 2, // no API key configured: a setup state, not a defect
    summary: (o) =>
      lastMatch(
        o,
        /(Narrator obeys the contract[^\n]*|\d+ narration failure\(s\)[^\n]*|no API key configured[^\n]*)/g,
      ),
  },
  {
    phase: "Answers",
    name: "synth:verify",
    what: "10 planted deviations on a dataset the engine has never seen",
    cmd: ["bun", "run", "synth:verify"],
    slow: true,
    skipCode: 2, // no scratch database / stale build
    summary: (o) =>
      lastMatch(o, /gated failures\s+\d+/g) ??
      lastMatch(o, /(STALE DATASET|SETUP ERROR|Refusing to run)[^\n]*/g),
  },

  // --- the optimisation claim ---------------------------------------------------------------------
  {
    phase: "Optimisation",
    name: "parity",
    what: "the same investigation, rollup vs raw — every recorded number identical",
    cmd: ["bun", "run", "parity"],
    slow: true,
    skipCode: 2, // rollup unavailable: nothing to compare
    summary: (o) =>
      lastMatch(
        o,
        /(VACUOUS[^\n]*|All \d+ scenario\(s\) read the rollup[^\n]*|\d+ of \d+ scenario\(s\) DIFFER[^\n]*)/g,
      ),
  },

  // --- the surfaces a human or a judge actually touches --------------------------------------------
  {
    phase: "Surfaces",
    name: "mcp:handshake",
    what: "the stdio server boots, initializes, and advertises its tools",
    check: checkMcpHandshake,
  },
  {
    phase: "Surfaces",
    name: "mcp:prompt",
    what: "the answer contract renders",
    cmd: ["bun", "run", "mcp:prompt"],
    summary: (o) => `${o.trim().length} chars of contract`,
  },
  {
    phase: "Surfaces",
    name: "dashboard",
    what: "Mission Control boots and every endpoint answers",
    check: checkDashboard,
    slow: true,
  },
  {
    phase: "Surfaces",
    name: "watch:list",
    what: "the watchman runner starts and can read its subscriptions",
    cmd: ["bun", "run", "watch", "--", "--list"],
  },

  // --- hygiene ------------------------------------------------------------------------------------
  {
    phase: "Hygiene",
    name: "secrets",
    what: "no credential in anything git tracks",
    check: checkNoSecrets,
  },
  {
    /**
     * Advisory, not gating. `origin/main` has never been prettier-clean — nine files were already
     * failing before any of this branch's work, several of them owned by other lanes, and
     * `BROADCAST.md` is append-only so reformatting it is not allowed at all.
     *
     * A gate that is red on the day it lands teaches everyone to skim past red, which costs more than
     * the formatting is worth. Reported every run so the number is visible and can be driven down by
     * whoever owns each file.
     */
    phase: "Hygiene",
    name: "format:check",
    what: "formatting matches prettier (advisory — main is not clean)",
    cmd: ["bun", "run", "format:check"],
    advisory: true,
    summary: (o) => lastMatch(o, /Code style issues found in \d+ files?/g) ?? "clean",
  },
];

if (LIST) {
  process.stdout.write(`\nSANITY — ${GATES.length} gate(s)\n\n`);
  let phase = "";
  for (const g of GATES) {
    if (g.phase !== phase) {
      phase = g.phase ?? "";
      process.stdout.write(`  ${phase}\n`);
    }
    process.stdout.write(`    ${g.name.padEnd(20)} ${g.slow ? "[slow] " : "       "}${g.what}\n`);
  }
  process.stdout.write(`\n  --quick skips ${GATES.filter((g) => g.slow).length} slow gate(s)\n\n`);
  process.exit(0);
}

const failures = await runGates(GATES, { title: "SANITY", quick: QUICK, only: ONLY });
process.exit(failures ? 1 : 0);
