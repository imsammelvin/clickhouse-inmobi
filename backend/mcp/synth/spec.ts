/**
 * The synthetic dataset and its answer key — one declaration, used to BUILD the data and to SCORE the
 * result. That is the whole point of the file.
 *
 * Why this exists. Detection accuracy is currently validated against `KNOWN_INCIDENTS`, which we wrote
 * by reading the training data. That measures whether the engine agrees with our own homework; it
 * cannot measure whether it generalises, because we found those incidents with the same intuitions we
 * then encoded. The private answer key is a different dataset with deviations nobody here has seen.
 *
 * A synthetic dataset closes exactly that gap: the deviations are planted by us and are therefore
 * known EXACTLY — not inferred, not eyeballed — so "did the engine find what is there, and nothing
 * else" becomes a measurement instead of an argument. And because the ground truth lives in the same
 * object that generates the data, the two cannot drift apart.
 *
 * What it deliberately does NOT do: reuse the training data's shape. Different volumes, different
 * dimension values, a different cause on a different metric on different days. Same columns only —
 * anything else and we would be testing our memory of June 2026.
 */

/** Dimension vocabulary. Same columns as `ad_events_enriched`, deliberately different values. */
export const DIMS = {
  os_version: [
    "Android 11",
    "Android 14",
    "Android 16",
    "iOS 15.7",
    "iOS 18.4",
    "iOS 19.0",
    "HarmonyOS 4",
    "KaiOS 3",
  ],
  region: ["NORTH", "SOUTH", "CENTRAL", "ISLANDS", "OFFSHORE"],
  country: ["AA", "BB", "CC", "DD", "EE", "FF", "GG", "HH", "II", "JJ", "KK", "LL"],
  device_model: [
    "Nova 9",
    "Pulse X",
    "Rugged 3",
    "Slate Mini",
    "Tab Pro",
    "Vertex 5",
    "Zeal",
    "Orbit",
  ],
  ad_format: ["banner", "interstitial", "native", "rewarded", "video"],
  app_category: ["travel", "fitness", "banking", "grocery", "puzzle", "dating", "weather"],
  publisher_tier: ["tier_a", "tier_b", "tier_c"],
  advertiser_vertical: ["auto", "retail", "telco", "pharma", "gaming"],
  campaign_type: ["cpc", "cpm", "cpi"],
} as const;

export const SHAPE = {
  /** Fixed, so a rebuild produces byte-identical data. Change it to get a different world. */
  seed: 20260802,
  from: "2026-09-01",
  /**
   * Six weeks, not five. Ten planted deviations plus the pre-day-14 blind zone left almost no
   * unplanted days, and three "quiet day" assertions were silently sitting inside planted windows —
   * the harness marking its own collisions as engine false alarms. The extra week buys room for real
   * quiet days and a deeper baseline.
   */
  days: 42,
  /**
   * Before weekend, growth and planted effects are applied.
   *
   * Matched to the real dataset's ~257k/day on purpose, and this is not a detail. The first version
   * used 40k, and at that volume segment-level sampling noise manufactured a "cause" inside a
   * genuinely uniform collapse and inside a metric that had merely risen — so the harness reported two
   * fabrication defects that do not exist, and I passed them to the team. At 260k both cases come back
   * correct, and unattributed windows fall from 29-of-50 to 4-of-20.
   *
   * A test harness sized below production does not test production; it measures its own noise. Override
   * with `--events-per-day` to explore the sensitivity deliberately, never by accident.
   */
  baseEventsPerDay: 260_000,
  apps: 1_200,
  advertisers: 400,
  geoDevices: 3_000,
  /** Platform baselines, chosen to differ from the training data's 0.785 / 2.47 / 0.011. */
  baseFillRate: 0.62,
  baseRenderRate: 0.94,
  baseCtr: 0.02,
  baseEcpmUsd: 3.8,
  /** Weekends run lighter. A detector that flags this is crying wolf. */
  weekendVolumeFactor: 0.72,
  /** Real underlying growth, so "a few percent up" must not read as an incident. */
  weeklyGrowth: 0.011,
} as const;

