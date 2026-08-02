/**
 * The tool surface. This is the user layer — the whole vocabulary of questions the chat can ask.
 *
 * Shape of the contract, and why it is this shape:
 *
 *   - **Ten parameterized tools, no SQL tool.** Coverage comes from parameters (filters, group-by,
 *     granularity, ordering, explicit or same-weekday baselines), not from letting the model author
 *     queries. See mcp/query.ts for the reasoning.
 *   - **Deterministic code analyses; the LLM narrates.** `investigate` runs the fixed six-stage
 *     pipeline with no model in its control flow, and hands back both the structured finding and a
 *     rendered narrative that has already passed the grounding check. The model's job is to say it
 *     well, not to work it out.
 *   - **Every answer carries its own receipt.** Each result includes `trace` — call id, elapsed ms,
 *     queries issued — and the evidence ids behind its numbers, which `get_evidence` expands into
 *     the exact SQL and hash. That is criterion 2 in the response envelope rather than in a promise,
 *     and it is what makes "diagnosed in 1.4s" a citable fact rather than a claim.
 *
 * Descriptions below are written to be read by a model deciding what to call, so each one says
 * *when* to use the tool, not just what it does — and several say what to call instead.
 */
import type { Ledger } from "../engine/ledger";
import { investigate } from "../engine/orchestrate";
import type { Investigation } from "../engine/types";
import { renderNarrative } from "../engine/render";
import { checkGrounding } from "../engine/grounding";
import { decompose } from "../engine/stages/decompose";
import { clusterWindows, groupIntoIncidents, scanSegments } from "../engine/segments";
import { DEFAULT_METRICS } from "../engine/scan";
import { rollupHealth } from "../clickhouse/rollup";
import { scanSegmentsRollup } from "./sweep";
import {
  DATASET_END,
  DATASET_START,
  DIMENSIONS,
  FILLED_ONLY_DIMENSIONS,
  METRICS,
  MAX_ROWS,
  type FilterValue,
  QueryError,
  assertDimension,
  assertWindow,
  buildScope,
  comparePeriods,
  datasetOverview,
  dimensionValues,
  measure,
  rankSegments,
  resolveMetric,
  weeklyGrowthFor,
} from "./query";
import { recommendAction } from "./action";
import { addWatch, listWatches, removeWatch, runOnce } from "./watch";
import type { Session, ToolOutcome } from "./trace";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    ledger: Ledger,
    session: Session,
  ) => Promise<ToolOutcome>;
}

const str = (description: string) => ({ type: "string", description });
const date = (description: string) => ({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description,
});
const metricEnum = (description: string) => ({
  type: "string",
  enum: Object.keys(METRICS),
  description,
});
const filtersSchema = {
  type: "object",
  additionalProperties: {
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  },
  description:
    'Filter to a slice. Three forms: exact {"os_version": "Android 15"}, several ' +
    '{"os_version": ["Android 15", "Android 14"]}, or a prefix {"os_version": "Android*"} which ' +
    'matches every version of that OS. Use the prefix or list form for a family question ("how much ' +
    'traffic is Android?", "the two newest iOS versions") rather than adding up separate calls ' +
    "yourself — a total you compute is not a measured number. Values must match the data exactly; " +
    "call list_dimension_values if unsure.",
};

const asRecord = (v: unknown): Record<string, FilterValue> | undefined =>
  v === undefined || v === null ? undefined : (v as Record<string, FilterValue>);

const fmtPct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

// -------------------------------------------------------------------------------------------------

const describeData: ToolDef = {
  name: "describe_data",
  description:
    "Start here when you do not already know the date range, the metric names, or which dimensions " +
    "exist. Returns the loaded window, total volumes, every metric with its exact formula, every " +
    "sliceable dimension, and the data caveats that make certain questions unanswerable. Call it " +
    "once at the start of a conversation rather than guessing a metric or column name.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ledger, session) => {
    const o = await session.getOverview(() => datasetOverview(ledger));
    return {
      summary: `${o.days} days, ${o.requests.toLocaleString()} requests`,
      payload: {
        servedFrom: o.servedFrom,
        window: { from: o.from, to: o.to, days: o.days },
        volumes: {
          requests: o.requests,
          filled: o.filled,
          impressions: o.impressions,
          clicks: o.clicks,
          revenueUsd: Number(o.revenue.toFixed(2)),
        },
        metrics: Object.values(METRICS).map((m) => ({
          name: m.name,
          kind: m.kind,
          unit: m.unit,
          formula:
            m.kind === "absolute"
              ? m.numerator
              : `${m.numerator} / ${m.denominator}${m.scale !== 1 ? ` * ${m.scale}` : ""}`,
          reliabilityFloor: m.minNumerator
            ? `${m.minNumerator} numerator events`
            : m.minDenominator
              ? `${m.minDenominator} denominator events`
              : "none",
        })),
        dimensions: {
          always: DIMENSIONS,
          filledEventsOnly: FILLED_ONLY_DIMENSIONS,
        },
        revenueIdentity: "revenue = requests x fill_rate x (impressions/fills) x ecpm/1000",
        caveats: [
          "Ratio metrics are always sum/sum over the group, never an average of per-row or per-day " +
            "ratios. Do not average a rate across days.",
          "advertiser_id is empty on unfilled requests, so advertiser_vertical, campaign_type and " +
            "advertiser_id can only slice metrics restricted to filled events (ecpm, ctr, " +
            "render_rate, impressions, revenue). Asking for fill_rate or requests by those is " +
            "rejected rather than answered, because the answer would be wrong.",
          "'Normal' means the same weekday in trailing weeks, never a flat average of recent days — " +
            "traffic has a strong weekly cycle and a flat mean makes every weekend look anomalous.",
          "There is a real +6.4% growth trend across the window. A rise of a few percent is usually " +
            "the trend, not an incident.",
          "The dataset contains no calendar, event or contextual data. Attribution to an external " +
            "cause (a match, a holiday) is out of scope and must not be asserted.",
        ],
      },
    };
  },
};

