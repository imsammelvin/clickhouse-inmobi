# Scalability: what is measured, what is converted, what is not

**Owner:** sam · **Date:** 2026-08-02 · For the pitch, and written to be defensible under questioning.

Every number here came from `system.query_log` or from a gate in this repo. Where a figure is a share
rather than an absolute, it says so — one earlier draft of this page quoted an absolute that was really
a sum across several runs, and that is exactly the kind of number a judge asks the follow-up about.

## The claim we can actually defend

**Rows returned to the client are bounded by dimension cardinality, not by event volume.** That is
gated: `criteria` fails the build if any stage streams more than 5,000 rows back, and the flagship
investigation's largest result set is 1,009 rows.

**Rows read are now bounded too, wherever the rollup serves the query.** Two materialized views,
maintained on insert, no manual step:

    mv_rollup_segment_hourly    ad_events             -> rollup_segment_hourly    3,089,172 rows
    mv_rollup_segment_daily     rollup_segment_hourly -> rollup_segment_daily       148,767 rows

The daily table is *derived from* the hourly one rather than being a second independent fan-out, so the
two grains cannot disagree — a derivation cannot drift where two parallel aggregations can.

Measured across a representative call mix (`clickhouse/rollup-bench.json`):

| | raw | rollup |
|---|---|---|
| rows read | 213,625,303 | 3,690,604 |
| bytes read | 2.6 GiB | 117 MiB |
| server time | 41,235 ms | 923 ms |
| peak memory | 884 MiB | 40.5 MiB |

The compression factor is `events_per_day / distinct_attribute_combinations`, so it **improves** with
scale: the rollup grows with dimension cardinality x time, not with events.

## What is converted, and what is not

| Component | Reads the MV | Evidence |
|---|---|---|
| All 10 MCP tools | yes | `servedFrom=rollup:daily:...`, 40-65 ms per call |
| `find_incidents` sweep | yes | 9,446 ms -> 325 ms |
| `detect`, `confirm`, `decompose` | yes | `bun run parity` reports `rollup-served` |
| `localize` | **no** | still scans raw events |
| `residualize` | **no** | still scans raw events |
| `classify` | no, and cannot | `uniqExact(advertiser_id)` is not additive over sums |

So: **asking a question is fast; asking *why* is not yet.** A measurement is 40 ms. A full
investigation is 5-20 s, because `localize` and `residualize` still read raw events and the run makes
~20 round trips to ClickHouse Cloud.

## Why the last two stages are not done

Not time, and not oversight. `detect` and `decompose` were a two-line swap: point the FROM clause at the
rollup, wrap the aggregates. `residualize` is a different shape.

It re-sweeps every dimension **with an exclusion mask** — "everything except Android 15" — and a
pre-aggregated table cannot subtract a segment unless that segment's dimension is part of the key. It is
answerable, from the pair keys, by summing the complement. But it needs three fallbacks (entity
dimensions cannot be paired, three-or-more-dimension cuts exceed the key space, non-additive metrics
never qualify), and the loop is **inherently sequential**: each iteration's exclusion is built from the
previous iteration's chosen cause, so it cannot be parallelised either.

And it is the arithmetic behind the *cleared-as-contamination* list, which is our differentiator. A
wrong residual does not error. It prints a plausible list of segments we claim to have ruled out.

That is the whole reason it is not done: the remaining work is the part where being wrong is invisible,
and we chose not to do it in the hours before a freeze.

## What makes finishing it safe rather than hopeful

`bun run parity` runs the same investigation twice in one process — once on the rollup, once with the
rollup forced off — and compares **every recorded number by label**, not just the headline. 799 evidence
values across five channel scenarios, currently bit-identical.

It also reports **VACUOUS** rather than PASS when no stage actually read the rollup, because the first
version of it silently compared raw against raw and would have blessed anything. A gate that reads green
having compared nothing is worse than no gate.

Two real defects were found by verification rather than by review while wiring the three stages that
are done: a mask constructed without its dimensions, planned against the wrong rollup key; and a second
such site found only by making the field required so the compiler had to point at it. Both would have
returned plausible numbers.

## The honest summary

- The scalability *design* is proven: rows read and rows returned are both bounded by cardinality
  rather than by event count, and the measured delta is 58x on rows and 45x on server time.
- The *conversion* is partial: the tool layer and three of six investigation stages.
- The remaining two stages are a known, scoped, ~2x latency win with a documented approach and a gate
  that can prove it correct. They are not a mystery; they are a decision we deferred.
