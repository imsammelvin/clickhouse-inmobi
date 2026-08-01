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
import type { Ledger } from "../backend/ledger";
import { investigate } from "../backend/orchestrate";
import { renderNarrative } from "../backend/render";
import { checkGrounding } from "../backend/grounding";
import { decompose } from "../backend/stages/decompose";
import { clusterWindows, groupIntoIncidents, scanSegments } from "../backend/segments";
import { DEFAULT_METRICS } from "../backend/scan";
import { segmentPredicate } from "../backend/types";
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
import type { Session, ToolOutcome } from "./trace";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ledger: Ledger, session: Session) => Promise<ToolOutcome>;
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
    'yourself — a total you compute is not a measured number. Values must match the data exactly; ' +
    'call list_dimension_values if unsure.',
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
      limit: { type: "integer", minimum: 1, maximum: MAX_ROWS, description: "Max values (default 30)." },
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
    return {
      summary: `${values.length} value(s) of ${String(args.dimension)}`,
      payload: {
        dimension: args.dimension,
        window,
        values,
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
      limit: { type: "integer", minimum: 1, maximum: MAX_ROWS, description: "Max rows (default 25)." },
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
    return {
      summary:
        r.rows.length === 1 && head
          ? `${r.metric} = ${head.value?.toFixed(4) ?? "null"} (${head.requests.toLocaleString()} requests)`
          : `${r.rows.length} row(s) of ${r.metric}`,
      payload: r,
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
      limit: { type: "integer", minimum: 1, maximum: MAX_ROWS, description: "Max rows (default 25)." },
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
    return {
      summary:
        r.rows.length === 1 && head?.deltaPct !== null && head?.deltaPct !== undefined
          ? `${r.metric} ${fmtPct(head.deltaPct)} vs baseline`
          : `${r.rows.length} row(s) compared`,
      payload: r,
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
      limit: { type: "integer", minimum: 1, maximum: MAX_ROWS, description: "Max rows (default 25)." },
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
    return { summary: `${r.rows.length} ${r.dimension} value(s), ${r.order} first`, payload: r };
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
      from: date("Restrict reported windows to those starting on/after this day. Baseline still uses full history."),
      to: date("Restrict reported windows to those on/before this day."),
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Max windows (default 12)." },
    },
    additionalProperties: false,
  },
  handler: async (args, ledger) => {
    const metrics = Array.isArray(args.metrics) && args.metrics.length
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
    const windows = clusterWindows(groupIntoIncidents(firings));

    return {
      summary: `${windows.length} incident window(s) across ${metrics.length} metric(s)`,
      payload: {
        metricsSwept: metrics,
        reportedWindow: window ?? { from: DATASET_START, to: DATASET_END },
        gates: "abs(change) >= 10% AND abs(sigma) >= 5, min 150 requests/day/segment",
        servedFrom: health?.ready ? "rollup:daily" : "raw",
        windowCount: windows.length,
        windows: windows.slice(0, limit).map((w) => ({
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
          nextStep:
            `investigate(metric='${w.metric}', from='${w.from}', to='${w.to}') to get the cause, ` +
            `the dollars and the ruled-out list`,
        })),
        truncated: windows.length > limit,
        note:
          windows.length > limit
            ? `${windows.length - limit} further window(s) not shown — raise \`limit\` to see them.`
            : undefined,
      },
    };
  },
};

const investigateTool: ToolDef = {
  name: "investigate",
  description:
    "The full root-cause investigation for a moving metric: detect -> decompose -> localize -> " +
    "residualize -> classify -> price. Use it for any 'why' question ('why did revenue drop on " +
    "Jun 23?', 'what caused the fill rate dip?') and for any window find_incidents returned. It " +
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
      segment_value: str("Optional: the segment value (e.g. 'finance'). Required with segment_dimension."),
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

    // `ruledOut` can run into the hundreds -- residualize can clear 800+ segments as dilution on a
    // single window (observed: 832, on the flagship incident), and inlining every one as a full
    // JSON object was the single largest driver of oversized LLM context seen in practice (one
    // `investigate` call alone reached ~98k input tokens with this uncapped). Capped the same way
    // `evidenceIds` already is below: top N in the order the engine found them, a count, and a
    // pointer to where the rest live -- not a silent drop. `narrative` already states the true
    // total ("N false lead(s) eliminated") regardless of this cap, so the human-readable answer
    // does not change, only what gets inlined as raw JSON.
    const SHOWN_RULED_OUT = 15;
    const ruledOutShown = inv.ruledOut.slice(0, SHOWN_RULED_OUT);

    return {
      summary: `${inv.primaryChannel}: ${inv.headline.slice(0, 90)}`,
      payload: {
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
        ruledOut: ruledOutShown,
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
      },
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
      scope.sql === "1" ? undefined : { sql: scope.sql, description: scope.description },
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
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Max rows listed (default 40)." },
    },
    additionalProperties: false,
  },
  handler: async (args, _ledger, session) => {
    if (args.id === undefined || args.id === null || args.id === "") {
      const needle = typeof args.label_contains === "string" ? args.label_contains.toLowerCase() : "";
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
    return {
      summary: `${trace.totals.calls} call(s) -> ${path}`,
      payload: {
        path,
        liveLog: session.traceFile,
        runId: trace.runId,
        startedAt: trace.startedAt,
        totals: trace.totals,
        calls: trace.calls.map((c) => ({
          callId: c.callId,
          tool: c.tool,
          ok: c.ok,
          ms: c.ms,
          queries: c.queries,
          summary: c.summary,
          otelTraceId: c.otelTraceId,
        })),
      },
    };
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