/** Which metric a planted deviation is expected to surface on. */
export type PlantedMetric = "fill_rate" | "ecpm" | "ctr" | "requests" | "render_rate";

export interface Condition {
  dimension: keyof typeof DIMS;
  value: string;
}

export interface Planted {
  id: string;
  /** What we did to the data, in one line. */
  what: string;
  /** Inclusive day offsets from SHAPE.from. */
  fromDay: number;
  toDay: number;
  /**
   * The rows the effect applies to. `null` = every row (platform-wide).
   *
   * A LIST, not a single dimension, so an effect can live at the intersection of two — which is the
   * problem statement's own example ("Device X in Region North") and the shape a single-dimension
   * sweep cannot see. With two conditions the slice is the product of their shares, so it is small:
   * that makes it a test of the pair cuts and of the materiality floor at the same time.
   */
  conditions: Condition[] | null;
  metric: PlantedMetric;
  /** Multiplier applied to the underlying probability or value. */
  factor: number;
  /** What the engine SHOULD conclude. */
  expect: {
    /** Must the sweep surface a window overlapping these days? */
    detected: boolean;
    /** Expected cause channel, or null when we are not asserting one. */
    channel: string | null;
    /** Must `investigate` name a segment? false for platform-wide, uniform, or suppressed. */
    localizes: boolean;
    /**
     * Any of these names is an acceptable answer. For an intersection cause the engine may name the
     * pair cut or either half, and all three are defensible — the pair is tightest, a half is
     * incomplete but not wrong.
     */
    acceptable?: Condition[];
    /**
     * Several causes were planted in this window on the same metric. It is enough to name one; how
     * many of them appear is measured and reported rather than gated, because greedy deflation is
     * documented as assuming a single dominant cause per pass.
     */
    oneOf?: boolean;
    /** Runs to the last day of the dataset, so the action must read `ongoing`, not `recovered`. */
    ongoing?: boolean;
    /** Below the materiality floor: real in the data, and correctly not worth reporting. */
    suppressed?: boolean;
    /** Notes for a human reading a failure. */
    why: string;
  };
}

const day = (from: string, offset: number): string =>
  new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

/** Absolute date of a day offset, for reporting. */
export const dateOf = (offset: number): string => day(SHAPE.from, offset);

/**
 * The planted deviations.
 *
 * Each one exercises a different branch, and three of them are traps: a metric moving UP, a uniform
 * platform-wide move with no responsible segment, and pure weekend seasonality. A system that reports
 * those as localized incidents is doing the thing the rubric punishes hardest, and only a dataset
 * where we know the truth can prove it does not.
 */
