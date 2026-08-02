# LLM Cost & Token Optimization

Once LibreChat and the Langfuse MCP connection went live, we inspected **real** production trace data
directly rather than guessing — token cost that compounds across millions of investigations at
petabyte scale is worth measuring precisely, not estimating.

## Capping the largest tool response

`investigate`'s `ruledOut` array — every segment the pipeline checked and excluded — can hold 800+
entries on a real incident, each restating segment name, delta%, and residual. The narrative text
already states the ruled-out total and the standout reasons in plain English, so the raw array added
no narrative value being sent to the model in full a second time.

Capped at 15 entries + a count + a note describing the rest, mirroring the same pattern already used
elsewhere in the tool layer (`evidenceIds`, `windows`, `matched`):

```ts
const SHOWN_RULED_OUT = 15;
const ruledOutShown = inv.ruledOut.slice(0, SHOWN_RULED_OUT);
```

The full list is never lost — `export_trace` still returns it verbatim for an auditor who needs the
raw data.

**Result on the flagship incident:**

|                                          | Before         | After                  |
| ---------------------------------------- | -------------- | ---------------------- |
| `ruledOut` entries in tool response      | 840            | 15 (+ count + note)    |
| Approx. response size                    | ~98,000 tokens | ~4,336 tokens (~17 KB) |
| `mcp:eval` gate                          | 15/15          | 15/15                  |
| `criteria` gate                          | 4/4            | 4/4                    |

**~96% token reduction on this one tool call**, with zero loss of narrative correctness or grounding —
every numeral the LLM narrates still resolves to a recorded evidence value.

## Real dollar cost attribution

Every generation is registered against DeepSeek's actual published pricing, matched per usage-type
bucket (cache-miss input, cache-hit input at DeepSeek's cache discount, and output) rather than a
single flat rate, so cost tracking reflects real DeepSeek prompt-caching economics rather than an
approximation:

```
modelName:    deepseek-v4-flash
matchPattern: (?i)^(deepseek-v4-flash|deepseek-chat)$
unit:         TOKENS
pricingTiers: [{
  name: "Default", isDefault: true, priority: 0, conditions: [],
  prices: {
    input:             0.14 / 1_000_000
    output:            0.28 / 1_000_000
    input_cache_read:  0.0028 / 1_000_000
  }
}]
```

Confirmed live in production: 20 real generations, 410,350 total tokens, **$0.020 total cost** —
attributed per call.

## Prompt caching is doing real work

Reading raw `input`/`output` for individual observations (not just the summarized preview) confirmed
DeepSeek's prompt caching is working as intended in production — steady-state turns within a session
are cheap:

| Call in session | cache-miss input | cache-hit input |
| ---------------- | ----------------- | ----------------- |
| 1st              | 26,088             | 0                   |
| 2nd               | 5,188              | 27,008 (~84%)       |
| 3rd               | 3,073              | 27,008 (~89%)       |

The real cost is the one uncached first call per session, paid once — not per turn.

## Removing a redundant full-table scan

`describe_data` runs one ClickHouse aggregate over the whole dataset window. Since the loaded dataset
never changes mid-session, its result is memoized on the session object the same way `ensureDatasetBounds`
already was:

```ts
getOverview<T>(compute: () => Promise<T>): Promise<T> {
  this.overview ??= compute();
  return this.overview as Promise<T>;
}
```

Verified against real ClickHouse: calling `describe_data` twice in one session now issues **1 query**
then **0**, returning a byte-identical payload both times. `mcp:eval` 16/16 (gated 60/60, 100%) and
`criteria` 4/4 unchanged. This removes a guaranteed full-table-scan round-trip on every repeat ask, and
the win grows directly with dataset size — the same scale-invariance argument as the rollup tables,
applied on the LLM-tool side instead of the query side.
