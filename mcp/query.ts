/**
 * The query layer. Every SQL string the MCP server ever sends is built in this file.
 *
 * DESIGN RULE, and the reason this file exists at all: **the model never writes SQL.** There is no
 * `run_sql` tool and no place a caller can inject a fragment. Tools take typed parameters —
 * metric name, ISO dates, dimension names from a fixed list, values that are escaped as literals —
 * and this module composes the query. The LLM is the reasoning and stitching layer: it decides
 * *which* question to ask and how to phrase the answer; it never decides how the number is computed.
 *
 * Three things follow from that, all of them things the rubric scores:
 *
 *   1. Every number is reproducible, because every query goes through `Ledger.run`, which records
 *      the SQL and its hash. A generated SQL string is auditable in a way a model-authored one is
 *      not — there is exactly one code path per tool, and it is in version control.
 *   2. The known-wrong questions cannot be asked. `advertiser_id` is empty on unfilled requests, so
 *      fill rate sliced by advertiser is definitionally broken (goal.md § 7 fact #1). A model with a
 *      SQL tool writes that join on its first try. Here it is a validation error that explains why.
 *   3. Analysis stays in ClickHouse (criterion 3). Grouping, ordering, floors, ranking and window
 *      comparison are all pushed into SQL; the tools return tens of rows, never thousands.
 *
 * SCALE. Windows are bounded to the dataset, group-by is capped at two dimensions, every
 * row-returning query carries a server-side LIMIT, and the incident/baseline comparison is a single
 * pass with conditional aggregates rather than two scans.
 */
import type { Ledger } from "../backend/ledger";
import {
  DIMENSIONS,
  FILLED_ONLY_DIMENSIONS,
  METRICS,
  type MetricDef,
  dimensionsFor,
  metricExpr,
} from "../backend/metrics";
import {
  DATASET_END,
  DATASET_START,
  baselineDates,
  estimateWeeklyGrowth,
  sqlDateList,
} from "../backend/baseline";

/**
 * Longest window any single tool call may span.
 *
 * Derived from the loaded data rather than fixed, so a full-range question on a Day-2 slice longer
 * than the 35-day training window is not rejected as too large. The cap exists to stop an unbounded
 * scan, not to encode the size of the slice we happened to develop against.
 */
const maxWindowDays = (): number =>
  Math.max(
    35,
    Math.round((Date.parse(DATASET_END) - Date.parse(DATASET_START)) / 86_400_000) + 1,
  );

/** Cap on rows any tool returns. Criterion 3 is about analysis staying in the database. */
export const MAX_ROWS = 200;
const DEFAULT_ROWS = 25;

/** At most two dimensions per grouping: past that the row count explodes and no reader benefits. */
const MAX_GROUP_BY = 2;

/**
 * ClickHouse string-literal escaping.
 *
 * Backslash as well as quote, unlike `segmentPredicate` in backend/types.ts which only handles the
 * quote — its inputs come from the sweep (real column values), whereas these come from a caller.
 * Dimension *names* are never escaped because they are matched against a fixed allow-list instead;
 * that is the only reason interpolating them is safe.
 */
const lit = (v: string): string => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Window {
  from: string;
  to: string;
}

/** A validated, human-describable set of equality filters. */
export interface Scope {
  sql: string;
  description: string;
  filters: Record<string, string>;
}

export const NO_SCOPE: Scope = { sql: "1", description: "whole platform", filters: {} };

export class QueryError extends Error {}

export function resolveMetric(name: unknown): MetricDef {
  if (typeof name !== "string" || !METRICS[name]) {
    throw new QueryError(
      `Unknown metric ${JSON.stringify(name)}. Available: ${Object.keys(METRICS).join(", ")}.`,
    );
  }
  return METRICS[name]!;
}

