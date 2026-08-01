/**
 * Starts the standalone ClickStack OTel collector.
 *
 *   bun run otel:collector          start (replaces any existing container)
 *   bun run otel:collector:stop
 *   bun run otel:collector:logs
 *
 * Why this exists at all: Managed ClickStack (HyperDX in ClickHouse Cloud) does not host a
 * collector and does not issue an ingestion key -- you run the collector yourself and choose its
 * auth token. So the path is:
 *
 *   app --OTLP--> this collector --> ClickHouse Cloud otel_* tables --> HyperDX Cloud UI
 *
 * Sending OTLP straight at a cloud endpoint instead does nothing: there is nothing listening for
 * this account, and the request still returns 200.
 *
 * This is a script rather than a package.json one-liner because `docker run -e FOO=$BAR` does not
 * work there -- Bun loads .env into its own process, not into the shell that runs the command, so
 * every variable expands to an empty string and the collector silently comes up unconfigured.
 */
import {
  CLICKSTACK_PASSWORD,
  CLICKSTACK_URL,
  CLICKSTACK_USER,
  COLLECTOR_CONTAINER,
  COLLECTOR_GRPC_PORT,
  COLLECTOR_HTTP_PORT,
  COLLECTOR_IMAGE,
  OTEL_INGESTION_TOKEN,
} from "../../shared/constants";
import { runScript } from "../../shared/utils/common.utils";
import {
  initObservability,
  log,
  shutdownObservability,
  withSpan,
} from "../../shared/utils/telemetryUtils";

/** Each `docker` invocation is a child process; spanned so a slow pull is attributable. */
const run = async (args: string[]): Promise<string> => {
  return withSpan(
    `docker.${args[0]}`,
    { "process.command": "docker", "process.command_args": args.join(" ") },
    async (span) => {
      const proc = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      span.setAttribute("process.exit_code", code);
      if (code !== 0) throw new Error(`docker ${args[0]} failed:\n${stderr || stdout}`);
      return stdout.trim();
    },
  );
};

const main = async (): Promise<void> => {
  initObservability();
  try {
    await withSpan("otel.collector.start", { "db.url": CLICKSTACK_URL }, () => start());
  } finally {
    await shutdownObservability();
  }
};

const start = async (): Promise<void> => {
  if (CLICKSTACK_URL.includes("localhost")) {
    // Pointing the collector at the all-in-one container's own ClickHouse would be a loop: that
    // container already runs a collector on 4317/4318.
    console.warn(
      `Warning: CLICKSTACK_CLICKHOUSE_URL is ${CLICKSTACK_URL}. The standalone collector is for\n` +
        `writing into a remote ClickHouse (e.g. Cloud). For local dev just use the all-in-one\n` +
        `container's collector on :4318 instead.\n`,
    );
  }

  // Replace rather than fail: re-running this after a config change is the common case.
  await run(["rm", "-f", COLLECTOR_CONTAINER]).catch(() => "");

  const id = await run([
    "run",
    "-d",
    "--name",
    COLLECTOR_CONTAINER,
    "-e",
    `CLICKHOUSE_ENDPOINT=${CLICKSTACK_URL}`,
    "-e",
    `CLICKHOUSE_USER=${CLICKSTACK_USER}`,
    "-e",
    `CLICKHOUSE_PASSWORD=${CLICKSTACK_PASSWORD}`,
    "-e",
    `OTLP_AUTH_TOKEN=${OTEL_INGESTION_TOKEN}`,
    "-p",
    `${COLLECTOR_HTTP_PORT}:4318`,
    "-p",
    `${COLLECTOR_GRPC_PORT}:4317`,
    COLLECTOR_IMAGE,
  ]);

  log.info(`${COLLECTOR_CONTAINER} started (${id.slice(0, 12)})`);
  log.info(`  writes to   ${CLICKSTACK_URL} as "${CLICKSTACK_USER}"`);
  log.info(`  OTLP http   http://localhost:${COLLECTOR_HTTP_PORT}`);
  log.info(`  OTLP grpc   http://localhost:${COLLECTOR_GRPC_PORT}`);
  log.info(
    `\nPoint the app at it with OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${COLLECTOR_HTTP_PORT}`,
  );
};

if (import.meta.main) await runScript(main);
