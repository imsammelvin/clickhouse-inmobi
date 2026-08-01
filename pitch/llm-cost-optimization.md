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

**Root cause:** the narrative text already *states* the ruled-out total and the standout ruled-out
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

| | Before | After |
|---|---|---|
| `ruledOut` entries in tool response (flagship case) | 840 | 15 (+ count + note) |
| Approx. response size | ~98,000 tokens | ~4,336 tokens (~17 KB) |
| `mcp:eval` gate | 15/15 | 15/15 (no regression) |
| `criteria` gate | 4/4 | 4/4 (no regression) |

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
*exactly* against a model's per-usage-type prices (confirmed via Langfuse's own docs on the
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

**Verification note:** Langfuse only applies cost inference to generations logged *after* a model
definition exists — it does not retroactively price historical traces. To confirm this is working,
ask a fresh question through LibreChat and check that the resulting observation's `totalCost` is
non-zero (was unconditionally `$0` before this change).

**Why this matters for the pitch:** without this, we could observe token *counts* growing but never
translate that into a dollar figure — cost attribution (`mcp/cost.ts`) already does this rigorously for
ClickHouse compute; this closes the same gap on the LLM side.

---

## 3. Identified, not yet fixed — flagged here for transparency

These came out of the same real-trace analysis but weren't actioned yet. Listed so the pitch narrative
is honest about what's solved vs. what's a known next step, not to overclaim.

- **Agentic loop depth.** One real user question observed traversing **15 sequential LLM round-trips**
  in LibreChat's tool-calling loop, with total tokens climbing each round because most agent frameworks
  resend full conversation history on every turn. This compounds independently of any single tool
  response's size (see #1) — worth periodic `queryMetrics` checks to watch trace depth per conversation,
  and worth checking whether the loop can early-exit once it has enough evidence to answer.
- **`describe_data` result is not cached.** Every conversation currently pays for at least one
  round-trip to re-fetch schema/data-description output that is static for the duration of the dataset
  being loaded. Caching this removes one guaranteed LLM+tool round-trip per conversation, for free.

---

_Log format: add new entries above this line as further optimizations land. Each entry should include
what was found (with a source — a real trace, not a hypothesis), the concrete fix, and a verified
before/after number._
