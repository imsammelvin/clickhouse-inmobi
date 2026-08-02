/**
 * Build the synthetic dataset in its own ClickHouse database.
 *
 *   bun run synth:build -- --dry-run     # print every statement, touch nothing
 *   bun run synth:build                  # create + populate rca_synth
 *   bun run synth:build -- --reset       # drop rca_synth first, then rebuild
 *
 * HOW IT RETARGETS THE ENGINE WITHOUT TOUCHING IT. `clickhouse/client.ts` reads the database from
 * `CLICKHOUSE_DATABASE`, so pointing that at another database moves every query in the system —
 * backend stages, MCP tools, the eval — onto different data with no code change at all. That is the
 * property that makes this a real test: the code under test is the shipping code, byte for byte, not
 * a fixture-shaped variant of it.
 *
 * SAFETY. The real 9M rows live in `default`. This script refuses to run against it, refuses any name
 * that does not look like a scratch database, and the only thing it will ever drop is that database.
 * Nothing here can write outside the target.
 *
 * DETERMINISM. Every value comes from `cityHash64(number, seed, salt)`, so the dataset is a pure
 * function of `SHAPE.seed` — a rebuild reproduces it exactly, and a failing assertion can be
 * reproduced by anyone. All generation happens server-side from `numbers()`: no rows cross the wire.
 */
import { readFileSync } from "node:fs";
import { ROLLUP_TABLES, rollupStatements } from "../../clickhouse/rollup";
import { splitStatements } from "../../../shared/utils/sql.utils";
import { DIMS, PLANTED, SHAPE, dateOf, specFingerprint } from "./spec";
import { resolveTargetDatabase, scratchClient, serverClient } from "./target";
import type { Span } from "@opentelemetry/api";
import {
  initObservability,
  shutdownObservability,
  withSpan,
} from "../../../shared/utils/telemetryUtils";

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const say = (s = ""): void => {
  process.stderr.write(`${s}\n`);
};

// -------------------------------------------------------------------------------------------------
// SQL fragment helpers. Every dimension value is recomputed from the same expression that built the
// dimension row, so an effect condition and the stored value can never disagree.
// -------------------------------------------------------------------------------------------------

const S = SHAPE.seed;
const lit = (v: string): string => `'${v.replace(/'/g, "\\'")}'`;
const arr = (vs: readonly string[]): string => `[${vs.map(lit).join(", ")}]`;

/** Deterministic index in [0, n) from a row key and a salt. */
const pick = (key: string, salt: number, n: number): string =>
  `toUInt32(cityHash64(${key}, ${S}, ${salt}) % ${n})`;

/** Deterministic uniform in [0, 1), as a fraction with 6 digits of resolution. */
const uniform = (key: string, salt: number): string =>
  `(toFloat64(cityHash64(${key}, ${S}, ${salt}) % 1000000) / 1000000)`;

const element = (values: readonly string[], key: string, salt: number): string =>
  `arrayElement(${arr(values)}, ${pick(key, salt, values.length)} + 1)`;

/** Salts. Fixed per field so adding a field never reshuffles the others. */
const SALT = {
  gdRegion: 1,
  gdCountry: 2,
  gdDevice: 3,
  gdOs: 4,
  appCategory: 5,
  appTier: 6,
  advVertical: 7,
  advCampaign: 8,
  rowGeo: 10,
  rowApp: 11,
  rowAdv: 12,
  rowFormat: 13,
  rowTime: 14,
  rowKeep: 15,
  rowFill: 16,
  rowRender: 17,
  rowClick: 18,
  rowEcpm: 19,
} as const;

/** Per-row expressions for each dimension, derived exactly as the dimension tables were built. */
const ROW = {
  geoIdx: pick("number", SALT.rowGeo, SHAPE.geoDevices),
  appIdx: pick("number", SALT.rowApp, SHAPE.apps),
  advIdx: pick("number", SALT.rowAdv, SHAPE.advertisers),
  dayIdx: `toUInt32(number % ${SHAPE.days})`,
} as const;

/** Dimension value for the current row, by dimension name. */
function rowDimension(dimension: string): string {
  switch (dimension) {
    case "region":
      return element(DIMS.region, "geo_idx", SALT.gdRegion);
    case "country":
      return element(DIMS.country, "geo_idx", SALT.gdCountry);
    case "device_model":
      return element(DIMS.device_model, "geo_idx", SALT.gdDevice);
    case "os_version":
      return element(DIMS.os_version, "geo_idx", SALT.gdOs);
    case "app_category":
      return element(DIMS.app_category, "app_idx", SALT.appCategory);
    case "publisher_tier":
      return element(DIMS.publisher_tier, "app_idx", SALT.appTier);
    case "ad_format":
      return element(DIMS.ad_format, "number", SALT.rowFormat);
    default:
      throw new Error(`No row expression for dimension "${dimension}".`);
  }
}

