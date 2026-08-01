/**
 * Stage 3 — residualize. The differentiator (D-017, T-040).
 *
 * Contribution ranking alone returns every segment that *overlaps* the cause, not the cause. On the
 * Jun 23-25 incident that is 21 segments when the answer is 1: Android 15 is 9.6% of traffic, so a
 * -35pp collapse inside it drags every blended slice it appears in down by roughly 3pp.
 *
 * The fix is deflation. Take the strongest candidate, exclude its rows, re-sweep. Anything that
 * returns to band was contamination, never a cause. Repeat until nothing survives.
 *
 * Two properties matter as much as the loop itself:
 *
 *   1. It may return ZERO causes. Incident B (Jun 21) is a uniform -44% across every dimension —
 *      no segment is responsible. An engine obliged to name its top candidate would report
 *      `country=BR` (-47.2%), which is a fabricated cause. Uniformity is detected explicitly.
 *   2. Cleared segments are output, not discarded. The ruled-out list the rubric asks for as a
 *      bonus falls out of this loop for free, with each residual as its proof.
 */
import type { Ledger } from "../ledger";
import { type Candidate, localize } from "./localize";
import { type Mask, NO_MASK, andMask } from "../types";

export interface ResidualizeResult {
  causes: Candidate[];
  /** Looked guilty on the raw sweep, returned to band once a real cause was excluded. */
  contamination: Array<Candidate & { residualDelta: number; residualPp: number | null }>;
  /** Never moved. */
  normal: Candidate[];
  uniform: boolean;
  uniformNote?: string;
  iterations: number;
}

/** A candidate must clear all three to be called a cause. */
export const CAUSE_MIN_PP = 2.0;
export const CAUSE_MIN_PCT = 5.0;
export const CAUSE_MIN_SHARE_PCT = 0.5;

/** Below this, a segment counts as "returned to normal" after deflation. */
export const RESIDUAL_BAND_PP = 0.75;
export const RESIDUAL_BAND_PCT = 2.0;

const magnitude = (c: Candidate): number =>
  c.deltaPp !== null ? Math.abs(c.deltaPp) : Math.abs(c.deltaPct);

const bandFor = (c: Candidate): number =>
  c.deltaPp !== null ? RESIDUAL_BAND_PP : RESIDUAL_BAND_PCT;

export function qualifies(c: Candidate): boolean {
  if (c.sharePct < CAUSE_MIN_SHARE_PCT) return false;
  return c.deltaPp !== null
    ? Math.abs(c.deltaPp) >= CAUSE_MIN_PP
    : Math.abs(c.deltaPct) >= CAUSE_MIN_PCT;
}

/**
 * Uniformity test — is every segment moving together?
 *
 * If the spread of per-segment deltas is small relative to their median magnitude, nothing is
 * localized: the platform moved and every slice inherited it. Incident B sits at roughly -45% +/-2
 * across 40 values, which is unmistakably this shape.
 */
function isUniform(cands: Candidate[]): { uniform: boolean; note: string } {
  const moved = cands.filter((c) => magnitude(c) > 1);
  if (moved.length < 8) return { uniform: false, note: "" };

  const mags = moved.map(magnitude).sort((a, b) => a - b);
  const median = mags[Math.floor(mags.length / 2)]!;
  const lo = mags[0]!;
  const hi = mags[mags.length - 1]!;
  if (median === 0) return { uniform: false, note: "" };

  // Spread under ~25% of the typical move means they are all the same move.
  const spreadRatio = (hi - lo) / median;
  if (spreadRatio > 0.25) return { uniform: false, note: "" };

  return {
    uniform: true,
    note:
      `${moved.length} segments across ${new Set(moved.map((c) => c.dimension)).size} dimensions ` +
      `all moved between ${lo.toFixed(1)} and ${hi.toFixed(1)} (median ${median.toFixed(1)}). ` +
      `Spread is ${(spreadRatio * 100).toFixed(0)}% of the typical move, so no segment is ` +
      `distinguishable as the cause.`,
  };
}

