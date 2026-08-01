/**
 * T-042 — latency and data-cost benchmark harness.
 *
 * The scalability claim ("this works at petabyte scale") has to be *measured*, not asserted. What
 * makes it true is not raw speed, it is that query cost should become independent of event volume
 * once T-013's rollups exist. So the number that matters is not milliseconds — it is **rows and
 * bytes read per investigation**. Milliseconds are a property of the cluster you rented; bytes read
 * is a property of the design.
 *
 *   bun run backend/benchmark.ts                  # run and print
 *   bun run backend/benchmark.ts --save baseline  # write pitch/bench-baseline.json
 *   bun run backend/benchmark.ts --compare pitch/bench-baseline.json
 *
 * Run it again after T-043 points the engine at rollups; the delta is the scalability story.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Ledger } from "./ledger";
import { investigate } from "./orchestrate";
import {
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

/** The scenarios we benchmark. Deliberately the three demo cases — cheap, and representative. */
const SCENARIOS = [
  { name: "technical_break", metric: "fill_rate", from: "2026-06-23", to: "2026-06-25" },
  { name: "not_localizable", metric: "requests", from: "2026-06-21", to: "2026-06-21" },
  { name: "no_anomaly", metric: "requests", from: "2026-06-28", to: "2026-06-28" },
];

interface StageCost {
  stage: string;
  queries: number;
  ms: number;
  rows: number;
  bytes: number;
  peakMemBytes: number;
}

interface ScenarioResult {
  name: string;
  metric: string;
  window: string;
  wallMs: number;
  clientQueries: number;
  stages: StageCost[];
  totals: Omit<StageCost, "stage">;
}

interface Report {
  capturedAt: string;
  label: string;
  scenarios: ScenarioResult[];
  grand: Omit<StageCost, "stage">;
}

interface LogRow {
  stage: string;
  queries: string | number;
  ms: string | number;
  rows: string | number;
  bytes: string | number;
  peak: string | number;
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0);

/**
 * Pull per-(run, stage) cost out of `system.query_log` for every run at once.
 *
 * Collected once at the end rather than per scenario, because `query_log` on a managed service is
 * flushed asynchronously and can lag by a minute or more — polling three times sequentially would
 * triple a wait we only need to serve once.
 *
 * If the expected query count never appears we throw. A benchmark that silently under-reports is
 * worse than one that fails, because the number it produces looks authoritative.
 */
async function collectCosts(
  ledger: Ledger,
  runIds: string[],
  expectedTotal: number,
  timeoutMs = 240_000,
): Promise<Map<string, StageCost[]>> {
  // Spanned because this is a poll loop against an asynchronously-flushed `query_log` — when a
  // benchmark run feels stuck, this span's duration is the answer.
  return withSpan(
    "bench.collect_costs",
    { "bench.runs": runIds.length, "bench.expected_queries": expectedTotal },
    () => collectCostsInner(ledger, runIds, expectedTotal, timeoutMs),
  );
}

async function collectCostsInner(
  ledger: Ledger,
  runIds: string[],
  expectedTotal: number,
  timeoutMs: number,
): Promise<Map<string, StageCost[]>> {
  const inList = runIds.map((r) => `'${r}'`).join(",");
  const sql = `
SELECT
  extract(query, 'bench run=([a-f0-9]+)') AS run,
  extract(query, 'stage=([a-z_]+)')       AS stage,
  count()                AS queries,
  sum(query_duration_ms) AS ms,
  sum(read_rows)         AS rows,
  sum(read_bytes)        AS bytes,
  max(memory_usage)      AS peak
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL 30 MINUTE
  AND extract(query, 'bench run=([a-f0-9]+)') IN (${inList})
  AND query NOT LIKE '%system.query_log%'
GROUP BY run, stage`.trim();

  const deadline = Date.now() + timeoutMs;
  let seen = 0;

  while (Date.now() < deadline) {
    const rows = await ledger.run<LogRow & { run: string }>(sql);
    seen = rows.reduce((a, r) => a + num(r.queries), 0);
    if (seen >= expectedTotal) {
      const byRun = new Map<string, StageCost[]>();
      for (const r of rows) {
        const list = byRun.get(r.run) ?? [];
        list.push({
          stage: r.stage || "(untagged)",
          queries: num(r.queries),
          ms: num(r.ms),
          rows: num(r.rows),
          bytes: num(r.bytes),
          peakMemBytes: num(r.peak),
        });
        byRun.set(r.run, list);
      }
      for (const list of byRun.values()) list.sort((a, b) => b.ms - a.ms);
      return byRun;
    }
    process.stdout.write(
      `\r  waiting for query_log flush… ${seen}/${expectedTotal} queries visible`,
    );
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    `\nquery_log showed only ${seen}/${expectedTotal} queries within ${timeoutMs / 1000}s. ` +
      `Refusing to report partial costs — an under-reported benchmark still looks authoritative.`,
  );
}

