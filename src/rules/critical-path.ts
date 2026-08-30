import type { Rule, Finding } from "../types.ts";
import { computeCriticalPath } from "../dag.ts";
import type { DagNode } from "../dag.ts";
import { durationMs, median, fmtMinutes } from "../utils.ts";

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

    const jobIdByName = new Map<string, string>();
    for (const [jobId, job] of workflow.jobs) {
      jobIdByName.set(job.name ?? jobId, jobId);
    }

    const nodes: DagNode[] = [];
    for (const [jobId, job] of workflow.jobs) {
      const label = job.name ?? jobId;
      const durations = jobDurations.get(label) ?? [];
      nodes.push({
        jobId,
        duration: median(durations),
        needs: job.needs,
      });
    }

    if (nodes.length === 0) return [];

    const result = computeCriticalPath(nodes);
    if (result.path.length === 0) return [];

    const longestJob = result.path.reduce((best, id) => {
      const node = nodes.find((n) => n.jobId === id);
      const bestNode = nodes.find((n) => n.jobId === best);
      return (node?.duration ?? 0) > (bestNode?.duration ?? 0) ? id : best;
    });

    const longestDuration = nodes.find((n) => n.jobId === longestJob)?.duration ?? 0;

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