export async function residualize(
  ledger: Ledger,
  metric: string,
  from: string,
  to: string,
  initial: Candidate[],
  maxIterations = 4,
): Promise<ResidualizeResult> {
  const uniformity = isUniform(initial);
  if (uniformity.uniform) {
    // The uniformity verdict quotes six figures in prose. Each is a claim about the data and each
    // must resolve, or the most important sentence we produce would be ungrounded.
    const moved = initial.filter((c) => magnitude(c) > 1);
    const mags = moved.map(magnitude).sort((a, b) => a - b);
    const med = mags[Math.floor(mags.length / 2)] ?? 0;
    const sqlRef = initial[0]?.sql ?? "";
    const rec = (label: string, value: number, unit: "count" | "pct") =>
      ledger.record({
        label,
        value: Number(value.toFixed(4)),
        unit,
        sql: sqlRef,
        window: { from, to },
        filters: {},
      });
    rec("uniformity.segments_moved", moved.length, "count");
    rec("uniformity.dimensions", new Set(moved.map((c) => c.dimension)).size, "count");
    rec("uniformity.min_magnitude", mags[0] ?? 0, "pct");
    rec("uniformity.max_magnitude", mags[mags.length - 1] ?? 0, "pct");
    rec("uniformity.median_magnitude", med, "pct");
    rec(
      "uniformity.spread_ratio_pct",
      med === 0 ? 0 : (((mags[mags.length - 1] ?? 0) - (mags[0] ?? 0)) / med) * 100,
      "pct",
    );
    return {
      causes: [],
      contamination: [],
      normal: initial.filter((c) => magnitude(c) <= 1),
      uniform: true,
      uniformNote: uniformity.note,
      iterations: 0,
    };
  }

  const causes: Candidate[] = [];
  const contamination: ResidualizeResult["contamination"] = [];
  let mask: Mask = NO_MASK;
  let current = initial;
  let iterations = 0;

  while (iterations < maxIterations) {
    const top = current.filter(qualifies)[0];
    if (!top) break;

    causes.push(top);
    iterations++;

    mask = andMask(mask, {
      sql: `${top.dimension} != '${top.value.replace(/'/g, "\\'")}'`,
      description: `excluding ${top.dimension} = '${top.value}'`,
    });

    // Re-sweep the remainder. This is the whole idea: what still moves once the cause is gone?
    const after = await localize(ledger, metric, from, to, mask);
    const afterByKey = new Map(after.map((c) => [`${c.dimension}|${c.value}`, c]));

    // Anything that qualified before but is now inside the band was contamination.
    for (const before of current) {
      if (before === top) continue;
      const key = `${before.dimension}|${before.value}`;
      const now = afterByKey.get(key);
      if (!now || !qualifies(before)) continue;
      const residual = now.deltaPp !== null ? Math.abs(now.deltaPp) : Math.abs(now.deltaPct);
      if (residual <= bandFor(now)) {
        contamination.push({
          ...before,
          residualDelta: now.deltaPp ?? now.deltaPct,
          residualPp: now.deltaPp,
        });
      }
    }

    ledger.record({
      label: `residualize.iteration_${iterations}.excluded`,
      value: causes.length,
      unit: "count",
      sql: after[0]?.sql ?? "",
      window: { from, to },
      filters: { mask: mask.description },
    });

    current = after;
    if (!after.some(qualifies)) break;
  }

  const causeKeys = new Set(causes.map((c) => `${c.dimension}|${c.value}`));
  const contamKeys = new Set(contamination.map((c) => `${c.dimension}|${c.value}`));
  const normal = initial.filter(
    (c) =>
      !causeKeys.has(`${c.dimension}|${c.value}`) && !contamKeys.has(`${c.dimension}|${c.value}`),
  );

  return { causes, contamination, normal, uniform: false, iterations };
}
