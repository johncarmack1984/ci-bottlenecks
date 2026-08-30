import type { Rule, Finding } from "../types.ts";
import { durationMs, median, percentile, fmtMinutes } from "../utils.ts";

export const flakyOrHanging: Rule = {
  id: "flaky-or-hanging",
  tier: "audit",
  severity: "high",
  describe: "Job with high duration variance or frequent cancellations",

  check(ctx): Finding[] {
    const { workflow, auditData } = ctx;
    if (!auditData || auditData.runs.length === 0) return [];

    const findings: Finding[] = [];

    const jobDurations = new Map<string, number[]>();
    const jobFailures = new Map<string, number>();

    for (const run of auditData.runs) {
      for (const job of run.jobs) {
        if (job.conclusion === "cancelled" || job.conclusion === "timed_out") {
          jobFailures.set(job.name, (jobFailures.get(job.name) ?? 0) + 1);
        }
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

    for (const [jobName, durations] of jobDurations) {
      if (durations.length < 5) continue;
      const sorted = [...durations].sort((a, b) => a - b);
      const med = median(sorted);
      const p95 = percentile(sorted, 95);

      if (med > 0 && p95 >= med * 3) {
        const ratio = (p95 / med).toFixed(1);
        const jobId = jobIdByName.get(jobName);
        findings.push({
          rule: "flaky-or-hanging",
          severity: "high",
          tier: "audit",
          workflow: workflow.path,
          job: jobId,
          message: `Job "${jobName}" has high duration variance: p95 is ${ratio}x the median`,
          evidence: `p95=${fmtMinutes(p95)}, median=${fmtMinutes(med)} (ratio ${ratio}x) over ${durations.length} samples`,
          remediation: `Add timeout-minutes near ${fmtMinutes(p95)} and investigate the root cause of variance.`,
        });
      }
    }

    for (const [jobName, count] of jobFailures) {
      const jobId = jobIdByName.get(jobName);
      findings.push({
        rule: "flaky-or-hanging",
        severity: "high",
        tier: "audit",
        workflow: workflow.path,
        job: jobId,
        message: `Job "${jobName}" had ${count} cancelled/timed_out run(s)`,
        evidence: `${count} cancelled/timed_out runs out of ${auditData.runs.length} sampled`,
        remediation: "Investigate why the job is being cancelled or timing out.",
      });
    }

    return findings;
  },
};
