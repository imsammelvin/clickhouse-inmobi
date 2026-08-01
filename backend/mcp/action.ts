/**
 * What to do about it.
 *
 * A diagnosis nobody acts on is worth nothing, and "here is the cause" is not an instruction. This
 * turns an `Investigation` into a recommendation — but it is built under a hard constraint, and the
 * constraint is the reason it is trustworthy:
 *
 *   **This dataset is ad requests. It contains no deploy logs, no bid logs, no server telemetry, no
 *   config history and no calendar.** So we never say "restart the Android 15 serving path" or "roll
 *   back yesterday's deploy". We have no evidence for either, and inventing a remediation is the same
 *   failure as inventing a number — worse, because it sends a person somewhere for an afternoon.
 *
 * What we can say, and all of it is derived rather than asserted:
 *
 *   1. **Is it still happening.** The single most actionable fact about any incident, and nothing in
 *      the engine reported it. An incident that recovered on the 26th and one that is still running
 *      demand completely different responses, and the difference is two queries.
 *   2. **What it has cost so far, and what fixing it recovers.** $/day is already priced; multiplying
 *      by the days it actually ran is arithmetic on that figure.
 *   3. **Who owns it** — from the channel, which `classify` already decided on evidence.
 *   4. **Where in the funnel to look.** Not which system: which *stage*. "Buyers were present and
 *      prices held, so the failure is between request and fill for this segment" is a deduction from
 *      the funnel, and it is as far as this data can honestly take anyone.
 *   5. **What not to chase.** The residualization payoff, turned into an instruction. Twenty slices
 *      looked broken and are clean; telling someone not to spend the morning on Europe is worth as
 *      much as telling them where to go.
 */
import type { Ledger } from "../engine/ledger";
import type { Channel, Investigation, Segment } from "../engine/types";
import { baselineDates, median, MIN_BASELINE_DAYS } from "../engine/baseline";
import { MIN_ABS_PCT } from "../engine/stages/detect";
import { DATASET_END, DATASET_START, MAX_ROWS, measure } from "./query";
import { SIDES, locateMetric, locateUnknownMetric } from "./domain";

/** Who picks it up. Mirrors the owner strings `classify` assigns, which are not exported. */
const OWNER: Record<Channel, string> = {
  demand_change: "Sales / account management",
  supply_change: "Publisher ops",
  technical_break: "Engineering",
  mix_shift: "Nobody — nothing is broken",
  seasonality: "Nobody — expected pattern",
  not_localizable: "Platform / on-call",
  no_anomaly: "Nobody",
};

/**
 * Where the funnel evidence points, per channel.
 *
 * Every one of these is a statement about which stage of the funnel moved, which the decomposition
 * measured. None of them names a system, a release or a team's internal component, because this data
 * cannot see any of those. The `nextQuestion` is a query this system can actually run, so the next
 * step is available in the same conversation rather than requiring tools we do not have.
 */
function whereToLook(
  channel: Channel,
  segment: Segment | null,
  metric: string,
): { lines: string[]; nextQuestion: string | null } {
  const seg = segment ? `${segment.dimension} = '${segment.value}'` : "the platform";
  const dim = segment?.dimension ?? null;
  /** Where in the funnel this metric sits — derived from mcp/domain.ts, never from the channel. */
  const located = locateMetric(metric, seg) ?? locateUnknownMetric(metric, seg);

  switch (channel) {
    case "technical_break":
      return {
        lines: [
          located,
          `Whatever changed is specific to ${seg} — every other value of ${dim ?? "that dimension"} ` +
            `stayed normal over the same days, so it is not a platform-wide fault.`,
        ],
        nextQuestion: dim
          ? `compare ${metric} across ${dim} over the same window, to see whether neighbouring values moved at all`
          : null,
      };
    case "demand_change":
      return {
        lines: [
          located,
          `The shortfall is on ${SIDES.demand} — not in traffic arriving or in delivery, both of which ` +
            `held. There is nothing to fix in the pipeline; this is a commercial change in ${seg}.`,
        ],
        nextQuestion: `break ecpm down by advertiser_vertical for ${seg} over the same window`,
      };
    case "supply_change":
      return {
        lines: [
          located,
          `The movement is on ${SIDES.supply}; everything downstream of it behaved normally, so ` +
            `inventory changed rather than performance. Check whether that change was expected.`,
        ],
        nextQuestion: dim ? `rank ${dim} by requests over the same window to see who moved` : null,
      };
    case "mix_shift":
      return {
        lines: [
          `Nothing is broken. The blended number moved because the composition of traffic changed, ` +
            `not because any segment performed worse.`,
          `Confirm the mix change was intended before spending time on it.`,
        ],
        nextQuestion: null,
      };
    case "seasonality":
      return {
        lines: [`Expected weekly pattern, not an incident. No action.`],
        nextQuestion: null,
      };
    case "not_localizable":
      return {
        lines: [
          `The movement is uniform across every dimension tested, so no segment is responsible and ` +
            `there is nothing to route to a segment owner.`,
          `That points at something shared by all traffic. This dataset cannot narrow it further — ` +
            `and being told "it is everything" is more useful than being pointed at a segment ` +
            `picked because it happened to rank first.`,
        ],
        nextQuestion: null,
      };
    case "no_anomaly":
      return {
        lines: [`Nothing to do — the metric is within its normal band.`],
        nextQuestion: null,
      };
  }
}

