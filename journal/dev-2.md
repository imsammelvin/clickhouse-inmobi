# Journal — dev-2

**Single-writer, append-only. Only `dev-2` writes to this file. Newest entry at the bottom.**

This is the handoff to your own next session and to the other three agents. Write it even when you
think nothing happened — especially the loose ends.

---

### YYYY-MM-DD — session N

**Done**
-

**Half-done — where the loose end is**
-

**Blocked on**
-

**Decided, and why** (if it affects another lane, also add it to `goal.md` § 11 and BROADCAST)
-

**Next session, start here**
-

**Branches left open**
-

---

### 2026-08-01 — session 1 (samarth / Lane B)

**Done — T-013: rollup tables + materialized views, and the whole MCP query surface moved onto them.**

Two `SummingMergeTree` targets, two incremental MVs, generated from one dimension registry in
`clickhouse/rollup.ts`:

| table                   | grain            | rows    |
| ----------------------- | ---------------- | ------- |
| `rollup_segment_hourly` | `(hour, dim, val)` | 3,089,172 |
| `rollup_segment_daily`  | `(day, dim, val)`  | ~148k (156,571 pre-merge) |

`mv_rollup_segment_hourly` reads `ad_events` and fans each row out 47 ways (11 single dimensions +
all 36 pairs of the 9 low-cardinality ones). `mv_rollup_segment_daily` is **cascaded off the hourly
table**, not a second MV off `ad_events`: it halves insert-time work, and more importantly the daily
rollup cannot disagree with the hourly one because it is derived from it. Both fire automatically on
every insert into `ad_events`, so a Day-2 load maintains them with no extra step.

**Measured delta (`bun run bench:rollup`, artifact in `clickhouse/rollup-bench.json`).** 11
representative tool calls, run twice through `callTool` — rollup forced off, then on — with cost read
per call from `system.query_log`:

| | raw | rollup | |
| --- | --- | --- | --- |
| rows read | 213,625,303 | 3,689,938 | **57.9x less** |
| bytes read | 2,680.6 MiB | 116.8 MiB | 22.9x less |
| peak memory | 848.2 MiB | 29.9 MiB | 28x less |
| server time | 49,064 ms | 1,041 ms | **47.1x faster** |
| wall clock | 50,591 ms | 1,990 ms | 25.4x faster |

`find_incidents` over the full history: **38.2s -> 1.14s**, 135M rows -> 2.3M. Every other tool call
is now 40-65ms. That 848 MiB peak is the same number in sam's cost report; it is now 30 MiB.

**The grain, because goal.md § 7 proposed the wrong one and I measured before building it.** The plan
called for `(hour, app_id, geo_device_id, advertiser_id, ad_format)`. That key space is so much
larger than the event count that **9M events land on ~9M distinct keys** — the "rollup" would have
been the fact table with extra steps and a second copy of the data. The access pattern is never one
app x one geo x one advertiser; it is one dimension at a time, occasionally two. So the rollup is
long-format — one row per `(bucket, dim, val)` — which is what gets 9M down to 148k and makes cost
grow with *cardinality x time* rather than with events. Entity dimensions (`app_id` 2,000 values,
`advertiser_id` 501) are carried singly but never paired: `app_id x os_version` alone would be 529k
daily / 3.2M hourly rows, more than every other pair combined, to answer questions nobody asks.
This is a **correction to a LOCKED section**, so it needs a decision-log row — see BROADCAST.

**What the rollup will not do, which is the load-bearing part.** Three or more dimensions at once,
`geo_device_id`, an entity dimension paired with anything, a metric referencing a column the rollup
does not sum — all fall back to `ad_events_enriched` and run exactly as before. `planRollup` returns
null rather than approximating; there is no code path that answers with a number the raw scan would
disagree with. Every result now carries `servedFrom` (`rollup:daily:os_version` or `raw`), so which
surface answered is in the response envelope rather than a matter of trust.

**Two hazards found and closed, both silent by nature.**

1. **`DROP PARTITION` does not cascade into a materialized view's target.** The loader's idempotency
   (D-014) rests on drop-then-insert. Leave the rollup's rows in place, re-insert the day, and the MV
   *adds* a second copy — so every rollup-served figure for that day comes back **exactly doubled**,
   with the fact table's own row-count assertion still passing and nothing to notice. `scripts/load.ts`
   now drops `DERIVED_TABLES` partitions inside the same retried unit. The property D-014 bought has
   to be bought again for every derived table.
2. **A derived table's failure mode is being BEHIND its source, and behind does not throw.** A missing
   day reads as a day with no traffic; a half-backfilled table reads as a quiet week. Both are numbers
   a narrative will happily print. So `ensureRollupReady` proves the rollup accounts for exactly as
   many events as `ad_events` holds before anything reads it, once per process, at the same entry
   point as `ensureDatasetBounds`. If it cannot, every plan returns null and the system behaves
   precisely as it did before — slower, and correct.

**How I know it is right: `bun run ch:verify-rollup`, 248 probes, PASS.** It runs the *real* query
path from `mcp/query.ts` twice over identical arguments — rollup forced off, then on — and asserts
they agree. Every metric x every dimension, both grains, the two-dimension cuts, filter+group-by
combinations, prefix and list filters, an explicit baseline window, and the sweep compared
**firing-for-firing against Lane A's raw `scanSegments`** across all default metrics. It also asserts
*which* surface served each probe: without that, a probe that silently fell back would pass by
comparing raw against itself — a green test that checks nothing.

