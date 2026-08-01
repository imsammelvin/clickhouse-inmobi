/**
 * Functions shared across scripts/. Values live in constants/, shapes in interfaces/.
 */
import { join } from "node:path";
import { DATA_DIR, FLOAT_TOLERANCE, REPO_ROOT, retryBackoffMs } from "../constants";
import { srcParquetFileMeta } from "../constants/queries";
import type { SourceFile } from "../enums";
import type { ParquetFileMeta } from "../interfaces";
import { withSpan } from "./telemetryUtils";

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export const sourcePath = (file: SourceFile): string => join(DATA_DIR, file);

/** Path relative to the repo root, for readable log lines. */
export const relPath = (path: string): string => path.replace(`${REPO_ROOT}/`, "");

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 9000000 -> "9,000,000" */
export const fmt = (n: number): string => n.toLocaleString("en-US");

/** Seconds since a performance.now() mark, as a number. */
export const elapsed = (t0: number): number => (performance.now() - t0) / 1000;

/** Seconds since a performance.now() mark, as "6.4s". */
export const secondsSince = (t0: number): string => `${elapsed(t0).toFixed(1)}s`;

/** Relative float comparison -- see FLOAT_TOLERANCE for why exact equality is the wrong test. */
export const closeEnough = (a: number, b: number, tolerance = FLOAT_TOLERANCE): boolean =>
  Math.abs(a - b) <= Math.abs(a) * tolerance;

// ---------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------

/**
 * Retry with exponential backoff. Ingest runs over the public internet against a cloud service;
 * a transient 503 or socket reset should cost a few seconds, not the whole load.
 */
export const withRetry = async <T>(
  what: string,
  attempts: number,
  fn: () => Promise<T>,
): Promise<T> => {
  // Spanned around the whole retry sequence, not around each attempt: the individual attempts
  // already open their own spans (they are `exec`/`insert` calls), and what is invisible without
  // this is that a step which "succeeded" actually took four goes to do it.
  return withSpan(
    "retry",
    { "app.retry.what": what, "app.retry.max_attempts": attempts },
    async (span) => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const value = await fn();
          span.setAttribute("app.retry.attempts_used", attempt);
          return value;
        } catch (error) {
          lastError = error;
          if (attempt === attempts) break;

          const backoff = retryBackoffMs(attempt);
          console.warn(`  ! ${what} failed (attempt ${attempt}/${attempts}): ${asMessage(error)}`);
          console.warn(`    retrying in ${backoff}ms`);
          await sleep(backoff);
        }
      }

      span.setAttribute("app.retry.attempts_used", attempts);
      throw lastError;
    },
  );
};

/** Run `fn` over `items` with at most `limit` in flight. Rejects on the first failure. */
export const pool = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

export const asMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// duckdb
//
// DuckDB is our second opinion. It splits the fact Parquet by day for ingest, and in verify.ts it
// recomputes the funnel totals off the raw source -- checking ClickHouse against ClickHouse would
// prove nothing, so the cross-check has to come from a different engine.
// ---------------------------------------------------------------------------

/**
 * Run SQL through the duckdb CLI and return raw stdout.
 *
 * Spanned for the same reason the ClickHouse calls are: this is the other engine we depend on, and
 * a slow day-split shows up here or nowhere. `db.system` distinguishes it from the ClickHouse
 * spans, so the two engines are separable in the UI.
 */
export const duckdb = async (sql: string): Promise<string> => {
  return withSpan(
    "duckdb.query",
    {
      "db.system": "duckdb",
      "db.query.text": sql.length > 500 ? `${sql.slice(0, 500)}...` : sql,
    },
    async (span) => {
      const proc = Bun.spawn(["duckdb", "-json", "-c", sql], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      span.setAttribute("process.exit_code", code);
      if (code !== 0) throw new Error(`duckdb failed (exit ${code}):\n${stderr || stdout}`);
      return stdout;
    },
  );
};

/** Run SQL through the duckdb CLI and parse the JSON result. */
export const duckdbJson = async <T>(sql: string): Promise<T[]> => {
  const out = await duckdb(sql);
  return (out.trim() ? JSON.parse(out) : []) as T[];
};

export const parquetFileMeta = (glob: string): Promise<ParquetFileMeta[]> =>
  duckdbJson<ParquetFileMeta>(srcParquetFileMeta(glob));

export const assertDuckdb = async (): Promise<void> => {
  try {
    await duckdb("SELECT 1");
  } catch {
    throw new Error(
      "The `duckdb` CLI is required to split the fact Parquet into daily chunks.\n" +
        "  macOS: brew install duckdb   |   else: https://duckdb.org/docs/installation/",
    );
  }
};

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

/** True if `flag` is present in argv. */
export const hasFlag = (argv: string[], flag: string): boolean => argv.includes(flag);

/** Value of `--flag=value`, or undefined. */
export const flagValue = (argv: string[], flag: string): string | undefined =>
  argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);

/** Split `--flag=a,b,c` into trimmed, non-empty parts. */
export const flagList = (argv: string[], flag: string): string[] | null => {
  const raw = flagValue(argv, flag);
  if (!raw) return null;

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
};

/** Run a script's main(), printing a clean error instead of a stack trace on failure. */
export const runScript = async (main: () => Promise<void>): Promise<void> => {
  try {
    await main();
  } catch (error) {
    console.error(`\n${asMessage(error)}`);
    process.exit(1);
  }
};