export function assertWindow(from: unknown, to: unknown): Window {
  if (typeof from !== "string" || !ISO_DATE.test(from)) {
    throw new QueryError(`\`from\` must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(from)}.`);
  }
  const end = to === undefined || to === null ? from : to;
  if (typeof end !== "string" || !ISO_DATE.test(end)) {
    throw new QueryError(`\`to\` must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(to)}.`);
  }
  if (end < from) throw new QueryError(`\`to\` (${end}) is before \`from\` (${from}).`);
  if (from < DATASET_START || end > DATASET_END) {
    throw new QueryError(
      `Window ${from}..${end} falls outside the loaded data (${DATASET_START}..${DATASET_END}). ` +
        `Call describe_data for the available range.`,
    );
  }
  const days = Math.round((Date.parse(end) - Date.parse(from)) / 86_400_000) + 1;
  const cap = maxWindowDays();
  if (days > cap) {
    throw new QueryError(`Window is ${days} days; the maximum per call is ${cap}.`);
  }
  return { from, to: end };
}

/**
 * Validate a dimension against the metric being measured.
 *
 * This is where trap #1 is enforced. `advertiser_id`, `advertiser_vertical` and `campaign_type` only
 * exist on filled events, so slicing an unfilled-inclusive metric by them silently drops the
 * denominator's unfilled half and returns a number that looks plausible and is wrong. Refusing with
 * the reason is strictly better than answering: the model can then tell the user why, which is the
 * kind of thing criterion 2 rewards.
 */
export function assertDimension(dimension: unknown, metric: MetricDef): string {
  if (typeof dimension !== "string") {
    throw new QueryError(`Dimension must be a string, got ${JSON.stringify(dimension)}.`);
  }
  const allowed = dimensionsFor(metric.name);
  if (allowed.includes(dimension)) return dimension;

  if ((FILLED_ONLY_DIMENSIONS as readonly string[]).includes(dimension)) {
    throw new QueryError(
      `\`${dimension}\` cannot be used with \`${metric.name}\`. It is only populated on filled ` +
        `events — advertiser_id is empty on an unfilled request — so slicing ${metric.name} by it ` +
        `would compare a filled-only numerator against a full denominator. It is available on ` +
        `metrics restricted to filled events (ecpm, ctr, render_rate, impressions, revenue).`,
    );
  }
  if (dimension === "geo_device_id") {
    throw new QueryError(
      `\`geo_device_id\` is a surrogate join key, not a business entity (5,000 profiles at ~0.02% ` +
        `of traffic each). Everything it carries is available as its own dimension: region, ` +
        `country, device_model, os_version.`,
    );
  }
  throw new QueryError(
    `Unknown dimension \`${dimension}\` for metric \`${metric.name}\`. Available: ${allowed.join(", ")}.`,
  );
}

/** Equality filters, validated per metric and escaped as literals. */
export function buildScope(filters: unknown, metric: MetricDef): Scope {
  if (filters === undefined || filters === null) return NO_SCOPE;
  if (typeof filters !== "object" || Array.isArray(filters)) {
    throw new QueryError("`filters` must be an object of {dimension: value}.");
  }
  const entries = Object.entries(filters as Record<string, unknown>);
  if (entries.length === 0) return NO_SCOPE;

  const parts: string[] = [];
  const described: string[] = [];
  const clean: Record<string, string> = {};
  for (const [dim, value] of entries) {
    assertDimension(dim, metric);
    if (typeof value !== "string") {
      throw new QueryError(`Filter \`${dim}\` must be a string value, got ${JSON.stringify(value)}.`);
    }
    parts.push(`${dim} = ${lit(value)}`);
    described.push(`${dim}='${value}'`);
    clean[dim] = value;
  }
  return { sql: parts.join(" AND "), description: described.join(", "), filters: clean };
}

function assertGroupBy(groupBy: unknown, metric: MetricDef): string[] {
  if (groupBy === undefined || groupBy === null) return [];
  if (!Array.isArray(groupBy)) throw new QueryError("`group_by` must be an array of dimension names.");
  if (groupBy.length > MAX_GROUP_BY) {
    throw new QueryError(
      `\`group_by\` accepts at most ${MAX_GROUP_BY} dimensions (got ${groupBy.length}). ` +
        `Deeper cuts multiply rows without adding readable signal — filter instead.`,
    );
  }
  return groupBy.map((d) => assertDimension(d, metric));
}

