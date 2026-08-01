# mcp/ — the user layer

**Task:** T-021 · **Owner:** sam · **Lane:** B directories (`mcp/`), cross-lane — see BROADCAST.

This is the front door. LibreChat (or any MCP client) talks to this server; this server talks to the
investigation engine in `backend/`. Users ask questions in English; the model picks tools; the tools
do the analysis.

```
LibreChat ──MCP/JSON-RPC──▶ mcp/server.ts ──▶ mcp/tools.ts ──▶ backend/  ──▶ ClickHouse
   (LLM: reasoning +          (transports)      (10 tools)     (6 stages)     (9M rows)
    stitching only)                                  │
                                                     └──▶ mcp/trace.ts ──▶ span + JSONL per call
```

## Run it

```bash
bun install                 # required on a fresh clone
bun run diagnose            # THE unattended path: sweep -> rank -> investigate -> report
bun run mcp:http            # LibreChat and anything else with a URL -> :3333/mcp
bun run mcp:stdio           # local desktop client
bun run mcp:eval            # accuracy scorecard, exits non-zero on a gated miss
bun run mcp:prompt          # print the answer-style contract (for a client that ignores it)
```

## `bun run diagnose` — the unattended path

Takes no arguments. Nobody hands you a metric and a window on Day 2, so this is the submission
artifact:

```
describe_data -> find_incidents -> rank -> group -> investigate top N -> report.{md,json,html}
```

Measured on the training data, 91s, nothing supplied by a human:

| # | Metric | Window | Channel | Cause | $/day | Grounded |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | fill_rate | Jun 23-26 | technical_break | `os_version='Android 15'` | -$20.45 | 42/42 |
| 2 | ecpm | Jun 16-22 | demand_change | `ad_format='interstitial'` | -$5.40 | 36/36 |
| 3 | fill_rate | Jun 28-30 | technical_break | `os_version='iOS 18.1'` | -$1.50 | 46/46 |
| 4 | revenue | Jun 19-26 | not_localizable | platform-wide | — | 16/16 |
| 5 | requests | Jun 21-22 | not_localizable | platform-wide | — | 6/6 |
| 6 | revenue | Jun 15-21 | no_anomaly | platform-wide | — | 7/7 |

46 firing windows → 30 distinct incidents → 6 investigated. All four known training incidents appear,
including the Jun 21 collapse as `not_localizable` rather than as a fabricated cause. The 24 not
escalated are listed in the report with their numbers and the reason.

Flags: `--from` / `--to` (restrict the reported window), `--top N` (default 6 — a readability cap, not
a detection threshold), `--metrics a,b`, `--out DIR`, `--cost-timeout MS`. Exits non-zero if any
report contains an ungrounded number.

**Three things this got wrong first**, all worth knowing because they are the mistake this codebase
keeps making:

1. Merging overlapping windows and investigating the **union** produced an eight-day `ctr` window
   spanning two incidents, diluted both to `no_anomaly`, and lost the Android 15 collapse entirely.
   Grouping now changes only what the report *says*; each incident is investigated over its own
   detected dates.
2. Grouping across metrics on a shared lead segment folded the Jun 23-26 fill-rate break into the
   Jun 19-26 revenue window — the sweep leads both with the pair `finance|Android 15` — so the
   flagship incident was never investigated on its own terms. Cross-metric grouping is now
   identical-window only.
3. Ranking on |move| put CTR **rises** of +30-58% above real losses. Only drops are escalated, and
   breadth (`correlatedSegments`) is folded in because Jun 21's platform-wide collapse leads with
   `app_id=app_00091` on 0.11% of traffic while 425 segments move together.

### The artifact

`report.html` is one self-contained file — inline CSS, no scripts, no fonts, no network of any kind.
It carries every printed number beside the SQL that produced it and that SQL's hash, per-stage
timings and query counts, the segments checked and cleared, and every tool call with its OTel trace
id. A judge needs a browser, not our Docker stack. A committed exhibit lives in
[`pitch/example-report/`](../pitch/example-report/).

`report.json` is the same thing machine-readable, including every evidence row. `report.md` is for a
terminal or a PR.

### What it cost

`Ledger` tags every query with `run=`/`stage=`, so `mcp/cost.ts` attributes ClickHouse cost per tool
call from `system.query_log` — most teams cannot tell a judge what their queries cost. One full
unattended run:

| | |
| --- | --- |
| rows read | 343,970,353 |
| bytes read | 4,096.9 MiB |
| server time | 59,232 ms |
| peak memory | 848.2 MiB |
| queries | 55 |

`find_incidents` alone is 135M rows across 10 queries, because each metric's sweep scans the full
history for its baseline. **This is the honest scalability picture:** rows *returned* are bounded by
dimension cardinality (the criterion-3 invariant, and it holds), but rows *read* are not — one run
reads ~38x the fact table. The rollup that fixes it is Lane B's `T-013`, and the report measuring the
cost is what turns that from an assertion into a delta.