**All other gates re-run green.** `typecheck` clean. `mcp:eval` **16/16 cases, 60/60 gated, 6/6
reported**. `criteria` **4/4**. `bun run diagnose` unchanged in behaviour: 46 windows -> 30 incidents
-> 6 investigated, all four known training incidents found, every report 100% grounded.

**Half-done — where the loose end is.** `investigate` is now the only slow tool, and its cost is
entirely in Lane A's engine stages. From the `diagnose` run's own `system.query_log` attribution:

| stage | queries | rows read | share |
| --- | --- | --- | --- |
| residualize | 25 | 121,770,166 | 36.7% |
| detect | 12 | 72,561,654 | 21.9% |
| confirm (calls `detect`) | 16 | 66,008,845 | 19.9% |
| localize | 5 | 21,722,112 | 6.5% |
| decompose | 10 | 21,722,107 | 6.5% |
| classify | 4 | 15,775,802 | 4.8% |
| **find_incidents** | 10 | **2,286,280** | **0.7%** |

`find_incidents` went from ~40% of the run to 0.7%. **`detect` + `confirm` are 41.8% of what remains
and are the same three-line change** — `detect`'s query is one `GROUP BY event_date` over a mask, which
is 0-2 dimensions, i.e. exactly what the rollup serves. It needs `Mask` to carry the dimension names it
constrains (`segmentPredicate`/`andMask` know them at construction; the `Mask` type just does not
record them) so `planRollup` can be asked. That is T-043 and it is Lane A's file, so I wrote the patch
up in BROADCAST rather than making it.

**A reproducibility bug the gate found, unrelated to the rollup but worth more than it.**
`ch:verify-rollup` ran the *same* call twice on the *same* code path and got two different top-N sets.
Cause: `ORDER BY requests DESC` is not a total order, and the result is then truncated by LIMIT.
Grouping by `app_id` produces 2,000 rows of which 25 are returned, and app traffic is even enough that
the rows at the cut-off routinely tie — so which segments came back depended on how ClickHouse happened
to parallelise the aggregation. In a product whose entire claim is that a judge can re-run a number and
get it back, that is a real defect. Fixed by appending the group columns as a tiebreaker to all four
orderings in `mcp/query.ts` (free — they are already grouped). Re-verified: 248/248, `mcp:eval` 16/16 /
60/60, `criteria` 4/4. **This is the argument for comparison-based testing over snapshot testing: a
snapshot test written against either run would have ratified whichever ordering it happened to see.**

**Blocked on** nothing.

**Decided, and why**
- Long-format `(bucket, dim, val)` over the wide grain goal.md § 7 proposed — measured, not preferred.
  9M events -> ~9M keys at the proposed grain.
- All 36 small-dimension pairs materialised, no entity pairs. The 36 together cost ~78k daily rows and
  make every two-dimension question a lookup; one entity pair would cost 7x that on its own.
- Sums only, never a stored ratio. `avg(fill_rate)` over rolled-up rows is a different number from
  `sum(fills)/sum(events)`, so a stored ratio stops being correct the moment anything aggregates it.
- `SummingMergeTree`, not `AggregatingMergeTree`: all five measures are pure sums, so `sum(revenue)`
  works verbatim and there are no `-Merge` suffixes for a reader (or a judge) to decode.
- `ORDER BY (dim, val, ...)` — leading with the dimension, not with time, which is the opposite of
  `ad_events` and deliberate. Time is already pruned by the daily partition, so the sort key's job is
  to prune the dimension: an `os_version` question touches 8 values out of 4,221 segments.
- One registry generating both the DDL and the planner. A planner that believes a cut exists when the
  MV never wrote it returns zero rows, which reads as a real zero.
- Rollup DDL generated in `clickhouse/rollup.ts` rather than written into `schema.sql`; `schema.sql`
  carries a pointer and the reasoning. The fan-out is 47 expressions that must agree exactly with
  `ROLLUP_DIM_KEYS`, and hand-maintaining both is how they drift.
- `MIN_BASELINE_POINTS` exported from `backend/segments.ts` (one line, `Crosses-lane: loges`) rather
  than restated in `mcp/sweep.ts`. A detection threshold in two places will eventually differ in two
  places, and the symptom is two sweeps disagreeing about whether an incident happened.

**Next session, start here**
1. T-043 for Lane A — `detect` first, it is 42% of the remaining rows for a three-line change.
2. `backend/scan.ts` (`bun run scan`) still uses the raw sweep. Lane A's entry point; one-line swap.
3. The daily rollup sits at 156,571 rows against a merged floor of ~148k because the client sets
   `min_insert_block_size_rows: 0`, so an `INSERT SELECT` writes many small blocks and the cascaded MV
   fires per block. Harmless — every read is a `sum()` and the event totals reconcile exactly — and it
   collapses on merge. Worth an `OPTIMIZE FINAL` before the demo if anyone wants the tidy number.

**Branches left open**
- `dev/samarth/rollup-mv` — not pushed yet.
