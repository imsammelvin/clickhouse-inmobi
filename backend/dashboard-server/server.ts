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
import { ensureDatasetBounds } from "../engine/baseline";
import { readFileSync, existsSync } from "node:fs";
import { channelLabel, listWatches, renderNotification, type Notification } from "../mcp/watch";
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** How many days the panel shows when the caller does not ask for a window. */
const DEFAULT_RANGE_DAYS = 7;

/** `date` shifted back `days`, in ISO. Plain UTC arithmetic — these are calendar days, not instants. */
function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function apiAnomalies(url: URL): Promise<Response> {
  const client = makeClient();
  try {
    const session = new Session(client, `dash${Date.now() % 100000}`);
    // Validated here rather than passed through: `find_incidents` rejects a bad window with an error,
    // and a date typo should narrow the sweep, not blank the panel.
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const window: Record<string, string> = {};
    if (from && ISO_DATE.test(from)) window.from = from;
    if (to && ISO_DATE.test(to)) window.to = to;

    /**
     * True dataset bounds, read before the sweep rather than inferred from it.
     *
     * They are needed for two separate things and only one of them used to work. `find_incidents`
     * reports back the window it swept, so when a window was requested the old code handed that
     * straight to the picker as its min/max — narrowing the control to the range already selected
     * and leaving no way to widen it again without a reload.
     *
     * They also supply the default window. "Last 7 days" has to mean the last 7 days OF THE DATA:
     * this dataset ends well before today, so anchoring to the wall clock would open the page on an
     * empty range and read as "nothing wrong" — the exact failure the clamp below exists to prevent.
     *
     * Memoized in the engine after the first resolve, so this is one cheap query per process.
     */
    const bounds = await ensureDatasetBounds(<T>(sql: string): Promise<T[]> =>
      select<T>(client, sql),
    );
    const defaulted = !window.from && !window.to;
    if (defaulted) {
      window.from = shiftDays(bounds.end, DEFAULT_RANGE_DAYS - 1);
      window.to = bounds.end;
    }

    const { isError, text } = await callTool(session, "find_incidents", {
      metrics: DEFAULT_METRICS,
      limit: 50,
      ...window,
    });
    if (isError) throw new Error(text);
    const payload = JSON.parse(text) as {
      reportedWindow?: { from: string; to: string };
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
    // `dataBounds` is what the picker clamps to, so it is the full dataset — never `reportedWindow`,
    // which is only the slice just swept. Asking for a window outside the loaded data is the one way
    // to get an empty panel that looks like "all clear".
    return json({
      measuredAt: new Date().toISOString(),
      appliedWindow: { from: window.from ?? null, to: window.to ?? null },
      dataBounds: { from: bounds.start, to: bounds.end },
      // Lets the client say "showing the last 7 days" instead of implying the user chose it.
      windowIsDefault: defaulted,
      defaultRangeDays: DEFAULT_RANGE_DAYS,
      windows: payload.windows,
    });
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

/** Shared by every Langfuse public-API call below -- one place to fail with the same clear error. */
function langfuseAuth(): { baseUrl: string; auth: string } | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  return {
    baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    auth: Buffer.from(`${publicKey}:${secretKey}`).toString("base64"),
  };
}

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
// /api/llm-cost/recent-prompts -- the last few real chat prompts: what was asked, what it cost, and
// the tool-call sequence that answered it, so a user can see their own prompt actually working.
// -------------------------------------------------------------------------------------------------

interface LangfuseToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface LangfuseObservation {
  id: string;
  startTime: string;
  latency: number | null;
  input: unknown;
  output: unknown;
}

interface LangfuseTrace {
  id: string;
  timestamp: string;
  input: unknown;
  totalCost: number;
  latency: number;
  sessionId: string | null;
  /** LibreChat's own Mongo user id, NOT an email -- Langfuse never receives an email address for a
   *  trace (checked directly: neither `userId` nor `metadata` carries one). Resolving this to the
   *  actual email would mean a new connection to LibreChat's own Mongo `users` collection, which
   *  this dashboard doesn't have configured (no MONGO_URI anywhere in this repo's .env). */
  userId: string | null;
  /** Langfuse's own relative link to this trace's page, e.g. "/project/<id>/traces/<traceId>" --
   *  joined with LANGFUSE_BASE_URL below to link straight out to the real trace for anyone who wants
   *  to audit beyond what this page shows. */
  htmlPath: string | null;
}

/** LibreChat's MCP tool names carry a `_mcp_<server-name>` suffix -- strip it back to the plain name
 *  a user would recognize (`investigate`, not `investigate_mcp_sherlook-mcp`). */
function stripMcpSuffix(name: string): string {
  const i = name.indexOf("_mcp_");
  return i === -1 ? name : name.slice(0, i);
}

/**
 * A trace's `input` is the new user message when it starts a fresh turn, but the full accumulated
 * message array when it is a continuation within an ongoing tool-calling exchange -- both shapes are
 * observed in production. Either way, the most recent `role: "user"` message is the actual question
 * driving this particular run.
 */
function extractPrompt(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "(no prompt recorded)";
  for (let i = input.length - 1; i >= 0; i--) {
    const m = input[i] as { role?: string; content?: unknown } | undefined;
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const part = m.content.find(
        (p): p is { type: string; text: string } =>
          typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
      );
      if (part) return part.text;
    }
  }
  return "(no prompt recorded)";
}

/**
 * DeepSeek (like every OpenAI-style tool-calling model) emits an empty `content` alongside its
 * `tool_calls` -- confirmed directly against a real generation's `output` in production. There is no
 * model-authored "why I picked this" text anywhere in the trace to surface; the model simply doesn't
 * narrate. So this doesn't try to reproduce reasoning that was never recorded -- it builds a plain
 * sentence from what each tool's OWN payload actually found.
 *
 * It also never shows the raw tool name (`rank_segments`, `compare_periods`, ...) or a raw
 * `dimension='value'` pair -- a revenue manager has no reason to know what those words mean, and this
 * page's whole point is trust, not a technical trail. That mirrors the rule already enforced on the
 * chat's own answers (backend/mcp/protocol.ts's "WHAT STAYS INTERNAL": never volunteer stage or tool
 * names). `label` is the plain-English stand-in for the tool name; `summary` is the plain-English
 * stand-in for its result.
 */
interface StepPreview {
  label: string;
  summary: string;
  /** The actual result, in plain-English rows -- "what a proper investigation tree should show," not
   *  just a one-line gloss. Capped per call (see ROW_CAP below); the full payload never reaches here
   *  in the first place, so there is nothing larger being held back. */
  rows?: Array<{ label: string; value: string }>;
}

/** Applied per tool call, not per prompt -- this is a human reading one card, not an LLM paying per
 *  token, so it can afford to be generous, but a `rank_segments` call over 200 values still needs a
 *  line somewhere. */
const ROW_CAP = 8;

/** "publisher_tier" -> "publisher tier". Field/dimension names are the raw column names in the
 *  dataset (see backend/mcp/query.ts) -- always snake_case, never meant for display as-is. */
const plainWord = (s: string): string => s.replace(/_/g, " ");

/** "tier_3" -> "Tier 3", "Android 15" -> "Android 15". Dimension VALUES are real data, so this only
 *  reshapes the common enum-code shape (snake_case) and leaves anything already human (a real app
 *  name, an OS version string) untouched. */
const plainValue = (s: string): string =>
  s.includes("_")
    ? s
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
    : s;

/** The three ratio metrics named as acronyms/abbreviations in backend/engine/metrics.ts -- everything
 *  else in METRICS (revenue, requests, impressions, clicks, fill_rate, render_rate) already reads
 *  fine through plainWord alone. */
const METRIC_DISPLAY: Record<string, string> = {
  ecpm: "eCPM",
  ctr: "CTR",
  rpr: "revenue per request",
};
const plainMetric = (m: string): string => METRIC_DISPLAY[m] ?? plainWord(m);

/** Renders a `group` (e.g. `{publisher_tier: 'tier_3', region: 'APAC'}`) as "Tier 3 publishers in
 *  APAC" rather than the technical `publisher_tier='tier_3'` pairing a data tool would print. */
const plainGroup = (group: unknown): string => {
  if (!group || typeof group !== "object" || Object.keys(group).length === 0)
    return "the whole platform";
  return Object.entries(group as Record<string, string>)
    .map(([k, v]) => `${plainValue(v)} (${plainWord(k)})`)
    .join(", ");
};

/** A ratio like 0.673 only means something to a reader as "67.3%" -- fmt is unit-aware using the
 *  same `unit` field every row-returning tool already reports (query.ts's MeasureResult/CompareResult/
 *  RankResult), so this never guesses at a metric's shape. */
const fmtValue = (value: unknown, unit: unknown): string => {
  if (typeof value !== "number") return "no data";
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (unit === "usd") return `$${value.toFixed(2)}`;
  return value.toLocaleString();
};
const fmtDeltaPct = (n: unknown): string =>
  typeof n === "number"
    ? `${n >= 0 ? "up" : "down"} ${Math.abs(n).toFixed(1)}%`
    : "no change recorded";

const asArray = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v : []);

