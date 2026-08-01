/**
 * The expected answers.
 *
 * This is our homework, not the answer key. The private key may contain planted anomalies we never
 * spotted, so a perfect score here is a floor on accuracy, never a claim about the real thing —
 * the same caveat `KNOWN_INCIDENTS` in backend/scan.ts carries, for the same reason.
 *
 * Two kinds of expectation, scored separately and on purpose:
 *
 *   GATED — things we are certain about. Localization (which segment), the reliability floors, the
 *   refusals, the grounding check, and the requirement that a normal weekend does NOT fire. A miss
 *   here is a real defect and fails the run.
 *
 *   REPORTED — the cause CHANNEL. The journal records channel assignment as the open question: the
 *   localization and the dollars have been right for a while and the channel has moved twice under
 *   window-contamination fixes. Encoding today's output as truth would turn this evaluator into a
 *   snapshot test that ratifies whatever the code currently does. So channel accuracy is measured
 *   and printed, and does not gate.
 *
 * Numbers marked `verified` were read out of a live tool call and cross-checked against
 * pitch/incident-dossier.md. Anything not verified is not asserted.
 */

/** A tolerance-checked numeric expectation. */
export interface Near {
  value: number;
  tolerance: number;
}

export interface ToolCase {
  kind: "tool";
  id: string;
  /** The user question this stands in for — the thing a judge would actually type. */
  question: string;
  tool: string;
  args: Record<string, unknown>;
  expect: {
    /** Dotted path into the result JSON, e.g. "rows.0.value". */
    path: string;
    near?: Near;
    equals?: unknown;
    /** Substring the value must contain, for text fields. */
    contains?: string;
  }[];
}

export interface RefusalCase {
  kind: "refusal";
  id: string;
  question: string;
  tool: string;
  args: Record<string, unknown>;
  /** The error must mention this, so the model can explain *why* rather than just failing. */
  errorContains: string;
}

/**
 * What the action block must say.
 *
 * Recovery dates and durations are GATED: they are facts about the series, verified by hand against
 * the daily numbers, and getting one wrong is how a recovered incident gets paged at 3am or a live one
 * gets filed for next week. `daysRunning` is checked separately from the window on purpose — asking
 * about one day of a three-day break must still report three days, or the money is understated.
 */
export interface ActionExpectation {
  status?: "ongoing" | "recovered" | "not_applicable";
  /** The day it came back. Gated — verified against the daily series. */
  recoveredOn?: string;
  /** How long it actually ran, which is NOT the length of the window asked about. */
  daysRunning?: number;
  priority?: "act_now" | "post_mortem" | "monitor" | "none";
  ownerContains?: string;
  /** A clean day has nothing to chase; listing cleared slices implies there was something to chase. */
  doNotChaseEmpty?: boolean;
  whereToLookContains?: string;
}

export interface InvestigationCase {
  kind: "investigation";
  id: string;
  question: string;
  args: Record<string, unknown>;
  action?: ActionExpectation;
  expect: {
    /** GATED: the segment that is actually responsible, or null for a platform-wide/no-cause verdict. */
    segment: { dimension: string; value: string } | null;
    /** Set when the case tests something else and localization is not the subject. */
    skipLocalization?: boolean;
    /** GATED: `true` when the correct answer is "nothing is wrong here". */
    noAnomaly?: boolean;
    /** GATED: the engine must not name a cause when the movement is uniform. */
    notLocalizable?: boolean;
    /** REPORTED, not gated — see the note above. */
    channel?: string;
    /** REPORTED: dollars per day, if we have a figure we trust. */
    revenueUsdPerDay?: Near;
  };
}

export type EvalCase = ToolCase | RefusalCase | InvestigationCase;

/**
 * The five training incidents (pitch/incident-dossier.md), plus the measurement and refusal cases
 * that cover the rest of the tool surface.
 */
