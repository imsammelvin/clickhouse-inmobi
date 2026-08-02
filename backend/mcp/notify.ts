/**
 * Getting the notification out of the process.
 *
 * Uses the SAME environment variables LibreChat already defines for its own mail — `EMAIL_HOST`,
 * `EMAIL_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, `EMAIL_FROM` — so the operator configures SMTP once
 * and both the chat app and the watchman use it. Inventing a second set of names would guarantee that
 * one of them is eventually wrong.
 *
 * `nodemailer` is imported DYNAMICALLY, and that is deliberate: the watchman must keep working when the
 * package is absent or SMTP is unconfigured. Delivery degrades to the JSONL log and says which sink it
 * used, because a cron that silently stops mailing is indistinguishable from a quiet week — and this
 * whole feature exists to tell people when something changed.
 */
export interface Delivery {
  sent: boolean;
  via: "webhook" | "resend" | "smtp" | "log";
  reason?: string;
}

/**
 * Three ways out, tried in order of how little setup they need.
 *
 * The server cannot simply mail you itself. Delivering straight to a recipient's MX needs outbound
 * port 25 — blocked on this machine, and blocked by most ISPs and cloud providers — and even when it
 * is open, mail from an address with no SPF, DKIM or reverse DNS is rejected or binned by every large
 * provider. Something has to vouch for the sender, so the only real choice is WHICH thing.
 *
 *   WATCH_WEBHOOK_URL   a Slack or Discord incoming webhook. Paste one URL, no account to verify, no
 *                       deliverability to worry about. The most reliable option for a demo.
 *   RESEND_API_KEY      real email via HTTPS. One key, no host/port/TLS/app-password.
 *   EMAIL_*             SMTP, reusing LibreChat's existing variables.
 *
 * Whichever is configured first wins, and the runner prints which one it used.
 */
async function sendWebhook(subject: string, text: string): Promise<Delivery | null> {
  const url = process.env.WATCH_WEBHOOK_URL;
  if (!url) return null;
  try {
    const body = `*${subject}*\n${text}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Slack reads `text`, Discord reads `content`. Both ignore the key they do not know, so one
      // payload serves either without asking the operator which they configured.
      body: JSON.stringify({ text: body, content: body }),
    });
    return res.ok
      ? { sent: true, via: "webhook" }
      : { sent: false, via: "log", reason: `webhook returned ${res.status}` };
  } catch (error) {
    return { sent: false, via: "log", reason: `webhook failed: ${(error as Error).message}` };
  }
}

async function sendResend(to: string, subject: string, text: string): Promise<Delivery | null> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!to.includes("@")) return { sent: false, via: "log", reason: `no email address ("${to}")` };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "watchman@resend.dev",
        to,
        subject,
        text,
      }),
    });
    return res.ok
      ? { sent: true, via: "resend" }
      : {
          sent: false,
          via: "log",
          reason: `resend returned ${res.status}: ${(await res.text()).slice(0, 120)}`,
        };
  } catch (error) {
    return { sent: false, via: "log", reason: `resend failed: ${(error as Error).message}` };
  }
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
  allowSelfSigned: boolean;
}

/** SMTP config if it is fully specified, otherwise the reason it is not usable. */
export function smtpConfig(): SmtpConfig | { missing: string[] } {
  const env = process.env;
  const missing = ["EMAIL_HOST", "EMAIL_USERNAME", "EMAIL_PASSWORD"].filter((k) => !env[k]);
  if (missing.length) return { missing };

  const port = Number(env.EMAIL_PORT ?? 587);
  return {
    host: env.EMAIL_HOST!,
    port,
    user: env.EMAIL_USERNAME!,
    pass: env.EMAIL_PASSWORD!,
    // Fall back to the authenticating user so a misconfigured From cannot silently drop mail.
    from: env.EMAIL_FROM || env.EMAIL_USERNAME!,
    // 465 is implicit TLS; 587 upgrades with STARTTLS, which nodemailer does when secure=false.
    secure: (env.EMAIL_ENCRYPTION ?? "").toLowerCase() === "tls" || port === 465,
    allowSelfSigned: env.EMAIL_ALLOW_SELFSIGNED === "true",
  };
}

async function sendSmtp(to: string, subject: string, text: string): Promise<Delivery> {
  const cfg = smtpConfig();
  if ("missing" in cfg) {
    return {
      sent: false,
      via: "log",
      reason: `SMTP not configured (missing ${cfg.missing.join(", ")})`,
    };
  }
  if (!to || !to.includes("@")) {
    return { sent: false, via: "log", reason: `no email address for this watch ("${to}")` };
  }

  let nodemailer: typeof import("nodemailer");
  try {
    nodemailer = await import("nodemailer");
  } catch {
    return {
      sent: false,
      via: "log",
      reason: "nodemailer is not installed — run: bun add nodemailer",
    };
  }

  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      ...(cfg.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    });
    await transport.sendMail({ from: cfg.from, to, subject, text });
    return { sent: true, via: "smtp" };
  } catch (error) {
    // Never let a mail failure take the run down: the finding is already in the log, and a cron that
    // exits non-zero on a transient SMTP error will be muted by whoever is on call.
    return {
      sent: false,
      via: "log",
      reason: `SMTP send failed: ${(error as Error).message.split("\n")[0]}`,
    };
  }
}

/** Try each sink in order of setup cost; the first configured one wins. */
export async function sendNotification(
  to: string,
  subject: string,
  text: string,
): Promise<Delivery> {
  return (
    (await sendWebhook(subject, text)) ??
    (await sendResend(to, subject, text)) ??
    (await sendSmtp(to, subject, text))
  );
}

/** One-line description of where a notification would go, printed on every run. */
export function deliveryStatus(): string {
  if (process.env.WATCH_WEBHOOK_URL)
    return `webhook (${new URL(process.env.WATCH_WEBHOOK_URL).host})`;
  if (process.env.RESEND_API_KEY) return "email via Resend";
  const cfg = smtpConfig();
  return "missing" in cfg
    ? `log only — set WATCH_WEBHOOK_URL (easiest), RESEND_API_KEY, or EMAIL_HOST/USERNAME/PASSWORD`
    : `SMTP ${cfg.host}:${cfg.port} as ${cfg.user}`;
}