const listDimensionValues: ToolDef = {
  name: "list_dimension_values",
  description:
    "List the actual values a dimension takes, largest by traffic first, with each value's share. " +
    "Call this before filtering or when a user names something loosely ('Android', 'the EU', 'that " +
    "finance app') — filters must match the data exactly, and this is the only way to resolve a " +
    "loose name into a real value. Also the right tool for 'how many countries are there?' or " +
    "'which apps carry the most traffic?'.",
  inputSchema: {
    type: "object",
    properties: {
      dimension: str(`Dimension to enumerate. One of: ${DIMENSIONS.join(", ")}.`),
      metric: metricEnum(
        "Metric you intend to measure. Only affects validation — a filled-events-only dimension is " +
          "rejected for fill_rate or requests. Defaults to revenue.",
      ),
      from: date("Start of the window to count traffic over. Defaults to the whole dataset."),
      to: date("End of the window. Defaults to `from`."),
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ROWS,
        description: "Max values (default 30).",
      },
    },
    required: ["dimension"],
    additionalProperties: false,
  },
  handler: async (args, ledger) => {
    const metric = typeof args.metric === "string" ? args.metric : "revenue";
    const window = assertWindow(args.from ?? DATASET_START, args.to ?? DATASET_END);
    const { values, servedFrom } = await dimensionValues(
      ledger,
      String(args.dimension),
      metric,
      window,
      typeof args.limit === "number" ? args.limit : 30,
    );
    // Same reasoning as compare_periods/rank_segments/get_metric: this result gets replayed on every
    // later turn, so cap what's inlined independent of the `limit` the caller asked for.
    const SHOWN_VALUES = 20;
    const valuesShown = values.slice(0, SHOWN_VALUES);
    return {
      summary: `${values.length} value(s) of ${String(args.dimension)}`,
      payload: {
        dimension: args.dimension,
        window,
        values: valuesShown,
        valueCount: values.length,
        ...(values.length > SHOWN_VALUES
          ? {
              valuesNote:
                `${values.length - SHOWN_VALUES} further value(s) not shown -- values are already ` +
                "ranked by traffic, so the head is the meaningful part; narrow with a smaller window " +
                "if you need a specific one.",
            }
          : {}),
        truncated: values.length >= MAX_ROWS,
        servedFrom,
      },
    };
  },
};

const getMetric: ToolDef = {
  name: "get_metric",
  description:
    "Measure one metric over one window — the workhorse for any 'what was X?' question. Optionally " +
    "filter to a segment, break out by up to two dimensions, and split by day or hour. Use this to " +
    "answer a level question ('what was fill rate for Android 15 in the EU last week, by day?'). " +
    "For 'did it change?' use compare_periods; for 'which is worst?' use rank_segments; for 'why " +
    "did it change?' use investigate. Rows below the reliability floor are returned with " +
    "reliable=false and a note rather than dropped — report the caveat, do not quote the number bare. " +
    // Repeated here rather than left to describe_data: a model that jumps straight to this tool never
    // sees the caveat otherwise, and averaging a rate across rows is the easiest way to produce a
    // confidently wrong number from correct data.
    "Every ratio is sum/sum over its own group: never average these values across rows or days to " +
    "get a total — call again without group_by, or at the granularity you want.",
  inputSchema: {
    type: "object",
    properties: {
      metric: metricEnum("Metric to measure."),
      from: date("First day of the window (inclusive)."),
      to: date("Last day (inclusive). Defaults to `from` for a single day."),
      filters: filtersSchema,
      group_by: {
        type: "array",
        items: { type: "string" },
        maxItems: 2,
        description: "Break the result out by these dimensions (max 2).",
      },
      granularity: {
        type: "string",
        enum: ["total", "day", "hour"],
        description: "One row for the window (default), or one per day / per hour.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ROWS,
        description: "Max rows (default 25).",
      },
    },
    required: ["metric", "from"],
    additionalProperties: false,
  },
  handler: async (args, ledger) => {
    const r = await measure(ledger, {
      metric: String(args.metric),
      from: String(args.from),
      to: args.to === undefined ? undefined : String(args.to),
      filters: asRecord(args.filters),
      group_by: args.group_by as string[] | undefined,
      granularity: args.granularity as "total" | "day" | "hour" | undefined,
      limit: args.limit as number | undefined,
    });
    const head = r.rows[0];
    // Same reasoning as compare_periods/rank_segments below: every tool result gets replayed
    // verbatim on every later turn, so an hourly-granularity, wide-window call is worth capping here
    // too rather than trusting the caller's `limit` alone.
    const SHOWN_ROWS = 20;
    const rowsShown = r.rows.slice(0, SHOWN_ROWS);
    return {
      summary:
        r.rows.length === 1 && head
          ? `${r.metric} = ${head.value?.toFixed(4) ?? "null"} (${head.requests.toLocaleString()} requests)`
          : `${r.rows.length} row(s) of ${r.metric}`,
      payload: {
        ...r,
        rows: rowsShown,
        rowCount: r.rows.length,
        ...(r.rows.length > SHOWN_ROWS
          ? {
              rowsNote:
                `${r.rows.length - SHOWN_ROWS} further row(s) not shown -- narrow the window, add ` +
                "a filter, or raise granularity, rather than raising `limit`.",
            }
          : {}),
      },
    };
  },
};