export type Priority = "act_now" | "post_mortem" | "monitor" | "none";

export interface ActionRecommendation {
  priority: Priority;
  priorityBasis: string;
  status: "ongoing" | "recovered" | "not_applicable";
  statusDetail: string;
  owner: string;
  moneyUsdPerDay: number | null;
  daysRunning: number | null;
  lostSoFarUsd: number | null;
  recoverableUsdPerDay: number | null;
  whereToLook: string[];
  /** The residualization payoff as an instruction: slices that look broken and are not. */
  doNotChase: string[];
  nextQuestion: string | null;
  /** Stated in the payload, not just in a comment, so the narrator cannot overclaim past it. */
  boundary: string;
}

/**
 * The band a day must be back inside to count as recovered.
 *
 * Deliberately the detector's own size gate rather than a number chosen here: "recovered" then means
 * exactly "would no longer fire", so the two halves of the system cannot disagree about whether an
 * incident is over. If Lane A retunes detection, this follows.
 */
const RECOVERY_GATE_PCT = MIN_ABS_PCT;

/**
 * Has the cause segment come back to its normal level since the incident window?
 *
 * EVERY DAY IS JUDGED AGAINST ITS OWN WEEKDAY. The obvious implementation — take the incident
 * window's baseline and compare each later day to it — is wrong for any absolute metric, and it was
 * wrong here first. Incident B is a one-day collapse on Sunday 21 June whose same-weekday baseline is
 * ~225k requests; the Mondays and Tuesdays that follow run ~281k, which is 25% above a *Sunday*
 * normal, so they read as "still broken" and the first day to land within 10% of 225k was the
 * following **Saturday**. It reported a one-day incident as recovering six days late.
 *
 * Ratio metrics hid it again — fill rate sits at ~0.785 every day of the week, so it is insensitive
 * to the weekday mismatch, and the Android 15 case looked perfect throughout. That is the third time
 * in this feature's short life that a ratio has concealed an arithmetic error in a window comparison.
 *
 * So: one query for the whole daily series, then each day gets the median of its own trailing
 * same-weekday values — the same rule `baselineDates` implements for detection, applied per day.
 */
