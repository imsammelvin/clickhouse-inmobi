/**
 * Accuracy evaluator: what the MCP layer answers vs what the answer should be.
 *
 *   bun run mcp:eval
 *   bun run mcp:eval -- --case A-android15-fill      # one case
 *   bun run mcp:eval -- --json                        # machine-readable, for the trace artifact
 *
 * Deliberately runs through `callTool`, not through the engine directly. What a judge sees is what
 * the chat client gets back, so that is the surface worth scoring — a regression in an argument
 * name, an envelope field or a refusal message is as much a wrong answer as a wrong number, and an
 * engine-level test cannot see any of them.
 *
 * Two tiers, because honesty about our own uncertainty matters more than a green tick:
 *
 *   GATED   localization, the no-false-alarm cases, grounding, refusals. Certain, so a miss exits 1.
 *   REPORTED cause channel and dollar figures. Measured and printed, never gating — the journal
 *            records channel as the open question, and a gate that encodes today's behaviour as
 *            truth would just ratify it.
 *
 * Related but not the same as `bun run criteria`, which gates the three judging criteria against the
 * engine. This one asks the narrower question the unseen round actually asks: given a question, did
 * the answer come back right?
 */
import { callTool } from "../tools";
import { Session } from "../trace";
import { CASES, type EvalCase, type Near } from "./cases";
import type { Span } from "@opentelemetry/api";
import {
  initObservability,
  shutdownObservability,
  withSpan,
} from "../../../shared/utils/telemetryUtils";

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const asJson = process.argv.includes("--json");

/** Console only — this is a report, and routing it through the log pipeline would be noise. */
const out = (s = ""): void => {
  if (!asJson) process.stdout.write(`${s}\n`);
};

interface Check {
  label: string;
  gated: boolean;
  ok: boolean;
  detail: string;
}

interface CaseResult {
  id: string;
  question: string;
  kind: string;
  ms: number;
  checks: Check[];
  passedGated: boolean;
}

const near = (actual: unknown, n: Near): boolean =>
  typeof actual === "number" &&
  Number.isFinite(actual) &&
  Math.abs(actual - n.value) <= n.tolerance;

/** Read a dotted path out of a parsed result. Array indices are plain numbers: `rows.0.value`. */
function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const show = (v: unknown): string =>
  typeof v === "number" ? String(Number(v.toFixed(4))) : JSON.stringify(v);

