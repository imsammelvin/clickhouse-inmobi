# LLM Cost & Token Optimization Log

Why this exists: once LibreChat + the Langfuse MCP connection went live, we could inspect **real**
production trace data instead of guessing. This log records what we found by reading actual traces,
what we fixed, and what's still open — framed for petabyte-scale data, where every LLM round-trip's
token cost compounds across millions of investigations.

Each entry: what we found → what we changed → how we verified it → the number that proves it.

---

## 1. Uncapped `ruledOut` array bloating every `investigate` tool response (FIXED)

**Found:** Pulling real observations via the Langfuse MCP tools (`listObservations`, `getObservation`),
two individual `getObservation` calls came back at 184,994, 185,519, and 300,334 characters — large
enough to hit the tool's own max-output-size limit. Tracing this to source: `mcp/tools.ts`'s
`investigate` tool handler returned the full `inv.ruledOut` array — every segment the pipeline checked
and excluded — as raw JSON in the tool payload. On a real incident this array can hold 800+ entries,
each restating segment name, delta%, and residual.

**Root cause:** the narrative text already _states_ the ruled-out total and the standout ruled-out
reasons in plain English (that's the whole point of T-046/T-045's grounding work) — the raw array was
being sent to the LLM a second time, in full, for no narrative benefit. The LLM never needed to read all
800 entries to summarize "we checked X segments, none of the rest mattered."

**Fix:** cap the array at 15 entries + a count + a note describing the rest, mirroring the truncation
pattern already used elsewhere in the same file (`evidenceIds`, `windows`, `matched`):

```ts
const SHOWN_RULED_OUT = 15;
const ruledOutShown = inv.ruledOut.slice(0, SHOWN_RULED_OUT);
// ...
ruledOut: ruledOutShown,
ruledOutCount: inv.ruledOut.length,
...(inv.ruledOut.length > SHOWN_RULED_OUT
  ? { ruledOutNote: `${inv.ruledOut.length - SHOWN_RULED_OUT} further ruled-out segment(s) not shown here (each with its residual as proof) -- narrative above already states the true total; call export_trace for the full list.` }
  : {}),
```

The full list is never lost — `export_trace` still returns it verbatim for anyone who genuinely needs
the raw data (e.g. an auditor, not the narrating LLM).

**Verified:**

|                                                     | Before         | After                  |
| --------------------------------------------------- | -------------- | ---------------------- |
| `ruledOut` entries in tool response (flagship case) | 840            | 15 (+ count + note)    |
| Approx. response size                               | ~98,000 tokens | ~4,336 tokens (~17 KB) |
| `mcp:eval` gate                                     | 15/15          | 15/15 (no regression)  |
| `criteria` gate                                     | 4/4            | 4/4 (no regression)    |

**~96% token reduction on this one tool call**, with zero loss of narrative correctness or grounding
(every numeral the LLM narrates still resolves to a recorded `Evidence` value).

At petabyte scale, where a single sweep can flag anomalies across thousands of segments, this isn't a
minor trim — it's the difference between a response an LLM can read in one context window and one that
can't be narrated at all without truncation or a second round-trip.

---

## 2. Langfuse cost tracking was silently $0 on every real call (FIXED — visibility, not reduction)

**Found:** every observation in Langfuse for the live DeepSeek traffic (`deepseek-v4-flash` and
`deepseek-chat` as the two `providedModelName` values actually seen in production) showed `totalCost:
0`. Not because DeepSeek is free — because Langfuse can only calculate cost from usage tokens if it has
a registered **Model** definition (`matchPattern` + price per usage type) for that model name. DeepSeek
had none. This is purely a Langfuse-project-side concern — LibreChat only forwards the model name and
token counts; it has no bearing on Langfuse's own cost math.