/**
 * Multiplier applied to `metric` for the current row, built from the planted spec.
 *
 * One expression per planted deviation, `multiIf`-chained. Because the condition is generated from the
 * same spec the scorer reads, a deviation cannot be planted on days or a segment the answer key does
 * not know about.
 */
function effectFactor(metric: string): string {
  const clauses: string[] = [];
  for (const p of PLANTED) {
    if (p.metric !== metric) continue;
    const window = `day_idx BETWEEN ${p.fromDay} AND ${p.toDay}`;
    // Conditions are ANDed, so two of them place the effect at an intersection — a slice whose share
    // is the product of theirs, invisible in either dimension alone.
    const scope = (p.conditions ?? [])
      .map((c) => ` AND ${rowDimension(c.dimension)} = ${lit(c.value)}`)
      .join("");
    clauses.push(`${window}${scope}, ${p.factor}`);
  }
  return clauses.length ? `multiIf(${clauses.join(", ")}, 1.0)` : "1.0";
}

// -------------------------------------------------------------------------------------------------

function dimensionStatements(): string[] {
  return [
    `TRUNCATE TABLE IF EXISTS apps`,
    `TRUNCATE TABLE IF EXISTS advertisers`,
    `TRUNCATE TABLE IF EXISTS geo_device`,
    `INSERT INTO apps
SELECT concat('app_', toString(number))                       AS app_id,
       ${element(DIMS.app_category, "number", SALT.appCategory)} AS category,
       ${element(DIMS.publisher_tier, "number", SALT.appTier)}   AS publisher_tier
FROM numbers(${SHAPE.apps})`,
    `INSERT INTO advertisers
SELECT concat('adv_', toString(number))                           AS advertiser_id,
       ${element(DIMS.advertiser_vertical, "number", SALT.advVertical)} AS vertical,
       ${element(DIMS.campaign_type, "number", SALT.advCampaign)}      AS campaign_type
FROM numbers(${SHAPE.advertisers})`,
    `INSERT INTO geo_device
SELECT concat('gd_', toString(number))                    AS geo_device_id,
       ${element(DIMS.region, "number", SALT.gdRegion)}    AS region,
       ${element(DIMS.country, "number", SALT.gdCountry)}  AS country,
       ${element(DIMS.device_model, "number", SALT.gdDevice)} AS device_model,
       ${element(DIMS.os_version, "number", SALT.gdOs)}    AS os_version
FROM numbers(${SHAPE.geoDevices})`,
    // Recreate the three dictionaries with a REFRESHING lifetime, in this database only.
    //
    // schema.sql declares LIFETIME(0) — never refresh — which is right for a load-once production
    // table and wrong the moment the dimension rows change underneath it. On a multi-node service any
    // node that loaded a dictionary before the rows existed serves empty strings for the life of the
    // process, and queries are load-balanced, so `dictGet` returns real values or '' depending on
    // which node answers. Every dimension in the enriched view then collapses to one blank value and
    // the engine reports "uniform across every dimension — no segment is responsible" with no error
    // and a clean-looking trace. It cost an hour and a wrong bug report to the team.
    //
    // A short lifetime makes it self-heal instead. Scoped to the scratch database; schema.sql is Lane
    // B's file and unchanged.
    ...dictionaryOverrides(),
    `SYSTEM RELOAD DICTIONARY dict_apps`,
    `SYSTEM RELOAD DICTIONARY dict_advertisers`,
    `SYSTEM RELOAD DICTIONARY dict_geo_device`,
    // Stamp what built this data, so the scorer can refuse a database the spec has moved on from.
    `CREATE TABLE IF NOT EXISTS synth_meta (fingerprint String, built_at DateTime) ENGINE = MergeTree ORDER BY built_at`,
    `TRUNCATE TABLE synth_meta`,
    `INSERT INTO synth_meta SELECT '${specFingerprint().replace(/'/g, "\\'")}', now()`,
  ];
}