export const CASES: EvalCase[] = [
  // --- investigations -------------------------------------------------------------------------
  {
    kind: "investigation",
    id: "A-android15-fill",
    question: "Why did fill rate drop between 23 and 25 June?",
    args: { metric: "fill_rate", from: "2026-06-23", to: "2026-06-25" },
    expect: {
      segment: { dimension: "os_version", value: "Android 15" },
      channel: "technical_break",
      revenueUsdPerDay: { value: -20.8, tolerance: 3 },
    },
    action: {
      status: "recovered",
      recoveredOn: "2026-06-26",
      daysRunning: 3,
      priority: "post_mortem",
      ownerContains: "Engineering",
      // Locates the break at the right funnel step for THIS metric, derived from mcp/domain.ts
      // rather than hardcoded per channel — a render-rate break used to get this same sentence.
      whereToLookContains: "from a request arriving to an ad being sold",
    },
  },
  {
    kind: "investigation",
    id: "B-uniform-collapse",
    question: "Revenue fell off a cliff on 21 June. Which segment caused it?",
    args: { metric: "requests", from: "2026-06-21", to: "2026-06-21" },
    expect: {
      // The whole point of this case: the movement is uniform across every dimension, so naming a
      // top segment would be a fabrication. -44% everywhere is not "Brazil's fault".
      segment: null,
      notLocalizable: true,
      channel: "not_localizable",
    },
    // A one-day collapse. The first version of the recovery check reported this as recovering on the
    // 27th, six days late, because it compared every following weekday against a *Sunday* baseline.
    action: {
      status: "recovered",
      recoveredOn: "2026-06-22",
      daysRunning: 1,
      ownerContains: "Platform",
    },
  },
  {
    kind: "investigation",
    id: "C-finance-ecpm",
    question: "eCPM looks soft over 19-22 June. What is going on?",
    args: { metric: "ecpm", from: "2026-06-19", to: "2026-06-22" },
    expect: {
      segment: { dimension: "app_category", value: "finance" },
      channel: "demand_change",
    },
    action: { status: "recovered", recoveredOn: "2026-06-23", daysRunning: 4 },
  },
  {
    kind: "investigation",
    id: "D-ios-fill-dip",
    question: "Anything wrong with fill rate at the end of June?",
    args: { metric: "fill_rate", from: "2026-06-28", to: "2026-06-30" },
    expect: {
      segment: { dimension: "os_version", value: "iOS 18.1" },
      channel: "technical_break",
    },
    action: { status: "recovered", recoveredOn: "2026-07-01", daysRunning: 3 },
  },
  {
    kind: "investigation",
    id: "E-weekend-decoy",
    question: "Revenue was down on Saturday 27 June — what broke?",
    args: { metric: "revenue", from: "2026-06-27", to: "2026-06-27" },
    expect: {
      // The planted seasonality decoy. A normal weekend must come back as no action. Answering
      // this one with a cause is the false-alarm failure the rubric punishes hardest, and the
      // question is deliberately phrased to presuppose a break.
      segment: null,
      noAnomaly: true,
      channel: "no_anomaly",
    },
    action: {
      status: "not_applicable",
      priority: "none",
      doNotChaseEmpty: true,
      ownerContains: "Nobody",
    },
  },

  {
    kind: "investigation",
    id: "D-duration-outlives-window",
    question: "Was there a fill rate problem on 28 June?",
    args: { metric: "fill_rate", from: "2026-06-28", to: "2026-06-28" },
    expect: {
      // Deliberately unchecked: a one-day slice of a three-day break localizes differently, and
      // localization is not what this case is testing.
      segment: null,
      skipLocalization: true,
    },
    // The point of the case. Asked about ONE day, the action must still report that the incident ran
    // three (28-30 June) and price three, because the money lost is a fact about the incident and not
    // about the question. The first version reported one day and understated the cost by two thirds.
    action: { status: "recovered", recoveredOn: "2026-07-01", daysRunning: 3 },
  },

  // --- measurement ----------------------------------------------------------------------------
  {
    kind: "tool",
    id: "M-android15-fill-level",
    question: "What was fill rate on Android 15 between 23 and 25 June?",
    tool: "get_metric",
    args: {
      metric: "fill_rate",
      from: "2026-06-23",
      to: "2026-06-25",
      filters: { os_version: "Android 15" },
    },
    // verified live: 0.4333098, 80,799 requests
    expect: [
      { path: "rows.0.value", near: { value: 0.4333, tolerance: 0.002 } },
      { path: "rows.0.reliable", equals: true },
    ],
  },
  {
    kind: "tool",
    id: "M-platform-fill-level",
    question: "What was platform fill rate over the same three days?",
    tool: "get_metric",
    args: { metric: "fill_rate", from: "2026-06-23", to: "2026-06-25" },
    // verified live via evidence c1/e1: 0.750802
    expect: [{ path: "rows.0.value", near: { value: 0.7508, tolerance: 0.002 } }],
  },
  {
    kind: "tool",
    id: "M-compare-finds-android15",
    question: "Which OS moved fill rate most over 23-25 June?",
    tool: "compare_periods",
    args: {
      metric: "fill_rate",
      from: "2026-06-23",
      to: "2026-06-25",
      group_by: ["os_version"],
      limit: 3,
    },
    // verified live: Android 15 ranked first at -35.17pp on 9.58% of traffic
    expect: [
      { path: "rows.0.group.os_version", equals: "Android 15" },
      { path: "rows.0.deltaPp", near: { value: -35.17, tolerance: 0.5 } },
      { path: "rows.0.sharePct", near: { value: 9.58, tolerance: 0.3 } },
    ],
  },
  {
    kind: "tool",
    id: "M-baseline-is-same-weekday",
    question: "Compare fill rate on Saturday 27 June with normal.",
    tool: "compare_periods",
    args: { metric: "fill_rate", from: "2026-06-27", to: "2026-06-27" },
    // The baseline for a Saturday must be other Saturdays, never the preceding weekdays. If this
    // ever picks up a flat trailing mean, every weekend becomes an incident.
    expect: [
      { path: "baselineDescription", contains: "same weekday" },
      { path: "baselineDates.0", equals: "2026-06-06" },
    ],
  },
  {
    kind: "tool",
    id: "M-incidents-found-unprompted",
    question: "Did anything break in the second half of June?",
    tool: "find_incidents",
    args: { metrics: ["fill_rate", "ecpm"], from: "2026-06-15", to: "2026-06-30", limit: 20 },
    // Nobody hands you a metric and a window on the unseen dataset. At minimum the sweep must
    // surface something in a fortnight that contains three known incidents.
    expect: [{ path: "windowCount", near: { value: 6, tolerance: 6 } }],
  },
  {
    kind: "tool",
    id: "M-revenue-identity-splits",
    question: "Was the 23-25 June revenue dip a volume problem or a price problem?",
    tool: "explain_revenue",
    args: { from: "2026-06-23", to: "2026-06-25" },
    expect: [
      // Fill rate, not requests and not eCPM: traffic was up and price held.
      { path: "driver", equals: "fill_rate" },
    ],
  },

  // --- refusals -------------------------------------------------------------------------------
  {
    kind: "refusal",
    id: "R-fill-by-advertiser",
    question: "Break fill rate down by advertiser vertical for 23-25 June.",
    tool: "get_metric",
    args: {
      metric: "fill_rate",
      from: "2026-06-23",
      to: "2026-06-25",
      group_by: ["advertiser_vertical"],
    },
    errorContains: "only populated on filled events",
  },
  {
    kind: "refusal",
    id: "R-geo-device-entity",
    question: "Which geo_device_id has the worst fill rate?",
    tool: "rank_segments",
    args: { metric: "fill_rate", dimension: "geo_device_id", from: "2026-06-23", to: "2026-06-25" },
    errorContains: "surrogate join key",
  },
  {
    kind: "refusal",
    id: "R-window-outside-data",
    question: "How did we do in December?",
    tool: "get_metric",
    args: { metric: "revenue", from: "2026-12-01", to: "2026-12-07" },
    errorContains: "outside the loaded data",
  },
  {
    kind: "refusal",
    id: "R-unknown-metric",
    question: "What was our conversion rate last week?",
    tool: "get_metric",
    args: { metric: "conversion_rate", from: "2026-06-23", to: "2026-06-25" },
    errorContains: "Unknown metric",
  },
];
