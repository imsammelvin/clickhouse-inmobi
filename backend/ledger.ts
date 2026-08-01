/**
 * The evidence ledger and the only sanctioned path to a number.
 *
 * Every query the engine runs goes through `Ledger.run`, which records the SQL, hashes it, and
 * hands back rows. Nothing else in `backend/` should import the ClickHouse client directly — that
 * is what makes "every number is reproducible" a property of the code rather than a promise.
 */
import { createHash } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { makeClient, select } from "../clickhouse/client";
import type { Evidence, PlanStep } from "./types";

export class Ledger {
  private readonly client: ClickHouseClient;
  private readonly evidence: Evidence[] = [];
  private seq = 0;
  private queryCount = 0;
  private readonly steps: PlanStep[] = [];
  private stage = "init";
  private stageStart = 0;
  private stageQueries = 0;

  constructor(client?: ClickHouseClient) {
    this.client = client ?? makeClient();
  }

  beginStage(name: string): void {
    this.stage = name;
    this.stageStart = Date.now();
    this.stageQueries = this.queryCount;
  }

  endStage(summary: string): void {
    this.steps.push({
      stage: this.stage,
      startedAt: this.stageStart,
      ms: Date.now() - this.stageStart,
      queries: this.queryCount - this.stageQueries,
      summary,
    });
  }

  /** Run a SELECT. This is the only place SQL reaches the server. */
  async run<T>(sql: string): Promise<T[]> {
    this.queryCount++;
    try {
      return await select<T>(this.client, sql);
    } catch (err) {
      // Surface the SQL. A failing query with no text is unusable at 3am.
      throw new Error(
        `Query failed in stage "${this.stage}":\n${sql}\n\n${(err as Error).message}`,
      );
    }
  }

  /**
   * Record a number. Returns the evidence id so callers embed `[e7]` rather than the literal.
   * A null value is still recorded — "we looked and got nothing back" is itself evidence.
   */
  record(e: Omit<Evidence, "id" | "sqlHash">): string {
    const id = `e${++this.seq}`;
    this.evidence.push({
      ...e,
      id,
      sqlHash: createHash("sha256").update(e.sql).digest("hex").slice(0, 12),
    });
    return id;
  }

  get(id: string): Evidence | undefined {
    return this.evidence.find((e) => e.id === id);
  }

  all(): Evidence[] {
    return [...this.evidence];
  }

  plan(): PlanStep[] {
    return [...this.steps];
  }

  totalQueries(): number {
    return this.queryCount;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