/** The same three dictionaries as schema.sql, but self-refreshing. See the note above. */
function dictionaryOverrides(): string[] {
  return [
    `CREATE OR REPLACE DICTIONARY dict_apps
(app_id String, category String DEFAULT '', publisher_tier String DEFAULT '')
PRIMARY KEY app_id
SOURCE(CLICKHOUSE(TABLE 'apps'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 30 MAX 60)`,
    `CREATE OR REPLACE DICTIONARY dict_advertisers
(advertiser_id String, vertical String DEFAULT '', campaign_type String DEFAULT '')
PRIMARY KEY advertiser_id
SOURCE(CLICKHOUSE(TABLE 'advertisers'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 30 MAX 60)`,
    `CREATE OR REPLACE DICTIONARY dict_geo_device
(geo_device_id String, region String DEFAULT '', country String DEFAULT '',
 device_model String DEFAULT '', os_version String DEFAULT '')
PRIMARY KEY geo_device_id
SOURCE(CLICKHOUSE(TABLE 'geo_device'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 30 MAX 60)`,
  ];
}

/**
 * The event generator: one INSERT, all of it server-side.
 *
 * Volume is shaped by *dropping* rows from an oversized pool rather than by looping days, which keeps
 * it to a single statement. The keep probability carries the weekend dip, the underlying growth trend
 * and any planted volume effect, normalised so it never exceeds 1.
 */
function eventStatement(): string {
  const maxGrowth = (1 + SHAPE.weeklyGrowth) ** (SHAPE.days / 7);
  // Overridable so the same planted deviations can be scored at production scale. Segment-level
  // sampling noise shrinks with volume, so a uniformity or significance test can pass at 250k
  // events/day and fail at 40k — which is a fact about the test, not about the engine, and the only
  // way to tell them apart is to run both.
  const perDay = Number(arg("events-per-day") ?? SHAPE.baseEventsPerDay);
  const pool = Math.round(perDay * SHAPE.days * 1.2);

  const weekend = `if(toDayOfWeek(toDate('${SHAPE.from}') + day_idx) IN (6, 7), ${SHAPE.weekendVolumeFactor}, 1.0)`;
  const growth = `pow(${1 + SHAPE.weeklyGrowth}, day_idx / 7)`;
  const keep = `least(1.0, ${weekend} * ${growth} / ${maxGrowth} * ${effectFactor("requests")})`;

  const fillProb = `least(0.999, ${SHAPE.baseFillRate} * ${effectFactor("fill_rate")})`;
  const renderProb = `least(0.999, ${SHAPE.baseRenderRate} * ${effectFactor("render_rate")})`;
  const clickProb = `least(0.999, ${SHAPE.baseCtr} * ${effectFactor("ctr")})`;
  // Jitter keeps eCPM from being a single constant, which would make its spread zero and sigma
  // meaningless — the same reason `baseline.ts` floors the coefficient of variation.
  const ecpm = `${SHAPE.baseEcpmUsd} * ${effectFactor("ecpm")} * (0.8 + ${uniform("number", SALT.rowEcpm)} * 0.4)`;

  return `INSERT INTO ad_events
SELECT
  toDateTime('${SHAPE.from} 00:00:00') + day_idx * 86400 + intDiv(cityHash64(number, ${S}, ${SALT.rowTime}) % 86400, 1) AS event_time,
  concat('app_', toString(app_idx))                          AS app_id,
  concat('gd_', toString(geo_idx))                           AS geo_device_id,
  if(is_filled = 1, concat('adv_', toString(adv_idx)), '')   AS advertiser_id,
  ad_format,
  is_filled,
  is_impression,
  is_click,
  if(is_impression = 1, ${ecpm} / 1000, 0)                   AS revenue
FROM (
  SELECT
    number, day_idx, app_idx, geo_idx, adv_idx, ad_format,
    is_filled,
    if(is_filled = 1 AND ${uniform("number", SALT.rowRender)} < ${renderProb}, 1, 0) AS is_impression,
    if(is_impression = 1 AND ${uniform("number", SALT.rowClick)} < ${clickProb}, 1, 0) AS is_click
  FROM (
    SELECT
      number,
      ${ROW.dayIdx}  AS day_idx,
      ${ROW.appIdx}  AS app_idx,
      ${ROW.geoIdx}  AS geo_idx,
      ${ROW.advIdx}  AS adv_idx,
      ${element(DIMS.ad_format, "number", SALT.rowFormat)} AS ad_format,
      if(${uniform("number", SALT.rowFill)} < ${fillProb}, 1, 0) AS is_filled
    FROM numbers(${pool})
    WHERE ${uniform("number", SALT.rowKeep)} < ${keep}
  )
)`;
}

async function main(): Promise<void> {
  initObservability();
  try {
    await withSpan(
      "synth.generate",
      {
        "app.synth.days": SHAPE.days,
        "app.synth.seed": SHAPE.seed,
        "app.synth.planted": PLANTED.length,
      },
      runGenerate,
    );
  } finally {
    await shutdownObservability();
  }
}

