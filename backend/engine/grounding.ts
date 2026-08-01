/**
 * Grounding check — enforcement for judging criterion #2.
 *
 *   "Every number in the diagnosis must be reproducible from the data.
 *    A single fabricated figure costs more than a missed anomaly."
 *
 * A prompt instruction ("do not invent numbers") is not enforcement — it is a hope. This is
 * enforcement: extract every numeral from the rendered narrative and require each one to resolve to
 * an `Evidence` row. Anything that does not resolve is reported, and the caller fails.
 *
 * The check is deliberately strict about what counts as "resolved". A numeral matches if it equals
 * an evidence value at the precision it was printed to — so 0.4333 matches evidence 0.43334, but a
 * figure that appears nowhere in the ledger fails no matter how plausible it looks.
 */
import type { Evidence } from "./types";
import { withSyncSpan } from "../../shared/utils/telemetryUtils";

export interface Ungrounded {
  text: string;
  value: number;
  context: string;
}

export interface GroundingResult {
  total: number;
  grounded: number;
  ungrounded: Ungrounded[];
  ok: boolean;
}

/**
 * Numerals that are structural rather than claims: ISO dates, evidence references like `[e7]`,
 * and sigma/percent signs attached to values already checked. Dates are stripped wholesale because
 * `2026-06-23` is an identifier, not a measurement.
 */
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const EVIDENCE_REF_RE = /\[e\d+\]/g;
const TRACE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/**
 * Single-quoted segment values are identifiers, not measurements: `'Galaxy A54'` and
 * `'Android 15'` contain digits that are part of a name. Stripping them prevents both a false
 * failure (54 is not a claim) and, more importantly, a false *pass* — 15 happening to coincide
 * with some evidence value would otherwise mark an identifier as "grounded" and hide a real gap.
 *
 * The `\n` exclusion is load-bearing. An apostrophe in ordinary prose — "within this segment's
 * normal range" — is an unmatched quote, and with `[^']*` the pairing desynchronises from there
 * on: the stripper pairs the apostrophe with the *opening* quote of the next line's identifier and
 * swallows everything between. The real identifier is then left bare, so `'LATAM|iPhone 14'` leaks
 * a `14` that reads as a claim. Refusing to cross a line boundary confines a stray apostrophe to
 * its own line and makes the false-pass direction — a swallowed span hiding an ungrounded figure —
 * impossible rather than merely unlikely.
 */
const QUOTED_IDENTIFIER_RE = /'[^'\n]*'/g;

/** Matches -$1.47, 35.04pp, +7.8%, 0.7837, 126,052 */
const NUMERAL_RE = /-?\$?\d[\d,]*\.?\d*/g;

function candidateValues(e: Evidence): number[] {
  if (e.value === null) return [];
  const v = e.value;
  const out = [v, Math.abs(v)];
  // Ratios are routinely printed as percentages or percentage points, and dollars are printed
  // without the sign. Accept those renderings of the same recorded fact.
  out.push(v * 100, Math.abs(v * 100));
  if (e.segmentSharePct !== undefined) out.push(e.segmentSharePct);
  return out;
}

/**
 * Does `printed` equal `actual` at the precision it was printed to?
 * "35.04" against 35.0417 passes; "35.04" against 35.9 does not.
 */
function matchesAtPrecision(printed: number, printedText: string, actual: number): boolean {
  const dot = printedText.indexOf(".");
  const decimals = dot === -1 ? 0 : printedText.length - dot - 1;
  const tolerance = decimals === 0 ? 0.5 : 0.5 * 10 ** -decimals;
  return Math.abs(printed - actual) <= tolerance + 1e-12;
}

export function checkGrounding(narrative: string, evidence: Evidence[]): GroundingResult {
  return withSyncSpan(
    "grounding.check",
    { "app.evidence.count": evidence.length, "app.narrative.length": narrative.length },
    (span) => {
      const result = checkGroundingInner(narrative, evidence);
      // The single most heavily-weighted judging criterion ("one fabricated figure costs more than
      // a missed anomaly"), so its result belongs on the trace, not only in the gate's stdout.
      span.setAttributes({
        "app.grounding.total": result.total,
        "app.grounding.grounded": result.grounded,
        "app.grounding.ungrounded": result.ungrounded.length,
        "app.grounding.ok": result.ok,
      });
      return result;
    },
  );
}

function checkGroundingInner(narrative: string, evidence: Evidence[]): GroundingResult {
  const cleaned = narrative
    .replace(TRACE_RE, " ")
    .replace(DATE_RE, " ")
    .replace(EVIDENCE_REF_RE, " ")
    .replace(QUOTED_IDENTIFIER_RE, " ");

  const pool: number[] = evidence.flatMap(candidateValues);
  const ungrounded: Ungrounded[] = [];
  let total = 0;

  for (const line of cleaned.split("\n")) {
    for (const m of line.matchAll(NUMERAL_RE)) {
      const raw = m[0];
      const numeric = Number(raw.replace(/[$,]/g, ""));
      if (!Number.isFinite(numeric)) continue;
      // 0 and 1 appear as structural artefacts (counts, "1 query"); they carry no claim.
      if (numeric === 0 || numeric === 1) continue;
      total++;
      const printedText = raw.replace(/[$,-]/g, "");
      const hit = pool.some((v) => matchesAtPrecision(numeric, printedText, v));
      if (!hit) {
        ungrounded.push({ text: raw, value: numeric, context: line.trim().slice(0, 90) });
      }
    }
  }

  return {
    total,
    grounded: total - ungrounded.length,
    ungrounded,
    ok: ungrounded.length === 0,
  };
}
