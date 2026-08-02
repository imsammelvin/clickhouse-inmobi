/**
 * The session, and the trace it leaves behind.
 *
 * **No trace, no credit.** The unseen-incident round is scored on what the system produced, and an
 * answer with no record of how it was reached does not count. So every tool call — parameters,
 * elapsed time, query count, the SQL hashes it ran, the evidence it created, and the error if it
 * failed — is appended to a per-session JSONL file as it happens, and the whole session can be
 * exported as a single submission artifact. Written incrementally rather than at the end because a
 * run that dies mid-investigation is exactly the run whose trace you want.
 *
 * Each call also runs inside an OTel span (`mcp.tool.<name>`), so the same activity shows up in
 * ClickStack next to the ClickHouse spans the client already emits, and the span/trace ids are
 * copied into the JSONL record so the two views join.
 *
 * Evidence identity. Every tool call gets its own `Ledger`, so `e1` from one call and `e1` from
 * another are different facts. What the model sees is therefore a qualified id — `c4/e12`, call 4's
 * twelfth number — and `get_evidence` resolves it back to the exact SQL, hash and window that
 * produced it. One ClickHouse client is shared across the session so per-call ledgers cost nothing.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import type { ClickHouseClient } from "@clickhouse/client";
import { makeClient } from "../clickhouse/client";
import { Ledger } from "../engine/ledger";
import { ensureDatasetBounds } from "../engine/baseline";
import { ensureRollupReady } from "../clickhouse/rollup";
import type { Evidence } from "../engine/types";
import { trySpan } from "../../shared/utils/telemetryUtils";

/** Where session traces land. Relative to the repo root, gitignored except for kept exhibits. */
const TRACE_DIR = process.env.MCP_TRACE_DIR ?? "backend/mcp/traces";

export interface ToolCallRecord {
  /** `c1`, `c2`, ... — also the namespace for this call's evidence ids. */
  callId: string;
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
  queries: number;
  /** Rows each query handed back to the client — the criterion-3 measure. */
  rowsReturned: number[];
  evidenceIds: string[];
  sqlHashes: string[];
  summary: string;
  error?: string;
  at: string;
  otelTraceId?: string;
  otelSpanId?: string;
}

export interface SessionTrace {
  runId: string;
  startedAt: string;
  calls: ToolCallRecord[];
  totals: { calls: number; queries: number; ms: number; evidence: number };
}

/** What a tool handler returns: a payload for the model plus a one-line summary for the trace. */
export interface ToolOutcome {
  payload: unknown;
  summary: string;
}

export class Session {
  readonly runId: string;
  readonly startedAt = new Date().toISOString();
  private readonly client: ClickHouseClient;
  private readonly calls: ToolCallRecord[] = [];
  /** Qualified id (`c4/e12`) -> the evidence row, for the whole session. */
  private readonly evidence = new Map<string, Evidence & { callId: string; tool: string }>();
  private seq = 0;
  private readonly tracePath: string;
  /** Memoized dataset-bounds resolution — see `ready()`. */
  private bounds?: Promise<unknown>;
  /** Memoized `describe_data` result — see `getOverview()`. */
  private overview?: Promise<unknown>;

  /**
   * Who is asking, when LibreChat is configured to say.
   *
   * It substitutes `{{LIBRECHAT_USER_ID}}` / `{{LIBRECHAT_USER_EMAIL}}` into MCP request headers and
   * re-resolves them before every tool call, so identity arrives per request rather than per process.
   * Defaults to "anonymous" so everything still works when the headers are not configured — a watch
   * simply is not tied to an account, and the tool says so rather than pretending it is.
   */
  userId = "anonymous";
  userEmail: string | undefined;

  constructor(client?: ClickHouseClient, runId?: string) {
    this.client = client ?? makeClient();
    this.runId = runId ?? randomUUID().slice(0, 8);
    mkdirSync(TRACE_DIR, { recursive: true });
    this.tracePath = join(TRACE_DIR, `session-${this.runId}.jsonl`);
    this.append({ type: "session_start", runId: this.runId, startedAt: this.startedAt });
  }

  /**
   * Resolve the real dataset bounds before the first tool call, once per session.
   *
   * Not optional, and the reason is the unseen incident. `DATASET_START`/`DATASET_END` default to the
   * training slice, and this server pastes them into window validation and into the sweep's WHERE
   * clause. Against a Day-2 slice that starts anywhere else, every window a judge asks about is
   * rejected as "outside the loaded data" and the sweep matches zero rows — no error, no empty
   * result to notice, and a trace that looks like a clean run. Awaited inside `run()` rather than
   * left to the entry point so it cannot be forgotten by a new caller (the CLI, the eval, a test).
   */
  private ready(): Promise<unknown> {
    this.bounds ??= (async () => {
      const bootstrap = <T>(sql: string): Promise<T[]> => {
        const ledger = new Ledger(this.client, `${this.runId}-bounds`);
        ledger.beginStage("bounds");
        return ledger.run<T>(sql);
      };
      const bounds = await ensureDatasetBounds(bootstrap);

      // Same argument as the bounds check above, applied to the rollup: a derived table's failure
      // mode is being BEHIND its source, and behind does not throw — it returns fewer rows, which
      // reads as a quiet day. So the rollup is proven to account for every event in `ad_events`
      // before anything is allowed to read it; if it cannot, every query falls back to the raw view
      // and the only thing that changes is latency.
      const health = await ensureRollupReady(bootstrap);
      this.append({ type: "rollup_health", ...health });
      return bounds;
    })();
    return this.bounds;
  }