const comparePeriodsTool: ToolDef = {
  name: "compare_periods",
  description:
    "Compare a metric between a window and a baseline, and rank what moved. This is the 'did it " +
    "change / how does this week compare / what moved the most' tool. By default the baseline is " +
    "the same weekday(s) in preceding weeks, which is the only like-for-like comparison in this " +
    "data — traffic has a strong weekly cycle, so comparing a Saturday against the preceding weekdays " +
    "invents an incident every weekend. Pass baseline_from/baseline_to only if the user named a " +
    "specific comparison period. Group by a dimension to get the biggest movers. " +
    // Also stated in describe_data, but a model that starts here would not have seen it, and this is
    // the tool whose output most invites reading a trend as a break.
    "The dataset has a real +6.4% growth trend across its span: a rise of a few percent is usually " +
    "that trend, not an incident. It tells you WHAT moved; it does not distinguish a cause from its " +
    "shadow — use investigate for that.",
  inputSchema: {
    type: "object",
    properties: {
      metric: metricEnum("Metric to compare."),
      from: date("First day of the window of interest."),
      to: date("Last day. Defaults to `from`."),
      baseline_from: date(
        "Optional explicit baseline start. Omit to use the same-weekday trailing baseline.",
      ),
      baseline_to: date("Optional explicit baseline end. Defaults to `baseline_from`."),
      filters: filtersSchema,
      group_by: {
        type: "array",
        items: { type: "string" },
        maxItems: 2,
        description: "Rank movers within these dimensions (max 2). Omit for the blended total.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ROWS,
        description: "Max rows (default 25).",
      },
    },
    required: ["metric", "from"],
    additionalProperties: false,
  },
  handler: async (args, ledger) => {
    const r = await comparePeriods(ledger, {
      metric: String(args.metric),
      from: String(args.from),
      to: args.to === undefined ? undefined : String(args.to),
      baseline_from: args.baseline_from === undefined ? undefined : String(args.baseline_from),
      baseline_to: args.baseline_to === undefined ? undefined : String(args.baseline_to),
      filters: asRecord(args.filters),
      group_by: args.group_by as string[] | undefined,
      limit: args.limit as number | undefined,
    });
    const head = r.rows[0];
    // Every tool result gets replayed verbatim on every later turn of the same conversation -- a
    // `limit: 200` call (the schema allows up to MAX_ROWS) was seen costing 60k+ chars, repeated on
    // every subsequent round-trip. Cap what's inlined here the same way `investigate`'s ruledOut
    // list already is: rows themselves already ranked by the query, so a small head is the
    // meaningful part; the rest is one call away by re-asking with a narrower filter or dimension.
    const SHOWN_ROWS = 20;
    const rowsShown = r.rows.slice(0, SHOWN_ROWS);
    return {
      summary:
        r.rows.length === 1 && head?.deltaPct !== null && head?.deltaPct !== undefined
          ? `${r.metric} ${fmtPct(head.deltaPct)} vs baseline`
          : `${r.rows.length} row(s) compared`,
      payload: {
        ...r,
        rows: rowsShown,
        rowCount: r.rows.length,
        ...(r.rows.length > SHOWN_ROWS
          ? {
              rowsNote:
                `${r.rows.length - SHOWN_ROWS} further row(s) not shown -- narrow with \`filters\` ` +
                `or a smaller \`group_by\` if you need a specific one, rather than raising \`limit\`.`,
            }
          : {}),
      },
    };
  },
};

const rankSegmentsTool: ToolDef = {
  name: "rank_segments",
  description:
    "Rank the values of one dimension by a metric — 'which country has the worst fill rate?', 'top " +
    "10 apps by revenue', 'best performing ad format'. Ranks on the level in the window, not on " +
    "change; for change use compare_periods with group_by. Values below the volume floor are " +
    "excluded (a rate on a handful of events would otherwise top the list) and the floor is stated " +
    "in the result — say so rather than implying the list is exhaustive.",
  inputSchema: {
    type: "object",
    properties: {
      metric: metricEnum("Metric to rank by."),
      dimension: str("Dimension whose values are ranked."),
      from: date("First day of the window."),
      to: date("Last day. Defaults to `from`."),
      order: {
        type: "string",
        enum: ["worst", "best", "largest"],
        description:
          "`worst` = lowest metric value first (default), `best` = highest, `largest` = most traffic.",
      },
      filters: filtersSchema,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ROWS,
        description: "Max rows (default 25).",
      },
    },
    required: ["metric", "dimension", "from"],
    additionalProperties: false,
  },
  handler: async (args, ledger) => {
    const r = await rankSegments(ledger, {
      metric: String(args.metric),
      dimension: String(args.dimension),
      from: String(args.from),
      to: args.to === undefined ? undefined : String(args.to),
      order: args.order as "worst" | "best" | "largest" | undefined,
      filters: asRecord(args.filters),
      limit: args.limit as number | undefined,
    });
    // Same reasoning as compare_periods just above: a full 200-row rank was seen costing 22k+ chars,
    // replayed on every later turn of the conversation. Rows are already ordered by the query, so
    // the head is the meaningful part.
    const SHOWN_ROWS = 20;
    const rowsShown = r.rows.slice(0, SHOWN_ROWS);
    return {
      summary: `${r.rows.length} ${r.dimension} value(s), ${r.order} first`,
      payload: {
        ...r,
        rows: rowsShown,
        rowCount: r.rows.length,
        ...(r.rows.length > SHOWN_ROWS
          ? {
              rowsNote:
                `${r.rows.length - SHOWN_ROWS} further row(s) not shown -- narrow with ` +
                "`filters` if you need a specific one, rather than raising `limit`.",
            }
          : {}),
      },
    };
  },
};

