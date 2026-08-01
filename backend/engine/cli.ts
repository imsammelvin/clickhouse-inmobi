/**
 * CLI entry point.
 *
 *   bun run backend/cli.ts --metric fill_rate --from 2026-06-23 --to 2026-06-25
 *   bun run backend/cli.ts --metric revenue   --from 2026-06-21 --json
 *   bun run backend/cli.ts --metric fill_rate --from 2026-06-23 --to 2026-06-25 --plain
 */
import { Ledger } from "./ledger";
import { investigate } from "./orchestrate";
import { renderFull, renderPlain } from "./render";
import {
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

async function main(): Promise<void> {
  initObservability();
  try {
    await withSpan("cli.explain", {}, () => run());
  } finally {
    await shutdownObservability();
  }
}

async function run(): Promise<void> {
  const metric = arg("metric", "revenue");
  const from = arg("from");
  const to = arg("to", from);
  const asJson = process.argv.includes("--json");
  const asPlain = process.argv.includes("--plain"); // T-045: pitch/diagnosis-template.md §1 wording

  const ledger = new Ledger();
  const started = Date.now();
  try {
    const inv = await investigate({ metric, from, to, ledger });
    if (asJson) {
      // Raw stdout, deliberately: --json exists to be piped, and shipping a whole Investigation
      // into the log pipeline on every run would be noise, not telemetry.
      process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
    } else if (asPlain) {
      log.info(renderPlain(inv));
    } else {
      log.info(renderFull(inv));
      // Human line stays clean; the structured record carries what ClickStack needs to chart
      // latency and outcome per metric. Kept to four attributes for the same readability reason.
      log.info(`total ${Date.now() - started}ms, ${ledger.totalQueries()} queries\n`);
      log.info("investigation.complete", {
        "app.metric": metric,
        "app.channel": inv.primaryChannel,
        "app.queries": ledger.totalQueries(),
        "app.duration_ms": Date.now() - started,
      });
    }
  } finally {
    await ledger.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