export const PLANTED: Planted[] = [
  {
    id: "P1-fill-collapse-os",
    what: "fill rate on os_version='iOS 18.4' cut to 45% of normal for 3 days",
    fromDay: 15,
    toDay: 17,
    conditions: [{ dimension: "os_version", value: "iOS 18.4" }],
    metric: "fill_rate",
    factor: 0.45,
    expect: {
      detected: true,
      channel: "technical_break",
      localizes: true,
      why:
        "Requests and price are untouched and render rate is untouched, so demand and supply are both " +
        "present and only the match fails — the signature of a technical break, confined to one OS.",
    },
  },
  {
    id: "P2-ecpm-drop-category",
    what: "eCPM on app_category='banking' cut to 60% of normal for 4 days",
    fromDay: 23,
    toDay: 26,
    conditions: [{ dimension: "app_category", value: "banking" }],
    metric: "ecpm",
    factor: 0.6,
    expect: {
      detected: true,
      channel: null,
      localizes: true,
      why: "Price fell while volume and fill held. Channel not asserted — that is Lane A's open question.",
    },
  },
  {
    id: "P3-uniform-request-collapse",
    what: "platform-wide request volume cut to 55% for a single day",
    fromDay: 29,
    toDay: 29,
    conditions: null,
    metric: "requests",
    factor: 0.55,
    expect: {
      detected: true,
      channel: "not_localizable",
      localizes: false,
      why:
        "Every segment drops by the same proportion, so no segment is responsible. Naming one would be " +
        "a fabrication, and this is the case that catches a system which always returns a top segment.",
    },
  },
  {
    id: "P4-ctr-rise-region",
    what: "CTR on region='ISLANDS' raised to 165% of normal for 2 days",
    fromDay: 19,
    toDay: 20,
    conditions: [{ dimension: "region", value: "ISLANDS" }],
    metric: "ctr",
    factor: 1.65,
    expect: {
      detected: true,
      channel: null,
      localizes: false,
      why: "A rise, not a loss. It must not be escalated as an incident or presented as something to fix.",
    },
  },
  {
    id: "P5-render-break-format",
    what: "render rate on ad_format='rewarded' cut to 70% of normal for 2 days",
    fromDay: 21,
    toDay: 22,
    conditions: [{ dimension: "ad_format", value: "rewarded" }],
    metric: "render_rate",
    factor: 0.7,
    expect: {
      detected: true,
      channel: null,
      localizes: true,
      why:
        "Ads were bought and then failed to display — a funnel stage nothing in June 2026 breaks, so " +
        "this branch has never run on real data.",
    },
  },

  // ---- the branches this project's own notes say have never executed --------------------------

  {
    id: "P6a-two-causes-country",
    what: "fill rate on country='CC' cut to 50% for 2 days, SIMULTANEOUSLY with P6b",
    fromDay: 27,
    toDay: 28,
    conditions: [{ dimension: "country", value: "CC" }],
    metric: "fill_rate",
    factor: 0.5,
    expect: {
      detected: true,
      channel: null,
      localizes: true,
      oneOf: true,
      acceptable: [
        { dimension: "country", value: "CC" },
        { dimension: "device_model", value: "Nova 9" },
      ],
      why:
        "Two independent causes on the same metric in the same window, on dimensions that barely " +
        "overlap. The journal flags this as the part of residualization most likely to be wrong: " +
        "greedy deflation assumes ONE dominant cause per pass, and nothing in the training data has " +
        "two at once. Naming one is a pass; naming both is the real target.",
    },
  },
  {
    id: "P6b-two-causes-device",
    what: "fill rate on device_model='Nova 9' cut to 55% for 2 days, SIMULTANEOUSLY with P6a",
    fromDay: 27,
    toDay: 28,
    conditions: [{ dimension: "device_model", value: "Nova 9" }],
    metric: "fill_rate",
    factor: 0.55,
    expect: {
      detected: true,
      channel: null,
      localizes: true,
      oneOf: true,
      acceptable: [
        { dimension: "country", value: "CC" },
        { dimension: "device_model", value: "Nova 9" },
      ],
      why: "The other half of the co-occurring pair. See P6a.",
    },
  },
  {
    id: "P7-pair-only-cause",
    what: "eCPM cut to 50% only where country='DD' AND ad_format='video', for 2 days",
    fromDay: 30,
    toDay: 31,
    conditions: [
      { dimension: "country", value: "DD" },
      { dimension: "ad_format", value: "video" },
    ],
    metric: "ecpm",
    factor: 0.5,
    expect: {
      detected: true,
      channel: null,
      localizes: true,
      acceptable: [
        { dimension: "country", value: "DD" },
        { dimension: "ad_format", value: "video" },
      ],
      why:
        "The problem statement's own example shape — a break at the intersection of two attributes, " +
        "diluted in either one alone (DD moves a fifth as much, video a twelfth). This is what the " +
        "pairwise cuts exist for; a single-dimension sweep can only see a shadow of it.",
    },
  },
  {
    id: "P8-still-ongoing",
    what: "fill rate on publisher_tier='tier_a' cut to 60% from day 40 to the END of the data",
    fromDay: 40,
    toDay: 41,
    conditions: [{ dimension: "publisher_tier", value: "tier_a" }],
    metric: "fill_rate",
    factor: 0.6,
    expect: {
      detected: true,
      channel: null,
      localizes: true,
      ongoing: true,
      why:
        "Runs to the last day loaded, so there is no evidence it stopped. Every incident in the " +
        "training data recovers, so `act_now` has never fired on real data — and on the unseen slice a " +
        "live incident is the single most consequential thing to get right.",
    },
  },
  {
    id: "P9-immaterial-slice",
    what: "fill rate cut to 75% where country='LL' AND ad_format='rewarded' (1.7% of traffic), 1 day",
    fromDay: 18,
    toDay: 18,
    conditions: [
      { dimension: "country", value: "LL" },
      { dimension: "ad_format", value: "rewarded" },
    ],
    metric: "fill_rate",
    factor: 0.75,
    expect: {
      detected: true,
      channel: null,
      localizes: false,
      suppressed: true,
      why:
        "Real in the data and correctly not worth anyone's morning: 1.7% of traffic moving -25% is " +
        "0.42 platform points, under the 0.5 floor and the 5%-of-traffic floor. This is T-046's " +
        "materiality gate, shipped days ago and never tested on data it was not tuned against. " +
        "Reporting this as an incident is the false-alarm failure; ignoring a real one is the opposite.",
    },
  },
];