/** Formats one `Finding` (backend/engine/types.ts) -- used for both `investigate`'s real causes
 *  (`findings`) and its cleared segments (`ruledOut`); the only difference is the value line, since a
 *  cleared segment's own delta is dilution, not a cause -- its `residualPp`/`deltaPp` after excluding
 *  the real cause is the number that actually matters. */
const fmtFinding = (f: Record<string, unknown>): { label: string; value: string } => {
  const segment = f.segment as { dimension: string; value: string } | null;
  const label = segment ? plainGroup({ [segment.dimension]: segment.value }) : "The whole platform";
  const status = String(f.status ?? "");
  if (status === "cleared_as_contamination" || status.startsWith("cleared")) {
    const residual = f.residualPp ?? f.deltaPp;
    return {
      label,
      value: `Looked broken, but cleared -- once the real cause is excluded it's normal (residual ${fmtDeltaPct(residual)})`,
    };
  }
  return { label, value: `${fmtDeltaPct(f.deltaPct)}, ${status.replace(/_/g, " ") || "flagged"}` };
};

/** Our own narrative text (`investigate`'s `headline`) is already written for a revenue manager,
 *  except metric names are still the raw dataset column (`fill_rate`, `render_rate`) -- the only two
 *  with an underscore among the metric set in backend/mcp/query.ts's METRICS. */
