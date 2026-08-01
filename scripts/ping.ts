/**
 * Connectivity smoke test.
 *
 *   bun run ch:ping
 */
import { DATABASE, makeClient, selectOne } from "../clickhouse/client";
import { SERVER_INFO } from "../constants/queries";
import type { ServerInfo } from "../interfaces";
import { runScript } from "../utils/common.utils";

async function main(): Promise<void> {
  const client = makeClient();

  try {
    const info = await selectOne<ServerInfo>(client, SERVER_INFO);

    console.log(`ClickHouse ${info.version}`);
    console.log(`database    ${DATABASE}`);
    console.log(`uptime      ${info.uptime}`);
    console.log(`server time ${info.now}`);
  } finally {
    await client.close();
  }
}

if (import.meta.main) await runScript(main);
