# Task — ClickHouse data ingestion

**Branch:** `dev/samarth/clickhouse-ingest` · **Commit:** `e584378` · **Board:** T-006 (canonical
DDL) + T-008 (idempotent ingest path) · **Date:** 2026-08-01

---

## 1. What this feature is

Get the InMobi ad-events dataset — 9,000,000 events plus three dimension tables — into our
ClickHouse Cloud service, in a way that can be run again and again without corrupting anything, and
then **prove** that what landed in ClickHouse is exactly what was in the source files.

That last part is not paranoia. We are judged on _"every number in the diagnosis must be
reproducible from the data"_, and a single fabricated figure costs more than a missed anomaly. The
cheapest way to end up with a fabricated figure is to quietly lose rows at ingest and never notice.
So the ingest ships with a verifier that recomputes the funnel totals in a **different engine**
(DuckDB, straight off the source Parquet) and asserts ClickHouse agrees — globally, and then day by
day.

Everything downstream — anomaly detection, drill-down, the LLM narration — sits on top of this. If
this layer is wrong, everything above it is confidently wrong.

---

## 2. The data

Four files in `InMobi/data/`, arranged as a star schema:

| File                | What it is                                                    | Rows          |
| ------------------- | ------------------------------------------------------------- | ------------- |
| `ad_events.parquet` | fact table — one row per ad request                           | **9,000,000** |
| `apps.csv`          | dimension — `category`, `publisher_tier`                      | 2,000         |
| `advertisers.csv`   | dimension — `vertical`, `campaign_type`                       | 500           |
| `geo_device.csv`    | dimension — `region`, `country`, `device_model`, `os_version` | 5,000         |

```
        apps (2K)                          advertisers (500)
   app_id, category,                 advertiser_id, vertical,
   publisher_tier                         campaign_type
            \                                 /
             \                               /
            ad_events  (9M rows)  ── the event stream
   event_time, app_id, geo_device_id, advertiser_id, ad_format,
   is_filled, is_impression, is_click, revenue
                        |
                 geo_device (5K)
      geo_device_id, region, country, device_model, os_version
```

Date range: **2026-06-01 00:00:00 → 2026-07-05 23:59:59** — exactly 35 days.

Each fact row is one ad request and what happened to it: `is_filled` → `is_impression` →
`is_click`, with `revenue` earned on impressions. `advertiser_id` is an empty string when the
request was never filled, because no ad was served. That empty-string case matters later.

---

## 3. Project structure

```
enums/
  index.ts              every literal that names something (71 lines)
interfaces/
  index.ts              every shape (155 lines)
constants/
  index.ts              paths, tuning knobs, expected values (74 lines)
  queries.ts            every SQL statement, named (157 lines)
utils/
  common.utils.ts       shared functions (167 lines)
  sql.utils.ts          DDL-file parsing (57 lines)
clickhouse/
  client.ts             connection factory + exec/select/selectOne (76 lines)
  schema.sql            canonical DDL (162 lines)
  .chunks/              scratch space for daily Parquet chunks (gitignored)
scripts/
  ping.ts               connectivity smoke test (26 lines)
  schema.ts             applies schema.sql (32 lines)
  load.ts               the ingest driver (306 lines)
  verify.ts             the reconciliation gate (229 lines)
```

### The rule for each folder

