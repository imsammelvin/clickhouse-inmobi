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
import { Ledger } from "../engine/ledger";
import { makeClient, makeTelemetryClient, select } from "../clickhouse/client";
import { Session } from "../mcp/trace";
import { callTool } from "../mcp/tools";
import { DEFAULT_METRICS } from "../engine/scan";
import { readFileSync, existsSync } from "node:fs";
import { listWatches, renderNotification, type Notification } from "../mcp/watch";
import { initObservability } from "../../shared/utils/telemetryUtils";

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
    const res = await fetch(
      `${baseUrl}/api/public/metrics?query=${encodeURIComponent(JSON.stringify(query))}`,
      {
        headers: { Authorization: `Basic ${auth}` },
      },
    );
    if (!res.ok) throw new Error(`Langfuse API ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: unknown[] };
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
// /api/watch -- what the watchman found while nobody was looking.
//
// The point of the watchman is that it runs when you are not here, so its output has to survive until
// you come back. The cron appends every firing to a JSONL log; this reads it. `since` lets the browser
// ask only for what it has not shown yet, which is what makes "while you were away" mean anything
// rather than replaying the same three incidents on every page load.
// -------------------------------------------------------------------------------------------------

const WATCH_LOG = join(import.meta.dir, "../mcp/watches/notifications.jsonl");

function apiWatch(url: URL): Response {
  const since = url.searchParams.get("since");
  if (!existsSync(WATCH_LOG)) {
    return json({ notifications: [], watching: listWatches().length, log: false });
  }

  const events = readFileSync(WATCH_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Notification & { at: string }];
      } catch {
        // A half-written final line is normal when the cron is mid-append; skip it rather than 500.
        return [];
      }
    })
    .filter((e) => !since || e.at > since)
    .reverse()
    .slice(0, 25);

  return json({
    watching: listWatches().length,
    log: true,
    notifications: events.map((e) => ({
      at: e.at,
      day: e.day,
      metric: e.watch.metric,
      where: e.watch.dimension ? `${e.watch.dimension} = '${e.watch.value}'` : "platform-wide",
      pct: e.pct,
      requestsPerDay: e.requestsPerDay,
      // The same words the email would have carried, so the two channels cannot drift apart.
      text: renderNotification(e),
    })),
  });
}

// -------------------------------------------------------------------------------------------------

async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  // No traversal outside PUBLIC_DIR -- this only ever serves the small fixed set of files we ship.
  if (rel.includes("..")) return null;
  const file = Bun.file(join(PUBLIC_DIR, rel));
  if (!(await file.exists())) return null;
  // `new Response(file)` alone does not forward `file.type` as a header -- without an explicit
  // Content-Type, some browsers refuse to apply a stylesheet or execute a script served this way.
  // no-store because this is under active development: without it, a browser can keep serving a
  // stale cached copy of style.css/app.js across edits and reloads, so a real fix looks like it
  // did nothing.
  return new Response(file, {
    headers: { "Content-Type": file.type, "Cache-Control": "no-store" },
  });
}

function main(): void {
  initObservability();

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/anomalies") return apiAnomalies();
      if (url.pathname === "/api/rollup-comparison") return apiRollupComparison();
      if (url.pathname === "/api/llm-cost") return apiLlmCost();
      if (url.pathname === "/api/system-health") return apiSystemHealth();
      if (url.pathname === "/api/watch") return apiWatch(url);
      if (url.pathname === "/api/config") return json({ libreChatUrl: LIBRECHAT_URL });

      const staticRes = await serveStatic(url.pathname);
      return staticRes ?? new Response("Not found", { status: 404 });
    },
  });

  process.stderr.write(`[dashboard] http://localhost:${PORT}\n`);
}

if (import.meta.main) main();
