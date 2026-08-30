import type { Rule, Finding } from "../types.ts";
import { computeCriticalPath } from "../dag.ts";
import type { DagNode } from "../dag.ts";
import { durationMs, median, fmtMinutes } from "../utils.ts";

function matchJobDurations(
  jobName: string,
  jobDurations: Map<string, number[]>,
): number[] {
  // Exact match first
  if (jobDurations.has(jobName)) return jobDurations.get(jobName)!;
  // Matrix legs: "test (ubuntu-latest)" matches job name "test"
  // Templated names: "Lint ${{ matrix.os }}" won't match exactly
  // Collect all entries that start with "jobName (" and take the max over legs
  const prefix = `${jobName} (`;
  const legDurations: number[][] = [];
  for (const [name, durations] of jobDurations) {
    if (name.startsWith(prefix)) legDurations.push(durations);
  }
  if (legDurations.length > 0) {
    // For DAG purposes, use the max median across legs
    return legDurations.flat();
  }
  // Try regex matching for templated names with ${{ }}
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
    for (const [jobId, job] of workflow.jobs) {
      const label = job.name ?? jobId;
      const durations = matchJobDurations(label, jobDurations);
      nodes.push({
        jobId,
        duration: median(durations),
        needs: job.needs,
      });
    }

    if (nodes.length === 0) return [];

    const result = computeCriticalPath(nodes);
    if (result.path.length === 0) return [];

    // Suppress when nothing matched (all durations are 0)
    if (result.totalDuration <= 0) return [];

    const longestJob = result.path.reduce((best, id) => {
      const node = nodes.find((n) => n.jobId === id);
      const bestNode = nodes.find((n) => n.jobId === best);
      return (node?.duration ?? 0) > (bestNode?.duration ?? 0) ? id : best;
    });

    const longestDuration = nodes.find((n) => n.jobId === longestJob)?.duration ?? 0;

    // Severity medium if serialization dominates (>2x single longest job)
    const severity = result.totalDuration > longestDuration * 2 ? "medium" as const : "info" as const;

    const pathStr = result.path
      .map((id) => {
        const node = nodes.find((n) => n.jobId === id);
        return `${id} (${fmtMinutes(node?.duration ?? 0)})`;
      })
      .join(" -> ");

    const offPathSlack = [...result.slack.entries()]
      .filter(([id, s]) => !result.path.includes(id) && s > 0)
      .map(([id, s]) => `${id}: ${fmtMinutes(s)} slack`)
      .join(", ");

    const findings: Finding[] = [
      {
        rule: "critical-path",
        severity,
        tier: "audit",
        workflow: workflow.path,
        message: `Critical path is ${fmtMinutes(result.totalDuration)}: ${pathStr}. Longest job on path: "${longestJob}" (${fmtMinutes(longestDuration)})`,
        evidence: `Measured over ${auditData.runs.length} runs. Critical path: ${fmtMinutes(result.totalDuration)}`,
        remediation: `Optimize "${longestJob}" or break it into parallel jobs to shorten the critical path.`,
      },
    ];

    if (offPathSlack) {
      findings[0]!.evidence += `. Off-path slack: ${offPathSlack}`;
    }

    return findings;
  },
};
