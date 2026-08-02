/**
 * Mission control: one shell page for the whole stack.
 *
 *   bun run dashboard
 *
 * LibreChat, ClickStack and Langfuse are each already-running, separately-branded web apps. Rather
 * than bounce a judge between four different UIs, this serves one page with a sidebar: Chat is an
 * iframe (it is genuinely interactive, re-implementing it would be pointless), everything else pulls
 * real data server-side and renders it in this page's own styling, so it reads as one product instead
 * of four bolted-together tools.
 *
 * Every API route below reuses code that already exists elsewhere in this repo -- the point of this
 * file is presentation, not a second copy of the query logic.
 */
import { join } from "node:path";
import { SpanKind, SpanStatusCode, context, propagation } from "@opentelemetry/api";
import { makeClient, makeTelemetryClient, select } from "../clickhouse/client";
import { Session } from "../mcp/trace";
import { callTool } from "../mcp/tools";
import { DEFAULT_METRICS } from "../engine/scan";
import {
  initObservability,
  log,
  shutdownObservability,
  trySpan,
  withSpan,
} from "../../shared/utils/telemetryUtils";

const PORT = Number(process.env.DASHBOARD_PORT ?? 4500);
// The static page lives in top-level frontend/, separate from this API/proxy server.
const PUBLIC_DIR = join(import.meta.dir, "../../frontend");
const ROLLUP_COMPARISON_FILE = join(import.meta.dir, "data", "rollup-comparison.json");
const LIBRECHAT_URL = process.env.LIBRECHAT_URL ?? "http://localhost:3080";

const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

const errorJson = (error: unknown, status = 500): Response =>
  json({ error: error instanceof Error ? error.message : String(error) }, status);

// -------------------------------------------------------------------------------------------------
// /api/anomalies -- what the engine actually found, live off find_incidents.
// -------------------------------------------------------------------------------------------------

async function apiAnomalies(): Promise<Response> {
  const client = makeClient();
  try {
    const session = new Session(client, `dash${Date.now() % 100000}`);
    const { isError, text } = await callTool(session, "find_incidents", {
      metrics: DEFAULT_METRICS,
      limit: 50,
    });
    if (isError) throw new Error(text);
    const payload = JSON.parse(text) as {
      windows: Array<{
        metric: string;
        from: string;
        to: string;
        leadSegment: { dimension: string; value: string };
        worstPct: number;
        worstSigma: number;
        requestsPerDay: number;
        correlatedSegments: number;
      }>;
    };
    return json({ measuredAt: new Date().toISOString(), windows: payload.windows });
  } catch (error) {
    return errorJson(error);
  } finally {
    await client.close();
  }
}

// -------------------------------------------------------------------------------------------------
// /api/rollup-comparison -- hourly vs daily rollup, rows read / server ms, pre-measured.
// -------------------------------------------------------------------------------------------------

async function apiRollupComparison(): Promise<Response> {
  try {
    const text = await Bun.file(ROLLUP_COMPARISON_FILE).text();
    return json(JSON.parse(text));
  } catch (error) {
    return errorJson(
      new Error(
        `No benchmark data yet -- run \`bun run bench:rollup -- --json > dashboard/data/rollup-comparison.json\`. (${error instanceof Error ? error.message : String(error)})`,
      ),
      503,
    );
  }
}

// -------------------------------------------------------------------------------------------------
// /api/llm-cost -- Langfuse's own metrics API, called server-side so keys never reach the browser.
// -------------------------------------------------------------------------------------------------

async function apiLlmCost(): Promise<Response> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";
  if (!publicKey || !secretKey) {
    return errorJson(new Error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set"), 503);
  }

  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const query = {
    view: "observations",
    dimensions: [{ field: "providedModelName" }],
    metrics: [
      { measure: "totalCost", aggregation: "sum" },
      { measure: "totalTokens", aggregation: "sum" },
      { measure: "count", aggregation: "count" },
    ],
    filters: [{ column: "type", operator: "=", value: "GENERATION", type: "string" }],
    fromTimestamp: from.toISOString(),
    toTimestamp: now.toISOString(),
  };

  try {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    // CLIENT span, and no `traceparent` injected: Langfuse's public API is a third party that will
    // not continue our trace, so propagating into it buys nothing. What this span is for is the
    // other half -- a slow or 5xx-ing Langfuse showing up as this panel's latency, attributed.
    const body = await withSpan(
      "langfuse.metrics",
      {
        "http.request.method": "GET",
        "server.address": new URL(baseUrl).host,
        "url.path": "/api/public/metrics",
        "app.window_hours": 24,
      },
      async (span) => {
        const res = await fetch(
          `${baseUrl}/api/public/metrics?query=${encodeURIComponent(JSON.stringify(query))}`,
          {
            headers: { Authorization: `Basic ${auth}` },
          },
        );
        span.setAttribute("http.response.status_code", res.status);
        if (!res.ok) throw new Error(`Langfuse API ${res.status}: ${await res.text()}`);
        const parsed = (await res.json()) as { data: unknown[] };
        span.setAttribute("app.rows", parsed.data.length);
        return parsed;
      },
      SpanKind.CLIENT,
    );
    return json({ measuredAt: now.toISOString(), windowHours: 24, rows: body.data });
  } catch (error) {
    return errorJson(error);
  }
}