const findIncidents: ToolDef = {
  name: "find_incidents",
  description:
    "Sweep for anomalies without being told where to look — 'did anything break?', 'what happened " +
    "last week?', 'anything I should know about?'. Detection runs inside ClickHouse against a " +
    "same-weekday, trend-adjusted, median/MAD baseline at strict gates (5 sigma and 10%, because " +
    "the sweep runs ~98k simultaneous tests per metric), and returns distinct incident WINDOWS — " +
    "one per event with its strongest segment — not one row per segment that moved. Each window is " +
    "a candidate to hand to investigate; this tool finds, investigate explains.",
  inputSchema: {
    type: "object",
    properties: {
      metrics: {
        type: "array",
        items: metricEnum("Metric name."),
        description: `Metrics to sweep. Defaults to ${DEFAULT_METRICS.join(", ")}.`,
      },
      from: date(
        "Restrict reported windows to those starting on/after this day. Baseline still uses full history.",
      ),
      to: date("Restrict reported windows to those on/before this day."),
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Max windows (default 12)." },
    },
    additionalProperties: false,
  },
  handler: async (args, ledger) => {
    const metrics =
      Array.isArray(args.metrics) && args.metrics.length
        ? (args.metrics as string[]).map((m) => resolveMetric(m).name)
        : DEFAULT_METRICS;
    const window =
      args.from !== undefined
        ? assertWindow(args.from, args.to ?? DATASET_END)
        : args.to !== undefined
          ? assertWindow(DATASET_START, args.to)
          : undefined;
    const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 12;

    // The rollup-backed sweep when the rollup is proven current, the raw fan-out otherwise. Same
    // gates, same statistics, same firings -- asserted firing-for-firing by ch:verify-rollup -- so
    // this chooses between two costs, not two answers. It is the biggest single latency item in the
    // server: the raw sweep fans 9M events out 17 ways per metric across the whole history, because
    // the baseline needs the whole history.
    const health = rollupHealth();
    const scan = health?.ready ? scanSegmentsRollup : scanSegments;

    // One metric's growth-estimate + segment sweep never depends on another's -- each is its own
    // independent ClickHouse round trip against the same fixed window. Measured serially at 4.3-4.9s
    // apiece for the raw-fallback path (~14s total for one find_incidents call); run concurrently.
    // Same win applies whichever `scan` was picked above -- rollup makes each call cheap, this makes
    // however many calls there are not stack serially.
    const perMetric = await Promise.all(
      metrics.map(async (metric) => {
        // Growth is estimated from the whole daily series, never from a handful of baseline points:
        // a 3-point fit once produced a phantom +213% at 427 sigma.
        const growth = await weeklyGrowthFor(ledger, metric);
        return scan(ledger, metric, growth, window);
      }),
    );
    const firings = perMetric.flat();
    // clusterWindows already returns these ranked by impact (magnitude x duration), most severe
    // first -- see backend/engine/segments.ts. The nextStep cap below relies on that ordering.
    const windows = clusterWindows(groupIntoIncidents(firings));

    // Only the top few windows get an explicit "go call investigate" invitation. Handing back a
    // nextStep on every one of a dozen windows was the direct cause of a single sweep turning into a
    // dozen-plus sequential investigate() calls (~3.5 minutes for one reply) -- see
    // pitch/latency-analysis.md. The rest are still fully returned, with the same numbers, just
    // without the per-row nudge to drill in.
    const NEXT_STEP_TOP_N = 3;

    return {
      summary: `${windows.length} incident window(s) across ${metrics.length} metric(s)`,
      payload: {
        metricsSwept: metrics,
        reportedWindow: window ?? { from: DATASET_START, to: DATASET_END },
        gates: "abs(change) >= 10% AND abs(sigma) >= 5, min 150 requests/day/segment",
        servedFrom: health?.ready ? "rollup:daily" : "raw",
        windowCount: windows.length,
        windows: windows.slice(0, limit).map((w, i) => ({
          metric: w.metric,
          from: w.from,
          to: w.to,
          leadSegment: { dimension: w.lead.dimension, value: w.lead.value },
          worstPct: Number(w.lead.worstPct.toFixed(2)),
          worstSigma: Number(w.lead.worstSigma.toFixed(2)),
          days: w.lead.days,
          requestsPerDay: w.lead.requestsPerDay,
          correlatedSegments: w.correlatedSegments,
          examples: w.examples,
          ...(i < NEXT_STEP_TOP_N
            ? {
                nextStep:
                  `investigate(metric='${w.metric}', from='${w.from}', to='${w.to}') to get the ` +
                  `cause, the dollars and the ruled-out list`,
              }
            : {}),
        })),
        truncated: windows.length > limit,
        note:
          windows.length > limit
            ? `${windows.length - limit} further window(s) not shown — raise \`limit\` to see them.`
            : undefined,
        investigateGuidance:
          `Windows are ranked by impact, most severe first. Only the top ${NEXT_STEP_TOP_N} carry a ` +
          `\`nextStep\` -- investigate at most those, in one turn, unless the user explicitly asks for ` +
          `more. Mention the remaining windows in one line each (metric, dates, lead segment) without ` +
          `investigating them.`,
      },
    };
  },
};

