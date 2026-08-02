/**
 * The rollup contract: what is pre-aggregated, and how a query is rewritten to read it.
 *
 * WHY THIS EXISTS (T-013, goal.md § 3 / D-019). Every stage of every investigation re-scans the
 * same raw days. Measured on one full `diagnose` run: **344M rows read, 4.1 GiB, 59s server time
 * across 55 queries** against a 9M-row fact table — ~38x the table per run. That is not a query
 * problem, it is a grain problem: the work is `(time x dimension x value) -> five sums`, and we were
 * recomputing it from events every time.
 *
 * WHY LONG FORMAT, and not the grain goal.md § 7 proposed. The plan called for a rollup at
 * `(hour, app_id, geo_device_id, advertiser_id, ad_format)`. Measured before building it: that key
 * space is so much larger than the event count that **it compresses nothing** — 9M events land on
 * ~9M distinct keys, so the "rollup" would be the fact table with extra steps. The access pattern is
 * never "one app x one geo x one advertiser"; it is "one dimension at a time, sometimes two". So we
 * materialise exactly that shape — one row per `(bucket, dim, val)` — which is how the same window
 * costs **148k daily / 3.09M hourly rows** instead of 9M, and grows with *cardinality x time*
 * rather than with events. That is the property that holds at 9M events or 9T.
 *
 * WHAT IS MATERIALISED
 *   - 9 low-cardinality dimensions, singly.
 *   - 2 entity dimensions (`app_id` 2,000 values, `advertiser_id` 501), singly.
 *   - All 36 pairs of the 9 low-cardinality dimensions — so any two-dimension question is one
 *     lookup, not a fact-table scan.
 *   - Entity dimensions are deliberately NOT paired. Measured: `app_id x os_version` alone is
 *     529k daily / 3.2M hourly rows, more than every other pair combined, to answer questions
 *     nobody asks. Those fall back to the raw view.
 *
 * WHAT IS NOT, and this is the load-bearing part: **a query the rollup cannot answer EXACTLY falls
 * back to `ad_events_enriched` rather than being approximated.** Three or more dimensions at once,
 * `geo_device_id`, a metric referencing a column we do not carry — all fall back. There is no path
 * in this module that returns a number the raw scan would disagree with; `scripts/verify-rollup.ts`
 * asserts that claim over every metric x dimension x grain.
 *
 * Owner: samarth (Lane B). The registry below is the single source of truth for BOTH the DDL and the
 * planner on purpose — a rollup whose planner thinks a cut exists when the DDL never built it is how
 * you serve a confidently wrong number.
 */
import { MaterializedView, Table } from "../../shared/enums";
import { counter, withSpan, withSyncSpan } from "../../shared/utils/telemetryUtils";

/**
 * How often each source served a query, labelled by the reason when it was the raw view.
 *
 * A metric rather than only a span attribute because the number worth watching is a *rate* -- "what
 * fraction of queries fell back, and why" -- and answering that from spans means scanning traces.
 */
const planDecisions = counter(
  "rollup.plan.decisions",
  "Rollup planner outcomes, by source and fallback reason.",
);

// ---------------------------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------------------------

/**
 * Dimension order, and why it is this order rather than alphabetical.
 *
 * A pair is stored under one canonical key (`region|os_version`, never `os_version|region`) with
 * values concatenated in the same order, because that string IS the dimension name everywhere
 * downstream — `segmentPredicate` in backend/types.ts splits it back apart. This order is chosen so
 * that every pair in backend/metrics.ts `DIMENSION_PAIRS` is already canonical under it, which is
 * what lets the rollup-backed sweep emit firings byte-identical to the raw one. `assertPairOrder`
 * below fails loudly if a future pair breaks that.
 */
const DIM_ORDER = [
  "app_category",
  "country",
  "publisher_tier",
  "region",
  "ad_format",
  "device_model",
  "os_version",
  "advertiser_vertical",
  "campaign_type",
] as const;

/** Pairable dimensions: cardinality <= 16, so all 36 pairs together are ~78k daily rows. */
export const ROLLUP_SMALL_DIMS: readonly string[] = DIM_ORDER;

/**
 * Entity dimensions. Carried singly because the answer key can name a publisher app, but never
 * paired — see the header for the measured cost.
 */
export const ROLLUP_ENTITY_DIMS = ["app_id", "advertiser_id"] as const;

