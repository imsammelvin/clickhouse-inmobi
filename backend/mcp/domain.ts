/**
 * What this dataset is about — the only file that knows.
 *
 * The action layer used to describe every technical break as "the failure is between request and fill",
 * which is true of a fill-rate collapse and false of anything else. A render-rate break happens one
 * step further down the funnel and a price drop is not a step at all, so the sentence was wrong in
 * exactly the cases the training data never produced. That is the giveaway that the prose belonged to
 * the metric, not to the channel.
 *
 * So the funnel is declared once, here, and the recommendation is composed from it. Two consequences:
 *
 *   1. **It says the right thing per metric.** "The step from an ad being sold to the ad displaying is
 *      failing" for render rate; "the price per impression fell" for eCPM. Neither is hardcoded in a
 *      channel branch, and adding a metric to `backend/metrics.ts` no longer leaves the advice stale.
 *   2. **It is portable.** Nothing in the mechanics of the action block is about advertising —
 *      whether something is still happening, what it has cost, who owns it, what not to chase are all
 *      properties of a time series and a residualization. Only the vocabulary is domain-specific, and
 *      it is all in this file. A checkout funnel or a delivery pipeline swaps these declarations and
 *      keeps everything else.
 *
 * The one honest limit: the *channels* (`demand_change`, `supply_change`, `technical_break`) and the
 * revenue identity live in `backend/`, and they are marketplace concepts. This file makes the advice
 * domain-driven; it does not pretend the whole engine is domain-free.
 */

/** A stage in the funnel, named as a reader would say it. */
export interface Stage {
  /** Stable key, referenced by STEP_METRICS. */
  key: string;
  /** How to name the thing itself in a sentence: "a request arriving". */
  label: string;
  /** How to name a count of them: "requests". */
  plural: string;
}

/**
 * The funnel, in order. Each adjacent pair is a conversion step that some ratio metric measures.
 */
export const FUNNEL: Stage[] = [
  { key: "request", label: "a request arriving", plural: "requests" },
  { key: "fill", label: "an ad being sold", plural: "fills" },
  { key: "impression", label: "the ad displaying", plural: "impressions" },
  { key: "click", label: "a click", plural: "clicks" },
];

const stage = (key: string): Stage =>
  FUNNEL.find((s) => s.key === key) ?? { key, label: key, plural: key };

/** Ratio metrics that measure the conversion between two adjacent stages. */
export const STEP_METRICS: Record<string, { from: string; to: string }> = {
  fill_rate: { from: "request", to: "fill" },
  render_rate: { from: "fill", to: "impression" },
  ctr: { from: "impression", to: "click" },
};

/** Metrics that are a value per unit rather than a conversion — a price. */
export const PRICE_METRICS: Record<string, { per: string }> = {
  ecpm: { per: "impression" },
  rpr: { per: "request" },
};

/** Metrics that are a count of something, where a move means more or less of it. */
export const VOLUME_METRICS: Record<string, { of: string }> = {
  requests: { of: "request" },
  impressions: { of: "impression" },
  revenue: { of: "impression" },
};

/** Who is on each side of the market, for the two commercial channels. */
export const SIDES = {
  demand: "the buyers — what advertisers were willing to pay, and how many were bidding",
  supply: "the sell side — how much inventory arrived",
} as const;

/**
 * One sentence locating a movement in the funnel, derived from the metric.
 *
 * Returns null for a metric this file does not describe, and the caller then says so rather than
 * guessing — an unrecognised metric getting confident funnel advice is how the original bug read.
 */
export function locateMetric(metric: string, scope: string): string | null {
  const step = STEP_METRICS[metric];
  if (step) {
    const from = stage(step.from);
    const to = stage(step.to);
    return (
      `The step from ${from.label} to ${to.label} is failing for ${scope}: the ${from.plural} were ` +
      `there and the stages around this one held, so the inputs exist and the conversion between them ` +
      `is what broke.`
    );
  }

  const price = PRICE_METRICS[metric];
  if (price) {
    return (
      `The price per ${stage(price.per).key} fell for ${scope} while volume and delivery held — this ` +
      `is what was paid, not whether anything was delivered.`
    );
  }

  const volume = VOLUME_METRICS[metric];
  if (volume) {
    return (
      `The number of ${stage(volume.of).plural} moved for ${scope}, while the conversion rates below ` +
      `it behaved normally — so the quantity arriving changed rather than how well it performed.`
    );
  }

  return null;
}

/** Fallback when the metric is not described above. Says what is known and stops. */
export function locateUnknownMetric(metric: string, scope: string): string {
  return (
    `\`${metric}\` moved for ${scope}. This dataset's funnel description does not cover that metric, ` +
    `so where in the pipeline it sits cannot be stated from the evidence — add it to mcp/domain.ts to ` +
    `get a specific answer instead of this one.`
  );
}
