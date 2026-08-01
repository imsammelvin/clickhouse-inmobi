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
    numerator: "sum(is_filled)",
    denominator: "count()",
    scale: 1,
    unit: "ratio",
  },
  render_rate: {
    name: "render_rate",
    kind: "ratio",
    numerator: "sum(is_impression)",
    denominator: "sum(is_filled)",
    scale: 1,
    unit: "ratio",
  },
  ctr: {
    name: "ctr",
    kind: "ratio",
    numerator: "sum(is_click)",
    denominator: "sum(is_impression)",
    scale: 1,
    unit: "ratio",
  },
  ecpm: {
    name: "ecpm",
    kind: "ratio",
    numerator: "sum(revenue)",
    denominator: "sum(is_impression)",
    scale: 1000,
    unit: "usd",
  },
  rpr: {
    name: "rpr",
    kind: "ratio",
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
 * `advertiser_vertical` and `campaign_type` are deliberately excluded from the default sweep:
 * `advertiser_id` is empty on unfilled requests, so those columns are only populated on filled
 * events. Slicing fill rate by them is definitionally broken (§ 7 fact #1, R-009) — the single
 * easiest way to produce a confidently wrong number in this dataset.
 */
export const DIMENSIONS = [
  "ad_format",
  "app_category",
  "publisher_tier",
  "region",
  "country",
  "device_model",
  "os_version",
] as const;

/** Only safe on metrics restricted to filled events. */
export const FILLED_ONLY_DIMENSIONS = ["advertiser_vertical", "campaign_type"] as const;

export function dimensionsFor(metric: string): readonly string[] {
  // Fill rate's denominator includes unfilled requests, where advertiser columns are ''.
  if (metric === "fill_rate" || metric === "requests") return DIMENSIONS;
  return [...DIMENSIONS, ...FILLED_ONLY_DIMENSIONS];
}
