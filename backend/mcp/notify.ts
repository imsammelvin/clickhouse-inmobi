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
  via: "smtp" | "log";
  reason?: string;
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

export async function sendEmail(to: string, subject: string, text: string): Promise<Delivery> {
  const cfg = smtpConfig();
  if ("missing" in cfg) {
    return { sent: false, via: "log", reason: `SMTP not configured (missing ${cfg.missing.join(", ")})` };
  }
  if (!to || !to.includes("@")) {
    return { sent: false, via: "log", reason: `no email address for this watch ("${to}")` };
  }

  let nodemailer: typeof import("nodemailer");
  try {
    nodemailer = await import("nodemailer");
  } catch {
    return { sent: false, via: "log", reason: "nodemailer is not installed — run: bun add nodemailer" };
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
    return { sent: false, via: "log", reason: `SMTP send failed: ${(error as Error).message.split("\n")[0]}` };
  }
}

/** One-line description of where mail would go, for the runner's banner. */
export function deliveryStatus(): string {
  const cfg = smtpConfig();
  return "missing" in cfg
    ? `log only — SMTP not configured (missing ${cfg.missing.join(", ")})`
    : `SMTP ${cfg.host}:${cfg.port} as ${cfg.user}`;
}