async function resolveStatus(
  ledger: Ledger,
  inv: Investigation,
  segment: Segment | null,
): Promise<{ status: ActionRecommendation["status"]; detail: string; daysRunning: number | null }> {
  const { metric, from, to } = inv.request;

  if (inv.primaryChannel === "no_anomaly" || inv.primaryChannel === "seasonality") {
    return {
      status: "not_applicable",
      detail: "Nothing was wrong, so there is nothing to recover from.",
      daysRunning: null,
    };
  }

  const filters = segment ? { [segment.dimension]: segment.value } : undefined;
  const series = await measure(ledger, {
    metric,
    from: DATASET_START,
    to: DATASET_END,
    filters,
    granularity: "day",
    limit: MAX_ROWS,
  });

  const byDay = new Map<string, number>();
  for (const r of series.rows) {
    if (r.value !== null) byDay.set(r.group.day ?? "", r.value);
  }

  /** That day's own normal: median of the same weekday in preceding weeks. */
  const normalFor = (day: string): number | null => {
    const priors = baselineDates(day, day)
      .map((d) => byDay.get(d))
      .filter((v): v is number => v !== undefined);
    return priors.length >= MIN_BASELINE_DAYS ? median(priors) : null;
  };

  /** How far a day sits from its own same-weekday normal, in percent. */
  const deviation = (day: string): number | null => {
    const v = byDay.get(day);
    const base = normalFor(day);
    if (v === undefined || base === null || base === 0) return null;
    return ((v - base) / Math.abs(base)) * 100;
  };

  /**
   * Recovery is judged in the direction the incident moved, against the detector's own gate.
   *
   * Two failures forced this shape, and neither was fixable with a better constant:
   *
   *   A symmetric 10% band called incident D recovered on 29 June at 0.7520 against a 0.7838 normal.
   *   That is -4%, and fill rate normally sits at 0.785 +/- 0.0005 — a 4% move on it is three
   *   percentage points and the incident was still running. Percentage bands are the wrong instrument
   *   for a pathologically stable ratio, which is the same reason `baseline.ts` floors sigma.
   *
   *   Tightening to the detector's 3% gate then broke incident B: 22 June sits +4.2% above its
   *   same-weekday normal, because the dataset's real +6.4% growth trend lifts every later day and
   *   this median-of-priors does not detrend. A symmetric gate reads that as "still anomalous" when
   *   the collapse plainly ended.
   *
   * Both go away by asking the right question. An incident is a movement in a direction, so it has
   * recovered when that movement is no longer present *in that direction* by more than the gate that
   * fired it. Being above normal is not a failure to recover from a drop — and the growth trend can
   * only ever push a day the harmless way.
   */
  const windowDeviations = [...byDay.keys()]
    .filter((d) => d >= from && d <= to)
    .map(deviation)
    .filter((v): v is number => v !== null);

  /**
   * No baseline is not the same as no movement.
   *
   * `median([])` returns 0, so an empty list silently became "+0.0% from its same-weekday normal,
   * inside the band" — a confident measurement, produced by having measured nothing. It happens
   * whenever a window is early in the dataset: a Thursday in week two has exactly one prior Thursday,
   * below the two-observation floor, so every day in the window yields null. Caught on the synthetic
   * set at 2026-09-10, and it would hit any incident in the first fortnight of a fresh Day-2 slice.
   */
  if (windowDeviations.length === 0) {
    return {
      status: "not_applicable",
      detail:
        `No same-weekday history for ${from}..${to} — the window is too early in the loaded data to ` +
        `have ${MIN_BASELINE_DAYS} prior observations of the same weekday, so whether this has ` +
        `recovered cannot be established either way. This is missing evidence, not a normal reading.`,
      daysRunning: null,
    };
  }

  const incidentDeviation = median(windowDeviations);
  const dropped = incidentDeviation < 0;

  /**
   * If the window's own movement is inside the gate, recovery is not a question we can answer.
   *
   * This is the growth trend arriving from the other side. Investigating platform `revenue` over
   * 19-26 June gives a window that is mostly normal — one collapsed day among eight — so its median
   * deviation lands near zero and slightly positive. `dropped` then reads false, recovery demands a
   * day below +3%, and the dataset's real +6.4% trend keeps every later day a few percent ABOVE its
   * same-weekday median forever. It reported a healthy platform as "ongoing, 17 days" and ranked it
   * act_now at the top of the digest — the loudest possible false alarm, produced entirely by
   * arithmetic. Saying "cannot assess" is the honest answer, and it is also the accurate one: there is
   * no coherent movement in this window to recover from.
   */
  if (Math.abs(incidentDeviation) < RECOVERY_GATE_PCT) {
    return {
      status: "not_applicable",
      detail:
        `Over ${from}..${to} this series sits ${incidentDeviation >= 0 ? "+" : ""}` +
        `${incidentDeviation.toFixed(1)}% from its same-weekday normal, which is inside the ` +
        `${RECOVERY_GATE_PCT}% band — so there is no sustained movement here to call recovered or ` +
        `ongoing. Any finding in this window is confined to part of it.`,
      daysRunning: null,
    };
  }

  const backInBand = (day: string): boolean => {
    const dev = deviation(day);
    if (dev === null) return false;
    return dropped ? dev > -RECOVERY_GATE_PCT : dev < RECOVERY_GATE_PCT;
  };

  const after = [...byDay.keys()].filter((d) => d > to).sort();
  const firstRecovered = after.find(backInBand);

  if (firstRecovered) {
    // Duration runs from the window start to the day it actually came back — NOT the length of the
    // window someone happened to ask about. Investigating just 28 June of a three-day break must
    // still report three days and price three days, or `lostSoFarUsd` understates by two thirds.
    //
    // Only days actually outside the band count. The sweep's window for the Android 15 break is
    // 23-26 June, but the 26th is already back to normal, so counting the window verbatim billed
    // four days for a three-day incident and overstated the loss by $20.
    const affected = [...byDay.keys()]
      .filter((d) => d >= from && d < firstRecovered && !backInBand(d))
      .sort();
    const ran = affected.length;
    const lastBad = affected[affected.length - 1];
    const v = byDay.get(firstRecovered)!;
    const base = normalFor(firstRecovered)!;
    return {
      status: "recovered",
      detail:
        `Recovered on ${firstRecovered} — back to ${fmt(v)} against a same-weekday normal of ` +
        `${fmt(base)}. It ran for ${ran} day(s)` +
        // The span names the days that were actually out of band, not the window that was asked
        // about: "3 day(s), 23 to 26 June" is four dates and reads as an off-by-one error.
        (ran > 1 && lastBad
          ? `, ${affected[0]} to ${lastBad}`
          : ran === 1
            ? `, ${affected[0]}`
            : "") +
        `.`,
      daysRunning: ran,
    };
  }

  const incidentDays = [...byDay.keys()].filter((d) => d >= from && d <= to).length;

  const last = after[after.length - 1];
  if (last === undefined) {
    return {
      status: "ongoing",
      detail:
        `The incident window ends on ${to}, which is the last day in the data — so there is no ` +
        `evidence it has stopped. Treat it as live until fresher data says otherwise.`,
      daysRunning: incidentDays,
    };
  }

  const v = byDay.get(last)!;
  const base = normalFor(last);
  return {
    status: "ongoing",
    detail:
      `Still off on ${last}, the last day in the data: ${fmt(v)} against a same-weekday normal of ` +
      `${base === null ? "unknown" : fmt(base)}. It has not recovered.`,
    daysRunning: incidentDays + after.length,
  };
}