/** Every dimension the rollup carries on its own. */
export const ROLLUP_SINGLE_DIMS: readonly string[] = [...DIM_ORDER, ...ROLLUP_ENTITY_DIMS];

/** All pairs of the small dimensions, in canonical order. */
export const ROLLUP_PAIRS: readonly (readonly [string, string])[] = DIM_ORDER.flatMap((a, i) =>
  DIM_ORDER.slice(i + 1).map((b) => [a, b] as const),
);

/** Every value the `dim` column can take — 11 singles + 36 pairs. */
export const ROLLUP_DIM_KEYS: readonly string[] = [
  ...ROLLUP_SINGLE_DIMS,
  ...ROLLUP_PAIRS.map(([a, b]) => `${a}|${b}`),
];

const DIM_KEY_SET = new Set(ROLLUP_DIM_KEYS);
const ORDER_INDEX = new Map(DIM_ORDER.map((d, i) => [d as string, i]));

/**
 * Canonical `dim` key for a set of dimensions, or null if the rollup does not carry that cut.
 *
 * Exported because the sweep needs to ask the same question the planner asks.
 */
export function rollupDimKey(dims: readonly string[]): string | null {
  const unique = [...new Set(dims)];
  if (unique.length === 1) return DIM_KEY_SET.has(unique[0]!) ? unique[0]! : null;
  if (unique.length !== 2) return null;
  const [a, b] = unique;
  const ia = ORDER_INDEX.get(a!);
  const ib = ORDER_INDEX.get(b!);
  if (ia === undefined || ib === undefined) return null;
  const key = ia < ib ? `${a}|${b}` : `${b}|${a}`;
  return DIM_KEY_SET.has(key) ? key : null;
}

/**
 * Guard for Lane A's pair list: every pair it sweeps must be canonical under DIM_ORDER.
 *
 * Called by the sweep and by verify-rollup. If Lane A adds `["os_version", "region"]` in that order,
 * the rollup would key it as `region|os_version` and the two sweeps would disagree about the name of
 * a dimension — findable now, at startup, instead of as a mismatched segment in a diagnosis.
 */
