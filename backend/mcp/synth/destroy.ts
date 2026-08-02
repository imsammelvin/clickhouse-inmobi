/**
 * Remove the synthetic dataset.
 *
 *   bun run synth:destroy              # show exactly what would go, drop nothing
 *   bun run synth:destroy -- --yes     # drop it
 *
 * Preview by default, and `--yes` to act. Not ceremony: this is a `DROP DATABASE`, the guard in
 * `target.ts` is the only thing standing between a mistyped env var and the dataset the whole project
 * runs on, and a command that deletes on muscle memory will eventually be run on muscle memory. One
 * extra word buys a listing of what is about to disappear.
 *
 * Safe to run when the database does not exist — it reports that and exits 0, so it can sit at the end
 * of a script without failing a clean machine.
 */
import { resolveTargetDatabase, serverClient } from "./target";
import type { Span } from "@opentelemetry/api";
import {
  initObservability,
  shutdownObservability,
  withSpan,
} from "../../../shared/utils/telemetryUtils";

const say = (s = ""): void => {
  process.stderr.write(`${s}\n`);
};

async function main(): Promise<void> {
  initObservability();
  try {
    await withSpan("synth.destroy", {}, runDestroy);
  } finally {
    await shutdownObservability();
  }
}

async function runDestroy(span: Span): Promise<void> {
  const db = resolveTargetDatabase();
  const confirmed = process.argv.includes("--yes");
  const client = serverClient();
  // A destructive command is exactly the one you want a record of afterwards: what database, and
  // whether this run was the preview or the one that actually dropped it.
  span.setAttributes({ "app.database": db, "app.confirmed": confirmed });

  try {
    const exists = await client.query({
      query: `SELECT count() AS n FROM system.databases WHERE name = {db:String}`,
      query_params: { db },
      format: "JSONEachRow",
    });
    const [row] = (await exists.json()) as Array<{ n: string | number }>;
    if (Number(row?.n ?? 0) === 0) {
      say(`[synth] "${db}" does not exist — nothing to destroy.`);
      span.setAttribute("app.outcome", "absent");
      return;
    }

    // Show the inventory before deleting it. "3 tables, 1.4M rows, 41 MiB" is the difference between
    // an informed confirmation and a blind one.
    const inv = await client.query({
      query: `SELECT name, sum(rows) AS rows, sum(bytes_on_disk) AS bytes
              FROM system.parts
              WHERE database = {db:String} AND active
              GROUP BY name
              ORDER BY rows DESC`,
      query_params: { db },
      format: "JSONEachRow",
    });
    const parts = (await inv.json()) as Array<{ name: string; rows: string; bytes: string }>;

    say(`[synth] database "${db}"`);
    if (parts.length === 0) {
      say(`  (no table parts — empty or dictionaries only)`);
    }
    let totalRows = 0;
    let totalBytes = 0;
    for (const p of parts) {
      totalRows += Number(p.rows);
      totalBytes += Number(p.bytes);
      say(
        `  ${p.name.padEnd(24)} ${Number(p.rows).toLocaleString().padStart(12)} rows  ${(Number(p.bytes) / 1048576).toFixed(1)} MiB`,
      );
    }
    if (parts.length > 1) {
      say(
        `  ${"total".padEnd(24)} ${totalRows.toLocaleString().padStart(12)} rows  ${(totalBytes / 1048576).toFixed(1)} MiB`,
      );
    }

    span.setAttributes({ "app.tables": parts.length, "app.rows": totalRows });

    if (!confirmed) {
      say(``);
      say(`[synth] preview only — nothing was dropped.`);
      say(`[synth] to actually remove it:  bun run synth:destroy -- --yes`);
      span.setAttribute("app.outcome", "preview");
      return;
    }

    say(``);
    say(`[synth] DROP DATABASE ${db}`);
    await client.command({
      query: `DROP DATABASE IF EXISTS ${db}`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
    say(
      `[synth] gone. Rebuild any time with \`bun run synth:build\` — seed-fixed, so it comes back identical.`,
    );
    span.setAttribute("app.outcome", "dropped");
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    say(`[synth] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
