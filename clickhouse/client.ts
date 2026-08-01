/**
 * Shared ClickHouse client factory. Connection settings live in constants/.
 */
import {
  createClient,
  type ClickHouseClient,
  type ClickHouseSettings,
} from "@clickhouse/client";
import {
  DEFAULT_DATABASE,
  PROGRESS_HEADER_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from "../constants";
import { DataFormat, EnvVar } from "../enums";

function required(name: EnvVar): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing env var ${name}. Copy .env.example to .env and fill in your ClickHouse Cloud credentials.`,
    );
  }
  return value;
}

export const DATABASE = process.env[EnvVar.Database] ?? DEFAULT_DATABASE;

export function makeClient(): ClickHouseClient {
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
}

/** Run a statement and discard the result. */
export async function exec(
  client: ClickHouseClient,
  query: string,
  settings: ClickHouseSettings = {},
): Promise<void> {
  await client.command({
    query,
    clickhouse_settings: { wait_end_of_query: 1, ...settings },
  });
}

/** Run a SELECT and return typed rows. */
export async function select<T>(client: ClickHouseClient, query: string): Promise<T[]> {
  const rs = await client.query({ query, format: DataFormat.JsonEachRow });
  return (await rs.json()) as T[];
}

/** Run a SELECT expected to return exactly one row. */
export async function selectOne<T>(client: ClickHouseClient, query: string): Promise<T> {
  const [row] = await select<T>(client, query);
  if (!row) throw new Error(`Query returned no rows:\n${query}`);
  return row;
}
