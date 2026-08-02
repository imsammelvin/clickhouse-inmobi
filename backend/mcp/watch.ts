/**
 * The watchman: notice it again, and say so.
 *
 *   bun run watch            # one pass — what a cron calls
 *   bun run watch -- --list  # what is being watched, and by whom
 *
 * Deliberately NOT a subscription system. Nobody configures alerts in the abstract, and a rule written
 * before you have seen the incident is a rule written blind — it is how alerting becomes noise. Here a
 * watch can only be created from an incident the user was just shown: the chat reports a cause, offers
 * to keep an eye on it, and the answer is one tool call carrying the finding it came from. The
 * threshold is the incident's own measured impact, so "tell me if this gets worse" needs no number
 * from the user.
 *
 * WHY A CRON AND NOT A PUSH INTO THE CHAT. MCP is request/response — a server cannot put a message
 * into a LibreChat conversation, and LibreChat has no path that sends one without a user action
 * (checked: `customWelcome` is static text, conversation starters are buttons). So the watching
 * happens out of band and the chat is where you follow it up. That split is honest, and it is also the
 * only version that works while nobody is looking at the screen.
 *
 * ONE SWEEP FOR EVERY WATCH. The runner does not query per watch. It runs the same segment sweep the
 * unattended path uses, once, and matches the firings against what people asked about — so the cost is
 * flat in the number of watchers.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Ledger } from "../engine/ledger";
import { groupIntoIncidents, scanSegments } from "../engine/segments";
import { DATASET_END, ensureDatasetBounds } from "../engine/baseline";
import { estimateWeeklyGrowth } from "../engine/baseline";
import { METRICS, metricExpr } from "../engine/metrics";
import { investigate } from "../engine/orchestrate";
import { recommendAction } from "./action";
import { deliveryStatus, sendNotification } from "./notify";

const DIR = process.env.MCP_WATCH_DIR ?? "backend/mcp/watches";
const FILE = join(DIR, "watches.json");
const LOG = join(DIR, "notifications.jsonl");

export interface Watch {
  id: string;
  /** From LibreChat's {{LIBRECHAT_USER_ID}} header, or "anonymous" when it is not configured. */
  userId: string;
  userEmail?: string;
  metric: string;
  /** null = watch the platform, not a segment. */
  dimension: string | null;
  value: string | null;
  /** What it cost when they saw it. Recurrence is judged against this, not a number they invented. */
  baselineImpactUsdPerDay: number | null;
  note: string;
  createdAt: string;
  /** Last day already reported, so the same incident is not mailed every morning. */
  watermark: string | null;
}

const load = (): Watch[] => {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Watch[];
  } catch {
    return [];
  }
};