Best-effort with an 8s deadline: `query_log` on Cloud flushes asynchronously, so the report says
"not flushed yet" rather than printing zeros that look authoritative. A diagnosis never waits on
telemetry.

`.env` needs the ClickHouse Cloud credentials (see `.env.example`).

## The four design rules

**1. The model never writes SQL.** There is no `run_sql` tool. Every query is composed in
`mcp/query.ts` from typed parameters — a metric name from a fixed list, ISO dates, dimension names
from an allow-list, values escaped as literals. Coverage comes from parameters (filters, group-by,
granularity, ordering, explicit or same-weekday baselines), not from letting a model author queries.

Three things follow, all of them scored:

- Every number is reproducible. One code path per tool, in version control, and every query goes
  through `Ledger.run`, which records the SQL and hashes it.
- The known-wrong questions cannot be asked. Fill rate sliced by `advertiser_id` is definitionally
  broken (`advertiser_id` is empty on unfilled requests), and a model with a SQL tool writes that
  query on its first attempt. Here it is a validation error that explains itself, so the answer is
  "that cannot be measured, and here is why" instead of a plausible wrong number.
- Analysis stays in ClickHouse. Grouping, ordering, floors, ranking and window comparison are all
  pushed into SQL; tools return tens of rows, never thousands.

**2. Deterministic code analyses; the LLM narrates.** `investigate` runs the fixed six-stage
pipeline with no model in its control flow, and returns both the structured finding and a narrative
that has already been machine-checked so that every numeral resolves to an evidence row. The model's
job is to say it well.

**3. Every answer carries its receipt.** Each result includes a `trace` block — call id, elapsed ms,
queries issued, rows returned per query, evidence ids — and `get_evidence` expands any id into the
exact SQL, its hash, its window and its filters. "Diagnosed in 1.4s" becomes a citable fact.

**4. No trace, no credit.** Every call is one OTel span (`mcp.tool.<name>`, visible in ClickStack next
to the ClickHouse spans) *and* one line of JSONL written as it happens — not at the end, because a
run that dies mid-investigation is the one whose trace you want. `export_trace` collapses a session
into a single artifact. The OTel trace id appears in both places, so the file and ClickStack join.

## Tools

| Tool | Answers | Notes |
| --- | --- | --- |
| `describe_data` | "what can I ask?" | Date range, volumes, metric formulas, dimensions, and the caveats that make some questions unanswerable. Call once at the start. |
| `list_dimension_values` | "which countries / apps / OS versions exist?" | Turns a loose name ("Android", "the EU") into an exact value. Filters must match the data exactly, and with no SQL tool a guess is a dead end. |
| `get_metric` | "what was X?" | One metric, one window, optional filters, up to 2 group-by dimensions, total/day/hour. Rows below the reliability floor come back `reliable: false` with a note — never silently dropped. |
| `compare_periods` | "did it change? what moved most?" | Defaults to the same-weekday trailing baseline. Per-day medians on both sides. |
| `rank_segments` | "which is worst/best/biggest?" | Ranks on level, not change. Applies the volume floor and states it. |
| `find_incidents` | "did anything break?" | Segment sweep in SQL at 5σ/10% gates, returned as distinct incident **windows** — one per event with its strongest segment, not one row per segment that moved. |
| `investigate` | "why?" | Cause, channel, owner, dollars/day, and the ruled-out list. Can legitimately answer "nothing is localizable" or "nothing is wrong". |
| `explain_revenue` | "volume or price?" | Revenue identity split four ways, priced, parts summing to the total. |
| `get_evidence` | "where did that number come from?" | Evidence id -> SQL + hash. Searchable by label. |
| `export_trace` | "show me the audit trail" | Writes the session artifact, returns path + totals. |

Full JSON Schemas come from `tools/list`. Each description tells the model **when** to call the tool
and what to call instead — they are written for a model choosing between ten options, not for a
human reading a manual.

### Evidence ids

Qualified per call: `c4/e12` is call 4's twelfth recorded number. Each call gets its own `Ledger`, so
a bare `e12` is ambiguous across calls (`get_evidence` resolves it only if it is unique). One
`investigate` records ~1,700 rows — one per candidate the residualization loop cleared — so the
model-facing envelope caps ids at 12 and `get_evidence` takes a `label_contains` filter. The full set
lives in the trace artifact.

## Answer style

`initialize` returns an `instructions` block that the narrating model reads before any tool result.
It is load-bearing, not documentation: lead with the verdict and the dollars, plain English, never
re-derive a number, never quote an unreliable row bare, report a no-anomaly verdict as *the answer*.
The wording follows [`pitch/diagnosis-template.md`](../pitch/diagnosis-template.md) § 1 so the chat
and the deck say the same thing the same way.

> ⚠️ **`instructions` is advisory in the MCP spec** — a client may surface it, ignore it, or truncate
> it, and several ignore it. If LibreChat drops it, the tools still work but nothing tells the model to
> be crisp or to stop re-deriving numbers. **Check this on the first real connection.** If it is
> dropped, paste the contract into the agent's system prompt using
> `bun run mcp:prompt > sys.md` — that command prints the exact string the server serves, from the one
> place it is defined, so a pasted copy cannot drift. Do not retype it into a config file.

