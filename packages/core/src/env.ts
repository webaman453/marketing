import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

/** Walks up from `start` to the first directory containing a .env file. */
function findEnvFile(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads the repo-root .env (or ENV_FILE) once. Variables already set in the
 * environment win, so production platforms can inject config directly.
 */
export function loadEnv() {
  const file = process.env.ENV_FILE ?? findEnvFile(process.cwd());
  if (file) {
    config({ path: file, quiet: true });
    // Relative paths in .env (e.g. UPLOAD_DIR) resolve against the .env location.
    process.env.REPO_ROOT ??= path.dirname(file);
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