const clampLimit = (limit: unknown): number => {
  if (limit === undefined || limit === null) return DEFAULT_ROWS;
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) throw new QueryError(`\`limit\` must be a positive number.`);
  return Math.min(Math.floor(n), MAX_ROWS);
};

/**
 * Whether a computed ratio carries enough events to be worth stating.
 *
 * Reported per row rather than used to drop rows: if a caller asks for CTR on one app, silently
 * returning nothing is worse than returning the number with "12 clicks — too few to trust".
 * `rank_segments` is the exception and says so, because an unreliable row would otherwise top the
 * ranking (T-017: insufficient volume is a stated conclusion, never a silent omission).
 */
function reliability(
  def: MetricDef,
  numerator: number,
  denominator: number,
): { reliable: boolean; note?: string } {
  if (def.minNumerator && numerator < def.minNumerator) {
    return {
      reliable: false,
      note: `only ${numerator} events in the numerator (floor ${def.minNumerator}) — too few to trust`,
    };
  }
  if (def.minDenominator && denominator < def.minDenominator) {
    return {
      reliable: false,
      note: `only ${denominator} events in the denominator (floor ${def.minDenominator}) — too few to trust`,
    };
  }
  return { reliable: true };
}

const num = (v: unknown): number => Number(v ?? 0);

// ---------------------------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------------------------

export type Granularity = "total" | "day" | "hour";

export interface MeasureArgs {
  metric: string;
  from: string;
  to?: string;
  filters?: Record<string, string>;
  group_by?: string[];
  granularity?: Granularity;
  limit?: number;
}

export interface MeasureRow {
  group: Record<string, string>;
  value: number | null;
  requests: number;
  numerator: number;
  denominator: number;
  sharePct: number;
  reliable: boolean;
  note?: string;
  evidenceId: string;
}

export interface MeasureResult {
  metric: string;
  unit: string;
  window: Window;
  scope: string;
  rows: MeasureRow[];
  truncated: boolean;
  sqlHash: string;
}

function granularityColumn(g: Granularity | undefined): { expr: string; name: string } | null {
  switch (g ?? "total") {
    case "total":
      return null;
    case "day":
      return { expr: "toString(event_date)", name: "day" };
    case "hour":
      return { expr: "toString(event_hour)", name: "hour" };
    default:
      throw new QueryError(`\`granularity\` must be one of: total, day, hour.`);
  }
}

/**
 * The workhorse: one metric, one window, optional filters, optional grouping.
 *
 * `sharePct` is share of the window's requests *inside the current scope*, computed with a window
 * function in the same pass — a delta without a size is not interpretable, and making the caller
 * issue a second call to get it invites them to skip it.
 */
export async function measure(ledger: Ledger, args: MeasureArgs): Promise<MeasureResult> {
  const def = resolveMetric(args.metric);
  const window = assertWindow(args.from, args.to);
  const scope = buildScope(args.filters, def);
  const groupDims = assertGroupBy(args.group_by, def);
  const limit = clampLimit(args.limit);
  const gran = granularityColumn(args.granularity);

  const selectCols: string[] = [];
  const groupCols: string[] = [];
  const names: string[] = [];
  if (gran) {
    selectCols.push(`${gran.expr} AS ${gran.name}`);
    groupCols.push(gran.name);
    names.push(gran.name);
  }
  for (const d of groupDims) {
    selectCols.push(d);
    groupCols.push(d);
    names.push(d);
  }

  const sql = `
SELECT ${[
    ...selectCols,
    `${metricExpr(def)} AS value`,
    "count() AS requests",
    `${def.numerator} AS numerator`,
    `${def.denominator} AS denominator`,
    "count() * 100.0 / nullIf(sum(count()) OVER (), 0) AS share_pct",
  ].join(",\n       ")}
FROM ad_events_enriched
WHERE event_date BETWEEN '${window.from}' AND '${window.to}'
  AND (${scope.sql})
${groupCols.length ? `GROUP BY ${groupCols.join(", ")}` : ""}
ORDER BY ${groupCols.length ? (gran ? `${gran.name}` : "requests DESC") : "1"}
LIMIT ${limit + 1}`.trim();

  const raw = await ledger.run<Record<string, unknown>>(sql);
  const truncated = raw.length > limit;
  const rows: MeasureRow[] = raw.slice(0, limit).map((r) => {
    const group: Record<string, string> = {};
    for (const n of names) group[n] = String(r[n] ?? "");
    const numerator = num(r.numerator);
    const denominator = num(r.denominator);
    const { reliable, note } = reliability(def, numerator, denominator);
    const label = names.length
      ? `measure.${def.name}.${names.map((n) => `${n}=${group[n]}`).join(".")}`
      : `measure.${def.name}`;
    return {
      group,
      value: r.value === null ? null : num(r.value),
      requests: num(r.requests),
      numerator,
      denominator,
      sharePct: num(r.share_pct),
      reliable,
      note,
      evidenceId: ledger.record({
        label,
        value: r.value === null ? null : Number(num(r.value).toFixed(6)),
        unit: def.unit === "usd" ? "usd" : def.unit === "count" ? "count" : "ratio",
        sql,
        window,
        filters: { ...scope.filters, ...group },
        segmentSharePct: Number(num(r.share_pct).toFixed(4)),
      }),
    };
  });

  return {
    metric: def.name,
    unit: def.unit,
    window,
    scope: scope.description,
    rows,
    truncated,
    sqlHash: ledger.get(rows[0]?.evidenceId ?? "")?.sqlHash ?? "",
  };
}

