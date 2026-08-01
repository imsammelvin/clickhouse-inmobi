# Architecture Plan

```
inmobi/data (9M ad_events + apps/advertisers/geo_device)
        │  load once
        ▼
┌───────────────────────────────────────────┐
│              CLICKHOUSE                    │
│  ad_events + dims  →  rollup table          │
│  (hour, app, geo_device, advertiser,        │
│   ad_format → sum requests/fills/           │
│   impressions/clicks/revenue)               │
└───────────────────┬─────────────────────────┘
                    │  MCP tools
                    ▼
┌───────────────────────────────────────────┐
│   ORCHESTRATOR (backend) ◀── STARTS HERE    │
│                                              │
│   detect → baseline → attribute revenue     │
│   (requests × fill rate × eCPM) → drill      │
│   down by dimension → significance gate →   │
│   rank → LLM narrates                       │
└──────┬───────────────────────────┬──────────┘
       │ every stage logged         │ diagnosis JSON
       ▼                            ▼
   LANGFUSE                    LIBRECHAT
   (1 trace/incident,          (shows diagnosis +
   stage-by-stage)             follow-up Q&A)

   CLICKSTACK — watches backend latency/errors (separate from Langfuse)
```

## Short version

- **Starts at the orchestrator** (`backend/`). It either detects a metric moving on its own
  (required for the unseen incident) or gets told "check X" for the demo — same pipeline either way.
- **ClickHouse does all the math** — baseline, revenue decomposition, dimension drill-down. The
  orchestrator just calls it and passes results along; it never computes a number itself.
- **LLM only narrates** the final JSON into plain English — no raw data reaches it.
- **Langfuse** wraps the orchestrator: one trace per incident, each stage = a span, the LLM call = a
  generation. This is what proves the investigation to judges.
- **LibreChat** is the only user-facing surface — shows the diagnosis, handles follow-up questions.
- **ClickStack** is separate — it watches the backend service's own health, not the investigation
  logic.
