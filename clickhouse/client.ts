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
} from "../constants";
import { DataFormat, EnvVar } from "../enums";
import { withSpan } from "../utils/telemetryUtils";

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

/** db.* attributes shared by every span this client creates. */
const dbAttributes = (query: string): Record<string, string> => {
  return {
    "db.system": "clickhouse",
    "db.operation": operation(query),
    "db.query.text": query.length > 500 ? `${query.slice(0, 500)}...` : query,
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

/** Run a SELECT and return typed rows. */
export const select = async <T>(
  client: ClickHouseClient,
  query: string,
): Promise<T[]> => {
  return withSpan("clickhouse.select", dbAttributes(query), async () => {
    const rs = await client.query({ query, format: DataFormat.JsonEachRow });
    return (await rs.json()) as T[];
  });
};

/** Run a SELECT expected to return exactly one row. */
export const selectOne = async <T>(
  client: ClickHouseClient,
  query: string,
): Promise<T> => {
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
