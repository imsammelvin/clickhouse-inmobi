/**
 * Env var validation. LangfuseSpanProcessor reads LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL itself;
 * this just gives a friendlier error than a silent no-op export if they're missing.
 */

const REQUIRED_LANGFUSE_VARS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

export enum NarrationEnvVar {
  DeepseekApiKey = "DEEPSEEK_API_KEY",
}

export function assertLangfuseEnv(): void {
  const missing = REQUIRED_LANGFUSE_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing env var(s): ${missing.join(", ")}. Copy backend/langfuse/.env.example to .env (repo root) and fill in your Langfuse project keys.`,
    );
  }
}
