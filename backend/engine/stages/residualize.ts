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
import { type Mask, NO_MASK, andMask, exclusionMask } from "../types";
import { withSpan } from "../../../shared/utils/telemetryUtils";

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

/**
 * Percentage points of the PLATFORM metric a segment must account for before it can be named the
 * cause of a platform move.
 *
 * Everything else here asks "did this segment move?". This asks the question a reader actually
 * means by *cause*: "if this segment had not moved, would the platform number look different?" A
 * segment can clear every other gate and still answer no, because share is not in any of them.
 *
 * This is what let the seasonality decoy through. On 2026-06-27 platform revenue is up 4.4% —
 * an ordinary Saturday whose sigma is manufactured by the spread floor (see baseline.ts) — and the
 * top candidate was `country|ad_format='IN|banner'`, +9.7% on 2.1% of traffic. It cleared the size
 * gate, the share gate, and 2.5 sigma against its own history at 19.4 sigma (also floored), and it
 * moves the platform total by 0.20pp. Naming it the cause of a 4.4% move is a fabrication, and the
 * rubric costs a fabricated figure more than a missed anomaly.
 *
 * Measured across everything we have, as |deltaPct| x share:
 *
 *     Android 15  -44.8% on 9.6%   4.30pp     <- real
 *     finance     -35.0% on 7.2%   2.52pp     <- real
 *     iOS 18.1    -11.6% on 9.8%   1.13pp     <- real, the weakest one
 *     IN|banner    +9.7% on 2.1%   0.20pp     <- decoy
 *     AE|banner   +10.0% on 1.7%   0.17pp     <- decoy
 *     PH|rewarded +10.8% on 0.9%   0.10pp     <- decoy
 *
 * 0.5 sits between 0.20 and 1.13 at roughly their geometric mean, so it is not pressed against
 * either side — the nearest real cause has 2.3x of headroom and the nearest decoy 2.5x. Note that
 * no threshold on magnitude alone could do this: the decoys move ~10% and iOS 18.1 moves 11.6%.
 * Share is the only thing that separates them, which is why it belongs in the gate and not just in
 * the ranking.
 */
export const CAUSE_MIN_PLATFORM_PP = 0.5;

/**
 * Percentage points of the platform metric this segment's move accounts for.
 * Share-weighted on purpose — a huge move on nothing is nothing.
 */
export const platformPointsMoved = (c: Candidate): number =>
  Math.abs(c.deltaPct) * (c.sharePct / 100);

/** Below this, a segment counts as "returned to normal" after deflation. */
export const RESIDUAL_BAND_PP = 0.75;
export const RESIDUAL_BAND_PCT = 2.0;

const magnitude = (c: Candidate): number =>
  c.deltaPp !== null ? Math.abs(c.deltaPp) : Math.abs(c.deltaPct);

const bandFor = (c: Candidate): number =>
  c.deltaPp !== null ? RESIDUAL_BAND_PP : RESIDUAL_BAND_PCT;

/**
 * A cause must move differently from the platform, not merely move.
 *
 * On 2026-06-28 the platform was up 6.0% — an ordinary Sunday. `publisher_tier='tier_2'` was up
 * 6.4%, i.e. it did exactly what everything else did, and was still reported as the driver of a
 * $39.51/day "finding" on the seasonality decoy. A segment that tracks the platform is the
 * platform; it explains nothing. Excess over the platform move is what makes a segment a cause,
 * and measuring it that way is also what lets the decoy stay quiet without a special case.
 */
export function qualifies(c: Candidate, platformDelta = 0): boolean {
  if (c.sharePct < CAUSE_MIN_SHARE_PCT) return false;
  if (c.deltaPp !== null) {
    return Math.abs(c.deltaPp - platformDelta) >= CAUSE_MIN_PP;
  }
  return Math.abs(c.deltaPct - platformDelta) >= CAUSE_MIN_PCT;
}