/**
 * `ruledOut` can run into the hundreds -- residualize can clear 800+ segments as dilution on a single
 * window (observed: 840 on the flagship incident), and inlining every one as a full JSON object was
 * the single largest driver of oversized LLM context seen in practice (one `investigate` call alone
 * reached ~98k input tokens with this uncapped).
 */
const SHOWN_RULED_OUT = 15;

/**
 * The `investigate` result, shaped once and exported so nothing can build a near-miss of it.
 *
 * Extracted from the tool handler because `eval/narrate.ts` was hand-rolling its own version to feed
 * the narrator -- and quietly diverged. It sent the first 8 ruled-out segments with no total, where
 * this sends 15 AND `ruledOutCount`. A live run caught the consequence: asked why fill rate dropped,
 * the model wrote "178 other slices ... were cleared". The real figure was 840, and 178 appears
 * nowhere in the data. Given a truncated list and no count, it produced a number that looked right.
 *
 * The grounding gate caught it, which is the system working. But the eval was scoring a payload the
 * server never sends, so it was neither testing the real contract nor reproducing a real failure --
 * the worst of both. One exported shape means the eval cannot drift from production again.
 *
 * The cap itself is not a silent drop: top N in the order the engine found them, a count, and a
 * pointer to the rest. `narrative` states the true total regardless, so the human-readable answer
 * never changes -- only what gets inlined as raw JSON.
 */
export function investigatePayload(
  inv: Investigation,
  narrative: string,
  grounding: ReturnType<typeof checkGrounding>,
  action: unknown,
): Record<string, unknown> {
  return {
    request: inv.request,
    headline: inv.headline,
    channel: inv.primaryChannel,
    narrative,
    grounding: {
      ok: grounding.ok,
      numeralsChecked: grounding.total,
      grounded: grounding.grounded,
      ungrounded: grounding.ungrounded,
      meaning:
        "Every numeral in `narrative` was matched against a recorded evidence row at the " +
        "precision printed. ok=false means do not repeat the narrative — say so instead.",
    },
    action,
    findings: inv.findings,
    ruledOut: inv.ruledOut.slice(0, SHOWN_RULED_OUT),
    ruledOutCount: inv.ruledOut.length,
    ...(inv.ruledOut.length > SHOWN_RULED_OUT
      ? {
          ruledOutNote:
            `${inv.ruledOut.length - SHOWN_RULED_OUT} further ruled-out segment(s) not shown ` +
            `here (each with its residual as proof) -- narrative above already states the true ` +
            `total; call export_trace for the full list.`,
        }
      : {}),
    planSteps: inv.planSteps,
    evidenceCount: inv.evidence.length,
    traceId: inv.traceId,
  };
}

