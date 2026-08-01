/**
 * What the queries actually cost, per tool call, read from `system.query_log`.
 *
 * `Ledger.run` already prepends `/* bench run=<runId> stage=<stage> *​/` to every query it sends, and
 * this server gives each tool call its own ledger with `runId = <session>-<callId>` and the tool name
 * as the stage. So cost attribution per call is free — it needs a query, not instrumentation.
 *
 * Deliberately NOT reusing `collectCosts` from backend/benchmark.ts: it is private to that module
 * (exporting it would be a cross-lane edit) and it polls for up to 240s because a benchmark that
 * under-reports is worse than one that fails. The opposite trade-off is right here — this decorates a
 * report that has already been produced, so it is best-effort with a short deadline and an explicit
 * "not available" state. A diagnosis must never wait on telemetry.
 *
 * `query_log` on ClickHouse Cloud is flushed asynchronously and can lag by a minute or more, so an
 * empty result means "not flushed yet", never "cost was zero" — and the report says so rather than
 * printing zeros that look authoritative.
 */
import type { Ledger } from "../engine/ledger";

export interface StageCost {
  callId: string;
  stage: string;
  queries: number;
  serverMs: number;
  readRows: number;
  readBytes: number;
  peakMemoryBytes: number;
}

export interface CostReport {
  available: boolean;
  reason?: string;
  stages: StageCost[];
  totals: {
    queries: number;
    serverMs: number;
    readRows: number;
    readBytes: number;
    peakMemoryBytes: number;
  };
}

const num = (v: unknown): number => Number(v ?? 0);

const EMPTY: CostReport["totals"] = {
  queries: 0,
  serverMs: 0,
  readRows: 0,
  readBytes: 0,
  peakMemoryBytes: 0,
};

/**
 * Pull per-call cost for one session. `sessionRunId` is the session's own id; each call's ledger
 * tags itself `<sessionRunId>-<callId>`, so one prefix match covers the whole session.
 */
export async function readCost(
  ledger: Ledger,
  sessionRunId: string,
  opts: { timeoutMs?: number; expectedQueries?: number } = {},
): Promise<CostReport> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const expected = opts.expectedQueries ?? 1;

  const sql = `
SELECT
  extract(query, 'bench run=[a-z0-9]+-(c[0-9]+)') AS call_id,
  extract(query, 'stage=([a-z_]+)')               AS stage,
  count()                AS queries,
  sum(query_duration_ms) AS server_ms,
  sum(read_rows)         AS read_rows,
  sum(read_bytes)        AS read_bytes,
  max(memory_usage)      AS peak
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL 30 MINUTE
  AND query LIKE '%bench run=${sessionRunId}-%'
  AND query NOT LIKE '%system.query_log%'
GROUP BY call_id, stage
ORDER BY call_id`.trim();

  const deadline = Date.now() + timeoutMs;
  let best: StageCost[] = [];

  while (Date.now() < deadline) {
    const rows = await ledger.run<Record<string, unknown>>(sql);
    const stages: StageCost[] = rows.map((r) => ({
      callId: String(r.call_id ?? ""),
      stage: String(r.stage ?? "(untagged)"),
      queries: num(r.queries),
      serverMs: num(r.server_ms),
      readRows: num(r.read_rows),
      readBytes: num(r.read_bytes),
      peakMemoryBytes: num(r.peak),
    }));
    const seen = stages.reduce((a, s) => a + s.queries, 0);
    if (stages.length > best.length) best = stages;
    if (seen >= expected) break;
    await new Promise((r) => setTimeout(r, 1_500));
  }

  if (best.length === 0) {
    return {
      available: false,
      reason:
        "system.query_log had not flushed within the deadline. On ClickHouse Cloud it lags " +
        "asynchronously by up to a minute; this is not a cost of zero.",
      stages: [],
      totals: EMPTY,
    };
  }

  return {
    available: true,
    stages: best,
    totals: best.reduce(
      (a, s) => ({
        queries: a.queries + s.queries,
        serverMs: a.serverMs + s.serverMs,
        readRows: a.readRows + s.readRows,
        readBytes: a.readBytes + s.readBytes,
        peakMemoryBytes: Math.max(a.peakMemoryBytes, s.peakMemoryBytes),
      }),
      EMPTY,
    ),
  };
}
