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

/**
 * A SQL predicate plus a human-readable form, so exclusions are explainable, not just applied.
 *
 * `dims` lists every underlying column the predicate constrains -- a pair dimension like
 * `region|os_version` splits into BOTH `region` and `os_version`, since that is what
 * `planRollup` needs to know how many of the rollup's dimension slots this mask has already
 * spent. Optional and defaulted to `[]` by every constructor below rather than made required,
 * so a caller building a `Mask` by hand (there are none left, but the type should not force it)
 * degrades to "unknown, assume unmasked" instead of a type error.
 */
export interface Mask {
  sql: string;
  description: string;
  dims?: readonly string[];
}

export const NO_MASK: Mask = { sql: "1", description: "no exclusions", dims: [] };

const esc = (v: string): string => v.replace(/'/g, "\\'");

/** The underlying column(s) a dimension name constrains -- splits a pair back into its two. */
export function dimsOf(dimension: string): string[] {
  return dimension.split("|");
}

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

export function andMask(a: Mask, b: Mask): Mask {
  if (a.sql === "1") return { ...b, dims: [...new Set([...(a.dims ?? []), ...(b.dims ?? [])])] };
  return {
    sql: `(${a.sql}) AND (${b.sql})`,
    description: `${a.description}; ${b.description}`,
    dims: [...new Set([...(a.dims ?? []), ...(b.dims ?? [])])],
  };
}