const investigateTool: ToolDef = {
  name: "investigate",
  description:
    "The full root-cause investigation for a moving metric: detect -> decompose -> localize -> " +
    "residualize -> classify -> price. Use it for any 'why' question ('why did revenue drop on " +
    "Jun 23?', 'what caused the fill rate dip?') and for any window find_incidents returned that " +
    "carries a `nextStep` — do not call this for every window a sweep returns, only the ranked few " +
    "that were invited; more windows are available on request. It " +
    "returns the cause segment, the cause channel with an owner, the dollar impact per day, and — " +
    "importantly — the segments it CHECKED AND CLEARED as mere dilution of the real cause, which a " +
    "ranked drill-down would have reported as 20 extra findings. It can also legitimately conclude " +
    "that nothing is localizable or that nothing is wrong; report that verdict as given, do not " +
    "hunt for a cause it declined to name. The narrative it returns has already been machine-checked " +
    "so that every numeral resolves to an evidence row — prefer quoting its numbers to recomputing them. " +
    "It also returns an `action` block: whether the incident is STILL HAPPENING or has recovered, who " +
    "owns it, what it has cost so far, where in the funnel to look, and which segments not to chase. " +
    "Always give the user the action — a cause with no next step is half an answer — and never go " +
    "beyond `action.whereToLook`: it names a stage of the funnel, not a system, because this data " +
    "cannot see deploys, bids or servers.",
  inputSchema: {
    type: "object",
    properties: {
      metric: metricEnum("Metric that moved."),
      from: date("First day of the incident window."),
      to: date("Last day. Defaults to `from`."),
      segment_dimension: str(
        "Optional: scope the investigation to one segment's dimension (e.g. 'app_category'). " +
          "Usually unnecessary — the engine finds the segment itself.",
      ),
      segment_value: str(
        "Optional: the segment value (e.g. 'finance'). Required with segment_dimension.",
      ),
    },
    required: ["metric", "from"],
    additionalProperties: false,
  },
  handler: async (args, ledger) => {
    const metric = resolveMetric(args.metric).name;
    const window = assertWindow(args.from, args.to);
    let segment: { dimension: string; value: string } | undefined;
    if (args.segment_dimension !== undefined || args.segment_value !== undefined) {
      if (args.segment_dimension === undefined || args.segment_value === undefined) {
        throw new QueryError("segment_dimension and segment_value must be provided together.");
      }
      segment = {
        dimension: assertDimension(args.segment_dimension, resolveMetric(metric)),
        value: String(args.segment_value),
      };
    }

    const inv = await investigate({ metric, from: window.from, to: window.to, ledger, segment });
    // Two extra queries on top of the investigation, and they answer the question the engine never
    // did: is this still happening? An incident that recovered and one still running need completely
    // different responses, and a diagnosis nobody can act on is worth nothing.
    const action = await recommendAction(ledger, inv);
    const narrative = renderNarrative(inv);
    // The same check the criteria gate runs, on the same string a reader sees. Reported per answer
    // rather than only in CI: a caller is entitled to know whether this specific text is grounded.
    // Computed against the FULL narrative/ruledOut, before the cap below -- capping is about what
    // gets inlined into the tool result, not about what gets checked for trustworthiness.
    const grounding = checkGrounding(narrative, inv.evidence);

    return {
      summary: `${inv.primaryChannel}: ${inv.headline.slice(0, 90)}`,
      payload: investigatePayload(inv, narrative, grounding, action),
    };
  },
};

const explainRevenue: ToolDef = {
  name: "explain_revenue",
  description:
    "Split a revenue move across the four factors of the revenue identity — requests, fill rate, " +
    "render rate, eCPM — and price each in dollars per day. Use it for 'was that a volume problem " +
    "or a price problem?', 'what drove revenue?', or to sanity-check which lever moved before " +
    "drilling into segments. Attribution is sequential so the parts sum to the total. Optionally " +
    "scope to a segment to decompose that segment's own funnel rather than the platform's.",
  inputSchema: {
    type: "object",
    properties: {
      from: date("First day of the window."),
      to: date("Last day. Defaults to `from`."),
      filters: filtersSchema,
    },
    required: ["from"],
    additionalProperties: false,
  },
  handler: async (args, ledger) => {
    const window = assertWindow(args.from, args.to);
    const scope = buildScope(args.filters, METRICS.revenue!);
    const dec = await decompose(
      ledger,
      window.from,
      window.to,
      // `dims` is not optional in spirit even where the type once allowed it: decompose passes it to
      // planRollup, and a mask whose dimensions are not declared gets planned as UNMASKED — the
      // filter then references a column the rollup projection does not have. This tool was the fifth
      // Mask construction site and the only one nobody had found, because omitting the field compiled.
      scope.sql === "1"
        ? undefined
        : { sql: scope.sql, description: scope.description, dims: Object.keys(scope.filters) },
    );
    return {
      summary: `driver ${dec.driver?.name ?? "none"}, ${dec.revenueDelta.toFixed(2)} USD/day`,
      payload: {
        window,
        scope: scope.description,
        baselineRevenuePerDay: Number(dec.baselineRevenuePerDay.toFixed(2)),
        incidentRevenuePerDay: Number(dec.incidentRevenuePerDay.toFixed(2)),
        revenueDeltaPerDay: Number(dec.revenueDelta.toFixed(2)),
        residualPerDay: Number(dec.residual.toFixed(2)),
        driver: dec.driver?.name ?? null,
        factors: dec.factors.map((f) => ({
          factor: f.name,
          baseline: Number(f.baseValue.toFixed(6)),
          current: Number(f.incValue.toFixed(6)),
          deltaPct: Number(f.deltaPct.toFixed(2)),
          revenueEffectUsdPerDay: Number(f.revenueEffect.toFixed(2)),
          isDriver: f.isDriver,
          evidenceIds: [f.evidenceId, f.evidenceIdPct, f.evidenceIdUsd],
        })),
        note:
          "Baseline is the same weekday(s) in preceding weeks, taken as a per-day median so a prior " +
          "incident inside the baseline cannot skew it.",
      },
    };
  },
};