async function runGenerate(span: Span): Promise<void> {
  const db = resolveTargetDatabase();
  const dryRun = flag("dry-run");
  const reset = flag("reset");
  span.setAttributes({ "app.database": db, "app.dry_run": dryRun, "app.reset": reset });

  /**
   * schema.sql plus the generated rollup DDL, in that order — the same pair `bun run ch:schema`
   * applies, and it has to be the same pair or this harness stops testing what ships.
   *
   * The rollup lives in `clickhouse/rollup.ts`, not in schema.sql, so applying only schema.sql left
   * the scratch database with no rollup tables and no materialized views. That is not a crash:
   * `ensureRollupReady` finds the tables missing and every query falls back to `ad_events_enriched`.
   * The harness would keep passing while silently exercising the raw path that production no longer
   * uses — a green scorer that scores the wrong code. Applied BEFORE the events are inserted, so the
   * MVs populate incrementally as the generator writes, and no backfill step is needed.
   */
  const schema = [
    ...splitStatements(readFileSync("backend/clickhouse/schema.sql", "utf8")),
    ...rollupStatements(),
  ];
  const statements: string[] = [
    ...(reset ? [`DROP DATABASE IF EXISTS ${db}`] : []),
    `CREATE DATABASE IF NOT EXISTS ${db}`,
  ];

  say(`[synth] target database: ${db}${reset ? " (reset)" : ""}`);
  say(`[synth] ${SHAPE.days} days from ${SHAPE.from}, seed ${SHAPE.seed}`);
  say(`[synth] planted:`);
  for (const p of PLANTED) {
    say(`  ${p.id.padEnd(28)} ${dateOf(p.fromDay)}..${dateOf(p.toDay)}  ${p.what}`);
  }

  if (dryRun) {
    process.stdout.write(
      [
        ...statements,
        "-- schema.sql --",
        ...schema,
        "-- dimensions --",
        ...dimensionStatements(),
        "-- events --",
        eventStatement(),
      ].join(";\n\n") + ";\n",
    );
    say(`\n[synth] dry run — nothing was executed.`);
    return;
  }

  // A client bound to the server, not to a database: the first statements create the database itself.
  const admin = serverClient();
  try {
    for (const sql of statements) {
      say(`[synth] ${sql}`);
      await admin.command({ query: sql, clickhouse_settings: { wait_end_of_query: 1 } });
    }
  } finally {
    await admin.close();
  }

  const client = scratchClient(db);

  try {
    say(`[synth] applying ${schema.length} schema statement(s)`);
    for (const sql of schema) {
      await client.command({ query: sql, clickhouse_settings: { wait_end_of_query: 1 } });
    }

    say(`[synth] loading dimensions`);
    for (const sql of dimensionStatements()) {
      await client.command({ query: sql, clickhouse_settings: { wait_end_of_query: 1 } });
    }

    say(`[synth] generating events (server-side, no rows over the wire)`);
    const started = Date.now();
    await client.command({
      query: `TRUNCATE TABLE IF EXISTS ad_events`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });

    // TRUNCATE does not cascade into a materialized view's target any more than DROP PARTITION does.
    // Without these, a rebuild without --reset empties `ad_events`, re-inserts it, and the MVs ADD a
    // second copy on top of the rows still sitting in the rollup — so every rollup-served figure in
    // the scratch database comes back doubled while `ad_events` counts correctly. Same trap as the
    // loader's, one layer over.
    for (const table of Object.values(ROLLUP_TABLES)) {
      await client.command({
        query: `TRUNCATE TABLE IF EXISTS ${table}`,
        clickhouse_settings: { wait_end_of_query: 1 },
      });
    }
    await client.command({
      query: eventStatement(),
      clickhouse_settings: { wait_end_of_query: 1 },
    });
    say(`[synth] events inserted in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    const rs = await client.query({
      query: `SELECT count() AS rows, uniqExact(event_date) AS days,
                     toString(min(event_date)) AS lo, toString(max(event_date)) AS hi,
                     round(sum(is_filled) / count(), 4) AS fill,
                     round(sum(revenue), 2) AS revenue
              FROM ad_events_enriched`,
      format: "JSONEachRow",
    });
    const [row] = (await rs.json()) as Array<Record<string, unknown>>;
    say(`[synth] ${JSON.stringify(row)}`);
    say(``);
    say(`[synth] done. Point the engine at it:`);
    say(`          bun run synth:verify        # score found vs planted`);
    say(`          bun run synth:destroy       # remove it again`);
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    say(`[synth] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
