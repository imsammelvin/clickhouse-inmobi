/**
 * MCP over JSON-RPC 2.0 — transport-agnostic request handling.
 *
 * Hand-rolled rather than pulled from the SDK, deliberately: the wire format is a small, stable
 * JSON-RPC surface (`initialize`, `tools/list`, `tools/call`, `prompts/*`, `ping`), and adding a
 * dependency here means touching `package.json` and `bun.lock` — the two files AGENTS.md § 2 calls
 * conflict magnets — a few hours before a code freeze, for code we would have had to write adapters
 * for anyway. It also lets one dispatcher serve both transports: stdio for a local client, and
 * streamable HTTP because LibreChat runs in its own container and cannot speak stdio to a process
 * outside it.
 *
 * The `instructions` block below is load-bearing, not documentation. The narrating model reads it
 * before it reads any tool result, and it is where "crisp" is enforced: lead with the verdict, use
 * the numbers the tools computed, never re-derive them, and report a no-anomaly verdict as the
 * answer rather than searching for something to blame. The prose contract follows
 * pitch/diagnosis-template.md § 1, so the chat answer and the deck say the same thing the same way.
 */
import { callTool, TOOLS } from "./tools";
import type { Session } from "./trace";

/** Protocol revision we implement. A client asking for another version gets ours back. */
const PROTOCOL_VERSION = "2025-06-18";

const SERVER_INFO = {
  name: "inmobi-rca",
  title: "InMobi marketplace root-cause analyst",
  version: "0.1.0",
};

/**
 * How to answer. Written for the model, in the second person, and kept short on purpose — a long
 * style guide gets skimmed.
 */
const INSTRUCTIONS = `
You are the analyst for InMobi's ad marketplace. You have tools that measure, compare, rank, sweep
for anomalies, and run a full root-cause investigation. The tools do the analysis; you do the
explaining. You are talking to a revenue manager, not an engineer.

HOW TO ANSWER
- Lead with the answer. One sentence: what happened, and what it is worth in dollars per day. Then
  why, then what was ruled out. Never open with preamble, method, or a restatement of the question.
- Plain English and whole numbers where you can: "we filled 75% of requests instead of the usual
  78.5%, worth about $18 a day", not "fill_rate delta -3.52pp".
- Short. A typical answer is a few sentences or a handful of short lines. Do not dump the tool's
  JSON, do not narrate which tools you called, and do not add a summary of your own summary.
- Say what a slice is worth relative to the whole: "-35 points on about 1 in 10 requests" beats
  "-35.04pp".

NUMBERS
- Only state numbers that came from a tool result in this conversation. Never estimate, round into a
  different claim, or carry a number over from a different window or segment than the one you are
  describing. If you need a figure you do not have, call a tool.
- 'investigate' returns a machine-checked narrative. Prefer its wording and its figures. If its
  grounding.ok is false, say the answer could not be verified instead of repeating it.
- If a row comes back with reliable=false, either say the sample is too small to call or do not use
  the number. Do not quote it bare.
- When asked where a number came from, call get_evidence and give the SQL — do not paraphrase it.

WHAT NOT TO CLAIM
- "No anomaly", "not localizable" and "too little data to call this" are real answers. Report them
  plainly and stop. Do not go looking for a second-best culprit the engine declined to name.
- A metric that moved and a cause are different things. A segment that only looks broken because the
  real cause sits inside it is dilution, and 'investigate' tells you which is which — say so.
- Never attribute anything to an external event (a match, a holiday, a competitor). That data is not
  in this dataset.

WHERE TO START
- Vague or unknown terms, or a first question about a metric or dimension: describe_data, then
  list_dimension_values to turn a loose name ("Android", "the EU") into an exact value.
- "What was X?" -> get_metric. "Did it change / what moved?" -> compare_periods.
  "Which is worst/best?" -> rank_segments. "Did anything break?" -> find_incidents.
  "Why?" -> investigate. "Volume or price?" -> explain_revenue.
`.trim();

interface Prompt {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  build: (args: Record<string, string>) => string;
}