const getEvidence: ToolDef = {
  name: "get_evidence",
  description:
    "Expand an evidence id from any earlier result in this conversation into the exact SQL that " +
    "produced it, its hash, its window and its filters. Call this whenever a user asks where a " +
    "number came from, how it was computed, or whether they can trust it — and use it instead of " +
    "re-deriving the figure. Omit `id` to list every number recorded so far.",
  inputSchema: {
    type: "object",
    properties: {
      id: str("Evidence id as returned by another tool, e.g. 'c4/e12'. Omit to search instead."),
      label_contains: str(
        "Substring filter when you do not have an id — e.g. 'cause', 'cleared', 'price', " +
          "'decompose.fill_rate'. An investigation records a row per candidate it checked, so " +
          "searching is usually better than listing.",
      ),
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Max rows listed (default 40).",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, _ledger, session) => {
    if (args.id === undefined || args.id === null || args.id === "") {
      const needle =
        typeof args.label_contains === "string" ? args.label_contains.toLowerCase() : "";
      const limit = typeof args.limit === "number" ? Math.min(args.limit, 100) : 40;
      const all = session.evidenceIndex();
      const matched = needle ? all.filter((e) => e.label.toLowerCase().includes(needle)) : all;
      return {
        summary: `${matched.length} of ${all.length} evidence row(s) matched`,
        payload: {
          totalRecorded: all.length,
          matched: matched.length,
          filter: needle || null,
          evidence: matched.slice(0, limit),
          truncated: matched.length > limit,
          note:
            matched.length > limit
              ? `Showing ${limit} of ${matched.length}. Narrow with label_contains, or ask for one id.`
              : undefined,
        },
      };
    }
    const id = String(args.id);
    const e = session.lookupEvidence(id);
    if (!e) {
      throw new QueryError(
        `No evidence with id '${id}' in this session. Call get_evidence with no argument to list ` +
          `what is available.`,
      );
    }
    return {
      summary: `${e.label} = ${e.value ?? "null"}`,
      payload: {
        id,
        producedBy: { callId: e.callId, tool: e.tool },
        label: e.label,
        value: e.value,
        unit: e.unit,
        window: e.window,
        filters: e.filters,
        segmentSharePct: e.segmentSharePct,
        sqlHash: e.sqlHash,
        sql: e.sql,
      },
    };
  },
};

const exportTrace: ToolDef = {
  name: "export_trace",
  description:
    "Write every tool call in this session — parameters, elapsed time, queries issued, SQL hashes, " +
    "evidence produced, and any errors — to a single JSON artifact, and return its path with the " +
    "session totals. Call it at the end of an investigation, and whenever a user asks for the " +
    "audit trail or how long something took. This is the submission artifact for a diagnosis: an " +
    "answer with no trace does not count.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, _ledger, session) => {
    const { path, trace } = session.export();
    // The written artifact at `path` is always the complete trace -- this is only what gets
    // inlined into the chat, and a long investigation's call list replayed on every later turn adds
    // up like any other tool result. `path` is the actual audit artifact; this is a preview of it.
    const SHOWN_CALLS = 20;
    const callsShown = trace.calls.slice(0, SHOWN_CALLS);
    return {
      summary: `${trace.totals.calls} call(s) -> ${path}`,
      payload: {
        path,
        liveLog: session.traceFile,
        runId: trace.runId,
        startedAt: trace.startedAt,
        totals: trace.totals,
        calls: callsShown.map((c) => ({
          callId: c.callId,
          tool: c.tool,
          ok: c.ok,
          ms: c.ms,
          queries: c.queries,
          summary: c.summary,
          otelTraceId: c.otelTraceId,
        })),
        ...(trace.calls.length > SHOWN_CALLS
          ? {
              callsNote:
                `${trace.calls.length - SHOWN_CALLS} further call(s) not shown here -- the full list ` +
                `is in the file at \`path\`.`,
            }
          : {}),
      },
    };
  },
};

/**
 * Watching is offered, never configured.
 *
 * A rule written before you have seen the incident is written blind, and that is how an alert channel
 * becomes noise. So there is no subscription form: a watch can only be created from a cause the user
 * was just shown, and its threshold is the impact the investigation already measured — the user is
 * never asked for a number they would have to invent.
 */