const fmtN = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : String(n);
const fmtB = (n: number): string =>
  n >= 1 << 30
    ? `${(n / (1 << 30)).toFixed(2)} GiB`
    : n >= 1 << 20
      ? `${(n / (1 << 20)).toFixed(2)} MiB`
      : `${(n / 1024).toFixed(1)} KiB`;

function sum(stages: StageCost[]): Omit<StageCost, "stage"> {
  return {
    queries: stages.reduce((a, s) => a + s.queries, 0),
    ms: stages.reduce((a, s) => a + s.ms, 0),
    rows: stages.reduce((a, s) => a + s.rows, 0),
    bytes: stages.reduce((a, s) => a + s.bytes, 0),
    peakMemBytes: Math.max(0, ...stages.map((s) => s.peakMemBytes)),
  };
}

interface RunHandle {
  scenario: (typeof SCENARIOS)[number];
  runId: string;
  wallMs: number;
  clientQueries: number;
}

async function runScenario(s: (typeof SCENARIOS)[number]): Promise<RunHandle> {
  return withSpan(
    "bench.scenario",
    { "bench.scenario": s.name, "bench.metric": s.metric, "bench.from": s.from, "bench.to": s.to },
    async (span) => {
      const handle = await runScenarioInner(s);
      span.setAttributes({
        "bench.run_id": handle.runId,
        "bench.wall_ms": handle.wallMs,
        "bench.client_queries": handle.clientQueries,
      });
      return handle;
    },
  );
}

async function runScenarioInner(s: (typeof SCENARIOS)[number]): Promise<RunHandle> {
  const ledger = new Ledger();
  const t0 = Date.now();
  try {
    await investigate({ metric: s.metric, from: s.from, to: s.to, ledger });
    return {
      scenario: s,
      runId: ledger.runId,
      wallMs: Date.now() - t0,
      clientQueries: ledger.totalQueries(),
    };
  } finally {
    await ledger.close();
  }
}

