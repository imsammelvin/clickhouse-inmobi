/**
 * Entry point and transports.
 *
 *   bun run mcp:stdio                 # local client (Claude Desktop, Claude Code, `mcp` CLI)
 *   bun run mcp:http                  # LibreChat -> http://host:3333/mcp
 *
 * Two transports because the consumer decides. LibreChat runs in its own container, so it cannot
 * launch a process on the host and speak stdio to it — it needs a URL. A local desktop client wants
 * the opposite. Both go through the same `handleRpc`, so there is one implementation of the protocol
 * and no chance of the two drifting.
 *
 * STDOUT IS THE PROTOCOL in stdio mode. Anything else printed there corrupts the JSON-RPC stream and
 * the client disconnects with no useful error, so diagnostics go to stderr explicitly rather than
 * through `log.info` (which writes to stdout via console.log). For the same reason, do not set
 * OTEL_LOG_LEVEL when running over stdio: the OTel diagnostic logger writes to the console too.
 */
import { context, propagation } from "@opentelemetry/api";
import { handleRpc, type JsonRpcRequest } from "./protocol";
import { Session } from "./trace";
import {
  flushObservability,
  initObservability,
  shutdownObservability,
} from "../../shared/utils/telemetryUtils";

const DEFAULT_PORT = 3333;

const note = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Parse one JSON-RPC message or batch, dispatch each, and collect the answers worth sending. */
async function dispatch(session: Session, body: unknown): Promise<unknown> {
  if (Array.isArray(body)) {
    const out = [];
    for (const item of body) {
      const res = await handleRpc(session, item as JsonRpcRequest);
      if (res) out.push(res);
    }
    return out.length ? out : null;
  }
  return handleRpc(session, body as JsonRpcRequest);
}

// -------------------------------------------------------------------------------------------------
// stdio
// -------------------------------------------------------------------------------------------------

async function runStdio(): Promise<void> {
  const session = new Session();
  note(`[mcp] stdio ready — run ${session.runId}, trace ${session.traceFile}`);

  let buffer = "";
  const decoder = new TextDecoder();

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    // Newline-delimited JSON. Split on every complete line and keep the remainder: a large
    // tools/call payload can arrive across several chunks, and parsing a half-line would drop it.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error: not valid JSON." },
          })}\n`,
        );
        continue;
      }

      const response = await dispatch(session, parsed);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }

  await flushObservability();
  await session.close();
}

// -------------------------------------------------------------------------------------------------
// streamable HTTP
// -------------------------------------------------------------------------------------------------

/**
 * One session per `Mcp-Session-Id`, minted on `initialize`.
 *
 * Sessions are what make `get_evidence` work across turns — evidence ids only mean something within
 * the session that produced them — so they have to outlive a single request. Each holds a ClickHouse
 * client, so the map is capped and the oldest is closed when it overflows rather than leaking
 * connections for the life of the process.
 */
const MAX_SESSIONS = 8;
const sessions = new Map<string, Session>();

function evictIfNeeded(): void {
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) return;
    const victim = sessions.get(oldest);
    sessions.delete(oldest);
    void victim?.close();
    note(`[mcp] evicted session ${oldest} (cap ${MAX_SESSIONS})`);
  }
}

function sessionFor(headerId: string | null): { session: Session; id: string } {
  if (headerId && sessions.has(headerId)) {
    return { session: sessions.get(headerId)!, id: headerId };
  }
  const session = new Session();
  sessions.set(session.runId, session);
  evictIfNeeded();
  return { session, id: session.runId };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, accept",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

function runHttp(port: number): void {
  Bun.serve({
    port,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if (url.pathname === "/health") {
        return Response.json({ ok: true, sessions: sessions.size }, { headers: CORS });
      }

      if (url.pathname !== "/mcp") {
        return Response.json(
          { error: "Not found. The MCP endpoint is POST /mcp." },
          {
            status: 404,
            headers: CORS,
          },
        );
      }

      // Streamable HTTP allows a client to open a GET stream for server-initiated messages. This
      // server never initiates any, so saying so is better than holding a socket open forever.
      if (req.method === "GET") {
        return new Response("This server does not push server-initiated messages. Use POST /mcp.", {
          status: 405,
          headers: { ...CORS, Allow: "POST" },
        });
      }

      if (req.method !== "POST") {
        return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST" } });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } },
          { status: 400, headers: CORS },
        );
      }

      const { session, id } = sessionFor(req.headers.get("mcp-session-id"));
      // Re-read per request: LibreChat re-resolves these headers before each tool call, so a session
      // that outlives a turn still attributes each call to whoever actually made it.
      const hUser = req.headers.get("x-user-id");
      const hMail = req.headers.get("x-user-email");
      if (hUser) session.userId = hUser;
      if (hMail) session.userEmail = hMail;

      // The propagator and context manager are already wired up in initObservability() for exactly
      // this -- but nothing extracted an inbound `traceparent` until now, so every mcp.tool.* span
      // started a brand-new root trace instead of continuing the caller's (measured: a LibreChat
      // agent trace and this server's investigation trace never shared a traceId, so following one
      // from the other meant matching timestamps by hand). A client that sends no `traceparent`
      // gets the same unset context back from `extract`, so this is a no-op for callers that don't.
      const parentCtx = propagation.extract(context.active(), {
        traceparent: req.headers.get("traceparent") ?? undefined,
        tracestate: req.headers.get("tracestate") ?? undefined,
      });
      const response = await context.with(parentCtx, () => dispatch(session, body));
      const headers = { ...CORS, "Mcp-Session-Id": id };

      // A batch of pure notifications has nothing to answer with.
      if (!response) return new Response(null, { status: 202, headers });

      // Some clients ask for SSE even when a single JSON body would do. Honour the Accept header
      // rather than assuming: a client that asked for a stream may refuse to parse plain JSON.
      if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
        return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
          headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }
      return Response.json(response, { headers });
    },
  });

  note(`[mcp] http ready on http://0.0.0.0:${port}/mcp  (health: /health)`);
}

// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  initObservability();

  const transport = arg("transport") ?? process.env.MCP_TRANSPORT ?? "stdio";

  const shutdown = async (): Promise<void> => {
    await Promise.allSettled([...sessions.values()].map((s) => s.close()));
    await shutdownObservability();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (transport === "http") {
    runHttp(Number(arg("port") ?? process.env.MCP_PORT ?? DEFAULT_PORT));
    return; // Bun.serve keeps the process alive.
  }
  if (transport !== "stdio") {
    note(`[mcp] unknown --transport '${transport}'. Use 'stdio' or 'http'.`);
    process.exit(2);
  }

  try {
    await runStdio();
  } finally {
    await shutdownObservability();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    note(`[mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
