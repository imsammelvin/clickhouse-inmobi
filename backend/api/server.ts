/**
 * HTTP API, instrumented end to end. Every request becomes one SERVER span in ClickStack.
 *
 *   bun run serve
 *   curl localhost:3000/ping
 *   curl localhost:3000/health
 *
 * Routes:
 *   GET /health   liveness. Never touches ClickHouse, so it still answers when the database is
 *                 down -- which is the whole point of separating it from /ping.
 *   GET /ping     readiness. Round-trips a real query to ClickHouse and reports version, uptime
 *                 and latency. 200 when the database answered, 503 when it did not.
 *   GET /ad-events/count
 *                 row count of the ad_events fact table. Same 200/503 contract as /ping.
 *
 * Both responses carry the `traceId` of the request, and it is also returned in the `x-trace-id`
 * header. Paste it into ClickStack to pull up the exact trace -- including the nested
 * `clickhouse.select` child span and the log records emitted inside it.
 *
 * Inbound `traceparent` headers are honoured (W3C propagation is registered in utils/telemetryUtils.ts),
 * so a caller that is already tracing gets one continuous trace across the hop rather than two
 * disconnected ones.
 */
import { SpanKind, SpanStatusCode, context, propagation } from "@opentelemetry/api";
import { DATABASE, makeClient, selectOne } from "../clickhouse/client";
import {
  API_PORT,
  API_PORT_SCAN,
  DEPLOYMENT_ENVIRONMENT,
  OTEL_ENDPOINT,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "../../shared/constants";
import { SERVER_INFO, countRows } from "../../shared/constants/queries";
import { ApiRoute, Table } from "../../shared/enums";
import type {
  CountResponse,
  CountRow,
  HealthResponse,
  PingResponse,
  ServerInfo,
} from "../../shared/interfaces";
import {
  counter,
  histogram,
  initObservability,
  log,
  shutdownObservability,
  trySpan,
} from "../../shared/utils/telemetryUtils";

// ---------------------------------------------------------------------------
// instruments -- lazy, see counter()/histogram()
// ---------------------------------------------------------------------------

const requestCounter = counter("http.server.requests", "HTTP requests served, by route and status");

const requestDuration = histogram("http.server.duration", "HTTP request duration", "ms");

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

initObservability();

const client = makeClient();
const startedAt = Date.now();

const json = (body: unknown, status: number, traceId: string): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "x-trace-id": traceId },
  });

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

const handlePing = async (traceId: string): Promise<Response> => {
  const info = await trySpan("db.server_info", { "db.system": "clickhouse" }, () =>
    selectOne<ServerInfo>(client, SERVER_INFO),
  );

  if (!info.ok) {
    log.error("ping failed", { "error.message": info.error.message });

    // 503, not 500: the API is alive, its dependency is not. A load balancer should pull this
    // instance out of rotation rather than treat it as a crash.
    const body: PingResponse = {
      status: "error",
      latencyMs: info.ms,
      database: DATABASE,
      traceId,
      error: info.error.message,
    };
    return json(body, 503, traceId);
  }

  log.info("ping ok", {
    "db.system": "clickhouse",
    "app.latency_ms": info.ms,
    "db.version": info.value.version,
  });

  const body: PingResponse = {
    status: "ok",
    latencyMs: info.ms,
    clickhouse: info.value,
    database: DATABASE,
    traceId,
  };
  return json(body, 200, traceId);
};

/**
 * Row count of the fact table. `count()` on a MergeTree reads part metadata rather than scanning,
 * so this stays in single-digit milliseconds server-side even at 9M rows -- the latency you see is
 * almost entirely the round trip to ClickHouse Cloud.
 */
