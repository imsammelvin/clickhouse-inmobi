/**
 * Build the whole project.
 *
 *   bun run build              # typecheck, bundle every entry point, copy runtime assets
 *   bun run build -- --skip-typecheck
 *
 * WHY A SCRIPT RATHER THAN A ONE-LINER. The old `build` script was
 * `bun build backend/api/server.ts --outdir dist --target=node` — one of twenty-odd entry points, and
 * silently so. `bun run build` passing said nothing about whether the MCP server, the dashboard, the
 * loader or any gate still bundled. Everything that ships is built here or it is not built.
 *
 * WHERE THE ENTRY POINTS COME FROM. They are derived from `package.json` scripts rather than listed
 * again: a hand-kept list in a build file is a list that goes stale the first time someone adds a
 * command, and the failure mode is silent (a missing bundle, not an error). If it is runnable via
 * `bun run <name>`, it is built.
 *
 * WHY THE LAYOUT IS MIRRORED. `shared/constants/index.ts` computes `REPO_ROOT` from
 * `import.meta.dir`, and the dashboard resolves `frontend/` and its benchmark JSON the same way. A
 * flat `--outdir dist` breaks all of that. Bundling `backend/api/server.ts` to
 * `dist/backend/api/server.js` keeps every one of those relative walks correct, with `dist/` standing
 * in for the repo root — which is why the asset copy below is part of the build and not a nicety.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../../shared/constants";
import { fmt, runScript } from "../../shared/utils/common.utils";

const OUT_DIR = join(REPO_ROOT, "dist");

const say = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};

/**
 * Runtime files the bundles read from disk, and where they must land so the mirrored layout finds
 * them. Source is repo-relative; destination is the same path under `dist/`.
 */
const ASSETS = [
  "backend/clickhouse/schema.sql",
  "backend/observability/clickstack-schema.sql",
  "backend/dashboard-server/data",
  "frontend",
] as const;

/** Every `bun run backend/....ts` in package.json scripts, deduplicated, in declaration order. */
async function entryPoints(): Promise<string[]> {
  const pkg = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as {
    scripts?: Record<string, string>;
  };
  const found = new Set<string>();
  for (const command of Object.values(pkg.scripts ?? {})) {
    for (const match of command.matchAll(/(?:^|\s)((?:backend|shared)\/[\w./-]+\.ts)/g)) {
      const rel = match[1]!;
      // `bun build` is what we are running; bundling the builder into its own output is noise.
      if (rel.endsWith("scripts/build.ts")) continue;
      if (existsSync(join(REPO_ROOT, rel))) found.add(rel);
    }
  }
  return [...found].sort();
}

async function typecheck(): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "typecheck"], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    process.stdout.write(`${out}${err}`);
    throw new Error("typecheck failed — not building a bundle that does not compile.");
  }
}

const main = async (): Promise<void> => {
  const skipTypecheck = process.argv.includes("--skip-typecheck");

  if (!skipTypecheck) {
    say("== typecheck ==");
    await typecheck();
    say("  ok    tsc --noEmit\n");
  }

  const entries = await entryPoints();
  say(`== bundling ${entries.length} entry point(s) ==`);

  // A clean output directory, because a stale bundle from a deleted entry point is worse than no
  // bundle: it runs, and it runs code that is no longer in the repo.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  let totalBytes = 0;
  const failures: string[] = [];

  for (const entry of entries) {
    const outdir = join(OUT_DIR, dirname(entry));
    const result = await Bun.build({
      entrypoints: [join(REPO_ROOT, entry)],
      outdir,
      // `bun`, not `node`: these are Bun programs (Bun.serve, Bun.spawn, Bun.file) and building for
      // node would produce bundles that fail at runtime rather than at build time.
      target: "bun",
      sourcemap: "linked",
    });

    if (!result.success) {
      failures.push(entry);
      say(`  FAIL  ${entry}`);
      for (const log of result.logs) say(`          ${log.message}`);
      continue;
    }

    const bytes = result.outputs
      .filter((o) => o.kind === "entry-point")
      .reduce((a, o) => a + o.size, 0);
    totalBytes += bytes;
    say(`  ok    ${entry.padEnd(44)} ${`${(bytes / 1024).toFixed(0)} KiB`.padStart(9)}`);
  }

  say(`\n== assets ==`);
  for (const asset of ASSETS) {
    const from = join(REPO_ROOT, asset);
    if (!existsSync(from)) {
      say(`  skip  ${asset} (not present)`);
      continue;
    }
    await cp(from, join(OUT_DIR, asset), { recursive: true });
    say(`  ok    ${asset}`);
  }

  // The raw dataset is gigabytes and only `ch:load` reads it. A symlink keeps `DATA_DIR` resolvable
  // from inside dist without copying it; if it is missing, only the loader is affected.
  const data = join(REPO_ROOT, "InMobi");
  if (existsSync(data)) {
    symlinkSync(data, join(OUT_DIR, "InMobi"), "dir");
    say(`  ok    InMobi -> symlink (dataset not copied)`);
  }

  say(
    `\n${entries.length - failures.length}/${entries.length} bundled, ` +
      `${fmt(Math.round(totalBytes / 1024))} KiB total -> dist/`,
  );
  say(`\nRun a bundle the same way you run the source, e.g.:`);
  say(`  bun dist/backend/api/server.js`);
  say(`  bun dist/backend/mcp/server.js --transport http`);

  if (failures.length) {
    throw new Error(`${failures.length} entry point(s) failed to bundle: ${failures.join(", ")}`);
  }
};

if (import.meta.main) await runScript(main);