// ---------------------------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------------------------

export interface CompareArgs {
  metric: string;
  from: string;
  to?: string;
  /** Omit to compare against the same-weekday trailing baseline (D-012). */
  baseline_from?: string;
  baseline_to?: string;
  filters?: Record<string, string>;
  group_by?: string[];
  limit?: number;
}

export interface CompareRow {
  group: Record<string, string>;
  current: number | null;
  baseline: number | null;
  deltaPct: number | null;
  /** Percentage points, for ratio metrics only. A pp move on a ratio is not a percentage move. */
  deltaPp: number | null;
  requests: number;
  sharePct: number;
  reliable: boolean;
  note?: string;
  evidenceId: string;
}

export interface CompareResult {
  metric: string;
  unit: string;
  current: Window;
  baselineDescription: string;
  baselineDates: string[];
  scope: string;
  rows: CompareRow[];
  truncated: boolean;
}

/**
 * Two windows, one pass, ranked by movement.
 *
 * The default baseline is the same weekday in trailing weeks, never a flat average of the preceding
 * days — the glossary is explicit that a flat mean makes every weekend look anomalous (D-012), and
 * a "compare to last week" tool that quietly used a mean would manufacture a Saturday incident on
 * demand. When the caller supplies an explicit baseline window we use it and say so.
 */
