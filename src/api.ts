import type { RunData, JobData, StepData } from "./types.ts";

const API_BASE = "https://api.github.com";

async function apiGet(path: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const resp = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!resp.ok) return null;
    return resp.json();
  }

  const proc = Bun.spawn(["gh", "api", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mapStep(s: Record<string, unknown>): StepData {
  return {
    name: s.name as string,
    number: s.number as number,
    status: s.status as string,
    conclusion: (s.conclusion as string) ?? null,
    startedAt: (s.started_at as string) ?? null,
    completedAt: (s.completed_at as string) ?? null,
  };
}

function mapJob(j: Record<string, unknown>): JobData {
  const rawSteps = (j.steps as Record<string, unknown>[]) ?? [];
  return {
    id: j.id as number,
    name: j.name as string,
    conclusion: (j.conclusion as string) ?? "",
    startedAt: (j.started_at as string) ?? null,
    completedAt: (j.completed_at as string) ?? null,
    steps: rawSteps.map(mapStep),
  };
}

function mapRun(r: Record<string, unknown>): RunData {
  return {
    id: r.id as number,
    name: r.name as string,
    workflowId: r.workflow_id as number,
    headSha: r.head_sha as string,
    conclusion: (r.conclusion as string) ?? "",
    createdAt: r.created_at as string,
    runStartedAt: (r.run_started_at as string) ?? null,
    updatedAt: r.updated_at as string,
    jobs: [],
  };
}

export async function fetchRuns(nwo: string, count: number): Promise<RunData[]> {
  const data = await apiGet(
    `/repos/${nwo}/actions/runs?per_page=${count}&status=completed`,
  );
  if (!data || typeof data !== "object") return [];
  const runs = (data as Record<string, unknown>).workflow_runs;
  if (!Array.isArray(runs)) return [];
  return runs.map((r) => mapRun(r as Record<string, unknown>));
}

export async function fetchJobsForRun(nwo: string, runId: number): Promise<JobData[]> {
  const data = await apiGet(
    `/repos/${nwo}/actions/runs/${runId}/jobs?per_page=100`,
  );
  if (!data || typeof data !== "object") return [];
  const jobs = (data as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) => mapJob(j as Record<string, unknown>));
}

export function detectNwo(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = new TextDecoder().decode(proc.stdout).trim();
    if (!url) return null;

    const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1]!;

    const httpsMatch = url.match(/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1]!;

    return null;
  } catch {
    return null;
  }
}
