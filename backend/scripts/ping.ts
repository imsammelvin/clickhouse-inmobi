/**
 * Connectivity smoke test.
 *
 *   bun run ch:ping
 */
import { DATABASE, makeClient, selectOne } from "../clickhouse/client";
import { SERVER_INFO } from "../../shared/constants/queries";
import type { ServerInfo } from "../../shared/interfaces";
import { runScript } from "../../shared/utils/common.utils";
import {
  initObservability,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";
import { log } from "../../shared/utils/telemetryUtils";

const main = async (): Promise<void> => {
  initObservability();
  const client = makeClient();

  try {
    await withSpan("ping.run", {}, async () => {
      const info = await selectOne<ServerInfo>(client, SERVER_INFO);

      log.info(`ClickHouse ${info.version}`);
      log.info(`database    ${DATABASE}`);
      log.info(`uptime      ${info.uptime}`);
      log.info(`server time ${info.now}`);
    });
  } finally {
    await client.close();
    await shutdownObservability();
  }
};

if (import.meta.main) await runScript(main);