const save = (watches: Watch[]): void => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(watches, null, 2)}\n`);
};

/** Create a watch from an incident the user was just shown. */
export function addWatch(w: Omit<Watch, "id" | "createdAt" | "watermark">): Watch {
  const watches = load();
  // One watch per user per segment+metric: asking twice should not mean being told twice.
  const existing = watches.find(
    (x) =>
      x.userId === w.userId &&
      x.metric === w.metric &&
      x.dimension === w.dimension &&
      x.value === w.value,
  );
  if (existing) return existing;

  const watch: Watch = {
    ...w,
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    watermark: null,
  };
  watches.push(watch);
  save(watches);
  return watch;
}

export const listWatches = (userId?: string): Watch[] =>
  load().filter((w) => !userId || w.userId === userId);

export function removeWatch(id: string, userId?: string): boolean {
  const watches = load();
  const next = watches.filter((w) => !(w.id === id && (!userId || w.userId === userId)));
  if (next.length === watches.length) return false;
  save(next);
  return true;
}

/** The engine's verdict on the recurrence, not just the fact of it. */
export interface Diagnosis {
  channel: string;
  owner: string;
  /** One line on what is actually broken, from the funnel evidence. */
  because: string;
  impactUsdPerDay: number | null;
  /** How many slices looked implicated and were cleared — the differentiator, in one number. */
  clearedCount: number;
  /** Three of them by name. A count is a claim; names are evidence. */
  clearedExamples: string[];
  status: string;
  /** Whether it is still happening — the fact that decides what anyone does next. */
  statusDetail: string;
  priority: string;
  daysRunning: number | null;
  lostSoFarUsd: number | null;
  /** How much of the platform this slice carries, so a percentage move has a size. */
  sharePct: number | null;
  /** Percentage points for a ratio, percent otherwise — the move in its natural unit. */
  deltaPp: number | null;
  sigma: number | null;
  /** A question this system can answer, so the alert leads somewhere. */
  nextQuestion: string | null;
  /** The engine's own sentence, already grounded. */
  headline: string;
}

export interface Notification {
  watch: Watch;
  day: string;
  pct: number;
  sigma: number;
  requestsPerDay: number;
  /** Absent when the investigation could not run; the alert is still sent. */
  diagnosis?: Diagnosis;
}

/**
 * Diagnose a recurrence so the alert says what happened AND why.
 *
 * A notification that only restates the firing — "fill_rate down 45%" — makes the reader open the chat
 * to learn anything. The cron has time the reader does not, so it spends ~5s running the same
 * six-stage investigation the chat would have run, and the alert arrives with a cause and an owner.
 *
 * Failure is non-fatal on purpose: a diagnosis that cannot be produced must not suppress the alert.
 * Knowing something recurred is worth more than knowing nothing.
 */
async function diagnose(metric: string, from: string, to: string): Promise<Diagnosis | undefined> {
  const ledger = new Ledger();
  try {
    const inv = await investigate({ metric, from, to, ledger });
    const action = await recommendAction(ledger, inv);
    const cleared = inv.ruledOut.filter((r) => r.status === "cleared_as_contamination");
    const finding = inv.findings.find((f) => f.segment) ?? inv.findings[0];
    return {
      channel: inv.primaryChannel,
      owner: action.owner,
      because: action.whereToLook[0] ?? inv.headline,
      impactUsdPerDay:
        inv.findings.find((f) => f.revenueImpactUsd !== null)?.revenueImpactUsd ?? null,
      clearedCount: cleared.length,
      clearedExamples: cleared
        .slice(0, 3)
        .map((r) => (r.segment ? `${r.segment.dimension} = '${r.segment.value}'` : ""))
        .filter(Boolean),
      status: action.status,
      statusDetail: action.statusDetail,
      priority: action.priority,
      daysRunning: action.daysRunning,
      lostSoFarUsd: action.lostSoFarUsd,
      sharePct: finding?.segmentSharePct ?? null,
      deltaPp: finding?.deltaPp ?? finding?.deltaPct ?? null,
      sigma: finding?.significanceSigma ?? null,
      nextQuestion: action.nextQuestion,
      headline: inv.headline,
    };
  } catch {
    return undefined;
  } finally {
    await ledger.close();
  }
}

/**
 * One pass. Sweep once, match every watch against the firings, report only what is new.
 *
 * "New" is per watch: a firing on or before that watch's watermark has already been reported, and
 * re-reporting it is exactly how an alert channel gets muted.
 */
export async function runOnce(opts: { only?: string } = {}): Promise<Notification[]> {
  /**
   * `all` is what gets written back; `watches` is only what this pass sweeps.
   *
   * They must stay separate. Saving the filtered list would delete every watch this pass did not
   * look at — the scoped path (`only`) sweeps exactly one, so that mistake would wipe the file down
   * to a single entry the first time a watch is created. Both arrays hold the SAME objects, so the
   * `w.watermark` writes below still land in `all`.
   */
  const all = load();
  const watches = opts.only ? all.filter((w) => w.id === opts.only) : all;
  if (watches.length === 0) return [];

  const ledger = new Ledger();
  ledger.beginStage("watch");
  const found: Notification[] = [];

  try {
    await ensureDatasetBounds(<T>(sql: string): Promise<T[]> => ledger.run<T>(sql));
    const metrics = [...new Set(watches.map((w) => w.metric))].filter((m) => METRICS[m]);

    for (const metric of metrics) {
      const def = METRICS[metric]!;
      const series = await ledger.run<{ d: string; v: number | null }>(
        `SELECT toString(event_date) AS d, ${metricExpr(def)} AS v
         FROM ad_events_enriched GROUP BY event_date ORDER BY event_date`,
      );
      const growth = estimateWeeklyGrowth(
        new Map(series.map((r): [string, number] => [r.d, Number(r.v ?? 0)])),
      );
      /**
       * Match PER SEGMENT, not per clustered window.
       *
       * `clusterWindows` collapses an event into one row led by its strongest segment, and that lead is
       * usually a pair — the Android 15 fill collapse is led by `app_category|os_version` =
       * `finance|Android 15`. A watch on `os_version='Android 15'` compared against the lead therefore
       * never matched, and the runner reported "nothing new" for an incident sitting in the data.
       *
       * Silent, and the worst possible failure for this feature: the user is told nothing and concludes
       * nothing happened. `groupIntoIncidents` keeps one row per segment, which is the grain a watch is
       * actually about.
       */
      const incidents = groupIntoIncidents(await scanSegments(ledger, metric, growth));

      for (const w of watches.filter((x) => x.metric === metric)) {
        const fresh = incidents
          .filter(
            (inc) =>
              w.dimension === null || (inc.dimension === w.dimension && inc.value === w.value),
          )
          .filter((inc) => !w.watermark || inc.to > w.watermark) // already told them
          // Sorted because the watermark below is the last element, and `groupIntoIncidents` does
          // not promise an order. Getting this wrong sets the watermark to an early day and re-reports
          // everything after it on the next run.
          .sort((a, b) => a.to.localeCompare(b.to));
        if (fresh.length === 0) continue;

        /**
         * A watch that has never reported has the whole dataset behind it, so report only its most
         * recent incident.
         *
         * Every other run reports everything new, which is right — those are things that happened
         * since the last look. But the FIRST pass is different: its "since" is the beginning of time,
         * and a segment with a dozen historical incidents would arrive as a dozen alerts, each one
         * costing a full investigation. That is a history dump, not news, and the user already knows
         * about it — seeing an incident is what made them ask for the watch.
         *
         * The watermark still moves past all of them, so the ones not reported are not reported later.
         */
        const report = w.watermark ? fresh : fresh.slice(-1);
        for (const inc of report) {
          found.push({
            watch: w,
            day: inc.to,
            pct: inc.worstPct,
            sigma: inc.worstSigma,
            requestsPerDay: inc.requestsPerDay,
            diagnosis: await diagnose(metric, inc.from, inc.to),
          });
        }
        w.watermark = fresh[fresh.length - 1]!.to;
      }
    }
  } finally {
    await ledger.close();
  }

  if (found.length) {
    save(all); // the full list, not the swept subset -- see the note at the top of this function

    mkdirSync(DIR, { recursive: true });
    for (const n of found) {
      appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...n })}\n`);
    }
  }
  return found;
}

