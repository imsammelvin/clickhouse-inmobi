/**
 * Cross-lane contracts for the investigation engine (goal.md § 8).
 *
 * Rule that everything else depends on: a number may only reach the narrator through an
 * `Evidence` row. The narrator never sees a raw event row (D-008), so if a figure is not in the
 * ledger it cannot be spoken, and the grounding check can prove that mechanically.
 */

/** One computed number, with everything needed to reproduce it. */
export interface Evidence {
  id: string;
  label: string;
  value: number | null;
  unit: "ratio" | "pp" | "pct" | "usd" | "count" | "sigma";
  sql: string;
  sqlHash: string;
  window: { from: string; to: string };
  filters: Record<string, string>;
  /** Share of total requests this segment carries. "-35pp" is meaningless without it. */
  segmentSharePct?: number;
}

/**
 * The cause channels (goal.md § 2), plus two outcomes that are not causes but are legitimate
 * conclusions. `not_localizable` exists because incident B (Jun 21) is real: a uniform -44% across
 * every dimension. An engine forced to name a top segment would fabricate `country=BR` as the cause.
 *
 * There is deliberately no `exogenous_event` channel. Naming an external cause (a match, a
 * festival) requires data outside `ad_events`, which is out of scope under D-019 — and the data has
 * no event structure to find in any case.
 */
export type Channel =
  | "demand_change"
  | "supply_change"
  | "technical_break"
  | "mix_shift"
  | "seasonality"
  | "not_localizable"
  | "no_anomaly";

/**
 * `cleared_as_contamination` is distinct from `cleared_as_normal` on purpose. A segment that only
 * looked anomalous because it overlaps the real cause is a different fact from one that never
 * moved, and the distinction is the differentiator (D-017).
 */
export type FindingStatus =
  "found" | "cleared_as_normal" | "cleared_as_contamination" | "cleared_insufficient_data";

export interface Segment {
  dimension: string;
  value: string;
}

export interface Finding {
  channel: Channel;
  segment: Segment | null;
  metric: string;
  deltaAbs: number | null;
  deltaPct: number | null;
  /** In pp for ratio metrics; null otherwise. */
  deltaPp: number | null;
  revenueImpactUsd: number | null;
  significanceSigma: number | null;
  status: FindingStatus;
  /** Populated on `cleared_as_contamination`: the delta once the true cause is excluded. */
  residualPp?: number | null;
  segmentSharePct?: number | null;
  evidenceIds: string[];
  note?: string;
}

export interface PlanStep {
  stage: string;
  startedAt: number;
  ms: number;
  queries: number;
  summary: string;
}

export interface Investigation {
  request: { metric: string; from: string; to: string };
  primaryChannel: Channel;
  headline: string;
  findings: Finding[];
  ruledOut: Finding[];
  evidence: Evidence[];
  planSteps: PlanStep[];
  traceId: string;
}

/** A SQL predicate plus a human-readable form, so exclusions are explainable, not just applied. */
export interface Mask {
  sql: string;
  description: string;
  /**
   * Which dimensions the predicate constrains. Empty for `NO_MASK`.
   *
   * Added for T-050 (samarth, Crosses-lane: loges). A stage cannot ask whether the rollup can serve
   * its query without knowing which dimensions the query touches, and `sql` is a string — parsing it
   * back would be both fragile and exactly the wrong direction, since the callers below already know
   * the answer at construction time and were simply discarding it.
   *
   * It carries a real obligation: **every dimension the predicate references must be listed.** The
   * rollup pre-sums each cut, so a dimension left out of this list is a dimension that has already
   * been summed away — `planRollup` would hand back a cut that cannot express the filter, and the
   * query would return the number for the WHOLE slice instead of the filtered one. Plausible, wrong,
   * and silent. Use the builders below rather than assembling a Mask by hand; they are the reason
   * this cannot be got wrong in one place and right in another.
   */
  dims: readonly string[];
}

export const NO_MASK: Mask = { sql: "1", description: "no exclusions", dims: [] };

const esc = (v: string): string => v.replace(/'/g, "\\'");

/**
 * SQL predicate matching one segment, including the synthetic pair dimensions.
 *
 * Pairs are swept as `('region|os_version', concat(region,'|',os_version))`, which reads back as a
 * single dimension called `region|os_version` with values like `EU|Android 15`. Naively rendering
 * that as `region|os_version = 'EU|Android 15'` is a syntax error — a pair has to be split back
 * into its two columns. Both the segment scope and residualize's exclusion mask go through here so
 * there is exactly one place that has to be right.
 */
export function segmentPredicate(dimension: string, value: string): string {
  const [dimA, dimB] = dimension.split("|");
  if (!dimB) return `${dimension} = '${esc(value)}'`;
  const [valA, valB] = value.split("|");
  return `${dimA} = '${esc(valA ?? "")}' AND ${dimB} = '${esc(valB ?? "")}'`;
}

/** Its negation, for excluding a cause during deflation. */
export function segmentExclusion(dimension: string, value: string): string {
  return `NOT (${segmentPredicate(dimension, value)})`;
}

/**
 * The dimensions a segment name constrains — one, or two for a synthetic pair.
 *
 * Split on `|` for the same reason `segmentPredicate` does: the sweep emits pairs as a single
 * dimension called `region|os_version`, and both halves are real columns that a rollup cut has to
 * carry for the predicate to be expressible.
 */
export const segmentDims = (dimension: string): readonly string[] => dimension.split("|");

/** Restrict to one segment. */
export function segmentMask(dimension: string, value: string): Mask {
  return {
    sql: segmentPredicate(dimension, value),
    description: `${dimension}='${value}'`,
    dims: segmentDims(dimension),
  };
}

/** Exclude one segment, for residualization's deflation loop. */
export function exclusionMask(dimension: string, value: string): Mask {
  return {
    sql: segmentExclusion(dimension, value),
    description: `excluding ${dimension} = '${value}'`,
    dims: segmentDims(dimension),
  };
}

export function andMask(a: Mask, b: Mask): Mask {
  if (a.sql === "1") return b;
  return {
    sql: `(${a.sql}) AND (${b.sql})`,
    description: `${a.description}; ${b.description}`,
    // Union, because the combined predicate constrains everything either side did. Two exclusions on
    // different dimensions therefore report two dims and `planRollup` declines the cut — correct: no
    // materialised cut can express both at once, so it falls back to the raw scan.
    dims: [...new Set([...a.dims, ...b.dims])],
  };
}
