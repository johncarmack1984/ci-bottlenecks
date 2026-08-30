import { execSync } from "node:child_process";
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

  try {
    const text = execSync(`gh api ${path}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
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
  const labels = j.labels as string[] | undefined;
  return {
    id: j.id as number,
    name: j.name as string,
    conclusion: (j.conclusion as string) ?? "",
    createdAt: (j.created_at as string) ?? (j.createdAt as string) ?? null,
    startedAt: (j.started_at as string) ?? (j.startedAt as string) ?? null,
    completedAt: (j.completed_at as string) ?? (j.completedAt as string) ?? null,
    runnerLabel: labels && labels.length > 0 ? labels[0]! : (j.runner_label as string) ?? (j.runnerLabel as string) ?? null,
    steps: rawSteps.map(mapStep),
  };
}

function mapRun(r: Record<string, unknown>): RunData {
  return {
    id: r.id as number,
    name: r.name as string,
    workflowId: r.workflow_id as number,
    headSha: r.head_sha as string,
    event: (r.event as string) ?? "",
    conclusion: (r.conclusion as string) ?? "",
    createdAt: r.created_at as string,
    runStartedAt: (r.run_started_at as string) ?? null,
    updatedAt: r.updated_at as string,
    jobs: [],
  };
}

export interface WorkflowInfo {
  id: number;
  path: string;
  name: string;
}

export async function fetchWorkflows(nwo: string): Promise<WorkflowInfo[]> {
  const results: WorkflowInfo[] = [];
  let page = 1;
  while (true) {
    const data = await apiGet(
      `/repos/${nwo}/actions/workflows?per_page=100&page=${page}`,
    );
    if (!data || typeof data !== "object") break;
    const workflows = (data as Record<string, unknown>).workflows;
    if (!Array.isArray(workflows) || workflows.length === 0) break;
    for (const w of workflows) {
      const wf = w as Record<string, unknown>;
      results.push({
        id: wf.id as number,
        path: wf.path as string,
        name: wf.name as string,
      });
    }
    if (workflows.length < 100) break;
    page++;
  }
  return results;
}

export async function fetchRunsForWorkflow(nwo: string, workflowId: number, count: number): Promise<RunData[]> {
  const data = await apiGet(
    `/repos/${nwo}/actions/workflows/${workflowId}/runs?per_page=${count}&status=completed`,
  );
  if (!data || typeof data !== "object") return [];
  const runs = (data as Record<string, unknown>).workflow_runs;
  if (!Array.isArray(runs)) return [];
  return runs.map((r) => mapRun(r as Record<string, unknown>));
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

export function detectNwo(cwd?: string): string | null {
  try {
    const url = execSync("git remote get-url origin", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd: cwd || undefined }).trim();
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
