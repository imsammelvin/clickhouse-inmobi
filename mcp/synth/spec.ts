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
  os_version: ["Android 11", "Android 14", "Android 16", "iOS 15.7", "iOS 18.4", "iOS 19.0", "HarmonyOS 4", "KaiOS 3"],
  region: ["NORTH", "SOUTH", "CENTRAL", "ISLANDS", "OFFSHORE"],
  country: ["AA", "BB", "CC", "DD", "EE", "FF", "GG", "HH", "II", "JJ", "KK", "LL"],
  device_model: ["Nova 9", "Pulse X", "Rugged 3", "Slate Mini", "Tab Pro", "Vertex 5", "Zeal", "Orbit"],
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
  days: 35,
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

export interface Planted {
  id: string;
  /** What we did to the data, in one line. */
  what: string;
  /** Inclusive day offsets from SHAPE.from. */
  fromDay: number;
  toDay: number;
  /** null = platform-wide, applied to every row on those days. */
  segment: { dimension: keyof typeof DIMS; value: string } | null;
  metric: PlantedMetric;
  /** Multiplier applied to the underlying probability or value. */
  factor: number;
  /** What the engine SHOULD conclude. */
  expect: {
    /** Must the sweep surface a window overlapping these days? */
    detected: boolean;
    /** Expected cause channel, or null when we are not asserting one. */
    channel: string | null;
    /** Must `investigate` name this exact segment? false for platform-wide/uniform. */
    localizes: boolean;
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
    segment: { dimension: "os_version", value: "iOS 18.4" },
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
    segment: { dimension: "app_category", value: "banking" },
    metric: "ecpm",
    factor: 0.6,
    expect: {
      detected: true,
      channel: null,
      localizes: true,
      why:
        "Price fell while volume and fill held. Channel is not asserted: the training data shows this " +
        "shape landing on demand_change, and that assignment is Lane A's open question (T-046 family).",
    },
  },
  {
    id: "P3-uniform-request-collapse",
    what: "platform-wide request volume cut to 55% for a single day",
    fromDay: 29,
    toDay: 29,
    segment: null,
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
    segment: { dimension: "region", value: "ISLANDS" },
    metric: "ctr",
    factor: 1.65,
    expect: {
      detected: true,
      channel: null,
      // A trap. The move is real and the sweep should see it, but a metric going UP is not an
      // incident to escalate, and the digest must rank it below every genuine loss.
      localizes: false,
      why:
        "A rise, not a loss. It may appear in the sweep, but it must not be escalated as an incident " +
        "or presented as something to fix.",
    },
  },
  {
    id: "P5-render-break-format",
    what: "render rate on ad_format='rewarded' cut to 70% of normal for 2 days",
    fromDay: 32,
    toDay: 33,
    segment: { dimension: "ad_format", value: "rewarded" },
    metric: "render_rate",
    factor: 0.7,
    expect: {
      detected: true,
      channel: null,
      localizes: true,
      why:
        "Ads were bought and then failed to display. Tests a funnel stage the training data never " +
        "exercises — nothing in June 2026 breaks render rate, so this branch has never run on real data.",
    },
  },
];

/**
 * Days that carry no planted deviation — nothing here may be reported as an incident.
 *
 * All chosen at day 14 or later, for the same reason the deviations are: see BLIND_ZONE_DAYS.
 */
export const CLEAN_DAYS: number[] = [14, 21, 28, 34];

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