const plainHeadline = (s: string): string =>
  s
    .replace(/\bfill_rate\b/g, "fill rate")
    .replace(/\brender_rate\b/g, "render rate")
    .replace(/\becpm\b/g, "eCPM")
    .replace(/\bctr\b/g, "CTR")
    .replace(/\brpr\b/g, "revenue per request");

function buildStepPreview(tool: string, p: Record<string, unknown>): StepPreview {
  switch (tool) {
    case "investigate": {
      const req = p.request as { metric?: string } | undefined;
      const metric = plainMetric(req?.metric ?? "the metric");
      const label = `Investigated ${metric}`;
      const bits = [
        plainHeadline(typeof p.headline === "string" ? p.headline : "No headline available."),
      ];
      if (typeof p.ruledOutCount === "number" && p.ruledOutCount > 0) {
        bits.push(
          `Also checked ${p.ruledOutCount} other possible explanation(s) and ruled them out.`,
        );
      }
      // The real causes first (there are usually 0-2), then a sample of what was checked and
      // cleared -- this IS the "checked and ruled out" evidence, the differentiator the whole
      // pipeline exists to produce, not something worth hiding behind a one-line count. Ruled-out
      // entries with no segment (the platform-wide checks that make up most of a no-anomaly verdict)
      // all read as an identical, uninformative "whole platform, cleared" line -- skip those in favor
      // of the specific segments that actually looked suspicious before being excluded.
      const findings = asArray(p.findings).map(fmtFinding);
      const ruledOut = asArray(p.ruledOut)
        .filter((f) => f.segment)
        .slice(0, ROW_CAP - findings.length)
        .map(fmtFinding);
      return { label, summary: bits.join(" "), rows: [...findings, ...ruledOut] };
    }
    case "find_incidents": {
      const metrics = Array.isArray(p.metricsSwept) ? p.metricsSwept.length : 0;
      const windows = asArray(p.windows)
        .slice(0, ROW_CAP)
        .map((w) => {
          const lead = w.leadSegment as { dimension: string; value: string } | undefined;
          return {
            label: `${plainMetric(String(w.metric ?? ""))} (${w.from} to ${w.to})`,
            value: `${lead ? plainGroup({ [lead.dimension]: lead.value }) : "platform-wide"}, ${fmtDeltaPct(w.worstPct)}`,
          };
        });
      return {
        label: "Scanned for anomalies",
        summary: `Scanned ${metrics} metric(s) for anything unusual -- found ${p.windowCount ?? 0} thing(s) worth a closer look.`,
        rows: windows,
      };
    }
    case "rank_segments": {
      const dim = plainWord(String(p.dimension ?? "segment"));
      const metric = plainMetric(String(p.metric ?? "the metric"));
      const label = `Checked which ${dim} was worst on ${metric}`;
      const rows = asArray(p.rows);
      const rowsOut = rows
        .slice(0, ROW_CAP)
        .map((r) => ({ label: plainGroup(r.group), value: fmtValue(r.value, p.unit) }));
      if (!rows.length) {
        return {
          label,
          summary: `Checked every ${dim} for ${metric} -- none had enough data to judge.`,
        };
      }
      const top = rows[0]!;
      return {
        label,
        summary: `Checked every ${dim} to find the worst ${metric} -- ${plainGroup(top.group)} came out worst, at ${fmtValue(top.value, p.unit)}.`,
        rows: rowsOut,
      };
    }
    case "compare_periods": {
      const metric = plainMetric(String(p.metric ?? "the metric"));
      const label = `Compared ${metric} to its usual level`;
      const rows = asArray(p.rows);
      const rowsOut = rows
        .slice(0, ROW_CAP)
        .map((r) => ({ label: plainGroup(r.group), value: `${fmtDeltaPct(r.deltaPct)} vs. usual` }));
      if (!rows.length) {
        return { label, summary: `Compared ${metric} to its usual level -- nothing to compare.` };
      }
      const biggest = [...rows].sort(
        (a, b) => Math.abs((b.deltaPct as number) ?? 0) - Math.abs((a.deltaPct as number) ?? 0),
      )[0]!;
      const scope = rows.length > 1 ? `across ${rows.length} segment(s), ` : "";
      return {
        label,
        summary: `Compared ${metric} to its usual level ${scope}-- the biggest move was ${plainGroup(biggest.group)}, ${fmtDeltaPct(biggest.deltaPct)} versus normal.`,
        rows: rowsOut,
      };
    }
    case "get_metric": {
      const metric = plainMetric(String(p.metric ?? "the metric"));
      const label = `Looked up ${metric}`;
      const rows = asArray(p.rows);
      const rowsOut = rows
        .slice(0, ROW_CAP)
        .map((r) => ({ label: plainGroup(r.group), value: fmtValue(r.value, p.unit) }));
      if (rows.length === 1) {
        const row = rows[0]!;
        return {
          label,
          summary: `${metric} was ${fmtValue(row.value, p.unit)}, based on ${Number(row.requests ?? 0).toLocaleString()} requests.`,
        };
      }
      return {
        label,
        summary: `Looked up ${metric} broken out across ${rows.length} row(s) of data.`,
        rows: rowsOut,
      };
    }
    case "explain_revenue": {
      const driver = typeof p.driver === "string" ? plainWord(p.driver) : null;
      const factors = asArray(p.factors).map((f) => ({
        label: plainWord(String(f.factor ?? "")),
        value: `${fmtDeltaPct(f.deltaPct)}, ${fmtValue(f.revenueEffectUsdPerDay, "usd")}/day`,
      }));
      return {
        label: "Checked what drove revenue",
        summary: driver
          ? `Checked which lever moved revenue -- it was ${driver}, worth ${fmtValue(p.revenueDeltaPerDay, "usd")} a day.`
          : `Checked which lever moved revenue -- no single factor stood out.`,
        rows: factors,
      };
    }
    case "describe_data": {
      const window = p.window as { days?: number } | undefined;
      const volumes = p.volumes as { requests?: number } | undefined;
      return {
        label: "Loaded the dataset overview",
        summary: `Loaded ${window?.days ?? "some"} day(s) of data, covering ${Number(volumes?.requests ?? 0).toLocaleString()} requests.`,
      };
    }
    case "list_dimension_values": {
      const dim = plainWord(String(p.dimension ?? "values"));
      return {
        label: `Looked up ${dim} values`,
        summary: `Found ${p.valueCount ?? 0} distinct ${dim} value(s) in the data.`,
      };
    }
    case "get_evidence": {
      const label = "Checked the underlying data";
      if (p.matched !== undefined) {
        return {
          label,
          summary: `Searched the underlying records -- ${p.matched} of ${p.totalRecorded} matched.`,
        };
      }
      return { label, summary: `Looked up one specific number to confirm it.` };
    }
    case "export_trace": {
      const totals = p.totals as { calls?: number } | undefined;
      return {
        label: "Saved the audit trail",
        summary: `Saved a full record of the ${totals?.calls ?? 0} check(s) made, for anyone who wants to audit it later.`,
      };
    }
    default:
      // An unrecognized/new tool -- still avoid a raw name/field dump.
      return { label: plainWord(tool), summary: "Ran a check as part of this answer." };
  }
}