/**
 * Days that carry no planted deviation — nothing here may be reported as an incident.
 *
 * All chosen at day 14 or later, for the same reason the deviations are: see BLIND_ZONE_DAYS.
 */
export const CLEAN_DAYS: number[] = [14, 32, 35, 38];

/**
 * The first two weeks of any dataset are undetectable, and that is a property of the method rather
 * than a bug.
 *
 * Detection compares a day against the same weekday in preceding weeks and requires two such
 * observations (`MIN_BASELINE_DAYS`). Day 0 has none, day 7 has one, and only from day 14 does a
 * second exist. So nothing planted before day 14 can be found, by construction.
 *
 * This cost two false bug reports. P4 was planted on day 9 and P5 on day 4, both missed, and both
 * looked like detector failures — one of them looked like proof that a whole metric was unswept. The
 * dataset simply had no baseline there. Anything planted from here on sits at day 14 or later, and the
 * same caveat applies to the real Day-2 slice: incidents in its first fortnight are invisible, which is
 * worth saying out loud rather than discovering under time pressure.
 */
export const BLIND_ZONE_DAYS = 14;

/** Weekend day offsets, for the seasonality assertion. */
export function weekendOffsets(): number[] {
  const out: number[] = [];
  for (let i = 0; i < SHAPE.days; i++) {
    const d = new Date(Date.parse(`${SHAPE.from}T00:00:00Z`) + i * 86_400_000).getUTCDay();
    if (d === 0 || d === 6) out.push(i);
  }
  return out;
}

/**
 * A fingerprint of everything that determines what is in the data.
 *
 * Written into the synthetic database at build time and checked before scoring, because the harness
 * has twice now blamed the engine for a dataset that no longer matched this file. The second time,
 * `rca_synth` held a 35-day build while the spec had moved to 42: seven assertions failed, one of them
 * reporting a FABRICATED cause on a "clean" day that the older spec had genuinely planted a break on.
 * Every one of those was the scorer marking its own staleness as an engine defect.
 *
 * Checking the start date was not enough — that matched. Anything that changes the data has to be in
 * here, so a stale database is caught rather than scored.
 */
export function specFingerprint(): string {
  const shape = [
    SHAPE.seed,
    SHAPE.from,
    SHAPE.days,
    SHAPE.baseEventsPerDay,
    SHAPE.baseFillRate,
    SHAPE.baseRenderRate,
    SHAPE.baseCtr,
    SHAPE.baseEcpmUsd,
    SHAPE.weekendVolumeFactor,
    SHAPE.weeklyGrowth,
    SHAPE.apps,
    SHAPE.advertisers,
    SHAPE.geoDevices,
  ].join(":");
  const planted = PLANTED.map((p) =>
    [
      p.id,
      p.fromDay,
      p.toDay,
      p.metric,
      p.factor,
      (p.conditions ?? []).map((c) => `${c.dimension}=${c.value}`).join("+"),
    ].join(":"),
  ).join("|");
  return `${shape}||${planted}`;
}