const watchThis: ToolDef = {
  name: "watch_this",
  description:
    "Keep an eye on an incident the user has just been shown, and notify them out of band if it " +
    "recurs. Offer this ONCE, right after reporting a real cause — 'want me to tell you if this comes " +
    "back?' — and call it only if they say yes. Never offer it for a no-anomaly or cannot-assess " +
    "verdict: there is nothing to watch. Never ask the user for a threshold; pass the impact the " +
    "investigation already measured. A scheduled sweep does the checking, and the result appears on " +
    "the Alerts tab of Mission Control (plus mail or webhook if configured) — never in this chat, " +
    "since nothing here can start a conversation. Tell them where it WILL appear.",
  inputSchema: {
    type: "object",
    properties: {
      metric: metricEnum("The metric that moved."),
      dimension: str("Cause dimension, e.g. os_version. Omit for a platform-wide finding."),
      value: str("Cause value, e.g. 'Android 15'. Required whenever dimension is given."),
      no_segment: {
        type: "boolean",
        description: "True for a platform-wide finding where no segment was responsible.",
      },
      impact_usd_per_day: {
        type: "number",
        description: "What the investigation priced it at, if it priced it. Do not invent one.",
      },
      note: str("One line describing the incident, used in the notification."),
    },
    required: ["metric"],
    additionalProperties: false,
  },
  handler: async (args, _ledger, session) => {
    const def = resolveMetric(args.metric);
    const hasSegment = args.no_segment !== true && args.dimension !== undefined;
    if (hasSegment && args.value === undefined) {
      throw new QueryError("`value` is required whenever `dimension` is given.");
    }
    const w = addWatch({
      userId: session.userId,
      userEmail: session.userEmail,
      metric: def.name,
      dimension: hasSegment ? assertDimension(args.dimension, def) : null,
      value: hasSegment ? String(args.value) : null,
      baselineImpactUsdPerDay:
        typeof args.impact_usd_per_day === "number" ? args.impact_usd_per_day : null,
      note: typeof args.note === "string" ? args.note : "",
    });
    const where = w.dimension ? `${w.dimension} = '${w.value}'` : "the platform";

    /**
     * Sweep this one watch immediately, so the Alerts tab is not empty when they go and look.
     *
     * Waiting for the next scheduled pass to say anything makes the feature look broken at exactly
     * the moment it was asked for. Scoped to this watch by id -- a full sweep here would make an
     * interactive tool call pay for every other watch on the box.
     *
     * Never fatal. The watch is saved before this runs, so a failed sweep costs a first alert, not
     * the subscription: reporting failure here would tell the user their watch did not take, which
     * is worse than being wrong about how quickly they will hear back.
     */
    let firstSweep: string;
    try {
      const fired = await runOnce({ only: w.id });
      firstSweep = fired.length
        ? `Already firing: ${fired.length} alert${fired.length > 1 ? "s" : ""} on the Alerts tab of ` +
          `Mission Control, most recent ${fired[fired.length - 1]!.day}. Tell them it is waiting there now.`
        : "Nothing firing right now, so the Alerts tab is empty until it recurs. Say so -- silence is the good case.";
    } catch {
      firstSweep =
        "The first check could not be run. The watch is saved and the scheduled sweep still covers it.";
    }

    return {
      summary: `watching ${def.name} on ${where}`,
      payload: {
        watching: { id: w.id, metric: w.metric, where, since: w.createdAt },
        firstSweep,
        howItWorks:
          "A sweep runs out of band on a schedule and checks whether this fires again. You are told " +
          "once per occurrence, not once per run, and nothing is sent while it stays normal.",
        deliveryCaveat:
          "Appears on the Alerts tab of Mission Control, and by mail or webhook if one is configured. " +
          "Not in this chat — a chat server cannot start a conversation — so tell them where to look.",
        accountCaveat:
          session.userId === "anonymous"
            ? "No user id reached this server, so this watch is not tied to an account. Add " +
              "X-User-Id: {{LIBRECHAT_USER_ID}} to the MCP headers in librechat.yaml."
            : undefined,
      },
    };
  },
};

const listWatchesTool: ToolDef = {
  name: "list_watches",
  description:
    "What this user is currently watching, and when each was last triggered. Use when they ask what " +
    "alerts they have, or before stopping one so they can pick.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, _ledger, session) => {
    const watches = listWatches(session.userId);
    return {
      summary: `${watches.length} watch(es)`,
      payload: {
        count: watches.length,
        watches: watches.map((w) => ({
          id: w.id,
          metric: w.metric,
          where: w.dimension ? `${w.dimension} = '${w.value}'` : "platform-wide",
          since: w.createdAt,
          lastNotified: w.watermark ?? "never — it has not recurred",
          note: w.note || undefined,
        })),
      },
    };
  },
};

const stopWatching: ToolDef = {
  name: "stop_watching",
  description: "Stop watching one incident. Takes an id from list_watches.",
  inputSchema: {
    type: "object",
    properties: { id: str("Watch id, as returned by list_watches.") },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, _ledger, session) => {
    const id = String(args.id);
    if (!removeWatch(id, session.userId)) {
      throw new QueryError(`No watch '${id}' belongs to you. Call list_watches to see yours.`);
    }
    return { summary: `stopped ${id}`, payload: { stopped: id } };
  },
};

export const TOOLS: ToolDef[] = [
  describeData,
  listDimensionValues,
  getMetric,
  comparePeriodsTool,
  rankSegmentsTool,
  findIncidents,
  investigateTool,
  explainRevenue,
  getEvidence,
  exportTrace,
  watchThis,
  listWatchesTool,
  stopWatching,
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Execute a tool by name and return MCP tool-result content.
 *
 * The `trace` block is merged in here rather than in each handler, because elapsed time and query
 * count are only known once the call is done — and every answer should be able to cite them.
 */
export async function callTool(
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    return {
      isError: true,
      text: JSON.stringify({
        error: `Unknown tool '${name}'. Available: ${[...TOOL_BY_NAME.keys()].join(", ")}.`,
      }),
    };
  }

  const { ok, payload, record } = await session.run(name, args, (ledger) =>
    tool.handler(args ?? {}, ledger, session),
  );

  // Evidence ids are capped in the model-facing envelope. A single `investigate` records ~1,700
  // rows — one per candidate the residualization loop checked — and inlining all of them would
  // spend most of the context window on identifiers nobody asked for. The full set is in the trace
  // artifact, which is where an auditor wants it, and get_evidence can reach any of them by id.
  const SHOWN_IDS = 12;
  const body =
    payload && typeof payload === "object"
      ? {
          ...(payload as Record<string, unknown>),
          trace: {
            callId: record.callId,
            elapsedMs: record.ms,
            queries: record.queries,
            rowsReturnedPerQuery: record.rowsReturned,
            evidenceCount: record.evidenceIds.length,
            evidenceIds: record.evidenceIds.slice(0, SHOWN_IDS),
            ...(record.evidenceIds.length > SHOWN_IDS
              ? {
                  evidenceNote:
                    `${record.evidenceIds.length - SHOWN_IDS} further evidence row(s) recorded; ` +
                    `call get_evidence with a label filter to find one.`,
                }
              : {}),
          },
        }
      : payload;

  return { isError: !ok, text: JSON.stringify(body, null, 2) };
}