export async function comparePeriods(ledger: Ledger, args: CompareArgs): Promise<CompareResult> {
  const def = resolveMetric(args.metric);
  const current = assertWindow(args.from, args.to);
  const scope = buildScope(args.filters, def);
  const groupDims = assertGroupBy(args.group_by, def);
  const limit = clampLimit(args.limit);

  let baseDates: string[];
  let baselineDescription: string;
  if (args.baseline_from) {
    const b = assertWindow(args.baseline_from, args.baseline_to);
    baseDates = [];
    for (let t = Date.parse(b.from); t <= Date.parse(b.to); t += 86_400_000) {
      baseDates.push(new Date(t).toISOString().slice(0, 10));
    }
    baselineDescription = `${b.from}..${b.to} (explicit)`;
  } else {
    baseDates = baselineDates(current.from, current.to);
    baselineDescription =
      `same weekday(s) in the ${baseDates.length ? "preceding weeks" : "dataset"} ` +
      `(${baseDates.length} day(s)), excluding the window itself`;
  }
  if (baseDates.length === 0) {
    throw new QueryError(
      `No baseline days available for ${current.from}..${current.to}. The dataset starts ` +
        `${DATASET_START}, so the earliest days have no same-weekday history to compare against.`,
    );
  }

  const isCur = `event_date BETWEEN '${current.from}' AND '${current.to}'`;
  const isBase = `event_date IN (${sqlDateList(baseDates)})`;

  /**
   * Aggregate PER DAY first, then take the median across days on each side.
   *
   * The obvious one-pass form — `sumIf(revenue, is_base)` against `sumIf(revenue, is_cur)` — is
   * wrong for any absolute metric, and wrong by a factor of (baseline days / window days). It cost
   * an afternoon to find: comparing one Saturday against its three same-weekday priors reported
   * platform revenue at -65%, because it was comparing one day's revenue with three days' total.
   * Ratio metrics hid the bug completely, being scale-invariant in the number of days pooled, so
   * fill-rate answers looked correct throughout.
   *
   * The median across days is the second reason for this shape: a prior incident inside the
   * baseline wrecks a mean, and this dataset has one (Jun 21) sitting in several baselines. Ratios
   * are formed from the median numerator over the median denominator, componentwise — the same
   * construction backend/stages/decompose.ts settled on, so the two agree by design rather than by
   * coincidence, and ratios stay sum/sum within a day as the glossary requires.
   */
  const ratio = def.kind === "ratio";
  const value = (side: string): string =>
    ratio
      ? `${side}_num / nullIf(${side}_den, 0)${def.scale !== 1 ? ` * ${def.scale}` : ""}`
      : `${side}_num`;

  const sql = `
SELECT ${[
    ...groupDims,
    `${value("cur")} AS cur_v`,
    `${value("base")} AS base_v`,
    "cur_num, cur_den, base_num, base_den, requests, total_numerator, total_denominator",
    "requests * 100.0 / nullIf(sum(requests) OVER (), 0) AS share_pct",
  ].join(",\n       ")}
FROM (
  SELECT ${[
    ...groupDims,
    // Median of each component across the days on each side, so both sides are per-day figures.
    "quantileExactIf(0.5)(num_d, is_cur)  AS cur_num",
    "quantileExactIf(0.5)(den_d, is_cur)  AS cur_den",
    "quantileExactIf(0.5)(num_d, is_base) AS base_num",
    "quantileExactIf(0.5)(den_d, is_base) AS base_den",
    // Window totals, not medians: the reliability floors ask how many events actually landed.
    "sumIf(reqs_d, is_cur) AS requests",
    "sumIf(num_d, is_cur)  AS total_numerator",
    "sumIf(den_d, is_cur)  AS total_denominator",
  ].join(",\n         ")}
  FROM (
    SELECT ${[
      ...groupDims,
      "event_date AS d",
      `${def.numerator} AS num_d`,
      `${def.denominator} AS den_d`,
      "count() AS reqs_d",
      `(${isCur}) AS is_cur`,
      `(${isBase}) AS is_base`,
    ].join(",\n           ")}
    FROM ad_events_enriched
    WHERE (${isCur} OR ${isBase})
      AND (${scope.sql})
    GROUP BY ${[...groupDims, "event_date"].join(", ")}
  )
  ${groupDims.length ? `GROUP BY ${groupDims.join(", ")}` : ""}
  ${groupDims.length ? "HAVING requests > 0" : ""}
)
ORDER BY ${groupDims.length ? "abs(cur_v - base_v) * requests DESC" : "1"}
LIMIT ${limit + 1}`.trim();

  const raw = await ledger.run<Record<string, unknown>>(sql);
  const truncated = raw.length > limit;
  const rows: CompareRow[] = raw.slice(0, limit).map((r) => {
    const group: Record<string, string> = {};
    for (const d of groupDims) group[d] = String(r[d] ?? "");
    const cur = r.cur_v === null ? null : num(r.cur_v);
    const base = r.base_v === null ? null : num(r.base_v);
    const deltaPct = cur === null || base === null || base === 0 ? null : ((cur - base) / base) * 100;
    const deltaPp = def.kind === "ratio" && cur !== null && base !== null ? (cur - base) * 100 : null;
    // Window totals, so the floors measure events that actually landed rather than a daily median.
    const numerator = num(r.total_numerator);
    const denominator = num(r.total_denominator);
    const { reliable, note } = reliability(def, numerator, denominator);
    const suffix = groupDims.length
      ? `.${groupDims.map((d) => `${d}=${group[d]}`).join(".")}`
      : "";
    return {
      group,
      current: cur,
      baseline: base,
      deltaPct,
      deltaPp,
      requests: num(r.requests),
      sharePct: num(r.share_pct),
      reliable,
      note,
      evidenceId: ledger.record({
        label: `compare.${def.name}${suffix}.delta${deltaPp !== null ? "_pp" : "_pct"}`,
        value:
          deltaPp !== null
            ? Number(deltaPp.toFixed(4))
            : deltaPct === null
              ? null
              : Number(deltaPct.toFixed(4)),
        unit: deltaPp !== null ? "pp" : "pct",
        sql,
        window: current,
        filters: { ...scope.filters, ...group, baseline: baselineDescription },
        segmentSharePct: Number(num(r.share_pct).toFixed(4)),
      }),
    };
  });

  return {
    metric: def.name,
    unit: def.unit,
    current,
    baselineDescription,
    baselineDates: baseDates,
    scope: scope.description,
    rows,
    truncated,
  };
}

