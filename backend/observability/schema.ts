/**
 * Creates ClickStack's otel_* tables in the telemetry store.
 *
 *   bun run otel:schema
 *
 * Idempotent (every statement is IF NOT EXISTS) and non-destructive -- it never drops anything,
 * so it is safe to re-run against a store that already has some of the tables.
 *
 * Normally the ClickStack collector creates these itself on first ingest. You need this when the
 * collector writes somewhere it has not bootstrapped -- most obviously ClickHouse Cloud, where the
 * tables are absent and every HyperDX panel is therefore empty.
 *
 * Target: CLICKSTACK_CLICKHOUSE_URL (defaults to the local ClickStack container). Point that at
 * ClickHouse Cloud to apply it there instead -- see .env.example.
 */
import { readFileSync } from "node:fs";
import type { Span } from "@opentelemetry/api";
import { exec, makeTelemetryClient } from "../clickhouse/client";
import { CLICKSTACK_SCHEMA_FILE, CLICKSTACK_URL } from "../../shared/constants";
import { runScript } from "../../shared/utils/common.utils";
import { splitStatements, statementLabel } from "../../shared/utils/sql.utils";
import {
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

const main = async (): Promise<void> => {
  initObservability();
  try {
    await withSpan("otel.schema", { "db.url": CLICKSTACK_URL }, (span) => apply(span));
  } finally {
    await shutdownObservability();
  }
};

const apply = async (span: Span): Promise<void> => {
  const statements = splitStatements(readFileSync(CLICKSTACK_SCHEMA_FILE, "utf8"));
  span.setAttribute("db.statements", statements.length);

  const client = makeTelemetryClient();

  try {
    log.info(`Applying ${statements.length} statements to ${CLICKSTACK_URL}\n`);

    for (const [index, statement] of statements.entries()) {
      const tag = `[${String(index + 1).padStart(2, " ")}/${statements.length}]`;
      process.stdout.write(`${tag} ${statementLabel(statement)} ... `);
      // `exec` rather than `client.command` directly: identical settings, and it opens the
      // `clickhouse.exec` span so a statement that hangs is visible as a span, not just a stalled
      // line of console output.
      await exec(client, statement);
      log.info("ok");
    }

    log.info("\notel_* tables ready. Next: bun run otel:verify");
  } finally {
    await client.close();
  }
};

if (import.meta.main) await runScript(main);