function print(report: Report, baseline?: Report): void {
  log.info(`\n=== ${report.label} · ${report.capturedAt} ===\n`);

  for (const s of report.scenarios) {
    log.info(
      `${s.name}  (${s.metric}, ${s.window})   wall ${s.wallMs}ms, ${s.clientQueries} queries`,
    );
    log.info(
      `  ${"stage".padEnd(14)}${"q".padStart(3)}${"ms".padStart(8)}${"rows".padStart(10)}${"bytes".padStart(12)}${"peak mem".padStart(12)}`,
    );
    for (const st of s.stages) {
      log.info(
        `  ${st.stage.padEnd(14)}${String(st.queries).padStart(3)}${String(st.ms).padStart(8)}` +
          `${fmtN(st.rows).padStart(10)}${fmtB(st.bytes).padStart(12)}${fmtB(st.peakMemBytes).padStart(12)}`,
      );
    }
    log.info(
      `  ${"TOTAL".padEnd(14)}${String(s.totals.queries).padStart(3)}${String(s.totals.ms).padStart(8)}` +
        `${fmtN(s.totals.rows).padStart(10)}${fmtB(s.totals.bytes).padStart(12)}${fmtB(s.totals.peakMemBytes).padStart(12)}\n`,
    );
  }

  const g = report.grand;
  log.info(
    `GRAND TOTAL   ${g.queries} queries, ${g.ms}ms server, ${fmtN(g.rows)} rows, ${fmtB(g.bytes)} read`,
    {
      "bench.label": report.label,
      "bench.queries": g.queries,
      "bench.server_ms": g.ms,
      "bench.rows_read": g.rows,
      "bench.bytes_read": g.bytes,
      "bench.peak_mem_bytes": g.peakMemBytes,
      "bench.scenarios": report.scenarios.length,
    },
  );

  // The headline claim, stated as a ratio so it survives a change of cluster size.
  const perInvestigation = g.rows / report.scenarios.length;
  log.info(
    `\nRows read per investigation: ${fmtN(perInvestigation)} (mean over ${report.scenarios.length} scenarios)`,
  );
  log.info(
    `This is the scalability number. It must stop growing with event volume once the rollups\n` +
      `land (T-013/T-043) — that, not milliseconds, is what makes the design survive scale.`,
  );

  if (baseline) {
    const b = baseline.grand;
    const pct = (now: number, was: number) =>
      was === 0 ? "n/a" : `${(((now - was) / was) * 100).toFixed(1)}%`;
    log.info(`\n--- vs ${baseline.label} (${baseline.capturedAt}) ---`);
    log.info(`  rows read   ${fmtN(b.rows)} -> ${fmtN(g.rows)}   ${pct(g.rows, b.rows)}`);
    log.info(`  bytes read  ${fmtB(b.bytes)} -> ${fmtB(g.bytes)}   ${pct(g.bytes, b.bytes)}`);
    log.info(`  server ms   ${b.ms} -> ${g.ms}   ${pct(g.ms, b.ms)}`);
    log.info(`  queries     ${b.queries} -> ${g.queries}`);
  }
  log.info("");
}

async function main(): Promise<void> {
  initObservability();
  try {
    await withSpan("bench.main", { "bench.scenarios": SCENARIOS.length }, () => run());
  } finally {
    await shutdownObservability();
  }
}

async function run(): Promise<void> {
  const argv = process.argv;
  const saveIdx = argv.indexOf("--save");
  const cmpIdx = argv.indexOf("--compare");
  const label = saveIdx >= 0 ? (argv[saveIdx + 1] ?? "baseline") : "current";

  log.info(`running ${SCENARIOS.length} scenarios…`);
  const handles: RunHandle[] = [];
  for (const s of SCENARIOS) {
    const h = await runScenario(s);
    log.info(`  ${s.name.padEnd(18)} ${h.wallMs}ms wall, ${h.clientQueries} queries`, {
      "bench.scenario": s.name,
      "bench.metric": s.metric,
      "bench.wall_ms": h.wallMs,
      "bench.client_queries": h.clientQueries,
    });
    handles.push(h);
  }

  const collector = new Ledger();
  let byRun: Map<string, StageCost[]>;
  try {
    byRun = await collectCosts(
      collector,
      handles.map((h) => h.runId),
      handles.reduce((a, h) => a + h.clientQueries, 0),
    );
  } finally {
    await collector.close();
  }
  process.stdout.write("\r".padEnd(70) + "\r");

  const scenarios: ScenarioResult[] = handles.map((h) => {
    const stages = byRun.get(h.runId) ?? [];
    return {
      name: h.scenario.name,
      metric: h.scenario.metric,
      window:
        h.scenario.from === h.scenario.to
          ? h.scenario.from
          : `${h.scenario.from}..${h.scenario.to}`,
      wallMs: h.wallMs,
      clientQueries: h.clientQueries,
      stages,
      totals: sum(stages),
    };
  });

  const report: Report = {
    capturedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    label,
    scenarios,
    grand: sum(scenarios.flatMap((s) => s.stages)),
  };

  let baseline: Report | undefined;
  if (cmpIdx >= 0) {
    const path = argv[cmpIdx + 1];
    if (path && existsSync(path)) baseline = JSON.parse(readFileSync(path, "utf8")) as Report;
    else log.warn(`(no baseline at ${path}; printing current only)`);
  }

  print(report, baseline);

  if (saveIdx >= 0) {
    const out = `pitch/bench-${label}.json`;
    writeFileSync(out, JSON.stringify(report, null, 2));
    log.info(`written: ${out}\n`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    log.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