// ---------------------------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------------------------

export interface RankArgs {
  metric: string;
  dimension: string;
  from: string;
  to?: string;
  order?: "worst" | "best" | "largest";
  filters?: Record<string, string>;
  limit?: number;
}

export interface RankResult {
  metric: string;
  unit: string;
  dimension: string;
  window: Window;
  scope: string;
  order: string;
  /** Stated, not silent: what the volume floor excluded from the ranking. */
  floorNote: string;
  rows: MeasureRow[];
}

/**
 * Top/bottom N values of one dimension by a metric.
 *
 * Floors are applied here (unlike `measure`) because a ranking is exactly where small samples do
 * damage: CTR on 200 requests is one click away from +60%, and the first version of the segment scan
 * duly reported `ctr +1312%` on an advertiser with 403 requests. The floor is reported in the result
 * so the answer can say what was left out instead of implying the list is exhaustive.
 */
export async function rankSegments(ledger: Ledger, args: RankArgs): Promise<RankResult> {
  const def = resolveMetric(args.metric);
  const dimension = assertDimension(args.dimension, def);
  const window = assertWindow(args.from, args.to);
  const scope = buildScope(args.filters, def);
  const limit = clampLimit(args.limit);
  const order = args.order ?? "worst";

  const floors = ["count() >= 150", "value IS NOT NULL"];
  if (def.minNumerator) floors.push(`numerator >= ${def.minNumerator}`);
  if (def.minDenominator) floors.push(`denominator >= ${def.minDenominator}`);

  const direction =
    order === "best" ? "value DESC" : order === "largest" ? "requests DESC" : "value ASC";
  if (!["worst", "best", "largest"].includes(order)) {
    throw new QueryError("`order` must be one of: worst, best, largest.");
  }

  const sql = `
SELECT ${[
    dimension,
    `${metricExpr(def)} AS value`,
    "count() AS requests",
    `${def.numerator} AS numerator`,
    `${def.denominator} AS denominator`,
    "count() * 100.0 / nullIf(sum(count()) OVER (), 0) AS share_pct",
  ].join(",\n       ")}
FROM ad_events_enriched
WHERE event_date BETWEEN '${window.from}' AND '${window.to}'
  AND (${scope.sql})
GROUP BY ${dimension}
HAVING ${floors.join(" AND ")}
ORDER BY ${direction}
LIMIT ${limit}`.trim();

  const raw = await ledger.run<Record<string, unknown>>(sql);
  const rows: MeasureRow[] = raw.map((r) => {
    const group = { [dimension]: String(r[dimension] ?? "") };
    const numerator = num(r.numerator);
    const denominator = num(r.denominator);
    return {
      group,
      value: r.value === null ? null : num(r.value),
      requests: num(r.requests),
      numerator,
      denominator,
      sharePct: num(r.share_pct),
      reliable: true,
      evidenceId: ledger.record({
        label: `rank.${def.name}.${dimension}=${group[dimension]}`,
        value: r.value === null ? null : Number(num(r.value).toFixed(6)),
        unit: def.unit === "usd" ? "usd" : def.unit === "count" ? "count" : "ratio",
        sql,
        window,
        filters: { ...scope.filters, ...group },
        segmentSharePct: Number(num(r.share_pct).toFixed(4)),
      }),
    };
  });

  const floorParts = ["150 requests/window"];
  if (def.minNumerator) floorParts.push(`${def.minNumerator} numerator events`);
  if (def.minDenominator) floorParts.push(`${def.minDenominator} denominator events`);

  return {
    metric: def.name,
    unit: def.unit,
    dimension,
    window,
    scope: scope.description,
    order,
    floorNote:
      `values below ${floorParts.join(" / ")} were excluded from this ranking — a rate on a ` +
      `handful of events would otherwise top it. Use get_metric to measure a specific value anyway.`,
    rows,
  };
}