export function assertPairOrder(pairs: readonly (readonly [string, string])[]): void {
  for (const [a, b] of pairs) {
    const ia = ORDER_INDEX.get(a);
    const ib = ORDER_INDEX.get(b);
    if (ia === undefined || ib === undefined) {
      throw new Error(
        `Pair (${a}, ${b}) uses a dimension the rollup does not pair. Pairable: ` +
          `${ROLLUP_SMALL_DIMS.join(", ")}. Add it to DIM_ORDER in clickhouse/rollup.ts and rebuild.`,
      );
    }
    if (ia > ib) {
      throw new Error(
        `Pair (${a}, ${b}) is not in canonical order — the rollup stores it as '${b}|${a}'. ` +
          `Swap it in backend/metrics.ts DIMENSION_PAIRS, or reorder DIM_ORDER in clickhouse/rollup.ts.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// physical layout
// ---------------------------------------------------------------------------------------------

export type Grain = "hourly" | "daily";

export const ROLLUP_TABLES: Record<Grain, string> = {
  hourly: Table.RollupHourly,
  daily: Table.RollupDaily,
};

export const ROLLUP_VIEWS: Record<Grain, string> = {
  hourly: MaterializedView.RollupHourly,
  daily: MaterializedView.RollupDaily,
};

/**
 * The five measures. Sums only, never a stored ratio — goal.md § 7 is explicit, and it is not a
 * style rule: `avg(fill_rate)` over rolled-up rows is a different number from `sum(fills)/sum(reqs)`,
 * so a stored ratio silently stops being correct the moment anything aggregates it further.
 */
export const ROLLUP_MEASURES = ["events", "fills", "impressions", "clicks", "revenue"] as const;
const MEASURE_SET = new Set<string>(ROLLUP_MEASURES);

/** Fact-table column -> rollup measure. `count()` is handled separately, being a function. */
const COLUMN_MAP: Record<string, string> = {
  is_filled: "fills",
  is_impression: "impressions",
  is_click: "clicks",
  revenue: "revenue",
};

// ---------------------------------------------------------------------------------------------
// expression translation
// ---------------------------------------------------------------------------------------------

/**
 * Rewrite an aggregate expression written against `ad_events_enriched` to read the rollup.
 *
 * The whole point is that `backend/metrics.ts` stays the ONE definition of every metric. A second
 * copy of the formulas for the rollup path would be the obvious way to do this and the wrong one:
 * two definitions drift, and the drift shows up as a diagnosis whose narrative disagrees with its
 * own evidence. So the formulas are translated mechanically, and anything not translatable throws.
 *
 *   count()                -> sum(events)
 *   countIf(c)             -> sumIf(events, c)
 *   sum(is_filled)         -> sum(fills)
 *   sumIf(is_impression,c) -> sumIf(impressions, c)
 *   sum(revenue)           -> sum(revenue)
 */
export function toRollupExpr(expr: string): string {
  let out = expr
    .replace(/\bcountIf\s*\(/g, "sumIf(events, ")
    .replace(/\bcount\s*\(\s*\)/g, "sum(events)");

  for (const [factColumn, measure] of Object.entries(COLUMN_MAP)) {
    if (factColumn === measure) continue;
    out = out.replace(new RegExp(`\\b${factColumn}\\b`, "g"), measure);
  }

  assertRollupSafe(out, expr);
  return out;
}

/**
 * Refuse to translate an expression that touches anything the rollup does not carry.
 *
 * R-005 says the unseen incident may land on a metric we did not build for, and the defence is that
 * adding one to `METRICS` is a config change. That defence breaks if a new metric silently reads a
 * column the rollup never summed — `sum(is_viewable)` would return 0, not an error, and 0 is a
 * number a narrative will happily print. So: identifiers that are not function calls must be one of
 * the five measures, or this throws and the caller falls back to the raw scan.
 */
function assertRollupSafe(translated: string, original: string): void {
  // Identifiers not immediately followed by `(` are column references; the rest are functions.
  const identifiers = translated.match(/\b[A-Za-z_][A-Za-z0-9_]*\b(?!\s*\()/g) ?? [];
  for (const id of identifiers) {
    if (!MEASURE_SET.has(id)) {
      throw new RollupUnsupported(
        `Expression \`${original}\` references \`${id}\`, which the rollup does not carry ` +
          `(it has ${ROLLUP_MEASURES.join(", ")}). Query the raw view for this metric, or add the ` +
          `column to the rollup in clickhouse/rollup.ts and rebuild it.`,
      );
    }
  }
}

/** Thrown when the rollup cannot serve something exactly. Callers fall back; they never approximate. */
export class RollupUnsupported extends Error {}

// ---------------------------------------------------------------------------------------------
// the readiness gate
// ---------------------------------------------------------------------------------------------

/**
 * Whether the rollup may be read at all. `null` = not yet checked, and the planner treats that as no.
 *
 * This flag is the reason the change is safe to ship. Every failure mode of a derived table is the
 * same failure mode -- it is BEHIND the source -- and a rollup that is behind does not error, it
 * returns fewer rows. A missing day reads as a day with no traffic; a half-backfilled table reads as
 * a quiet week. Both are numbers a narrative will print.
 *
 * So nothing reads the rollup until it has been proven to account for exactly as many events as
 * `ad_events` holds. If it cannot, every plan returns null, every query goes to the raw view, and
 * the system behaves precisely as it did before this file existed -- slower, and correct.
 */
let ready: boolean | null = null;

export interface RollupHealth {
  ready: boolean;
  factEvents: number;
  rollupEvents: number;
  dailyRows: number;
  hourlyRows: number;
  reason?: string;
}

let lastHealth: RollupHealth | null = null;

/**
 * Check the rollup against the fact table once per process, and remember the answer.
 *
 * Takes a `run` callback rather than a client, the same way `ensureDatasetBounds` does, so this
 * module keeps no dependency on the ledger and cannot create an import cycle with it.
 *
 * Cost: one query reading ~175 rollup rows plus a MergeTree row count, which is metadata. Cheap
 * enough that paying it at every entry point is better than the alternative of trusting the table.
 */
export async function ensureRollupReady(
  run: <T>(sql: string) => Promise<T[]>,
): Promise<RollupHealth> {
  // The cached answer is a field read, not work -- spanning it would put a span on every entry
  // point that says nothing. Only the once-per-process check that actually queries gets one.
  if (lastHealth) return lastHealth;

  return withSpan("rollup.ready", {}, async (span) => {
    const health = await checkRollupReady(run);
    span.setAttribute("app.rollup.ready", health.ready);
    span.setAttribute("app.rollup.fact_events", health.factEvents);
    span.setAttribute("app.rollup.rollup_events", health.rollupEvents);
    span.setAttribute("app.rollup.daily_rows", health.dailyRows);
    span.setAttribute("app.rollup.hourly_rows", health.hourlyRows);
    // Not a span error: an unbuilt rollup is a correct, expected state that falls back to raw.
    // Recording the reason is what makes "why is everything suddenly slow" answerable.
    if (health.reason) span.setAttribute("app.rollup.reason", health.reason);
    return health;
  });
}

/** The check itself. Sets `ready`/`lastHealth` and never throws -- see the catch at the bottom. */
async function checkRollupReady(run: <T>(sql: string) => Promise<T[]>): Promise<RollupHealth> {
  try {
    // EVERY dim key must account for the whole fact table, not just one of them.
    //
    // This checked `dim = 'ad_format'` alone. Each key is an independent slice of the same events, so
    // one of them summing correctly says nothing about the others when they were not written
    // together — and they are not: `bun run ch:rollup` backfills a day at a time, so an interrupted
    // backfill, or a fan-out that gained a dimension after some days were already built, leaves one
    // key short while `ad_format` still ties out. The planner would then serve that key happily and
    // return a number that is low by whatever is missing. Silent, and it reads as a quiet segment.
    //
    // min/max over the per-key totals catches any key that disagrees, and the key COUNT catches one
    // that is absent entirely — which a sum over present keys cannot see. Cost is a grouped scan of
    // ~150k daily rows, which is metadata next to the queries it guards.
    //
    // BOTH grains get the per-key treatment, not just daily (samarth, following sam's fix). The
    // hourly table was still being spot-checked on `dim = 'ad_format'` alone, which is the very
    // argument sam's commit makes, one table over: hourly-grain reads go straight to
    // `rollup_segment_hourly`, so a key short THERE is served just as silently. Daily tying out is
    // strong evidence but not proof — daily is derived from hourly by the cascaded MV, so anything
    // written through that path moves both together, but `backfillDailySql` exists as a repair route
    // that writes daily alone, and a rollup is exactly the kind of thing someone repairs at 3am.
    // Two tables, two independent checks.
    const [row] = await run<Record<string, unknown>>(
      `WITH daily_key AS (
         SELECT dim, sum(events) AS total FROM ${ROLLUP_TABLES.daily} GROUP BY dim
       ),
       hourly_key AS (
         SELECT dim, sum(events) AS total FROM ${ROLLUP_TABLES.hourly} GROUP BY dim
       )
       SELECT (SELECT count() FROM ad_events)                     AS fact_events,
              (SELECT count() FROM daily_key)                     AS key_count,
              (SELECT min(total) FROM daily_key)                  AS min_key_events,
              (SELECT max(total) FROM daily_key)                  AS max_key_events,
              (SELECT count() FROM hourly_key)                    AS hourly_key_count,
              (SELECT min(total) FROM hourly_key)                 AS min_hourly_events,
              (SELECT max(total) FROM hourly_key)                 AS max_hourly_events,
              (SELECT count() FROM ${ROLLUP_TABLES.daily})        AS daily_rows,
              (SELECT count() FROM ${ROLLUP_TABLES.hourly})       AS hourly_rows`,
    );

    const factEvents = Number(row?.fact_events ?? 0);
    const keyCount = Number(row?.key_count ?? 0);
    const minKeyEvents = Number(row?.min_key_events ?? 0);
    const maxKeyEvents = Number(row?.max_key_events ?? 0);
    const hourlyKeyCount = Number(row?.hourly_key_count ?? 0);
    const minHourlyEvents = Number(row?.min_hourly_events ?? 0);
    const maxHourlyEvents = Number(row?.max_hourly_events ?? 0);
    const expectedKeys = ROLLUP_DIM_KEYS.length;

    const health: RollupHealth = {
      ready:
        factEvents > 0 &&
        keyCount === expectedKeys &&
        minKeyEvents === factEvents &&
        maxKeyEvents === factEvents &&
        hourlyKeyCount === expectedKeys &&
        minHourlyEvents === factEvents &&
        maxHourlyEvents === factEvents,
      factEvents,
      rollupEvents: minKeyEvents,
      dailyRows: Number(row?.daily_rows ?? 0),
      hourlyRows: Number(row?.hourly_rows ?? 0),
    };
    if (!health.ready) {
      health.reason =
        minKeyEvents === 0 && maxKeyEvents === 0
          ? `rollup is empty (fact table has ${factEvents} events) — run: bun run ch:rollup`
          : keyCount !== expectedKeys
            ? `rollup has ${keyCount} dimension key(s), expected ${expectedKeys} — a cut is missing ` +
              `entirely. Re-run: bun run ch:rollup`
            : minKeyEvents !== maxKeyEvents
              ? `rollup dimension keys disagree: one accounts for ${minKeyEvents} events, another for ` +
                `${maxKeyEvents}, fact table has ${factEvents} — a partial backfill. ` +
                `Re-run: bun run ch:rollup`
              : hourlyKeyCount !== expectedKeys
                ? `hourly rollup has ${hourlyKeyCount} dimension key(s), expected ${expectedKeys} — ` +
                  `a cut is missing entirely. Re-run: bun run ch:rollup`
                : minHourlyEvents !== maxHourlyEvents
                  ? `hourly rollup dimension keys disagree: one accounts for ${minHourlyEvents} ` +
                    `events, another for ${maxHourlyEvents}, fact table has ${factEvents} — a partial ` +
                    `backfill. Re-run: bun run ch:rollup`
                  : minHourlyEvents !== factEvents
                    ? `hourly rollup accounts for ${minHourlyEvents} events, fact table has ` +
                      `${factEvents} — re-run: bun run ch:rollup`
                    : `rollup accounts for ${minKeyEvents} events, fact table has ${factEvents} — ` +
                      `re-run: bun run ch:rollup`;
    }
    ready = health.ready;
    lastHealth = health;
    return health;
  } catch (error) {
    // A missing table is the expected shape of "schema not applied yet", and it must degrade to the
    // raw path rather than taking the process down.
    ready = false;
    lastHealth = {
      ready: false,
      factEvents: 0,
      rollupEvents: 0,
      dailyRows: 0,
      hourlyRows: 0,
      reason: `rollup unavailable (${(error as Error).message.split("\n")[0]}) — run: bun run ch:schema && bun run ch:rollup`,
    };
    return lastHealth;
  }
}

/** Last health result, for the trace and for the startup banner. */
export const rollupHealth = (): RollupHealth | null => lastHealth;

/** Test hook: forget the readiness check so the next call re-runs it. */
export function resetRollupReady(): void {
  ready = null;
  lastHealth = null;
}

/**
 * Force the rollup path off for this process.
 *
 * `bun run bench` needs it: the point of that harness is to measure raw-scan cost against
 * rollup-served cost, which means it has to be able to ask for the old path deliberately.
 */
export function disableRollup(reason: string): void {
  ready = false;
  lastHealth = {
    ready: false,
    factEvents: 0,
    rollupEvents: 0,
    dailyRows: 0,
    hourlyRows: 0,
    reason,
  };
}

// ---------------------------------------------------------------------------------------------
// the planner
// ---------------------------------------------------------------------------------------------

export interface RollupPlan {
  grain: Grain;
  table: string;
  /** The `dim` value this plan reads, e.g. `os_version` or `region|os_version`. */
  dimKey: string;
  /**
   * Drop-in replacement for the string `ad_events_enriched` in a FROM clause.
   *
   * It projects the dimension columns back under their real names, so the surrounding query — its
   * WHERE, GROUP BY, ORDER BY, window functions — is textually unchanged. That is deliberate: the
   * smallest possible diff at each call site is also the smallest possible surface for a mistake.
   */
  from: string;
  /** Rewrites a fact-table aggregate for this plan. */
  expr: (expression: string) => string;
}

export interface PlanRequest {
  /** Every dimension the query mentions — group_by AND filters. Both cost a cut. */
  dims: readonly string[];
  /** `hourly` only when the answer is per-hour; daily is 20x smaller and answers everything else. */
  grain: Grain;
  /** Metric expressions that must translate. Passing them here makes the check part of planning. */
  expressions?: readonly string[];
}

/**
 * Decide whether the rollup can serve this query, and how.
 *
 * Returns null — meaning "use the raw view" — rather than throwing, because falling back is a
 * normal, correct outcome, not an error. The only thing that would be an error is answering.
 */
export function planRollup(request: PlanRequest): RollupPlan | null {
  return withSyncSpan(
    "rollup.plan",
    {
      "app.rollup.requested_grain": request.grain,
      "app.rollup.dims": [...new Set(request.dims)].join(","),
      "app.rollup.dim_count": new Set(request.dims).size,
    },
    (span) => {
      const plan = decidePlan(request, (source, reason) => {
        span.setAttribute("app.rollup.source", source);
        if (reason) span.setAttribute("app.rollup.fallback_reason", reason);
        planDecisions().add(1, {
          source,
          ...(reason ? { reason } : {}),
          grain: request.grain,
        });
      });
      if (plan) {
        span.setAttribute("app.rollup.table", plan.table);
        span.setAttribute("app.rollup.dim_key", plan.dimKey);
      }
      return plan;
    },
  );
}

/**
 * The planner proper. Split out from `planRollup` so the span wrapper stays readable and so each
 * `return null` can say *why* it declined -- "fell back" with no reason is the one thing that makes
 * this decision hard to debug from a trace, because every fallback looks identical from outside.
 */
function decidePlan(
  request: PlanRequest,
  record: (source: string, reason?: string) => void,
): RollupPlan | null {
  // Unchecked or behind the fact table: use the raw view. See `ensureRollupReady`.
  if (ready !== true) {
    record(RAW_SOURCE.label, ready === null ? "not_checked" : "rollup_not_ready");
    return null;
  }

  const dims = [...new Set(request.dims)];

  // A dimensionless question (platform total, daily series, dataset overview) still needs a row
  // source. Any single dimension's rows sum to the platform, so pick the cheapest: 5 values.
  const carrier = dims.length === 0 ? ["ad_format"] : dims;
  const dimKey = rollupDimKey(carrier);
  if (!dimKey) {
    record(RAW_SOURCE.label, "no_such_cut");
    return null;
  }

  // Fail the plan, not the query, if a metric formula cannot be translated.
  try {
    for (const expression of request.expressions ?? []) toRollupExpr(expression);
  } catch (error) {
    if (error instanceof RollupUnsupported) {
      record(RAW_SOURCE.label, "untranslatable_metric");
      return null;
    }
    throw error;
  }

  record("rollup");

  const grain = request.grain;
  const table = ROLLUP_TABLES[grain];
  const parts = dimKey.split("|");

  const projected =
    dims.length === 0
      ? []
      : parts.length === 1
        ? [`val AS ${parts[0]}`]
        : parts.map((d, i) => `splitByChar('|', val)[${i + 1}] AS ${d}`);

  const columns = [
    "event_date",
    ...(grain === "hourly" ? ["event_hour"] : []),
    ...projected,
    ...ROLLUP_MEASURES,
  ];

  const from = `(
  -- ${table}: one row per (bucket, dim, val), maintained by ${ROLLUP_VIEWS[grain]} on insert.
  -- Reading dim='${dimKey}' instead of scanning ad_events is what makes this query's cost
  -- independent of event volume (T-013). Ratios stay sum/sum over these sums, never stored.
  SELECT ${columns.join(",\n         ")}
  FROM ${table}
  WHERE dim = '${dimKey}'
)`;

  return { grain, table, dimKey, from, expr: toRollupExpr };
}

/**
 * Identity plan for the raw path, so call sites read the same on both branches.
 *
 * `expr` is the identity function: expressions from `backend/metrics.ts` are already written against
 * `ad_events_enriched`.
 */
export const RAW_SOURCE = {
  from: "ad_events_enriched",
  expr: (expression: string): string => expression,
  label: "raw",
} as const;

/** What actually served a query, for the trace and the cost report. */
export const sourceLabel = (plan: RollupPlan | null): string =>
  plan ? `rollup:${plan.grain}:${plan.dimKey}` : RAW_SOURCE.label;

// ---------------------------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------------------------

/** Dimension value expressions against the RAW fact table — the MV cannot read the enriched view. */
const DIM_SOURCE_SQL: Record<string, string> = {
  ad_format: "toString(ad_format)",
  app_id: "toString(app_id)",
  advertiser_id: "toString(advertiser_id)",
  app_category: "dictGet('dict_apps', 'category', tuple(app_id))",
  publisher_tier: "dictGet('dict_apps', 'publisher_tier', tuple(app_id))",
  advertiser_vertical: "dictGet('dict_advertisers', 'vertical', tuple(advertiser_id))",
  campaign_type: "dictGet('dict_advertisers', 'campaign_type', tuple(advertiser_id))",
  region: "dictGet('dict_geo_device', 'region', tuple(geo_device_id))",
  country: "dictGet('dict_geo_device', 'country', tuple(geo_device_id))",
  device_model: "dictGet('dict_geo_device', 'device_model', tuple(geo_device_id))",
  os_version: "dictGet('dict_geo_device', 'os_version', tuple(geo_device_id))",
};

/**
 * The fan-out: one array element per materialised cut, `arrayJoin`ed so a single pass over the
 * inserted block produces every cut at once. 47 elements — 11 singles + 36 pairs.
 *
 * This is the `GROUPING SETS` idea moved from query time to insert time, which is the only place it
 * is paid once rather than once per investigation.
 */
const fanOut = (): string => {
  const singles = ROLLUP_SINGLE_DIMS.map((d) => `('${d}', ${DIM_SOURCE_SQL[d]})`);
  const pairs = ROLLUP_PAIRS.map(
    ([a, b]) => `('${a}|${b}', concat(${DIM_SOURCE_SQL[a]}, '|', ${DIM_SOURCE_SQL[b]}))`,
  );
  return [...singles, ...pairs].join(",\n           ");
};

/** Columns shared by both target tables, in the order the MVs emit them. */
const MEASURE_DDL = [
  "events        UInt64 CODEC(ZSTD(1))",
  "fills         UInt64 CODEC(ZSTD(1))",
  "impressions   UInt64 CODEC(ZSTD(1))",
  "clicks        UInt64 CODEC(ZSTD(1))",
  "revenue       Float64 CODEC(ZSTD(1))",
];

/**
 * The rollup DDL, generated from the registry above.
 *
 * Generated rather than hand-written into `schema.sql` because the fan-out is 47 expressions that
 * must match `ROLLUP_DIM_KEYS` exactly. Hand-maintaining both is how the planner ends up reading a
 * `dim` the MV never wrote — a query that returns zero rows and reports it as a real zero.
 *
 * Every statement is idempotent, so `bun run ch:schema` stays re-runnable.
 */
export function rollupStatements(): string[] {
  return [
    // -----------------------------------------------------------------------------------------
    // Hourly target.
    //
    // ORDER BY leads with (dim, val) rather than with time, which is the opposite of `ad_events`
    // and deliberate: time is already pruned by the daily partition, so the sort key's job is to
    // prune the DIMENSION. A question about os_version then touches 8 values' granules out of
    // 4,221 segments instead of reading the partition.
    //
    // PARTITION BY day, matching the fact table 1:1, because that is what keeps the loader
    // idempotent — see `dropRollupPartition` in constants/queries.ts.
    // -----------------------------------------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS ${ROLLUP_TABLES.hourly}
(
    event_date    Date,
    event_hour    DateTime CODEC(Delta(4), ZSTD(1)),
    dim           LowCardinality(String),
    val           LowCardinality(String),
    ${MEASURE_DDL.join(",\n    ")}
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMMDD(event_date)
ORDER BY (dim, val, event_date, event_hour)`,

    // Daily target. Same shape without the hour: ~148k rows for the whole 5-week window, which is
    // what makes the detection sweep a 99k-row read instead of a 9M-row fan-out per metric.
    `CREATE TABLE IF NOT EXISTS ${ROLLUP_TABLES.daily}
(
    event_date    Date,
    dim           LowCardinality(String),
    val           LowCardinality(String),
    ${MEASURE_DDL.join(",\n    ")}
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMMDD(event_date)
ORDER BY (dim, val, event_date)`,

    // -----------------------------------------------------------------------------------------
    // MV 1: ad_events -> hourly.
    //
    // FROM ad_events, not ad_events_enriched: a materialized view triggers on inserts to the table
    // it names, and `ad_events_enriched` is a plain VIEW — pointing at it would create a view that
    // compiles, never fires, and leaves the rollup silently empty. So the dictGet enrichment is
    // repeated here rather than reused, and DIM_SOURCE_SQL above is the one place it lives.
    // -----------------------------------------------------------------------------------------
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${ROLLUP_VIEWS.hourly}
TO ${ROLLUP_TABLES.hourly}
AS SELECT
    event_date,
    event_hour,
    dim,
    val,
    e AS events,
    f AS fills,
    i AS impressions,
    c AS clicks,
    r AS revenue
FROM (
  SELECT event_date, event_hour, kv.1 AS dim, kv.2 AS val,
         count()            AS e,
         sum(is_filled)     AS f,
         sum(is_impression) AS i,
         sum(is_click)      AS c,
         sum(revenue)       AS r
  FROM (
    SELECT
      toDate(event_time)        AS event_date,
      toStartOfHour(event_time) AS event_hour,
      is_filled, is_impression, is_click, revenue,
      arrayJoin([
           ${fanOut()}
      ]) AS kv
    FROM ad_events
  )
  GROUP BY event_date, event_hour, dim, val
)`,

    // -----------------------------------------------------------------------------------------
    // MV 2: hourly -> daily, cascaded.
    //
    // Cascaded rather than a second MV off `ad_events` for two reasons. It halves insert-time work
    // (the 47-way fan-out is paid once, and rolling 24 hourly rows into 1 is nearly free), and more
    // importantly the daily table CANNOT disagree with the hourly one, because it is derived from
    // it. Two independent fan-outs could drift; a derivation cannot.
    //
    // The aggregate is explicit rather than trusting SummingMergeTree to collapse on write: reads
    // always `sum()`, so either way is correct, but one inserted block per day means one row per
    // (dim, val) instead of 24 waiting on a background merge.
    // -----------------------------------------------------------------------------------------
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${ROLLUP_VIEWS.daily}
TO ${ROLLUP_TABLES.daily}
AS SELECT
    event_date,
    dim,
    val,
    e AS events,
    f AS fills,
    i AS impressions,
    c AS clicks,
    r AS revenue
FROM (
  SELECT event_date, dim, val,
         sum(events)      AS e,
         sum(fills)       AS f,
         sum(impressions) AS i,
         sum(clicks)      AS c,
         sum(revenue)     AS r
  FROM ${ROLLUP_TABLES.hourly}
  GROUP BY event_date, dim, val
)`,
  ];
}

/**
 * Backfill for rows already in `ad_events`.
 *
 * A materialized view only sees inserts that happen after it exists, so creating the MVs over a
 * loaded table leaves them empty. `POPULATE` is the obvious answer and is not safe — it misses any
 * row inserted while it runs. Explicit per-day backfill instead: idempotent (drop the day's
 * partition first), restartable, and it reuses the MV's own SELECT so the backfilled rows are
 * computed by exactly the same expression as the incremental ones.
 */
export function backfillHourlySql(date: string): string {
  return `INSERT INTO ${ROLLUP_TABLES.hourly}
SELECT
    event_date,
    event_hour,
    dim,
    val,
    e AS events,
    f AS fills,
    i AS impressions,
    c AS clicks,
    r AS revenue
FROM (
  SELECT event_date, event_hour, kv.1 AS dim, kv.2 AS val,
         count()            AS e,
         sum(is_filled)     AS f,
         sum(is_impression) AS i,
         sum(is_click)      AS c,
         sum(revenue)       AS r
  FROM (
    SELECT
      toDate(event_time)        AS event_date,
      toStartOfHour(event_time) AS event_hour,
      is_filled, is_impression, is_click, revenue,
      arrayJoin([
           ${fanOut()}
      ]) AS kv
    FROM ad_events
    WHERE toDate(event_time) = toDate('${date}')
  )
  GROUP BY event_date, event_hour, dim, val
)`;
}

/** Daily backfill, derived from the hourly table so it matches the cascaded MV exactly. */
export function backfillDailySql(date: string): string {
  return `INSERT INTO ${ROLLUP_TABLES.daily}
SELECT event_date, dim, val,
       e AS events, f AS fills, i AS impressions, c AS clicks, r AS revenue
FROM (
  SELECT event_date, dim, val,
         sum(events)      AS e,
         sum(fills)       AS f,
         sum(impressions) AS i,
         sum(clicks)      AS c,
         sum(revenue)     AS r
  FROM ${ROLLUP_TABLES.hourly}
  WHERE event_date = toDate('${date}')
  GROUP BY event_date, dim, val
)`;
}
