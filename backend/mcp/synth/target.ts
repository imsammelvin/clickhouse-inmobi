/**
 * The one place that decides which database the synthetic tooling may touch.
 *
 * Shared by `generate.ts` and `destroy.ts` deliberately: a safety guard that exists in two copies is a
 * safety guard that will eventually disagree with itself, and the failure mode here is dropping the
 * 9M-row dataset the whole project depends on.
 *
 * Two independent conditions, so one typo cannot be enough:
 *   1. the name must not be `default` — that is where the real data lives;
 *   2. the name must contain "synth" — a scratch database announces itself.
 *
 * A slip in `CLICKHOUSE_DATABASE` therefore fails loudly instead of rebuilding or deleting production.
 */
import { createClient, type ClickHouseClient } from "@clickhouse/client";

export const DEFAULT_SYNTH_DB = "rca_synth";

/** Long, because generating and dropping ~1.4M rows are both slower than a normal query. */
const TIMEOUT_MS = 600_000;

export function assertScratchDatabase(db: string): string {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(db)) {
    throw new Error(
      `Refusing database "${db}": expected lowercase letters, digits and underscores.`,
    );
  }
  if (db === "default" || !db.includes("synth")) {
    throw new Error(
      `Refusing to operate on "${db}". The synthetic tooling only ever touches a scratch database ` +
        `whose name contains "synth" — the real dataset lives in "default" and must never be a target.`,
    );
  }
  return db;
}

/** Target from `--db`, then `CLICKHOUSE_DATABASE`, then the default. Always guarded. */
export function resolveTargetDatabase(argv: string[] = process.argv): string {
  const i = argv.indexOf("--db");
  const explicit = i >= 0 ? argv[i + 1] : undefined;
  return assertScratchDatabase(explicit ?? process.env.CLICKHOUSE_DATABASE ?? DEFAULT_SYNTH_DB);
}

const credentials = (): { url: string; username: string; password: string } => {
  const url = process.env.CLICKHOUSE_URL;
  const username = process.env.CLICKHOUSE_USER;
  if (!url || !username) {
    throw new Error("Missing CLICKHOUSE_URL / CLICKHOUSE_USER. Copy .env.example to .env first.");
  }
  return { url, username, password: process.env.CLICKHOUSE_PASSWORD ?? "" };
};

/** Server-scoped client, for statements that create or drop the database itself. */
export const serverClient = (): ClickHouseClient =>
  createClient({ ...credentials(), request_timeout: TIMEOUT_MS });

/** Client bound to a guarded scratch database. */
export const scratchClient = (db: string): ClickHouseClient =>
  createClient({
    ...credentials(),
    database: assertScratchDatabase(db),
    request_timeout: TIMEOUT_MS,
  });
