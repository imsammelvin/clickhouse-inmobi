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
import { createClient } from "@clickhouse/client";
import { splitStatements } from "../../utils/sql.utils";
import { DIMS, PLANTED, SHAPE, dateOf } from "./spec";

const DEFAULT_DB = "rca_synth";

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const say = (s = ""): void => {
  process.stderr.write(`${s}\n`);
};

/**
 * Refuse anything that could be a real database.
 *
 * Two independent conditions, because one typo should not be able to drop the dataset the whole
 * project depends on: the name must not be `default`, and it must contain "synth". A slip in an env
 * var then fails loudly instead of rebuilding production as test data.
 */
function assertScratchDatabase(db: string): string {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(db)) {
    throw new Error(`Refusing database "${db}": expected lowercase letters, digits and underscores.`);
  }
  if (db === "default" || !db.includes("synth")) {
    throw new Error(
      `Refusing to build into "${db}". This script only ever writes to a scratch database whose name ` +
        `contains "synth" — the real dataset lives in "default" and must never be a target.`,
    );
  }
  return db;
}

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
    const scope = p.segment ? ` AND ${rowDimension(p.segment.dimension)} = ${lit(p.segment.value)}` : "";
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
    `SYSTEM RELOAD DICTIONARY dict_apps`,
    `SYSTEM RELOAD DICTIONARY dict_advertisers`,
    `SYSTEM RELOAD DICTIONARY dict_geo_device`,
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
  const pool = Math.round(SHAPE.baseEventsPerDay * SHAPE.days * 1.2);

  const weekend =
    `if(toDayOfWeek(toDate('${SHAPE.from}') + day_idx) IN (6, 7), ${SHAPE.weekendVolumeFactor}, 1.0)`;
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
  const db = assertScratchDatabase(arg("db") ?? process.env.CLICKHOUSE_DATABASE ?? DEFAULT_DB);
  const dryRun = flag("dry-run");
  const reset = flag("reset");

  const schema = splitStatements(readFileSync("clickhouse/schema.sql", "utf8"));
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
      [...statements, "-- schema.sql --", ...schema, "-- dimensions --", ...dimensionStatements(), "-- events --", eventStatement()].join(
        ";\n\n",
      ) + ";\n",
    );
    say(`\n[synth] dry run — nothing was executed.`);
    return;
  }

  // A client bound to the server, not to a database: the first statements create the database itself.
  const admin = createClient({
    url: process.env.CLICKHOUSE_URL!,
    username: process.env.CLICKHOUSE_USER!,
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    request_timeout: 600_000,
  });
  try {
    for (const sql of statements) {
      say(`[synth] ${sql}`);
      await admin.command({ query: sql, clickhouse_settings: { wait_end_of_query: 1 } });
    }
  } finally {
    await admin.close();
  }

  const client = createClient({
    url: process.env.CLICKHOUSE_URL!,
    username: process.env.CLICKHOUSE_USER!,
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    database: db,
    request_timeout: 600_000,
  });

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
    await client.command({ query: eventStatement(), clickhouse_settings: { wait_end_of_query: 1 } });
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
    say(`          CLICKHOUSE_DATABASE=${db} bun run synth:verify`);
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
