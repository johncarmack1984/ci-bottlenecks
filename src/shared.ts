import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { fetchRuns, fetchJobsForRun } from "./api.ts";
import { cachedFetch, DEFAULT_CACHE_DIR } from "./cache.ts";
import type { ParsedWorkflow, WorkflowAuditData, RunData } from "./types.ts";

export function discoverWorkflows(basePath: string): string[] {
  const wfDir = join(basePath, ".github", "workflows");
  if (!existsSync(wfDir)) return [];
  try {
    return readdirSync(wfDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => join(wfDir, f));
  } catch {
    return [];
  }
}

export async function loadAuditData(
  nwo: string,
  workflows: ParsedWorkflow[],
  maxRuns: number,
  log?: (msg: string) => void,
): Promise<Map<string, WorkflowAuditData>> {
  const cacheDir = DEFAULT_CACHE_DIR;
  const map = new Map<string, WorkflowAuditData>();

  const runs = await cachedFetch(
    cacheDir,
    `${nwo.replace("/", "_")}/runs`,
    60 * 60 * 1000,
    () => fetchRuns(nwo, maxRuns),
  );

  if (runs.length === 0) {
    log?.("No completed runs found for this repository.");
    return map;
  }

  log?.(`Fetched ${runs.length} runs, loading job data...`);

  const enrichedRuns: RunData[] = [];
  for (const run of runs.slice(0, maxRuns)) {
    const jobs = await cachedFetch(
      cacheDir,
      `${nwo.replace("/", "_")}/jobs/${run.id}`,
      0,
      () => fetchJobsForRun(nwo, run.id),
    );
    enrichedRuns.push({ ...run, jobs });
  }

  for (const wf of workflows) {
    const wfRuns = enrichedRuns.filter((r) => {
      const wfFileName = wf.path.split("/").pop()?.replace(/\.ya?ml$/, "");
      return r.name === wf.name || r.name === wfFileName;
    });
    if (wfRuns.length > 0) {
      map.set(wf.path, { runs: wfRuns });
    }
  }

  return map;
}