/**
 * Uniformity test — is every segment moving together?
 *
 * If the spread of per-segment deltas is small relative to their median magnitude, nothing is
 * localized: the platform moved and every slice inherited it. Incident B sits at roughly -45% +/-2
 * across 40 values, which is unmistakably this shape.
 */
/** Share below which a segment is too small to inform the uniformity verdict. */
const UNIFORMITY_MIN_SHARE_PCT = 1;

/** Single predicate for "counts toward the uniformity verdict", used by the test and its evidence. */
const informsUniformity = (c: Candidate): boolean =>
  magnitude(c) > 1 && c.sharePct >= UNIFORMITY_MIN_SHARE_PCT;

function isUniform(cands: Candidate[]): { uniform: boolean; note: string } {
  // Judged only on segments large enough to be meaningful. Adding app_id put 2,000 thinly-traded
  // candidates into the sweep, whose magnitudes scatter widely, and that scatter alone pushed the
  // spread ratio past the threshold — so incident B stopped being recognised as uniform and the
  // engine went back to naming a top segment. The platform-wide collapse is visible in the big
  // slices; the long tail only adds noise to the test.
  const moved = cands.filter(informsUniformity);
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
  /** The platform-level move for the same metric and window; segments are judged against it. */
  platformDelta = 0,
): Promise<ResidualizeResult> {
  return withSpan(
    "stage.residualize",
    {
      "app.stage": "residualize",
      "app.metric": metric,
      "app.window.from": from,
      "app.window.to": to,
      "app.residualize.initial_candidates": initial.length,
      "app.residualize.max_iterations": maxIterations,
      "app.residualize.platform_delta": Number(platformDelta.toFixed(4)),
    },
    async (span) => {
      const result = await residualizeInner(
        ledger,
        metric,
        from,
        to,
        initial,
        maxIterations,
        platformDelta,
      );
      // The deflation loop's whole claim is "N raw candidates reduced to M causes". Both halves on
      // the span, so the reduction is visible in a trace without reading the console.
      span.setAttributes({
        "app.residualize.causes": result.causes.length,
        "app.residualize.contamination": result.contamination.length,
        "app.residualize.uniform": result.uniform,
      });
      return result;
    },
  );
}