/**
 * A tool-dispatch's `output` wraps one LangGraph tool message per call in the same dispatch, in the
 * same order as `input` -- each message's `content` is that call's raw JSON response text (or a
 * plain-text error). Only a short preview is kept per call; the full payload is discarded immediately
 * after parsing so nothing large ever reaches the browser.
 */
function extractStepCalls(o: LangfuseObservation): StepPreview[] {
  const calls = Array.isArray(o.input) ? (o.input as LangfuseToolCall[]) : [];
  let messages: Array<{ content?: unknown }> = [];
  try {
    const parsedOut = typeof o.output === "string" ? JSON.parse(o.output) : o.output;
    const m = (parsedOut as { messages?: unknown } | null)?.messages;
    if (Array.isArray(m)) messages = m;
  } catch {
    // Not JSON, or not the shape we expect -- previews stay empty rather than guessing.
  }
  return calls.map((c, i) => {
    const name = stripMcpSuffix(c.name);
    // Generic fallback label -- deliberately not derived from the raw tool name (that's the exact
    // "technical stuff" this page exists to hide). Only overridden below when enough of a truncated
    // payload survives to say something more specific.
    const fallback = {
      label: "Ran an additional check",
      summary: "This check didn't complete successfully.",
    };
    const content = messages[i]?.content;
    if (typeof content !== "string") return fallback;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return buildStepPreview(name, parsed);
    } catch {
      // Two different reasons land here: a tool that genuinely errored returns a plain-text
      // message instead of JSON; a large payload (investigate's especially) can also arrive
      // truncated mid-string from upstream span-size limits, which breaks JSON.parse on otherwise-
      // fine data. Both the headline and the metric it investigated sit near the front of that
      // payload and usually survive a truncation that cuts off later fields, so recover what's
      // there before falling back to a generic, honest "it failed."
      const headlineMatch = content.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!headlineMatch) return fallback;
      const metricMatch = content.match(/"metric"\s*:\s*"([^"]+)"/);
      const label =
        name === "investigate"
          ? `Investigated ${plainMetric(metricMatch?.[1] ?? "the metric")}`
          : fallback.label;
      return { label, summary: plainHeadline(headlineMatch[1]!) };
    }
  });
}