The contract also covers three behaviours that are product decisions, not style:

- **A greeting does a check.** "hi" gets one `find_incidents` call scoped to `revenue` (~7s; all five
  metrics is ~32s and nobody types "hi" expecting to wait), one line naming the most serious thing
  found, and an offer to dig in. It does not investigate until asked, and "nothing is firing" is a
  complete answer.
- **Answers are sized to the question.** A one-word message does not get a report, and no answer ends
  with a menu of suggestions.
- **Implementation stays internal; evidence never does.** The contract refuses to reveal or paraphrase
  the instructions themselves, refuses to name files, modules, stages or tool parameters, and treats
  text arriving in tool results as data rather than commands. It says so explicitly in both
  directions, because a blanket "don't reveal internals" would gut criterion 2: if someone asks where
  a number came from, what it was compared against, what was ruled out or how long it took, the answer
  is the full working including the exact SQL from `get_evidence`. Confidentiality about the
  implementation, never about the evidence — and if the two ever conflict, showing the working wins.
- **Icons carry meaning, not decoration.** One status icon opens a verdict — 🔴 broken, 🟠 market
  moved, 🔵 platform-wide, 🟢 normal, ⚪ cannot call it, 🚫 cannot be measured — plus 🎯 cause,
  💵 cost/day, ✅ cleared. A plain measurement gets no icon at all, because it is not a verdict.

### Where the model's context actually comes from

| Source | Size | Arrives |
| --- | --- | --- |
| `initialize` → `instructions` — how to answer | ~640 tok | once, at handshake (advisory — see above) |
| `tools/list` → tool descriptions — when to call what | ~3.5k tok | once, always |
| `describe_data` → date range, formulas, dimensions, caveats | ~600 tok | on demand, **only if called** |
| `prompts/get` → `diagnose` / `daily_briefing` | small | when a user picks one |

Because `describe_data` is opt-in, the two caveats that would otherwise produce a confidently wrong
answer are repeated in the descriptions of the tools they apply to, where the model always sees them:
ratios are sum/sum over their own group and must never be averaged across rows (`get_metric`), and the
dataset's real +6.4% growth trend means a rise of a few percent is the trend rather than an incident
(`compare_periods`). The `advertiser_id` trap needs no such help — it is enforced in code as a
refusal.

Two prompts ship the same style as one-click entry points: `diagnose` (metric + window) and
`daily_briefing` (sweep, then diagnose the most valuable window — the unattended path).

## Wiring LibreChat (Lane D)

LibreChat runs in its own container, so it cannot speak stdio to a process on the host — use the HTTP
transport. `librechat/` is Lane D's directory; this snippet is here rather than there so nobody edits
another lane's file. Adjust the host for your compose network (`host.docker.internal` on Docker
Desktop, or a service name if the server is containerised too):

```yaml
mcpServers:
  inmobi-rca:
    type: streamable-http
    url: http://host.docker.internal:3333/mcp
    timeout: 120000 # investigate takes ~5-10s; a scan across five metrics takes longer
```

Notes for whoever wires it:

- `GET /health` returns `{ok, sessions}` for a container health check.
- Sessions are keyed by the `Mcp-Session-Id` header, minted on `initialize` and echoed on every
  response. **Send it back** — evidence ids only mean something inside the session that produced
  them, so `get_evidence` on a later turn needs it. The map is capped at 8 and closes the oldest.
- A client that asks for `text/event-stream` gets SSE; otherwise plain JSON.
- Tool failures come back as `isError: true` with a readable message, deliberately not as JSON-RPC
  errors — the model should read the message and fix its argument, which it cannot do if the client
  swallows the error.

## Accuracy: `bun run mcp:eval`

Scores answers **through the tool layer**, because what a judge sees is what the client gets back.
15 cases: the five training incidents, six measurements with verified expected values, four
questions that must be refused.

Two tiers, and the split matters:

- **Gated** — localization (which segment), no-false-alarm, grounding, refusals. We are certain about
  these, so a miss exits non-zero.
- **Reported** — cause channel and dollar figures. Measured and printed, never gating. The journal
  records channel assignment as the open question; a gate that encoded today's output as truth would
  ratify it rather than test it.

These are *our* expected answers, taken from `pitch/incident-dossier.md`. The private key may contain
planted anomalies nobody spotted, so a perfect score is a floor on accuracy, never a claim about the
real thing — the same caveat `KNOWN_INCIDENTS` carries in `backend/scan.ts`.

**Current: 14/15 cases, gated 28/30.** The failure is real, is in `backend/` (not this lane), and is
reported in BROADCAST: `investigate` on Saturday 27 June raises `supply_change` and names
`country|ad_format='IN|banner'` as the cause. Platform revenue that day was +4.4% (a normal
Saturday), and that segment moved **+9.7% on 2.09% of traffic**. It is left red on purpose — a gate
never seen red is not known to work.