**Extra wrinkle:** DeepSeek reports three distinct token buckets, not two — cache-miss input, cache-hit
input (`input_cache_read`, ~50x cheaper), and output. Langfuse's cost engine matches usage-detail keys
_exactly_ against a model's per-usage-type prices (confirmed via Langfuse's own docs on the
[usage-details contract](https://langfuse.com/docs/model-usage-and-cost#usage-details-contract) and
[pricing tiers](https://langfuse.com/docs/model-usage-and-cost#pricing-tiers)) — a flat `inputPrice`
alone would either ignore the cache-read bucket (undercounting cost) or price it at the full cache-miss
rate (overcounting by ~50x). We registered a single default pricing tier with all three buckets priced
individually, instead of relying on the flat `inputPrice`/`outputPrice` fields.

**Fix:** registered via Langfuse's `createModel` API:

```
modelName:    deepseek-v4-flash
matchPattern: (?i)^(deepseek-v4-flash|deepseek-chat)$
unit:         TOKENS
pricingTiers: [{
  name: "Default", isDefault: true, priority: 0, conditions: [],
  prices: {
    input:             0.14 / 1_000_000   // cache-miss input, per DeepSeek's published pricing
    output:            0.28 / 1_000_000
    input_cache_read:  0.0028 / 1_000_000 // cache-hit input, ~50x cheaper
  }
}]
```

Pricing pulled live from DeepSeek's own pricing page (not guessed).

**Known open assumption (documented, not hidden):** DeepSeek's pricing page documents `deepseek-v4-flash`
and `deepseek-v4-pro` by name; it does not separately document `deepseek-chat`, even though that's one of
the two model names actually observed in our traces. We matched `deepseek-chat` to the `deepseek-v4-flash`
price tier as the best available assumption (flash is DeepSeek's general-purpose chat-tier model) rather
than leave it unpriced. If DeepSeek confirms `deepseek-chat` is actually routed to the pricier `v4-pro`
tier, this needs a second model definition with a distinct `matchPattern`.

**Verification note:** Langfuse only applies cost inference to generations logged _after_ a model
definition exists — it does not retroactively price historical traces. To confirm this is working,
ask a fresh question through LibreChat and check that the resulting observation's `totalCost` is
non-zero (was unconditionally `$0` before this change).

**Why this matters for the pitch:** without this, we could observe token _counts_ growing but never
translate that into a dollar figure — cost attribution (`mcp/cost.ts`) already does this rigorously for
ClickHouse compute; this closes the same gap on the LLM side.

**Confirmed live** (2026-08-01, ~30 min after registering the model): 20 real generations,
410,350 total tokens, **$0.020 total cost** — all attributing per-call now, versus unconditional `$0`
before.

---

## 3. Cold-start-per-session is the real cost driver, not per-turn resends (MEASURED — partially open)

**Found:** pulling the raw `input`/`output` for individual observations (not just the Langfuse UI list
preview, which only shows the first message of a multi-turn `input` array and can look misleadingly
stale) showed the actual cost shape of one real conversation:

| Call in session | `input` (cache-miss) | `input_cache_read` (cache-hit) | Notes                                                           |
| --------------- | -------------------- | ------------------------------ | --------------------------------------------------------------- |
| 1st (cold)      | 26,088               | 0                              | Full system prompt + tool schemas + history, nothing cached yet |
| 2nd             | 5,188                | 27,008 (~84%)                  | Prior turn's prefix reused at ~50x cheaper cache-hit rate       |
| 3rd             | 3,073                | 27,008 (~89%)                  | Same reused prefix, only the new turn is cache-miss             |

**This is good news first:** DeepSeek's prompt caching is genuinely working — steady-state turns in a
session are already cheap, contradicting the earlier (pre-measurement) worry that every round-trip
resends full history at full price. The real fixed cost is the **one uncached first call per session**,
paid once, not per-turn.

**What inflated that one first call in this sample:** the system message carried a ~1,900-word
"Conversation Summary/Checkpoint" that was leftover context from a _different, unrelated_ prior
conversation (another teammate's earlier Android-15 investigation) — because the LibreChat conversation
thread was continued by a different person during testing rather than started fresh. That's a
session-hygiene issue on the client side, not a bug in our MCP/backend code — flagged to Lane D
(BROADCAST, 2026-08-01) rather than fixed here, since it isn't ours to change.

**Still open, ours to act on if we want to shave the cold-start further:** our own MCP tool schema
definitions (`mcp/tools.ts`, 10 tools with parameter descriptions) are part of that same uncached
first-call payload every session. We chose descriptive, information-dense tool/parameter descriptions
deliberately (they're what stops the model from re-deriving or mis-averaging a number — see the
`get_metric`/`compare_periods` caveats) and caching already amortizes their cost after turn one, so
trimming them is a low-value, correctness-risking lever. Not planned unless cold-start cost becomes a
real problem at higher session volume.

---

## 4. `describe_data` re-scanned the dataset on every call, even mid-session (FIXED)

**Found:** `describe_data` (`mcp/tools.ts`) runs one real ClickHouse aggregate over the whole
`ad_events_enriched` window — a full-table scan for min/max date, row counts, sums. Its own tool
description tells the model to "call it once at the start of a conversation," but nothing enforced
that: a multi-turn agent loop (see §3's 15-round-trip pattern) can call it again mid-session, and
every repeat call paid for the same scan to get back the exact same, unchanging answer — the loaded
dataset never changes mid-session.

**Fix:** memoized on the `Session` object (`mcp/trace.ts`), the same pattern already used for
`ensureDatasetBounds` (`private bounds?`) — a `getOverview()` method with a `private overview?`
cache slot, generic rather than tied to one result type so any other pure per-session read can reuse
the same slot later:

```ts
getOverview<T>(compute: () => Promise<T>): Promise<T> {
  this.overview ??= compute();
  return this.overview as Promise<T>;
}
```

`describeData`'s handler now calls `session.getOverview(() => datasetOverview(ledger))` instead of
`datasetOverview(ledger)` directly. No new cache-invalidation logic needed — the dataset is fixed for
the life of a session, so there's nothing that can go stale.

**Verified** against real ClickHouse, not just typechecked: called `describe_data` twice in one
session — first call issued **1 query**, second issued **0**, and both returned a byte-identical
payload. `mcp:eval` 16/16 (gated 60/60, 100%) and `criteria` 4/4, both unchanged.

**Why this matters for the pitch:** removes a guaranteed, full-table-scan round-trip per repeat ask —
free at today's data volume, and the win grows directly with dataset size, which is the same
scale-invariance argument as T-013's rollup tables, just on the LLM-tool side instead of the query
side.

---

_Log format: add new entries above this line as further optimizations land. Each entry should include
what was found (with a source — a real trace, not a hypothesis), the concrete fix, and a verified
before/after number._
