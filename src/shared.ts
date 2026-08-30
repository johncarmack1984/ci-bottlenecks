import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { fetchWorkflows, fetchRunsForWorkflow, fetchJobsForRun } from "./api.ts";
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
  const nwoSlug = nwo.replace("/", "_");

  const apiWorkflows = await cachedFetch(
    cacheDir,
    `${nwoSlug}/workflows`,
    60 * 60 * 1000,
    () => fetchWorkflows(nwo),
  );

  if (apiWorkflows.length === 0) {
    log?.("No workflows found via API.");
    return map;
  }

  for (const wf of workflows) {
    const apiWf = apiWorkflows.find((aw) => aw.path === wf.path);
    if (!apiWf) continue;

    const pathSlug = wf.path.replace(/[/\\]/g, "_").replace(/\.ya?ml$/, "");
    const runs = await cachedFetch(
      cacheDir,
      `${nwoSlug}/workflow_runs/${pathSlug}_${maxRuns}`,
      60 * 60 * 1000,
      () => fetchRunsForWorkflow(nwo, apiWf.id, maxRuns),
    );

    if (runs.length === 0) continue;

    log?.(`${wf.path}: ${runs.length} runs, loading job data...`);

    const enrichedRuns: RunData[] = [];
    for (const run of runs) {
      const jobs = await cachedFetch(
        cacheDir,
        `${nwoSlug}/jobs/${run.id}`,
        0,
        () => fetchJobsForRun(nwo, run.id),
      );
      enrichedRuns.push({ ...run, jobs });
    }

    map.set(wf.path, { runs: enrichedRuns });
  }

  return map;
}
