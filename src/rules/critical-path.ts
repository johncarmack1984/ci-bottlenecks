import type { Rule, Finding } from "../types.ts";
import { computeCriticalPath } from "../dag.ts";
import type { DagNode } from "../dag.ts";
import { durationMs, median, fmtMinutes } from "../utils.ts";

function matchJobDurations(
  jobName: string,
  jobDurations: Map<string, number[]>,
): number[] {
  if (jobDurations.has(jobName)) return jobDurations.get(jobName)!;
  const prefix = `${jobName} (`;
  const legDurations: number[][] = [];
  for (const [name, durations] of jobDurations) {
    if (name.startsWith(prefix)) legDurations.push(durations);
  }
  if (legDurations.length > 0) {
    return legDurations.flat();
  }
  const escapedName = jobName.replace(/\$\{\{[^}]*\}\}/g, ".*").replace(/[.*+?^${}()|[\]\\]/g, (m) => m === ".*" ? ".*" : `\\${m}`);
  if (escapedName !== jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) {
    const pattern = new RegExp(`^${escapedName}$`);
    for (const [name, durations] of jobDurations) {
      if (pattern.test(name)) return durations;
    }
  }
  return [];
}

export const criticalPath: Rule = {
  id: "critical-path",
  tier: "audit",
  severity: "info",
  describe: "Critical path through the job dependency graph",

  check(ctx): Finding[] {
    const { workflow, auditData } = ctx;
    if (!auditData || auditData.runs.length === 0) return [];

    if (auditData.runs.length < 3) return [];

    if (workflow.jobs.size <= 1) return [];

    const jobDurations = new Map<string, number[]>();
    for (const run of auditData.runs) {
      for (const job of run.jobs) {
        const d = durationMs(job.startedAt, job.completedAt);
        if (d == null) continue;
        const arr = jobDurations.get(job.name) ?? [];
        arr.push(d);
        jobDurations.set(job.name, arr);
      }
    }

    const nodes: DagNode[] = [];
    const unmatchedJobs: string[] = [];
    for (const [jobId, job] of workflow.jobs) {
      const label = job.name ?? jobId;
      const durations = matchJobDurations(label, jobDurations);
      const dur = median(durations);
      if (durations.length === 0) {
        unmatchedJobs.push(label);
      }
      nodes.push({
        jobId,
        duration: dur,
        needs: job.needs,
      });
    }

    if (nodes.length === 0) return [];

    const result = computeCriticalPath(nodes);
    if (result.path.length === 0) return [];

    if (result.totalDuration <= 0) return [];
    if (result.totalDuration < 60_000) return [];

    const unmatchedOnPath = result.path.filter((id) => {
      const node = nodes.find((n) => n.jobId === id);
      if (!node) return false;
      const label = workflow.jobs.get(id)?.name ?? id;
      return matchJobDurations(label, jobDurations).length === 0;
    });

    const matchedPathDuration = result.path.reduce((sum, id) => {
      if (unmatchedOnPath.includes(id)) return sum;
      const node = nodes.find((n) => n.jobId === id);
      return sum + (node?.duration ?? 0);
    }, 0);

    const longestJob = result.path
      .filter((id) => !unmatchedOnPath.includes(id))
      .reduce((best, id) => {
        const node = nodes.find((n) => n.jobId === id);
        const bestNode = nodes.find((n) => n.jobId === best);
        return (node?.duration ?? 0) > (bestNode?.duration ?? 0) ? id : best;
      }, result.path[0]!);

    const longestDuration = nodes.find((n) => n.jobId === longestJob)?.duration ?? 0;

    let severity: "info" | "medium" = "info";
    if (matchedPathDuration > 30 * 60_000) severity = "medium";
    if (longestDuration > 0 && matchedPathDuration > longestDuration * 2) severity = "medium";

    const pathStr = result.path
      .map((id) => {
        if (unmatchedOnPath.includes(id)) {
          return `${id} (unmatched)`;
        }
        const node = nodes.find((n) => n.jobId === id);
        return `${id} (${fmtMinutes(node?.duration ?? 0)})`;
      })
      .join(" -> ");

    const offPathSlack = [...result.slack.entries()]
      .filter(([id, s]) => !result.path.includes(id) && s > 0)
      .map(([id, s]) => `${id}: ${fmtMinutes(s)} slack`)
      .join(", ");

    let evidence = `Measured over ${auditData.runs.length} runs. Critical path: ${fmtMinutes(matchedPathDuration)}`;

    if (unmatchedOnPath.length > 0) {
      evidence += `. Unmatched: ${unmatchedOnPath.map((id) => {
        const label = workflow.jobs.get(id)?.name ?? id;
        return `${label} (skipped in all sampled runs?)`;
      }).join(", ")}`;
    }

    if (offPathSlack) {
      evidence += `. Off-path slack: ${offPathSlack}`;
    }

    const findings: Finding[] = [
      {
        rule: "critical-path",
        severity,
        tier: "audit",
        workflow: workflow.path,
        message: `${fmtMinutes(matchedPathDuration)} critical path: ${pathStr}`,
        evidence,
        remediation: `Optimize "${longestJob}" or break it into parallel jobs to shorten the critical path.`,
        estimatedSavings: { minutesPerRun: Math.round(matchedPathDuration / 60_000 * 10) / 10, confidence: "estimate" },
      },
    ];

    return findings;
  },
};