| Path                    | What goes in it                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enums/index.ts`        | Every literal that _names_ something: table names, view names, dictionary names, dimension key columns, source filenames, ClickHouse data formats, env var names, CLI flags. If you are about to type a table name as a raw string, it belongs here. |
| `interfaces/index.ts`   | Every shape that crosses a function boundary. `LoadOptions`, `DayChunk`, `FunnelTotals`, `MetricSnapshot`, `PartStats`, `EnrichmentGaps`, and the row types for each query.                                                                          |
| `constants/index.ts`    | Paths (`REPO_ROOT`, `DATA_DIR`, `FACT_FILE`, `CHUNK_DIR`), timeouts, `DEFAULT_CONCURRENCY` / `MAX_CONCURRENCY`, `RETRY_ATTEMPTS`, the backoff curve, the dimension load order, and the row counts each dimension must have.                          |
| `constants/queries.ts`  | Every SQL statement, as a named export. Statements prefixed `src` run in DuckDB against the raw files; the rest run in ClickHouse. The funnel-totals expression list is shared between both engines so `verify.ts` compares like with like.          |
| `utils/common.utils.ts` | Functions used by more than one script: `fmt`, `elapsed`, `secondsSince`, `closeEnough`, `withRetry`, `pool`, the DuckDB wrapper, flag parsing, `runScript`.                                                                                         |
| `utils/sql.utils.ts`    | Only `splitStatements` and `statementLabel` — parsing the DDL file. Kept separate because it is a parser, not a helper.                                                                                                                              |
| `clickhouse/client.ts`  | `makeClient()` plus `exec` / `select` / `selectOne`. One place for timeouts, compression and insert settings.                                                                                                                                        |
| `clickhouse/schema.sql` | The canonical DDL. Single owner. Everyone else reads it.                                                                                                                                                                                             |
| `scripts/*.ts`          | Orchestration only.                                                                                                                                                                                                                                  |

**The invariant:** a file in `scripts/` contains **no interfaces, no constants, no enums and no raw
SQL**. It reads config from `constants/`, types from `interfaces/`, names from `enums/`, SQL from
`constants/queries.ts`, and helpers from `utils/`. If you find yourself declaring an `interface` or
typing a quoted SQL string inside `scripts/`, it is in the wrong file.

---

## 4. The schema, and why it looks like that

`clickhouse/schema.sql` has four parts. It is idempotent (`IF NOT EXISTS` / `OR REPLACE`) so
re-running it is always safe and never drops data.

### 4.1 Dimension tables

`apps`, `advertisers`, `geo_device` — plain `MergeTree`, ordered by their key. Nothing clever;
they are small and get fully replaced on every load.

### 4.2 Dictionaries

`dict_apps`, `dict_advertisers`, `dict_geo_device` — `COMPLEX_KEY_HASHED`, held in RAM.

The dimensions are tiny (2,000 / 500 / 5,000 rows). A drill-down that groups by five dimensions at
once costs **one hash probe per row per dimension** instead of five join builds. `COMPLEX_KEY_HASHED`
rather than `HASHED` because the keys are strings.

They are declared `LIFETIME(0)`, meaning they never refresh on their own. The loader issues
`SYSTEM RELOAD DICTIONARY` explicitly after reloading the dimension tables. **If you ever edit a
dimension table by hand, reload it yourself or queries will keep serving stale labels.**

### 4.3 The fact table

```sql
CREATE TABLE ad_events
(
    event_time      DateTime CODEC(Delta(4), ZSTD(1)),
    app_id          LowCardinality(String),
    geo_device_id   LowCardinality(String),
    advertiser_id   LowCardinality(String),   -- '' when the request was not filled
    ad_format       LowCardinality(String),
    is_filled       UInt8 CODEC(ZSTD(1)),
    is_impression   UInt8 CODEC(ZSTD(1)),
    is_click        UInt8 CODEC(ZSTD(1)),
    revenue         Float64 CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (event_time, ad_format, app_id, geo_device_id);
```

**`PARTITION BY` day — this is for idempotency, not query speed.** 35 partitions, ~257k rows each.
One source chunk maps 1:1 onto one partition, so loading a day is `DROP PARTITION` + `INSERT`.
Re-running therefore cannot double-count revenue, and a crash halfway through leaves the completed
days intact. Without that mapping we would need dedup logic, and dedup logic that is subtly wrong
produces confidently wrong revenue numbers.

**`event_time` leads the sort key** because every root-cause query is time-windowed first ("what
happened between 14:00 and 18:00 on Jun 23") and only then sliced by dimension. Time-leading order
plus daily partitions means a one-hour investigation touches roughly 1/840th of the granules.
`ad_format` comes second as the cheapest prune (5 values); `app_id` and `geo_device_id` give
locality within a format.

**Codecs:** `Delta` + `ZSTD` on the monotonically increasing timestamp, `ZSTD` on the 0/1 flags,
which are long runs and compress to almost nothing. Net result: 9M rows in **89.25 MiB**.

### 4.4 `ad_events_enriched` — the query interface

A plain `VIEW`, so it costs **zero storage and zero ingest time**. It flattens all 12 dimensions
from `metrics_glossary.md` onto every event via `dictGet`, plus `event_date`, `event_hour`,
`day_of_week` and `hour_of_day` for seasonality baselines.

```sql
SELECT region, device_model,
       sum(is_filled) / count()                 AS fill_rate,
       sum(revenue) / sum(is_impression) * 1000 AS ecpm,
       sum(revenue)                             AS revenue
FROM ad_events_enriched
WHERE event_time >= '2026-06-23' AND event_time < '2026-06-24'
GROUP BY region, device_model
ORDER BY revenue DESC;
```

No JOINs to get wrong, and ratio metrics stay `sum / sum` as the glossary requires.

**This is what the other lanes should query — not `ad_events`.**

---

## 5. How the loader works

```
DuckDB splits ad_events.parquet into 35 daily files      (one pass, ~0.6s)
        │
        ▼   for each day, N in parallel (default 4):
   ALTER TABLE ad_events DROP PARTITION 20260623   SETTINGS alter_sync = 2
   INSERT INTO ad_events FORMAT Parquet            (stream that day's file)
   SELECT count() … SETTINGS select_sequential_consistency = 1
        │                    └── must equal the row count in the Parquet footer,
        ▼                        or the whole day is retried
   next day
```

**Why chunk by day.** One chunk = one partition is the entire trick. Drop-then-insert makes the
load idempotent with no dedup logic anywhere. It also makes it resumable: a re-run compares each
day's live row count against the source and skips the ones that already match.

**Why parallel.** A single 103 MB POST from a laptop to `ap-south-1` is bottlenecked on uplink
round-trips, not on the server. Six concurrent day-uploads finish in about a third of the time.

**Why the count check.** The row count comes from the Parquet **footer** — a metadata read, not a
scan — so it is nearly free. Ingest that silently loses rows is worse than ingest that fails.

The dimension tables are simpler: `TRUNCATE` + `INSERT` (they are a few thousand rows with no
natural version column, so a full replace is both simplest and correct), then
`SYSTEM RELOAD DICTIONARY`.

### Loader flags

| Flag                           | Effect                                                 |
| ------------------------------ | ------------------------------------------------------ |
| `--force`                      | Reload every day even if its row count already matches |
| `--dims-only`                  | Only the three dimension tables                        |
| `--facts-only`                 | Only `ad_events`                                       |
| `--only=2026-06-21,2026-06-22` | Just these days — fast iteration on one incident       |
| `--concurrency=6`              | Parallel day uploads (default 4, max 16)               |
| `--skip-extract`               | Reuse the daily chunks already on disk                 |
| `--keep-chunks`                | Don't delete `clickhouse/.chunks` afterwards           |

Requires the `duckdb` CLI on PATH (`brew install duckdb`).

---

## 6. Step by step — what was actually done

1. **Read the docs.** `AGENTS.md`, `goal.md`, `TASKS.md`, and the three InMobi documents
   (`PROBLEM_STATEMENT.md`, `README_START_HERE.md`, `metrics_glossary.md`). Then branched
   `dev/samarth/clickhouse-ingest` per the AGENTS.md rule that `main` is read-only.

2. **Inspected the data** with DuckDB — 9,000,000 rows, 9 columns, 35 days, and confirmed the
   dimension CSV headers.

3. **Reviewed the existing `ping.ts`.** It worked. The ClickHouse Cloud service was **already
   provisioned** (`ket4…ap-south-1.aws.clickhouse.cloud`, server 26.2.1), so there was nothing to
   host or set up. Its `createClient` call was pulled out into `clickhouse/client.ts` so every
   script shares one connection setup instead of copy-pasting credentials and timeouts.

4. **Wrote `clickhouse/schema.sql`** and applied it — dimension tables, dictionaries, fact table,
   enriched view. 8 statements, all green.

5. **Wrote the loader** and ran it. Dimensions first (1.2s), then the fact table: 9,000,000 rows in
   6.4 seconds.

6. **Wrote `verify.ts`** — the DuckDB cross-check. 30 assertions, all passing.

7. **Restructured the whole thing.** The first version had interfaces, constants and SQL strings
   inline in each script, which was correctly called out as messy. Everything moved into
   `enums/`, `interfaces/`, `constants/`, `utils/`, with `scripts/` reduced to orchestration.
   `tsc --noEmit` clean afterwards.

8. **Found and fixed a real bug** during the post-restructure verification run — see §7.

9. **Re-ran everything green** and committed as `e584378`.

---

## 7. The bug that verification caught

During a forced full reload at concurrency 6:

```
2026-07-02: expected 284,319 rows in partition 20260702, found 0
```

**Cause.** `ALTER TABLE … DROP PARTITION` is applied _asynchronously per replica_. Under
concurrency, the drop could land **after** the `INSERT` that followed it — deleting the day that had
just been loaded.

There was a second, compounding problem: the post-insert check was reading `system.parts`, which is
replica-local metadata and lags a fresh insert on ClickHouse Cloud. It was the wrong instrument for
the job even when the data was fine.

**Fixes, both in place:**

- `alter_sync = "2"` on the drop — wait for _every_ replica to apply it before inserting.
- The confirmation now counts rows in the **table itself** with
  `SETTINGS select_sequential_consistency = 1`, which gives read-your-writes.
- Drop + insert + confirm are retried as a single unit. If the confirmation fails we do not know
  which half went wrong, and redoing both is always safe because the drop comes first.

**Why this matters:** without the count check this would not have thrown an error. It would have
shown up as a silently missing day — and the first person to notice would have been a judge looking
at a diagnosis built on a hole in the data.

---

## 8. Results

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| **Load**    | 9,000,000 rows in **6.0s** (~1,489,525 rows/s, concurrency 6) |
| **Re-run**  | no-op in 2.1s — every day skipped, nothing rewritten          |
| **Verify**  | **30/30 checks pass** in 1.4s                                 |
| **Storage** | 89.25 MiB on disk (218.10 MiB raw, 2.44x), 35 parts           |

Funnel totals, reconciled against the source Parquet:

| Metric      | Value       |
| ----------- | ----------- |
| Requests    | 9,000,000   |
| Fills       | 7,027,910   |
| Impressions | 6,887,058   |
| Clicks      | 74,940      |
| Revenue     | 17,020.3642 |
| Fill rate   | 0.7809      |
| Render rate | 0.9800      |
| CTR         | 0.0109      |
| eCPM        | 2.4714      |
| RPR         | 0.001891    |

What `verify.ts` checks: dimension row counts and key uniqueness · global funnel totals vs DuckDB ·
**per-day row counts and revenue for all 35 days** · no duplicated rows · every event resolves its
app/geo/advertiser through the dictionaries · funnel monotonicity (no click without an impression,
no impression without a fill, no revenue without an impression) · the revenue identity from the
glossary · metric sanity ranges.

> ### Note for the anomaly-detection lane
>
> **`2026-06-21` has 126,052 events** against ~270,000 on neighbouring days — less than half the
> volume. That is **in the source data, not an ingest fault**: `verify.ts` reconciles that day
> exactly against the Parquet. It looks like a planted request-volume anomaly.

---

## 9. How to run it

```bash
bun install
cp .env.example .env         # fill in the ClickHouse Cloud credentials
bun run ch:ping              # connectivity
bun run ch:schema            # create tables / dictionaries / view
bun run ch:load              # load 9M events + 3 dimension tables
bun run ch:verify            # reconcile against the source files
```

`bun run ch:setup` runs schema + load + verify in one go. `bun run typecheck` runs `tsc --noEmit`.

Re-running `ch:load` is always safe — it skips any day whose row count already matches the source.

Passing flags through bun needs a `--` separator:

```bash
bun run ch:load -- --force --concurrency=6
bun run ch:load -- --only=2026-06-21
```

---

## 10. Hosting — where ClickHouse actually runs

Our service is **already provisioned** and nothing needs creating:
`ket4….ap-south-1.aws.clickhouse.cloud`, server 26.2.1. The problem statement requires it — _"Load
the dataset into your team's own ClickHouse Cloud service. There is no shared instance."_

For reference, creating one from scratch:

1. Sign up at <https://clickhouse.cloud>, apply the hackathon credits.
2. **Create service** → pick a region _close to you_. Ours is `ap-south-1` (Mumbai). Every INSERT is
   an HTTP round trip from your laptop, so a US region would roughly triple ingest time from India.
3. Cloud shows the connection details **once**. They go in `.env`:

   ```
   CLICKHOUSE_URL=https://<service-id>.<region>.aws.clickhouse.cloud:8443
   CLICKHOUSE_USER=default
   CLICKHOUSE_PASSWORD=<generated>
   CLICKHOUSE_DATABASE=default
   ```

Three things that waste an hour if you don't know them:

- **Port 8443 is the HTTPS interface.** `@clickhouse/client` speaks HTTP, not the native protocol on 9440. Using 9440 gives a confusing TLS error.
- **Settings → IP access list.** A new service is locked down by default. The symptom of forgetting
  this is a connection timeout, not a clear error message.
- **Cloud idles the service after ~15 minutes** of no queries. The first query after an idle period
  takes a few seconds to wake it — **warm it up before the demo.**

`.env` is gitignored. Never commit credentials; if one leaks, rotate it in the Cloud console.

### Offline fallback

If the wifi dies, a local server is one container:

```bash
docker run -d --name ch \
  -p 8123:8123 -p 9000:9000 \
  -e CLICKHOUSE_PASSWORD=local \
  --ulimit nofile=262144:262144 \
  clickhouse/clickhouse-server
```

Point `.env` at `http://localhost:8123` with user `default` / password `local`. Everything here
works unchanged. Data lives in the container — `docker rm` deletes it.

---

## 11. Loading the unseen incident dataset

Day 2 releases a fresh slice of the same universe with new planted anomalies. It has the same
schema, so:

```bash
cp <new>/ad_events.parquet InMobi/data/ad_events.parquet
bun run ch:load && bun run ch:verify
```

- If the new slice covers **new days**, they load alongside the existing ones and nothing is lost.
- If it **replaces existing days**, those partitions are dropped and rewritten — which is what you
  want.

Either way `verify.ts` is the gate. **Do not demo numbers it has not reconciled.**

---

## 12. What is NOT done

Honest list, so nobody assumes otherwise:

- `goal.md` is still entirely `_TBD_` — kickoff never happened.
- `TASKS.md` T-006 and T-008 are **not claimed**; no rows updated.
- No journal entry, no BROADCAST entry, despite this defining a cross-lane contract
  (`ad_events_enriched`).
- No `clickhouse/README.md` — this document covers the same ground for now.
- **No materialized views or pre-aggregated rollups.** Deliberate: they belong to whoever owns
  anomaly detection, and MVs only fire on insert, so they must be created _before_ a reload.
- The branch is **not merged to `main`** and has had no review.

### Contract for other lanes

Changing any of these is a `Breaking:` commit **and** a BROADCAST entry:

- `ad_events_enriched` column names. Adding columns is free; renaming or removing one is breaking.
- The `ad_events` sort key and partitioning.
- Ratio metrics are always `sum(x) / sum(y)` over the group — never an average of per-row or per-day
  ratios, or rollups stop being correct.
