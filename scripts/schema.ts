/**
 * Applies clickhouse/schema.sql. Idempotent -- safe to re-run, never drops data.
 *
 *   bun run ch:schema
 */
import { readFileSync } from "node:fs";
import { DATABASE, exec, makeClient } from "../clickhouse/client";
import { SCHEMA_FILE } from "../constants";
import { runScript } from "../utils/common.utils";
import { splitStatements, statementLabel } from "../utils/sql.utils";
import {
  initObservability,
  shutdownObservability,
  withSpan,
} from "../utils/telemetryUtils";
import { log } from "../utils/telemetryUtils";

const main = async (): Promise<void> => {
  const statements = splitStatements(readFileSync(SCHEMA_FILE, "utf8"));
  initObservability();
  const client = makeClient();

  try {
    log.info(
      `Applying ${statements.length} statements to database "${DATABASE}"\n`,
    );

    await withSpan(
      "schema.run",
      { "schema.statements": statements.length },
      async () => {
        for (const [index, statement] of statements.entries()) {
          const tag = `[${String(index + 1).padStart(2, " ")}/${statements.length}]`;
          process.stdout.write(`${tag} ${statementLabel(statement)} ... `);
          await exec(client, statement);
          log.info("ok");
        }
      },
    );

    log.info("\nSchema applied. Next: bun run ch:load");
  } finally {
    await client.close();
    await shutdownObservability();
  }
};

if (import.meta.main) await runScript(main);
