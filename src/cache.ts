import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_CACHE_DIR = ".ci-bottlenecks/cache";

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