export async function recommendAction(
  ledger: Ledger,
  inv: Investigation,
): Promise<ActionRecommendation> {
  const segment = inv.findings.find((f) => f.segment)?.segment ?? null;
  const perDay = inv.findings.find((f) => f.revenueImpactUsd !== null)?.revenueImpactUsd ?? null;
  const { status, detail, daysRunning } = await resolveStatus(ledger, inv, segment);
  const { lines, nextQuestion } = whereToLook(inv.primaryChannel, segment, inv.request.metric);

  const lost =
    perDay !== null && daysRunning !== null ? Number((perDay * daysRunning).toFixed(2)) : null;

  // Priority from facts already established, not from a tuned threshold: whether it is still losing
  // money is the thing that separates "now" from "later", and a channel with no owner needs neither.
  let priority: Priority;
  let priorityBasis: string;
  if (
    inv.primaryChannel === "no_anomaly" ||
    inv.primaryChannel === "seasonality" ||
    inv.primaryChannel === "mix_shift"
  ) {
    priority = "none";
    priorityBasis = "Nothing is broken, so there is nothing to prioritise.";
  } else if (status === "ongoing") {
    priority = "act_now";
    priorityBasis =
      perDay !== null
        ? `Still losing ${fmtUsd(perDay)}/day as of the last day in the data.`
        : `Still outside its normal band as of the last day in the data.`;
  } else if (status === "recovered") {
    priority = "post_mortem";
    // Only call it a cost when the money actually went the wrong way. Stripping the sign for
    // readability turned a +$1.32/day segment into "it cost about $3.97", which is backwards.
    priorityBasis =
      lost === null
        ? `Already recovered — worth understanding so it does not recur, not worth paging anyone.`
        : lost < 0
          ? `Already recovered, so nothing is bleeding now — but it cost about ${fmtUsd(lost)} while it ran, and nothing here says it cannot happen again.`
          : `Already recovered, and revenue over the window was ${fmtUsd(lost)} ABOVE its baseline rather than below — so there is no loss to recover. Worth understanding, not worth paging anyone.`;
  } else {
    priority = "monitor";
    priorityBasis = "Recovery could not be established from this data.";
  }

  return {
    priority,
    priorityBasis,
    status,
    statusDetail: detail,
    owner: OWNER[inv.primaryChannel],
    moneyUsdPerDay: perDay,
    daysRunning,
    lostSoFarUsd: lost,
    recoverableUsdPerDay: status === "ongoing" ? perDay : 0,
    whereToLook: lines,
    // Nothing to chase when nothing is wrong. On a normal day these lines imply there was something
    // to investigate and we talked the reader out of it, which is a different (and false) claim.
    doNotChase: (priority === "none" ? [] : inv.ruledOut)
      .filter((r) => r.status === "cleared_as_contamination" && r.segment)
      .slice(0, 6)
      .map(
        (r) =>
          `${r.segment!.dimension} = '${r.segment!.value}' looks affected and is not — it only moved ` +
          `because the real cause sits inside it.`,
      ),
    nextQuestion,
    boundary:
      "This dataset is ad request events only — no deploy logs, bid logs, server telemetry, config " +
      "history or calendar. `whereToLook` says which stage of the funnel the evidence points at, not " +
      "which system is at fault, and no remediation beyond that can be supported from this data.",
  };
}

/** Money already spent or lost is stated as a positive amount — "cost -$61" reads as a refund. */
const fmtUsd = (n: number): string => `$${Math.abs(n).toFixed(2)}`;
const fmt = (n: number): string =>
  Math.abs(n) < 10 ? n.toFixed(4) : Math.round(n).toLocaleString("en-US");