  /**
   * Memoize a call-scoped read that is pure for the life of the session — the model is told to call
   * `describe_data` once at the start of a conversation, but nothing stops it (or a multi-turn agent
   * loop) asking again, and each ask was a full `ad_events_enriched` scan for the same fixed answer.
   * Generic rather than typed to `DatasetOverview` specifically, same reason `bounds` above isn't:
   * one memoization slot, reused for whichever pure per-session read needs it.
   */
  getOverview<T>(compute: () => Promise<T>): Promise<T> {
    this.overview ??= compute();
    return this.overview as Promise<T>;
  }

  private append(line: unknown): void {
    try {
      appendFileSync(this.tracePath, `${JSON.stringify(line)}\n`);
    } catch {
      // A trace we cannot write must not take the answer down with it. The in-memory session
      // trace and the OTel span still carry the record, and export_trace still works.
    }
  }

  /**
   * Run one tool call: fresh ledger, span, timing, trace record.
   *
   * Errors are captured rather than thrown — an MCP tool error is a result the model should read and
   * react to (usually by fixing an argument), not an exception that kills the connection. The span
   * is still marked ERROR, so a failed call is as visible in ClickStack as a successful one.
   */
  async run(
    tool: string,
    args: unknown,
    handler: (ledger: Ledger, callId: string) => Promise<ToolOutcome>,
  ): Promise<{ ok: boolean; payload: unknown; record: ToolCallRecord }> {
    await this.ready();
    const callId = `c${++this.seq}`;
    const ledger = new Ledger(this.client, `${this.runId}-${callId}`);
    ledger.beginStage(tool);

    // Captured inside the callback, not after: by the time `trySpan` returns, its span has ended
    // and is no longer the active one, so reading the context out here would silently record the
    // parent's ids — or none at all — and the JSONL would no longer join to ClickStack.
    let spanCtx: ReturnType<Span["spanContext"]> | undefined;
    const outcome = await trySpan(
      `mcp.tool.${tool}`,
      {
        "app.mcp.tool": tool,
        "app.mcp.call_id": callId,
        "app.mcp.run_id": this.runId,
        "app.mcp.args": JSON.stringify(args ?? {}).slice(0, 900),
      },
      async (span) => {
        spanCtx = span.spanContext();
        return handler(ledger, callId);
      },
    );
    const created = ledger.all();
    for (const e of created) {
      this.evidence.set(`${callId}/${e.id}`, { ...e, callId, tool });
    }

    const record: ToolCallRecord = {
      callId,
      tool,
      args,
      ok: outcome.ok,
      ms: outcome.ms,
      queries: ledger.totalQueries(),
      rowsReturned: ledger.rowsReturnedPerQuery(),
      evidenceIds: created.map((e) => `${callId}/${e.id}`),
      sqlHashes: [...new Set(created.map((e) => e.sqlHash))],
      summary: outcome.ok ? outcome.value.summary : "failed",
      ...(outcome.ok ? {} : { error: outcome.error.message }),
      at: new Date().toISOString(),
      ...(spanCtx ? { otelTraceId: spanCtx.traceId, otelSpanId: spanCtx.spanId } : {}),
    };
    this.calls.push(record);
    this.append({ type: "tool_call", ...record });

    return {
      ok: outcome.ok,
      payload: outcome.ok ? outcome.value.payload : { error: outcome.error.message },
      record,
    };
  }

  /** Resolve a qualified evidence id (`c4/e12`). Bare `e12` resolves if it is unambiguous. */
  lookupEvidence(id: string): (Evidence & { callId: string; tool: string }) | undefined {
    const direct = this.evidence.get(id);
    if (direct) return direct;
    if (!id.includes("/")) {
      const hits = [...this.evidence.entries()].filter(([k]) => k.endsWith(`/${id}`));
      if (hits.length === 1) return hits[0]![1];
    }
    return undefined;
  }

  /** Full evidence rows produced by one call, for the report's receipts table. */
  evidenceFor(callId: string): Array<Evidence & { qualifiedId: string }> {
    return [...this.evidence.entries()]
      .filter(([, e]) => e.callId === callId)
      .map(([id, e]) => ({ ...e, qualifiedId: id }));
  }

  evidenceIndex(): Array<{ id: string; label: string; value: number | null; unit: string }> {
    return [...this.evidence.entries()].map(([id, e]) => ({
      id,
      label: e.label,
      value: e.value,
      unit: e.unit,
    }));
  }

  snapshot(): SessionTrace {
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      calls: this.calls,
      totals: {
        calls: this.calls.length,
        queries: this.calls.reduce((a, c) => a + c.queries, 0),
        ms: this.calls.reduce((a, c) => a + c.ms, 0),
        evidence: this.evidence.size,
      },
    };
  }

  /** Write the whole session as one artifact and return its path. */
  export(): { path: string; trace: SessionTrace } {
    const trace = this.snapshot();
    const path = join(TRACE_DIR, `trace-${this.runId}.json`);
    writeFileSync(
      path,
      `${JSON.stringify({ ...trace, evidence: this.evidenceIndex() }, null, 2)}\n`,
    );
    return { path, trace };
  }

  get traceFile(): string {
    return this.tracePath;
  }

  /**
   * A ledger for out-of-band queries that are not tool calls — currently only the `system.query_log`
   * cost read. Kept separate so it cannot distort a tool's own query count or evidence, and tagged
   * `stage=cost` so it is identifiable in the log it is reading.
   */
  costLedger(): Ledger {
    const ledger = new Ledger(this.client, `${this.runId}-cost`);
    ledger.beginStage("cost");
    return ledger;
  }

  async close(): Promise<void> {
    this.append({
      type: "session_end",
      at: new Date().toISOString(),
      totals: this.snapshot().totals,
    });
    await this.client.close();
  }
}
