/**
 * Applies clickhouse/schema.sql. Idempotent -- safe to re-run, never drops data.
 *
 *   bun run ch:schema
 */
import { readFileSync } from "node:fs";
import { DATABASE, exec, makeClient } from "../clickhouse/client";
import { rollupStatements } from "../clickhouse/rollup";
import { SCHEMA_FILE } from "../../shared/constants";
import { runScript } from "../../shared/utils/common.utils";
import { splitStatements, statementLabel } from "../../shared/utils/sql.utils";
import {
  initObservability,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";
import { log } from "../../shared/utils/telemetryUtils";

const main = async (): Promise<void> => {
  // schema.sql first, then the generated rollup DDL -- the MVs reference both `ad_events` and the
  // dictionaries, so order matters on a fresh database.
  const statements = [...splitStatements(readFileSync(SCHEMA_FILE, "utf8")), ...rollupStatements()];
  initObservability();
  const client = makeClient();

  try {
    log.info(`Applying ${statements.length} statements to database "${DATABASE}"\n`);

    await withSpan("schema.run", { "schema.statements": statements.length }, async () => {
      for (const [index, statement] of statements.entries()) {
        const tag = `[${String(index + 1).padStart(2, " ")}/${statements.length}]`;
        process.stdout.write(`${tag} ${statementLabel(statement)} ... `);
        await exec(client, statement);
        log.info("ok");
      }
    });

    log.info("\nSchema applied. Next: bun run ch:load");
    log.info(
      "If ad_events was already loaded, the rollups are empty -- a materialized view only sees " +
        "inserts made after it exists. Run: bun run ch:rollup",
    );
  } finally {
    await client.close();
    await shutdownObservability();
  }
};

if (import.meta.main) await runScript(main);