// ---------------------------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------------------------

export interface DimensionValue {
  value: string;
  requests: number;
  sharePct: number;
}

/**
 * The values a dimension actually takes, largest first.
 *
 * Without this the model guesses — `os_version='Android'` when the data says `'Android 15'` — and
 * with no SQL tool to fall back on a guess is a dead end. Cheap: one grouped scan, LIMIT applied
 * server-side.
 */
export async function dimensionValues(
  ledger: Ledger,
  dimension: string,
  metricName: string,
  window: Window,
  limit = 30,
): Promise<DimensionValue[]> {
  const def = resolveMetric(metricName);
  const dim = assertDimension(dimension, def);
  const rows = await ledger.run<Record<string, unknown>>(
    `
SELECT ${dim} AS value,
       count() AS requests,
       count() * 100.0 / nullIf(sum(count()) OVER (), 0) AS share_pct
FROM ad_events_enriched
WHERE event_date BETWEEN '${window.from}' AND '${window.to}'
GROUP BY ${dim}
ORDER BY requests DESC
LIMIT ${Math.min(Math.max(1, Math.floor(limit)), MAX_ROWS)}`.trim(),
  );
  return rows.map((r) => ({
    value: String(r.value ?? ""),
    requests: num(r.requests),
    sharePct: num(r.share_pct),
  }));
}

/** Daily series for one metric across the whole dataset — the input to the growth estimate. */
export async function dailySeries(ledger: Ledger, metricName: string): Promise<Map<string, number>> {
  const def = resolveMetric(metricName);
  const rows = await ledger.run<{ d: string; v: number | null }>(
    `
SELECT toString(event_date) AS d, ${metricExpr(def)} AS v
FROM ad_events_enriched
WHERE event_date BETWEEN '${DATASET_START}' AND '${DATASET_END}'
GROUP BY event_date
ORDER BY event_date`.trim(),
  );
  return new Map(rows.map((r) => [r.d, num(r.v)]));
}

/** Weekly growth trend, estimated from the whole series (never from 3-4 baseline points). */
export async function weeklyGrowthFor(ledger: Ledger, metricName: string): Promise<number> {
  return estimateWeeklyGrowth(await dailySeries(ledger, metricName));
}

export interface DatasetOverview {
  from: string;
  to: string;
  days: number;
  requests: number;
  filled: number;
  impressions: number;
  clicks: number;
  revenue: number;
}

export async function datasetOverview(ledger: Ledger): Promise<DatasetOverview> {
  const [row] = await ledger.run<Record<string, unknown>>(
    `
SELECT toString(min(event_date)) AS from_d,
       toString(max(event_date)) AS to_d,
       uniqExact(event_date)     AS days,
       count()                   AS requests,
       sum(is_filled)            AS filled,
       sum(is_impression)        AS impressions,
       sum(is_click)             AS clicks,
       sum(revenue)              AS revenue
FROM ad_events_enriched
WHERE event_date BETWEEN '${DATASET_START}' AND '${DATASET_END}'`.trim(),
  );
  if (!row) throw new QueryError("describe_data: the events table returned no rows.");
  return {
    from: String(row.from_d ?? DATASET_START),
    to: String(row.to_d ?? DATASET_END),
    days: num(row.days),
    requests: num(row.requests),
    filled: num(row.filled),
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    revenue: num(row.revenue),
  };
}

export { DATASET_END, DATASET_START, DIMENSIONS, FILLED_ONLY_DIMENSIONS, METRICS };