const handleAdEventsCount = async (traceId: string): Promise<Response> => {
  const row = await trySpan(
    "db.ad_events.count",
    { "db.system": "clickhouse", "db.collection.name": Table.AdEvents },
    () => selectOne<CountRow>(client, countRows(Table.AdEvents)),
  );

  if (!row.ok) {
    log.error("ad_events count failed", { "error.message": row.error.message });

    log.info("Fetching ad_events count");

    const body: CountResponse = {
      status: "error",
      table: Table.AdEvents,
      count: 0,
      latencyMs: row.ms,
      traceId,
      error: row.error.message,
    };
    return json(body, 503, traceId);
  }

  // ClickHouse returns counts as strings over the HTTP interface.
  const count = Number(row.value.n);

  log.info("ad_events count", {
    "db.collection.name": Table.AdEvents,
    "app.row_count": count,
    "app.latency_ms": row.ms,
  });

  const body: CountResponse = {
    status: "ok",
    table: Table.AdEvents,
    count,
    latencyMs: row.ms,
    traceId,
  };
  log.info("Successfully fetched ad events count");
  log.error("Sample error msg");
  log.warn("Sample warn msg");
  log.debug("Sample warn msg");
  return json(body, 200, traceId);
};

const handleHealth = (traceId: string): Response => {
  const body: HealthResponse = {
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: DEPLOYMENT_ENVIRONMENT,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
  return json(body, 200, traceId);
};

// ---------------------------------------------------------------------------
// request pipeline
// ---------------------------------------------------------------------------

const route = async (request: Request, path: string, traceId: string): Promise<Response> => {
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405, traceId);
  }

  switch (path) {
    case ApiRoute.Ping:
      return handlePing(traceId);
    case ApiRoute.AdEventsCount:
      return handleAdEventsCount(traceId);
    case ApiRoute.Health:
      return handleHealth(traceId);
    default:
      return json({ error: "not found", routes: Object.values(ApiRoute) }, 404, traceId);
  }
};

/**
 * Wraps one request in a SERVER span. `propagation.extract` pulls any inbound `traceparent` off
 * the headers, and `context.with` makes that the parent, so the span we open continues the
 * caller's trace instead of rooting a new one.
 */
const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  const parent = propagation.extract(context.active(), Object.fromEntries(request.headers));

  let traceId = "";

  const handled = await context.with(parent, () =>
    trySpan(
      // Low-cardinality span name -- the route template, never the raw URL.
      `${request.method} ${path}`,
      {
        "http.request.method": request.method,
        "url.path": path,
        "url.scheme": url.protocol.replace(":", ""),
        "server.address": url.host,
        "user_agent.original": request.headers.get("user-agent") ?? "",
      },
      async (span) => {
        traceId = span.spanContext().traceId;
        const response = await route(request, path, traceId);

        span.setAttribute("http.response.status_code", response.status);
        // 4xx is the caller's fault, not ours; only 5xx marks the span failed.
        if (response.status >= 500) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${response.status}`,
          });
        }
        return response;
      },
      SpanKind.SERVER,
    ),
  );

  // A handler that threw is a bug on our side, not a failing dependency -- 500, and the client
  // gets a trace id to quote rather than a dropped connection.
  const response = handled.ok
    ? handled.value
    : json({ error: "internal server error", traceId }, 500, traceId);

  if (!handled.ok) {
    log.error("unhandled error", {
      "url.path": path,
      "error.message": handled.error.message,
    });
  }

  const labels = {
    "http.route": path,
    "http.request.method": request.method,
    "http.response.status_code": response.status,
  };
  requestCounter().add(1, labels);
  requestDuration().record(handled.ms, labels);

  return response;
};

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const isPortTaken = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === "EADDRINUSE";

/**
 * Bind to API_PORT, or the next free port after it.
 *
 * A stale `bun run serve` still holding the port is common enough in development that crashing on
 * it is just friction -- the port actually bound is printed below, and PORT pins it explicitly
 * when something downstream depends on a fixed value.
 */
const listen = (): ReturnType<typeof Bun.serve> => {
  for (let port = API_PORT; port < API_PORT + API_PORT_SCAN; port++) {
    try {
      return Bun.serve({ port, fetch: handle });
    } catch (error) {
      if (!isPortTaken(error)) throw error;
      console.warn(`port ${port} in use, trying ${port + 1}`);
    }
  }
  // Everything in the scan range was taken; let the OS choose.
  return Bun.serve({ port: 0, fetch: handle });
};

const server = listen();

log.info(`Started the server`);

/** Stop accepting requests, then flush -- an un-flushed batch is a lost trace. */
const shutdown = async (): Promise<void> => {
  await server.stop();
  await client.close();
  log.info(`Shutting down the server`);
  await shutdownObservability();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