async function runCase(session: Session, c: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  const checks: Check[] = [];

  const tool = c.kind === "investigation" ? "investigate" : c.tool;
  const { isError, text } = await callTool(session, tool, c.args as Record<string, unknown>);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { error: "unparseable tool output" };
  }

  if (c.kind === "refusal") {
    const message = String(parsed.error ?? "");
    checks.push({
      label: "refused",
      gated: true,
      ok: isError,
      detail: isError ? "rejected" : "ANSWERED — this question has no correct answer",
    });
    checks.push({
      label: "explains why",
      gated: true,
      ok: message.includes(c.errorContains),
      detail: message.includes(c.errorContains)
        ? `mentions "${c.errorContains}"`
        : `expected "${c.errorContains}", got: ${message.slice(0, 120)}`,
    });
  } else if (c.kind === "tool") {
    if (isError) {
      checks.push({
        label: "answered",
        gated: true,
        ok: false,
        detail: `errored: ${String(parsed.error).slice(0, 140)}`,
      });
    } else {
      for (const e of c.expect) {
        const actual = at(parsed, e.path);
        let ok: boolean;
        let want: string;
        if (e.near) {
          ok = near(actual, e.near);
          want = `${e.near.value} +/- ${e.near.tolerance}`;
        } else if (e.contains !== undefined) {
          ok = typeof actual === "string" && actual.includes(e.contains);
          want = `contains "${e.contains}"`;
        } else {
          ok = JSON.stringify(actual) === JSON.stringify(e.equals);
          want = show(e.equals);
        }
        checks.push({
          label: e.path,
          gated: true,
          ok,
          detail: ok ? show(actual) : `got ${show(actual)}, want ${want}`,
        });
      }
    }
  } else {
    // investigation
    if (isError) {
      checks.push({
        label: "completed",
        gated: true,
        ok: false,
        detail: `errored: ${String(parsed.error).slice(0, 140)}`,
      });
    } else {
      const channel = String(parsed.channel ?? "");
      const findings = (parsed.findings ?? []) as Array<{
        segment: { dimension: string; value: string } | null;
        revenueImpactUsd: number | null;
      }>;
      const grounding = (parsed.grounding ?? {}) as {
        ok?: boolean;
        grounded?: number;
        numeralsChecked?: number;
      };
      const named = findings.find((f) => f.segment)?.segment ?? null;
      const want = c.expect;

      // Localization is the criterion-1 question and the one we are certain about.
      if (want.skipLocalization) {
        // nothing to assert — this case is about something else
      } else if (want.segment) {
        const ok =
          named?.dimension === want.segment.dimension && named?.value === want.segment.value;
        checks.push({
          label: "localization",
          gated: true,
          ok,
          detail: ok
            ? `${named!.dimension}='${named!.value}'`
            : `got ${named ? `${named.dimension}='${named.value}'` : "no segment"}, ` +
              `want ${want.segment.dimension}='${want.segment.value}'`,
        });
      } else {
        // No segment is responsible. Naming one is a hallucination, which the rubric weights
        // above a miss — so this is gated exactly as hard as a positive localization.
        checks.push({
          label: "named no false cause",
          gated: true,
          ok: named === null,
          detail:
            named === null
              ? "no segment blamed"
              : `FABRICATED cause ${named.dimension}='${named.value}'`,
        });
      }

      if (want.noAnomaly) {
        checks.push({
          label: "no false alarm",
          gated: true,
          ok: channel === "no_anomaly",
          detail: channel === "no_anomaly" ? "no action" : `raised ${channel} on a normal day`,
        });
      }
      if (want.notLocalizable) {
        checks.push({
          label: "not localizable",
          gated: true,
          ok: channel === "not_localizable",
          detail: channel === "not_localizable" ? "platform-level" : `got ${channel}`,
        });
      }

      // Criterion 2, on the exact text a reader would see.
      checks.push({
        label: "grounded",
        gated: true,
        ok: grounding.ok === true,
        detail: `${grounding.grounded ?? 0}/${grounding.numeralsChecked ?? 0} numerals resolve to evidence`,
      });

      if (want.channel) {
        const ok = channel === want.channel;
        checks.push({
          label: "channel",
          gated: false,
          ok,
          detail: ok ? channel : `got ${channel}, believed ${want.channel}`,
        });
      }
      // ---- the action block -------------------------------------------------------------
      const action = parsed.action as Record<string, unknown> | undefined;
      if (!action) {
        checks.push({
          label: "action present",
          gated: true,
          ok: false,
          detail:
            "investigate returned no action block — a cause with no next step is half an answer",
        });
      } else {
        /**
         * Anti-fabrication. This dataset is ad request events: no deploy logs, no bid logs, no server
         * telemetry, no config history. Any of these words in a recommendation means the system has
         * started inventing remediation, which sends a person somewhere for an afternoon on no
         * evidence — the same failure as a fabricated number, and harder to notice because it reads
         * as expertise.
         */
        const FORBIDDEN = [
          "deploy",
          "rollback",
          "roll back",
          "restart",
          "reboot",
          "hotfix",
          "patch",
          "release",
          "sdk",
          "changelog",
          "git ",
          "commit",
        ];
        const text = JSON.stringify([
          action.whereToLook,
          action.priorityBasis,
          action.statusDetail,
        ]).toLowerCase();
        const found = FORBIDDEN.filter((w) => text.includes(w));
        checks.push({
          label: "no invented remedy",
          gated: true,
          ok: found.length === 0,
          detail:
            found.length === 0
              ? "recommends only what the funnel evidence supports"
              : `claims this data cannot support: ${found.join(", ")}`,
        });

        const a = c.action;
        if (a) {
          if (a.status) {
            checks.push({
              label: "action.status",
              gated: true,
              ok: action.status === a.status,
              detail:
                action.status === a.status
                  ? String(action.status)
                  : `got ${String(action.status)}, want ${a.status}`,
            });
          }
          if (a.recoveredOn) {
            const detail = String(action.statusDetail ?? "");
            const ok = detail.includes(a.recoveredOn);
            checks.push({
              label: "recovered on",
              gated: true,
              ok,
              detail: ok ? a.recoveredOn : `expected ${a.recoveredOn} in: ${detail.slice(0, 100)}`,
            });
          }
          if (a.daysRunning !== undefined) {
            const ok = action.daysRunning === a.daysRunning;
            checks.push({
              label: "days it ran",
              gated: true,
              ok,
              detail: ok
                ? `${a.daysRunning} day(s)`
                : `got ${String(action.daysRunning)}, want ${a.daysRunning}`,
            });
          }
          if (a.priority) {
            const ok = action.priority === a.priority;
            checks.push({
              label: "priority",
              gated: true,
              ok,
              detail: ok
                ? String(action.priority)
                : `got ${String(action.priority)}, want ${a.priority}`,
            });
          }
          if (a.ownerContains) {
            const owner = String(action.owner ?? "");
            const ok = owner.includes(a.ownerContains);
            checks.push({
              label: "owner",
              gated: true,
              ok,
              detail: ok ? owner : `got "${owner}", want it to name ${a.ownerContains}`,
            });
          }
          if (a.doNotChaseEmpty) {
            const list = (action.doNotChase ?? []) as unknown[];
            checks.push({
              label: "nothing to chase",
              gated: true,
              ok: list.length === 0,
              detail:
                list.length === 0
                  ? "empty, as it should be on a clean day"
                  : `${list.length} item(s) listed on a day with no incident`,
            });
          }
          if (a.whereToLookContains) {
            const where = JSON.stringify(action.whereToLook ?? []);
            const ok = where.includes(a.whereToLookContains);
            checks.push({
              label: "where to look",
              gated: true,
              ok,
              detail: ok
                ? `mentions "${a.whereToLookContains}"`
                : `expected "${a.whereToLookContains}" in ${where.slice(0, 110)}`,
            });
          }
        }
      }

      if (want.revenueUsdPerDay) {
        const priced = findings.find((f) => f.revenueImpactUsd !== null)?.revenueImpactUsd ?? null;
        const ok = near(priced, want.revenueUsdPerDay);
        checks.push({
          label: "dollars/day",
          gated: false,
          ok,
          detail: ok
            ? `$${priced?.toFixed(2)}`
            : `got ${priced === null ? "none" : `$${priced.toFixed(2)}`}, ` +
              `believed $${want.revenueUsdPerDay.value} +/- ${want.revenueUsdPerDay.tolerance}`,
        });
      }
    }
  }

  return {
    id: c.id,
    question: c.question,
    kind: c.kind,
    ms: Date.now() - started,
    checks,
    passedGated: checks.filter((k) => k.gated).every((k) => k.ok),
  };
}