/** A fresh turn's own tool-dispatch steps can be empty when the model answers from a PRIOR turn's
 *  investigation already in context (observed: a one-line follow-up costing $0.001, zero tool calls
 *  of its own, in the same Langfuse session as the investigation that answered it minutes earlier).
 *  Merging in the same session's steps, walked backward from this prompt's own end time and stopped
 *  at the first gap wider than this, keeps "what was investigated" attached to the answer it actually
 *  supports without dragging in an unrelated, much older part of a long-running session. */
const SESSION_STEP_GAP_MS = 3 * 60 * 1000;

async function apiRecentPrompts(): Promise<Response> {
  const creds = langfuseAuth();
  if (!creds) return errorJson(new Error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set"), 503);
  const { baseUrl, auth } = creds;

  try {
    const prompts = await withSpan(
      "langfuse.recent_prompts",
      { "http.request.method": "GET", "server.address": new URL(baseUrl).host },
      async (span) => {
        // `name=AgentRun` is LibreChat's own name for one agent turn -- the same filter that isolates
        // real chat activity from this dashboard's own polling traffic, which also lands in Langfuse.
        const tracesRes = await fetch(
          `${baseUrl}/api/public/traces?limit=5&orderBy=timestamp.desc&name=AgentRun`,
          { headers: { Authorization: `Basic ${auth}` } },
        );
        if (!tracesRes.ok) {
          throw new Error(`Langfuse API ${tracesRes.status}: ${await tracesRes.text()}`);
        }
        const traces = ((await tracesRes.json()) as { data: LangfuseTrace[] }).data;
        span.setAttribute("app.trace_count", traces.length);

        // One fetch per distinct session, shared across every prompt from that session, rather than
        // one fetch per prompt -- the last 5 prompts are frequently 2-3 turns of the same session.
        const sessionSteps = new Map<string, Promise<LangfuseObservation[]>>();
        const stepsForSession = (sessionId: string): Promise<LangfuseObservation[]> => {
          let p = sessionSteps.get(sessionId);
          if (p) return p;
          p = fetch(
            `${baseUrl}/api/public/observations?sessionId=${encodeURIComponent(sessionId)}` +
              `&name=tool-dispatch&limit=100&orderBy=startTime.desc`,
            { headers: { Authorization: `Basic ${auth}` } },
          )
            .then((res) =>
              res.ok ? (res.json() as Promise<{ data: LangfuseObservation[] }>) : null,
            )
            .then((body) =>
              (body?.data ?? []).sort((a, b) => a.startTime.localeCompare(b.startTime)),
            );
          sessionSteps.set(sessionId, p);
          return p;
        };

        return Promise.all(
          traces.map(async (t, idx) => {
            const promptEndMs = new Date(t.timestamp).getTime() + t.latency * 1000;
            // Bound the backward walk at the previous OLDER prompt WE ALSO SHOW, in the same
            // session, so its own tool calls never get re-attributed to a later, unrelated prompt
            // just because the two happened to land within the gap window of each other (observed:
            // four back-to-back small-talk turns in one session, one of which called a tool --
            // without this bound, that one call showed up under all four).
            let lowerBoundMs = -Infinity;
            for (let j = idx + 1; j < traces.length; j++) {
              if (traces[j]!.sessionId === t.sessionId) {
                lowerBoundMs = new Date(traces[j]!.timestamp).getTime() + traces[j]!.latency * 1000;
                break;
              }
            }
            let cluster: LangfuseObservation[] = [];
            if (t.sessionId) {
              const all = await stepsForSession(t.sessionId);
              let lastIdx = -1;
              for (let i = all.length - 1; i >= 0; i--) {
                const tMs = new Date(all[i]!.startTime).getTime();
                if (tMs > promptEndMs) continue;
                if (tMs < lowerBoundMs) break; // already claimed by an earlier shown prompt
                lastIdx = i;
                break;
              }
              if (lastIdx >= 0) {
                cluster = [all[lastIdx]!];
                let cursorMs = new Date(all[lastIdx]!.startTime).getTime();
                for (let i = lastIdx - 1; i >= 0; i--) {
                  const tMs = new Date(all[i]!.startTime).getTime();
                  if (tMs < lowerBoundMs) break;
                  if (cursorMs - tMs > SESSION_STEP_GAP_MS) break;
                  cluster.unshift(all[i]!);
                  cursorMs = tMs;
                }
              }
            }
            const steps = cluster.map((o) => {
              const calls = extractStepCalls(o);
              return {
                calls,
                // Several tools dispatched in the same round-trip were genuinely evaluated together
                // -- e.g. ranking a segment by two different dimensions at once before picking one --
                // worth saying explicitly rather than letting them read as a sequence.
                parallel: calls.length > 1,
                startTime: o.startTime,
                latencySec: o.latency ?? 0,
              };
            });
            return {
              traceId: t.id,
              traceUrl: t.htmlPath ? `${baseUrl}${t.htmlPath}` : null,
              userId: t.userId,
              timestamp: t.timestamp,
              prompt: extractPrompt(t.input),
              costUsd: t.totalCost,
              latencySec: t.latency,
              steps,
            };
          }),
        );
      },
      SpanKind.CLIENT,
    );
    return json({ measuredAt: new Date().toISOString(), prompts });
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
      diagnosis: e.diagnosis
        ? { ...e.diagnosis, channelLabel: channelLabel(e.diagnosis.channel) }
        : null,
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

/** The set of paths that get their own span name. Everything else collapses to one label. */
const API_ROUTES = new Set([
  "/api/anomalies",
  "/api/rollup-comparison",
  "/api/llm-cost",
  "/api/llm-cost/recent-prompts",
  "/api/system-health",
  "/api/watch",
  "/api/config",
]);

/**
 * Span names must be low-cardinality or the trace list becomes unreadable. The API routes are a
 * fixed set so they can be used verbatim; every static asset collapses to `/static/*`, with the
 * real path kept in `url.path` where high cardinality is fine.
 */
const routeLabel = (pathname: string): string =>
  API_ROUTES.has(pathname) ? pathname : "/static/*";

/**
 * Takes the whole URL, not just the pathname: `/api/anomalies` reads a from/to date range and
 * `/api/watch` reads a `since` watermark, and neither can be expressed by a path. The span label is
 * still built from the pathname alone so query strings never become high-cardinality span names.
 */
async function dispatch(url: URL): Promise<Response> {
  const pathname = url.pathname;
  if (pathname === "/api/anomalies") return apiAnomalies(url);
  if (pathname === "/api/rollup-comparison") return apiRollupComparison();
  if (pathname === "/api/llm-cost") return apiLlmCost();
  if (pathname === "/api/llm-cost/recent-prompts") return apiRecentPrompts();
  if (pathname === "/api/system-health") return apiSystemHealth();
  if (pathname === "/api/watch") return apiWatch(url);
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
        const response = await dispatch(url);
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

  /**
   * `idleTimeout` is set because Bun's default is 10 seconds, and `/api/anomalies` can exceed it.
   *
   * Observed on the hosted demo: the sweep took ~12s there and Bun closed the socket before the
   * handler produced anything. curl reports an empty reply, the browser shows a network error, and
   * the panel renders "could not load" — a failure that looks like the engine is broken when it is
   * actually still working and about to answer. The server stays up, so nothing in a log says why.
   *
   * 120s is well past any real sweep (locally the full 35-day range returns in under a second off the
   * rollup) and only exists so a slow one degrades to slow rather than to a dropped connection.
   */
  const server = Bun.serve({ port: PORT, fetch: handle, idleTimeout: 120 });
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
