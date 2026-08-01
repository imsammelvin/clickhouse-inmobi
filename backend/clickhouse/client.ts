/**
 * Shared ClickHouse client factory. Connection settings live in constants/.
 */
import type { Readable } from "node:stream";
import {
  createClient,
  type ClickHouseClient,
  type ClickHouseSettings,
  type InsertValues,
} from "@clickhouse/client";
import {
  CLICKSTACK_PASSWORD,
  CLICKSTACK_URL,
  CLICKSTACK_USER,
  DEFAULT_DATABASE,
  PROGRESS_HEADER_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from "../../shared/constants";
import { DataFormat, EnvVar } from "../../shared/enums";
import { histogram, withSpan } from "../../shared/utils/telemetryUtils";

const required = (name: EnvVar): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing env var ${name}. Copy .env.example to .env and fill in your ClickHouse Cloud credentials.`,
    );
  }
  return value;
};

export const DATABASE = process.env[EnvVar.Database] ?? DEFAULT_DATABASE;

export const makeClient = (): ClickHouseClient => {
  return createClient({
    url: required(EnvVar.Url),
    username: required(EnvVar.User),
    password: process.env[EnvVar.Password] ?? "",
    database: DATABASE,
    request_timeout: REQUEST_TIMEOUT_MS,
    compression: { response: true },
    clickhouse_settings: {
      // Keeps the connection alive through the cloud load balancer's idle timeout while a large
      // Parquet body is still being parsed server-side.
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: PROGRESS_HEADER_INTERVAL_MS,
      // One INSERT per chunk should land as one part -- either the whole day is there or none of it.
      max_insert_block_size: "10000000",
      min_insert_block_size_rows: "0",
      min_insert_block_size_bytes: "0",
      // Fail loudly on a malformed source row rather than skipping it. A silently dropped event is
      // a wrong revenue number downstream, which is the one thing we cannot ship.
      input_format_allow_errors_num: "0",
      input_format_allow_errors_ratio: 0,
    },
  });
};

/** First keyword of a query, e.g. "SELECT", "INSERT", "ALTER". */
const operation = (query: string): string => {
  return query.trim().split(/\s+/, 1)[0]!.toUpperCase();
};

/**
 * Cap on the SQL recorded on a span.
 *
 * Deliberately generous rather than the 500 chars this used to use. The queries worth debugging are
 * exactly the ones that exceeded it: the localize sweep and the segment detection SQL are ~1.5-3 KB,
 * so a 500-char cap kept the boilerplate SELECT list and cut away every predicate, window and floor
 * that determines what the query actually did. A cap still exists so a pathological generated query
 * cannot blow up a span payload, but at this size nothing in this codebase is truncated.
 */
const MAX_QUERY_TEXT = 16_384;

/** db.* attributes shared by every span this client creates. */
const dbAttributes = (query: string): Record<string, string> => {
  return {
    "db.system": "clickhouse",
    "db.operation": operation(query),
    "db.query.text":
      query.length > MAX_QUERY_TEXT ? `${query.slice(0, MAX_QUERY_TEXT)}...[truncated]` : query,
    "db.query.length": String(query.length),
    "db.collection.name": DATABASE,
  };
};

/**
 * Client for ClickStack's telemetry store -- the otel_* tables.
 *
 * Deliberately separate from makeClient(): the fact data lives in ClickHouse Cloud while the
 * ClickStack all-in-one container keeps its otel_* tables in its own bundled instance, so the
 * observability scripts have to look somewhere else than the app does. Defaults to that container;
 * point CLICKSTACK_CLICKHOUSE_URL at Cloud to target it instead.
 */
export const makeTelemetryClient = (): ClickHouseClient => {
  return createClient({
    url: CLICKSTACK_URL,
    username: CLICKSTACK_USER,
    password: CLICKSTACK_PASSWORD,
  });
};

/** Run a statement and discard the result. */
export const exec = async (
  client: ClickHouseClient,
  query: string,
  settings: ClickHouseSettings = {},
): Promise<void> => {
  await withSpan("clickhouse.exec", dbAttributes(query), async () => {
    await client.command({
      query,
      clickhouse_settings: { wait_end_of_query: 1, ...settings },
    });
  });
};

/**
 * Rows handed back to the client, per query.
 *
 * The companion to the span attribute: the attribute answers "what did THIS query return", the
 * histogram answers "what do our queries return in general" — which is the criterion-3 invariant
 * (result sets bounded by dimension cardinality, never by event count) as a chartable series
 * rather than a one-off assertion in the gate.
 */
const rowsReturned = histogram(
  "db.rows_returned",
  "Rows returned to the client by a SELECT",
  "{row}",
);

/** Run a SELECT and return typed rows. */
export const select = async <T>(client: ClickHouseClient, query: string): Promise<T[]> => {
  return withSpan("clickhouse.select", dbAttributes(query), async (span) => {
    const rs = await client.query({ query, format: DataFormat.JsonEachRow });
    const rows = (await rs.json()) as T[];
    // Recorded on the span next to the SQL that produced it, so a trace answers "what ran and how
    // much came back" without a second lookup.
    span.setAttribute("db.response.returned_rows", rows.length);
    rowsReturned().record(rows.length, {
      "db.operation": operation(query),
      "db.collection.name": DATABASE,
    });
    return rows;
  });
};

/** Run a SELECT expected to return exactly one row. */
export const selectOne = async <T>(client: ClickHouseClient, query: string): Promise<T> => {
  const [row] = await select<T>(client, query);
  if (!row) throw new Error(`Query returned no rows:\n${query}`);
  return row;
};

/** Insert rows from a readable stream into `table`, traced as its own span. */
export const insert = async (
  client: ClickHouseClient,
  table: string,
  values: InsertValues<Readable, unknown>,
  format: DataFormat,
): Promise<void> => {
  await withSpan(
    "clickhouse.insert",
    { ...dbAttributes(`INSERT INTO ${table}`), "db.collection.name": table },
    async () => {
      await client.insert({ table, values, format });
    },
  );
};
