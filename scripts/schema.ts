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

async function main(): Promise<void> {
  const statements = splitStatements(readFileSync(SCHEMA_FILE, "utf8"));
  const client = makeClient();

  try {
    console.log(`Applying ${statements.length} statements to database "${DATABASE}"\n`);

    for (const [index, statement] of statements.entries()) {
      const tag = `[${String(index + 1).padStart(2, " ")}/${statements.length}]`;
      process.stdout.write(`${tag} ${statementLabel(statement)} ... `);
      await exec(client, statement);
      console.log("ok");
    }

    console.log("\nSchema applied. Next: bun run ch:load");
  } finally {
    await client.close();
  }
}

if (import.meta.main) await runScript(main);