const PROMPTS: Prompt[] = [
  {
    name: "diagnose",
    title: "Diagnose a moving metric",
    description:
      "Full root-cause pass on one metric and window, answered in the house style: what happened, " +
      "what it is worth, why, and what was checked and cleared.",
    arguments: [
      { name: "metric", description: "Metric that moved, e.g. fill_rate", required: true },
      { name: "from", description: "First day of the window (YYYY-MM-DD)", required: true },
      { name: "to", description: "Last day (YYYY-MM-DD). Defaults to `from`.", required: false },
    ],
    build: (a) =>
      `Investigate ${a.metric} between ${a.from} and ${a.to ?? a.from}. Use the investigate tool. ` +
      `Answer in four short blocks: what happened and what it costs per day; why, naming the ` +
      `segment and how much of traffic it carries; whether something is broken or the market moved, ` +
      `with the checks that decided it; and what was checked and ruled out. If the engine reports no ` +
      `anomaly or no localizable cause, say exactly that and stop.`,
  },
  {
    name: "daily_briefing",
    title: "What happened, unprompted",
    description:
      "Sweep for incidents with no window given, then diagnose the most valuable one. This is the " +
      "unattended path — nobody hands you a metric and a date.",
    arguments: [
      { name: "from", description: "Optional first day to report on (YYYY-MM-DD)", required: false },
      { name: "to", description: "Optional last day (YYYY-MM-DD)", required: false },
    ],
    build: (a) => {
      const window =
        a.from || a.to
          ? ` Restrict reporting to ${a.from ?? "the start of the data"}..${a.to ?? "the end of the data"}.`
          : "";
      return (
        `Call find_incidents to see what moved.${window} Then investigate the window with the ` +
        `largest dollar impact and report it in the house style. List the other windows as one line ` +
        `each — metric, dates, lead segment — without investigating them. If nothing cleared the ` +
        `gates, say the platform was normal and name the strictest thing you checked.`
      );
    },
  },
];

// -------------------------------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});

const fail = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });

export const RPC = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * Handle one JSON-RPC message. Returns `null` for notifications (no `id`), which per JSON-RPC must
 * not be answered — a stray response to `notifications/initialized` makes some clients disconnect.
 */
export async function handleRpc(
  session: Session,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;
  const method = req.method;

  if (!method || typeof method !== "string") {
    return isNotification ? null : fail(id, RPC.InvalidRequest, "Missing `method`.");
  }

  // Notifications: acknowledge by doing nothing, and never reply.
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize": {
      const requested = (req.params?.protocolVersion as string | undefined) ?? PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = req.params?.name;
      if (typeof name !== "string") {
        return fail(id, RPC.InvalidParams, "`params.name` must be a tool name.");
      }
      const rawArgs = req.params?.arguments;
      if (rawArgs !== undefined && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
        return fail(id, RPC.InvalidParams, "`params.arguments` must be an object.");
      }
      const { isError, text } = await callTool(
        session,
        name,
        (rawArgs as Record<string, unknown>) ?? {},
      );
      // A tool that failed is a *result*, not a protocol error: the model should read the message
      // and fix its arguments. Returning a JSON-RPC error here would hide it from the model.
      return ok(id, { content: [{ type: "text", text }], isError });
    }

    case "prompts/list":
      return ok(id, {
        prompts: PROMPTS.map((p) => ({
          name: p.name,
          title: p.title,
          description: p.description,
          arguments: p.arguments,
        })),
      });

    case "prompts/get": {
      const name = req.params?.name;
      const prompt = PROMPTS.find((p) => p.name === name);
      if (!prompt) {
        return fail(
          id,
          RPC.InvalidParams,
          `Unknown prompt '${String(name)}'. Available: ${PROMPTS.map((p) => p.name).join(", ")}.`,
        );
      }
      const args = (req.params?.arguments as Record<string, string> | undefined) ?? {};
      const missing = prompt.arguments.filter((a) => a.required && !args[a.name]);
      if (missing.length) {
        return fail(
          id,
          RPC.InvalidParams,
          `Prompt '${prompt.name}' requires: ${missing.map((m) => m.name).join(", ")}.`,
        );
      }
      return ok(id, {
        description: prompt.description,
        messages: [
          { role: "user", content: { type: "text", text: prompt.build(args) } },
        ],
      });
    }

    // Declared unsupported explicitly rather than falling through to "method not found", so a
    // client probing capabilities gets a clean empty list instead of an error in its log.
    case "resources/list":
      return ok(id, { resources: [] });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });

    default:
      return isNotification ? null : fail(id, RPC.MethodNotFound, `Unknown method '${method}'.`);
  }
}

export { INSTRUCTIONS, PROTOCOL_VERSION, SERVER_INFO };