/**
 * Returns the exit code rather than calling `process.exit` itself: the root span has to end and the
 * batch processor has to flush before the process goes away, and `process.exit` from in here would
 * take the whole run's telemetry with it. `main` exits, once, after both.
 */
async function runEval(span: Span): Promise<number> {
  const only = argOf("case");
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;
  if (cases.length === 0) {
    process.stderr.write(
      `No case matching '${only}'. Known: ${CASES.map((c) => c.id).join(", ")}\n`,
    );
    process.exit(2);
  }

  const session = new Session();
  const results: CaseResult[] = [];
  span.setAttribute("app.eval.cases", cases.length);
  if (only) span.setAttribute("app.eval.case_filter", only);
  try {
    out(`\nACCURACY — ${cases.length} case(s), answered through the MCP tool layer\n`);
    for (const c of cases) {
      const r = await runCase(session, c);
      results.push(r);
      if (!asJson) {
        out(
          `${r.passedGated ? "PASS" : "FAIL"}  ${r.id.padEnd(28)} ${r.ms.toString().padStart(6)}ms  ${r.question}`,
        );
        for (const k of r.checks) {
          const mark = k.ok ? "ok  " : k.gated ? "MISS" : "note";
          out(`        ${mark} ${k.label.padEnd(22)} ${k.detail}`);
        }
      }
    }
  } finally {
    const exported = session.export();
    await session.close();

    const gated = results.flatMap((r) => r.checks.filter((k) => k.gated));
    const reported = results.flatMap((r) => r.checks.filter((k) => !k.gated));
    const gatedPassed = gated.filter((k) => k.ok).length;
    const reportedPassed = reported.filter((k) => k.ok).length;
    const casesPassed = results.filter((r) => r.passedGated).length;
    const pct = (n: number, d: number): string =>
      d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`;

    const summary = {
      cases: results.length,
      casesPassed,
      gated: {
        checks: gated.length,
        passed: gatedPassed,
        accuracy: pct(gatedPassed, gated.length),
      },
      reported: {
        checks: reported.length,
        passed: reportedPassed,
        accuracy: pct(reportedPassed, reported.length),
      },
      totalMs: results.reduce((a, r) => a + r.ms, 0),
      trace: exported.path,
      failures: results
        .filter((r) => !r.passedGated)
        .map((r) => ({
          id: r.id,
          missed: r.checks.filter((k) => k.gated && !k.ok).map((k) => `${k.label}: ${k.detail}`),
        })),
    };

    if (asJson) {
      process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
    } else {
      out(`\nSCORECARD`);
      out(`  cases passed        ${casesPassed}/${results.length}`);
      out(
        `  gated accuracy      ${gatedPassed}/${gated.length}  ${summary.gated.accuracy}   (localization, no-false-alarm, grounding, refusals)`,
      );
      out(
        `  reported accuracy   ${reportedPassed}/${reported.length}  ${summary.reported.accuracy}   (cause channel, dollars — measured, not gating)`,
      );
      out(`  wall clock          ${summary.totalMs}ms for ${results.length} answer(s)`);
      out(`  trace               ${exported.path}`);
      for (const f of summary.failures) {
        out(`\n  FAILED ${f.id}`);
        for (const m of f.missed) out(`    ${m}`);
      }
      out(
        gatedPassed === gated.length
          ? `\nAll gated checks pass. Channel accuracy is reported above and is the known open item.\n`
          : `\n${gated.length - gatedPassed} gated check(s) missed — see above.\n`,
      );
    }

    span.setAttributes({
      "app.eval.cases_passed": casesPassed,
      "app.eval.gated_checks": gated.length,
      "app.eval.gated_passed": gatedPassed,
      "app.eval.reported_checks": reported.length,
      "app.eval.reported_passed": reportedPassed,
    });

    // Returning from `finally` is deliberate and replaces the `process.exit` that used to sit here:
    // same "this is the answer however we got out of the try" semantics, but it lets the span end.
    // eslint-disable-next-line no-unsafe-finally
    return gatedPassed === gated.length ? 0 : 1;
  }
}

async function main(): Promise<void> {
  initObservability();
  let code = 1;
  try {
    code = await withSpan("eval.run", {}, runEval);
  } finally {
    await shutdownObservability();
  }
  process.exit(code);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
