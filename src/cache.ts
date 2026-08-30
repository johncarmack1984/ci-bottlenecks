import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

// Cache lives in the user's cache directory, never in the audited repo's
// working tree (an untracked .ci-bottlenecks/ there risks being swept into
// someone's commit). Override with CI_BOTTLENECKS_CACHE; on hosted runners
// RUNNER_TEMP keeps it inside the job's disposable workspace.
function defaultCacheDir(): string {
  const override = process.env["CI_BOTTLENECKS_CACHE"];
  if (override) return override;
  const runnerTemp = process.env["RUNNER_TEMP"];
  if (runnerTemp) return join(runnerTemp, "ci-bottlenecks-cache");
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg) return join(xdg, "ci-bottlenecks");
  try {
    return join(homedir(), ".cache", "ci-bottlenecks");
  } catch {
    return join(tmpdir(), "ci-bottlenecks-cache");
  }
}

export const DEFAULT_CACHE_DIR = defaultCacheDir();

export async function cachedFetch<T>(
  cacheDir: string,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const filePath = `${cacheDir}/${key}.json`;

  if (existsSync(filePath)) {
    try {
      const stat = statSync(filePath);
      const age = Date.now() - stat.mtimeMs;
      if (ttlMs <= 0 || age < ttlMs) {
        const raw = readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as T;
      }
    } catch {
      // stale or corrupt — re-fetch
    }
  }

  const result = await fetcher();

  try {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(result));
  } catch {
    // cache write failure is non-fatal
  }

  return result;
}
