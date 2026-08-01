/**
 * CLI entry point.
 *
 *   bun run backend/cli.ts --metric fill_rate --from 2026-06-23 --to 2026-06-25
 *   bun run backend/cli.ts --metric revenue   --from 2026-06-21 --json
 */
import { Ledger } from "./ledger";
import { investigate } from "./orchestrate";
import { renderFull } from "./render";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

async function main(): Promise<void> {
  const metric = arg("metric", "revenue");
  const from = arg("from");
  const to = arg("to", from);
  const asJson = process.argv.includes("--json");

  const ledger = new Ledger();
  const started = Date.now();
  try {
    const inv = await investigate({ metric, from, to, ledger });
    if (asJson) {
      console.log(JSON.stringify(inv, null, 2));
    } else {
      console.log(renderFull(inv));
      console.log(`total ${Date.now() - started}ms, ${ledger.totalQueries()} queries\n`);
    }
  } finally {
    await ledger.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