async function residualizeInner(
  ledger: Ledger,
  metric: string,
  from: string,
  to: string,
  initial: Candidate[],
  maxIterations: number,
  platformDelta: number,
): Promise<ResidualizeResult> {
  const uniformity = isUniform(initial);
  if (uniformity.uniform) {
    // The uniformity verdict quotes six figures in prose. Each is a claim about the data and each
    // must resolve, or the most important sentence we produce would be ungrounded.
    //
    // MUST use the same predicate isUniform used. When the share floor was added there, this was
    // left filtering on magnitude alone, so the recorded evidence described a different set of
    // segments than the sentence did and three numerals went ungrounded. Shared predicate now.
    const moved = initial.filter(informsUniformity);
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
    const top = current.filter((c) => qualifies(c, platformDelta))[0];
    if (!top) break;

    causes.push(top);
    iterations++;

    // Via the shared builder: a pair dimension has to be split back into its two columns, and
    // hand-rolling that here emitted `country|ad_format != 'ES|native'`, which is a syntax error.
    // The builder also records which dimensions the exclusion constrains, so a stage reading the
    // rollup can tell whether a materialised cut can express it.
    mask = andMask(mask, exclusionMask(top.dimension, top.value));

    // Re-sweep the remainder. This is the whole idea: what still moves once the cause is gone?
    const after = await localize(ledger, metric, from, to, mask);
    const afterByKey = new Map(after.map((c) => [`${c.dimension}|${c.value}`, c]));

    // Anything that qualified before but is now inside the band was contamination.
    for (const before of current) {
      if (before === top) continue;
      const key = `${before.dimension}|${before.value}`;
      const now = afterByKey.get(key);
      if (!now || !qualifies(before, platformDelta)) continue;
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
    if (!after.some((c) => qualifies(c, platformDelta))) break;
  }

  await orderBySurvival(ledger, metric, from, to, causes);

  const causeKeys = new Set(causes.map((c) => `${c.dimension}|${c.value}`));
  const contamKeys = new Set(contamination.map((c) => `${c.dimension}|${c.value}`));
  const normal = initial.filter(
    (c) =>
      !causeKeys.has(`${c.dimension}|${c.value}`) && !contamKeys.has(`${c.dimension}|${c.value}`),
  );

  return { causes, contamination, normal, uniform: false, iterations };
}

/**
 * Reorder surviving causes by how much of each is left once the OTHERS are excluded. In place.
 *
 * The loop above admits causes in contribution order, and contribution is the wrong tie-breaker
 * between two causes that overlap. Incident C on its auto-detected window (ecpm, 2026-06-16..22) is
 * the case: `ad_format='interstitial'` scores -7.5% x 17.4% = 1.31 and `app_category='finance'`
 * scores -18.6% x 5.9% = 1.10, so interstitial leads by 19% and became the headline — while finance,
 * the planted incident, was demoted to a second line. Hand the same investigation the narrower
 * window a human would pick and finance wins; nothing about the data changed except which window
 * the sweep derived, which is exactly the input nobody controls on the unseen dataset.
 *
 * Contribution cannot separate them because interstitial's move IS finance leaking into it —
 * finance ads run heavily as interstitials, so the parent's collapse drags the format. Deflation
 * already knows how to tell a cause from its shadow, and the answer is what survives exclusion:
 *
 *     finance      -34.5%  ->  -33.7%  with interstitial removed   (survives)
 *     interstitial  -7.1%  ->   -4.7%  with finance removed        (two thirds of it was finance)
 *
 * So each cause is re-measured against a sweep with every other cause masked out, and they are
 * ordered by what remains. This is the same test the loop already applies to contamination, turned
 * on the survivors — the difference being that a survivor keeps its move and merely reorders, where
 * contamination loses its move and is dropped.
 *
 * Costs one sweep per cause and only runs when there are at least two, so the single-cause case —
 * incidents A and D — pays nothing.
 */
async function orderBySurvival(
  ledger: Ledger,
  metric: string,
  from: string,
  to: string,
  causes: Candidate[],
): Promise<void> {
  if (causes.length < 2) return;

  const key = (c: Candidate): string => `${c.dimension}|${c.value}`;

  // Each cause's survival check excludes a different mask and reads nothing the others wrote --
  // the sequential form paid one full localize() round trip per survivor back to back (measured:
  // up to 4 extra 1.2-2.3s round trips stacked on a real trace). Independent, so run concurrently.
  //
  // The mask goes through `exclusionMask` rather than a literal: it records which dimensions the
  // exclusion constrains, which is what lets a stage reading the rollup decide whether a
  // materialised cut can express it (T-050). Both halves of this are load-bearing and they are
  // orthogonal -- concurrency is about round trips, `dims` is about which table answers.
  const checks = await Promise.all(
    causes.map(async (c) => {
      const others = causes.filter((o) => o !== c);
      const mask = others.reduce<Mask>(
        (m, o) => andMask(m, exclusionMask(o.dimension, o.value)),
        NO_MASK,
      );
      const after = await localize(ledger, metric, from, to, mask);
      const self = after.find((a) => key(a) === key(c));
      return { c, mask, self };
    }),
  );

  const survival = new Map<string, number>();
  for (const { c, mask, self } of checks) {
    // Absent from the re-sweep means it fell under the volume floor once the others were removed,
    // which is itself a failure to survive — rank it last rather than crediting its raw move.
    const value = self ? magnitude(self) : 0;
    survival.set(key(c), value);
    ledger.record({
      label: `survival.${c.dimension}.${c.value}`,
      value: Number(value.toFixed(4)),
      unit: c.deltaPp !== null ? "pp" : "pct",
      sql: self?.sql ?? c.sql,
      window: { from, to },
      filters: { mask: mask.description },
    });
  }

  causes.sort((a, b) => (survival.get(key(b)) ?? 0) - (survival.get(key(a)) ?? 0));
}