// -------------------------------------------------------------------------------------------------
// /api/system-health -- ClickStack's own ClickHouse (otel_traces), stage latency + error rate.
// -------------------------------------------------------------------------------------------------

interface StageHealthRow {
  span_name: string;
  calls: string;
  p50_ms: string;
  p95_ms: string;
  errors: string;
}

async function apiSystemHealth(): Promise<Response> {
  const client = makeTelemetryClient();
  try {
    const rows = await select<StageHealthRow>(
      client,
      `
      SELECT
        SpanName AS span_name,
        count()                                             AS calls,
        round(quantile(0.50)(Duration) / 1e6, 1)             AS p50_ms,
        round(quantile(0.95)(Duration) / 1e6, 1)             AS p95_ms,
        countIf(StatusCode = 'Error')                        AS errors
      FROM otel_traces
      WHERE Timestamp >= now() - INTERVAL 24 HOUR
        AND ServiceName LIKE 'clickhouse-inmobi%'
        AND (SpanName LIKE 'stage.%' OR SpanName LIKE 'mcp.tool.%' OR SpanName = 'investigation')
      GROUP BY SpanName
      ORDER BY calls DESC
      LIMIT 30`,
    );
    return json({
      measuredAt: new Date().toISOString(),
      windowHours: 24,
      stages: rows.map((r) => ({
        spanName: r.span_name,
        calls: Number(r.calls),
        p50Ms: Number(r.p50_ms),
        p95Ms: Number(r.p95_ms),
        errors: Number(r.errors),
      })),
    });
  } catch (error) {
    return errorJson(error);
  } finally {
    await client.close();
  }
}

// -------------------------------------------------------------------------------------------------

async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  // No traversal outside PUBLIC_DIR -- this only ever serves the small fixed set of files we ship.
  if (rel.includes("..")) return null;
  const file = Bun.file(join(PUBLIC_DIR, rel));
  if (!(await file.exists())) return null;
  return new Response(file);
}

/** The set of paths that get their own span name. Everything else collapses to one label. */
const API_ROUTES = new Set([
  "/api/anomalies",
  "/api/rollup-comparison",
  "/api/llm-cost",
  "/api/system-health",
  "/api/config",
]);

/**
 * Span names must be low-cardinality or the trace list becomes unreadable. The API routes are a
 * fixed set so they can be used verbatim; every static asset collapses to `/static/*`, with the
 * real path kept in `url.path` where high cardinality is fine.
 */
const routeLabel = (pathname: string): string =>
  API_ROUTES.has(pathname) ? pathname : "/static/*";

async function dispatch(pathname: string): Promise<Response> {
  if (pathname === "/api/anomalies") return apiAnomalies();
  if (pathname === "/api/rollup-comparison") return apiRollupComparison();
  if (pathname === "/api/llm-cost") return apiLlmCost();
  if (pathname === "/api/system-health") return apiSystemHealth();
  if (pathname === "/api/config") return json({ libreChatUrl: LIBRECHAT_URL });

  const staticRes = await serveStatic(pathname);
  return staticRes ?? new Response("Not found", { status: 404 });
}

/**
 * One SERVER span per request, same shape as `backend/api/server.ts`.
 *
 * `propagation.extract` + `context.with` matter here specifically: this server calls `callTool`,
 * which opens `mcp.tool.*`, which runs the whole investigation engine. Without a parent on the
 * context those spans root a brand-new trace each, so a slow dashboard panel could not be followed
 * down into the stage that made it slow.
 */
const handle = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const parent = propagation.extract(context.active(), Object.fromEntries(req.headers));

  const handled = await context.with(parent, () =>
    trySpan(
      `${req.method} ${routeLabel(url.pathname)}`,
      {
        "http.request.method": req.method,
        "http.route": routeLabel(url.pathname),
        "url.path": url.pathname,
        "url.scheme": url.protocol.replace(":", ""),
        "server.address": url.host,
        "user_agent.original": req.headers.get("user-agent") ?? "",
      },
      async (span) => {
        const response = await dispatch(url.pathname);
        span.setAttribute("http.response.status_code", response.status);
        // 4xx is the caller asking for something that isn't there; only 5xx is our failure.
        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
        }
        return response;
      },
      SpanKind.SERVER,
    ),
  );

  if (handled.ok) return handled.value;

  // A handler that threw rather than returning `errorJson` is a bug on our side. The span is
  // already marked ERROR by `trySpan`; the browser gets a shape it can render.
  log.error("dashboard request failed", {
    "url.path": url.pathname,
    "error.message": handled.error.message,
  });
  return json({ error: handled.error.message }, 500);
};

function main(): void {
  initObservability();

  const server = Bun.serve({ port: PORT, fetch: handle });

  // Not optional. The batch span processor holds un-exported spans, and a dashboard killed with
  // Ctrl-C mid-demo would otherwise drop exactly the traces someone just asked to see.
  const shutdown = async (): Promise<void> => {
    await server.stop();
    await shutdownObservability();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  process.stderr.write(`[dashboard] http://localhost:${PORT}\n`);
}

if (import.meta.main) main();