/** What the user is sent. Plain text on purpose — it has to read well in a mail client. */
export function renderNotification(n: Notification): string {
  const where = n.watch.dimension ? `${n.watch.dimension} = '${n.watch.value}'` : "the platform";
  const dir = n.pct < 0 ? "down" : "up";
  const d = n.diagnosis;
  return [
    `It happened again: ${where}.`,
    ``,
    `${n.watch.metric} is ${dir} ${Math.abs(n.pct).toFixed(0)}% on ${n.day}, ` +
      `on about ${n.requestsPerDay.toLocaleString()} requests a day.`,
    d ? `` : ``,
    d ? `${channelLabel(d.channel)} — ${d.owner}.` : ``,
    d ? d.because : ``,
    d && d.impactUsdPerDay !== null
      ? `Worth ${d.impactUsdPerDay < 0 ? "-" : ""}$${Math.abs(d.impactUsdPerDay).toFixed(2)}/day.`
      : ``,
    d && d.clearedCount > 0
      ? `${d.clearedCount} other slice(s) looked implicated and were checked and cleared.`
      : ``,
    ``,
    `Full diagnosis:  "why did ${n.watch.metric} drop on ${n.day}?"`,
  ]
    .filter((l) => l !== undefined && l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Channel as a person would say it. Mirrors the table in engine/render.ts, which is not exported. */
export function channelLabel(channel: string): string {
  const labels: Record<string, string> = {
    technical_break: "Something is broken",
    demand_change: "The market moved — demand",
    supply_change: "The market moved — supply",
    mix_shift: "Nothing is broken, the traffic mix moved",
    seasonality: "Expected weekly pattern",
    not_localizable: "Platform-wide, no single segment",
    no_anomaly: "Within its normal band",
  };
  return labels[channel] ?? channel;
}

if (import.meta.main) {
  const say = (s = ""): void => {
    process.stdout.write(`${s}\n`);
  };

  const testTo = process.argv.indexOf("--test-email");
  if (testTo >= 0) {
    // Proves credentials end to end without waiting for an anomaly to recur.
    const to = process.argv[testTo + 1] ?? "";
    say(`\ndelivery: ${deliveryStatus()}`);
    const d = await sendNotification(to, "Watchman test", "If you are reading this, SMTP works.");
    say(d.sent ? `  sent via ${d.via}${to ? ` to ${to}` : ""}\n` : `  NOT sent: ${d.reason}\n`);
    process.exit(d.sent ? 0 : 1);
  }

  if (process.argv.includes("--list")) {
    const watches = listWatches();
    say(`\n${watches.length} watch(es)\n`);
    for (const w of watches) {
      say(
        `  ${w.id}  ${(w.userEmail ?? w.userId).padEnd(28)} ${w.metric.padEnd(11)} ` +
          `${w.dimension ? `${w.dimension}='${w.value}'` : "platform"}` +
          `${w.watermark ? `   last told: ${w.watermark}` : ""}`,
      );
    }
    say(``);
  } else {
    const found = await runOnce();
    say(`\nWATCH — ${listWatches().length} watch(es), ${found.length} new event(s)`);
    say(`  delivery: ${deliveryStatus()}\n`);
    for (const n of found) {
      const to = n.watch.userEmail ?? "";
      const body = renderNotification(n);
      const where = n.watch.dimension
        ? `${n.watch.dimension} = '${n.watch.value}'`
        : "the platform";
      const d = await sendNotification(to, `${n.watch.metric} moved again on ${where}`, body);
      say(
        `  -> ${to || n.watch.userId}   ${d.sent ? `sent via ${d.via}` : `not sent: ${d.reason}`}`,
      );
      say(
        body
          .split("\n")
          .map((l) => `     ${l}`)
          .join("\n"),
      );
      say(``);
    }
    if (found.length === 0) say(`  Nothing new. Watermarks unchanged.\n`);
    say(`  Every event is also appended to ${LOG}.\n`);
  }
  process.exit(0);
}
