# Scalability: what is measured

Every number here came from `system.query_log` or from a gate in this repo. Where a figure is a share
rather than an absolute, it says so.

## The core claim

**Rows returned to the client are bounded by dimension cardinality, not by event volume.** Gated:
`criteria` fails the build if any stage streams more than 5,000 rows back, and the flagship
investigation's largest result set is 1,009 rows.

**Rows read are bounded too, wherever the rollup serves the query.** Two materialized views,
maintained on insert, no manual step:

    mv_rollup_segment_hourly    ad_events             -> rollup_segment_hourly    3,089,172 rows
    mv_rollup_segment_daily     rollup_segment_hourly -> rollup_segment_daily       148,767 rows

The daily table is derived from the hourly one rather than a second independent fan-out, so the two
grains cannot disagree.

Measured across a representative call mix (`backend/clickhouse/rollup-bench.json`):

|             | raw         | rollup    |
| ----------- | ----------- | --------- |
| rows read   | 213,625,303 | 3,690,604 |
| bytes read  | 2.6 GiB     | 117 MiB   |
| server time | 41,235 ms   | 923 ms    |
| peak memory | 884 MiB     | 40.5 MiB  |

That's a **58x reduction in rows read** and a **45x reduction in server time**. The compression factor
is `events_per_day / distinct_attribute_combinations`, so it **improves** with scale: the rollup grows
with dimension cardinality x time, not with events.

Every MCP tool call reports which surface actually answered it (`servedFrom=rollup:daily:...`),
so which path served a given request is never a matter of trust — it's in the response envelope,
and 40-65 ms per call is typical. `find_incidents`'s full sweep runs in **325 ms**, down from
9,446 ms unrolled.

## Why this is safe to trust, not just fast

`bun run parity` runs the same investigation twice in one process — once on the rollup, once with the
rollup forced off — and compares **every recorded number by label**, not just the headline. 799
evidence values across five channel scenarios, bit-identical.

It also reports **VACUOUS** rather than PASS when no stage actually read the rollup, so a gate reading
green always means it compared something real, not a rollup path silently falling back to raw.

## Summary

The scalability design is proven: rows read and rows returned are both bounded by cardinality rather
than by event count, and the measured delta is 58x on rows and 45x on server time — a margin that
grows, not shrinks, as the dataset scales up.
