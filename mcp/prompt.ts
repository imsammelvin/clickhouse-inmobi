/**
 * Print the answer-style contract to stdout.
 *
 *   bun run mcp:prompt                    # read it
 *   bun run mcp:prompt > /tmp/sys.md      # paste it into a client that ignores `instructions`
 *
 * Exists because the `instructions` field an MCP server returns from `initialize` is advisory: the
 * spec lets a client surface it, ignore it, or truncate it, and several do ignore it. If LibreChat
 * drops it, the narrator never receives the contract — tools still work, but nothing tells the model
 * to lead with the verdict, to stop re-deriving numbers, or to report "no anomaly" as an answer.
 *
 * The fallback is to paste the same text into the agent's system prompt, and this command is what
 * makes that safe: it prints the exact string the server sends, from the one place it is defined, so
 * a pasted copy cannot silently drift from the served one. Do not retype it into a config file.
 */
import { INSTRUCTIONS } from "./protocol";

if (import.meta.main) {
  process.stdout.write(`${INSTRUCTIONS}\n`);
}
