/**
 * Metric tree and dimension list — config, not code.
 *
 * R-005 is that the unseen incident lands on a metric we did not build for. The defence is that
 * adding a metric here is a data change, not a code change: every stage reads these definitions.
 *
 * All formulas are sum/sum over the group, per metrics_glossary.md. Never an average of per-row
 * or per-day ratios, or rollups stop being correct.
 */

export type MetricKind = "ratio" | "absolute";

export interface MetricDef {
  name: string;
  kind: MetricKind;
  /**
   * Minimum numerator before a ratio is trusted at all.
   *
   * A request-count floor is the wrong gate for a rate. CTR sits at ~0.011, so a segment with 200
   * requests/day has under two clicks — one extra click reads as +60%, and the first segment scan
   * duly reported `ctr +1312%` on an advertiser with 403 requests. The binding constraint is how
   * many events landed in the numerator, not how much traffic passed through.
   *
   * 30 is the usual rule-of-thumb floor for treating a count as approximately normal; below it the
   * standard error is a larger number than most anomalies we care about.
   */
  minNumerator?: number;
  /** Minimum denominator, for ratios whose numerator is money rather than a count. */
  minDenominator?: number;
  /** SQL numerator and denominator. For absolutes the denominator is `1` and unused. */
  numerator: string;
  denominator: string;
  /** Multiplier applied after the division (eCPM is per 1000). */
  scale: number;
  unit: "ratio" | "usd" | "count";
}

export const METRICS: Record<string, MetricDef> = {
  revenue: {
    name: "revenue",
    kind: "absolute",
    numerator: "sum(revenue)",
    denominator: "1",
    scale: 1,
    unit: "usd",
  },
  requests: {
    name: "requests",
    kind: "absolute",
    numerator: "count()",
    denominator: "1",
    scale: 1,
    unit: "count",
  },
  impressions: {
    name: "impressions",
    kind: "absolute",
    numerator: "sum(is_impression)",
    denominator: "1",
    scale: 1,
    unit: "count",
  },
  fill_rate: {
    name: "fill_rate",
    kind: "ratio",
    minNumerator: 50,
    numerator: "sum(is_filled)",
    denominator: "count()",
    scale: 1,
    unit: "ratio",
  },
  render_rate: {
    name: "render_rate",
    kind: "ratio",
    minNumerator: 50,
    numerator: "sum(is_impression)",
    denominator: "sum(is_filled)",
    scale: 1,
    unit: "ratio",
  },
  ctr: {
    name: "ctr",
    kind: "ratio",
    minNumerator: 30,
    numerator: "sum(is_click)",
    denominator: "sum(is_impression)",
    scale: 1,
    unit: "ratio",
  },
  ecpm: {
    name: "ecpm",
    kind: "ratio",
    // Revenue is continuous, so the count that matters is the impressions it is spread over.
    minDenominator: 500,
    numerator: "sum(revenue)",
    denominator: "sum(is_impression)",
    scale: 1000,
    unit: "usd",
  },
  rpr: {
    name: "rpr",
    kind: "ratio",
    minDenominator: 500,
    numerator: "sum(revenue)",
    denominator: "count()",
    scale: 1,
    unit: "usd",
  },
};

/** SQL expression evaluating a metric over the current group. */
export function metricExpr(m: MetricDef): string {
  if (m.kind === "absolute") return m.numerator;
  return `${m.numerator} / nullIf(${m.denominator}, 0)${m.scale !== 1 ? ` * ${m.scale}` : ""}`;
}

/**
 * Dimensions available on `ad_events_enriched` (goal.md § 7).
 *
 * `advertiser_vertical`, `campaign_type` and `advertiser_id` are deliberately excluded from
 * fill-rate and request sweeps: `advertiser_id` is empty on unfilled requests, so those columns
 * exist only on filled events. Slicing fill rate by them is definitionally broken (§ 7 fact #1,
 * R-009) — the single easiest way to produce a confidently wrong number in this dataset.
 */
export const DIMENSIONS = [
  "ad_format",
  "app_category",
  "publisher_tier",
  "region",
  "country",
  "device_model",
  "os_version",
  // Entity dimension. The answer key can name a publisher app ("app_00393 broke"), which a
  // seven-attribute sweep could never say. 2,000 values, ~0.05% of traffic each.
  "app_id",
] as const;

/**
 * `geo_device_id` is deliberately NOT swept.
 *
 * It is a surrogate join key, not a business entity: 5,000 profiles at ~0.02% of traffic each, so a
 * single-profile anomaly is worth about $0.02/day and could never be actioned. Everything it
 * carries — region, country, device_model, os_version — is already swept as its own dimension, at
 * cardinalities where a finding means something. Adding it would multiply candidate rows 2.5x to
 * describe the same variance less usefully.
 */
export const EXCLUDED_DIMENSIONS = ["geo_device_id"] as const;

/** Only safe on metrics restricted to filled events. */
export const FILLED_ONLY_DIMENSIONS = [
  "advertiser_vertical",
  "campaign_type",
  "advertiser_id",
] as const;

/**
 * Pairwise cuts. Not a full cube — each pair carries a hypothesis, and pairs are what make an
 * incident like the problem statement's own example ("Device X in Region North") findable when it
 * is invisible in either dimension alone.
 *
 * They also do real work for residualization: clearing a cause out of another dimension needs the
 * two together, so `os_version` is paired widely because an OS-level break is the shape we have
 * actually observed in this data.
 */
export const DIMENSION_PAIRS = [
  ["region", "os_version"],
  ["publisher_tier", "os_version"],
  ["app_category", "os_version"],
  ["region", "device_model"],
  ["app_category", "ad_format"],
  ["country", "ad_format"],
] as const;

export function dimensionsFor(metric: string): readonly string[] {
  // Fill rate's denominator includes unfilled requests, where advertiser columns are ''.
  if (metric === "fill_rate" || metric === "requests") return DIMENSIONS;
  return [...DIMENSIONS, ...FILLED_ONLY_DIMENSIONS];
}
