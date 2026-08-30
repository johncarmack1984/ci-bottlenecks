import type { Rule, Finding } from "../types.ts";
import { durationMs, median, percentile, fmtMinutes } from "../utils.ts";

function matchJobId(jobName: string, workflow: { jobs: Map<string, { name?: string }> }): string | undefined {
  for (const [jobId, job] of workflow.jobs) {
    const label = job.name ?? jobId;
    if (label === jobName) return jobId;
    if (jobName.startsWith(`${label} (`)) return jobId;
  }
  return undefined;
}

function extractLegName(jobName: string, workflow: { jobs: Map<string, { name?: string }> }): string | undefined {
  for (const [jobId, job] of workflow.jobs) {
    const label = job.name ?? jobId;
    if (jobName.startsWith(`${label} (`)) {
      return jobName.slice(label.length + 2, -1);
    }
  }
  return undefined;
}

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
    const jobTimedOut = new Map<string, number>();
    const jobCancelledReal = new Map<string, number>();
    const jobSampleCount = new Map<string, number>();

    for (const run of auditData.runs) {
      const runCancelled = run.conclusion === "cancelled";
      for (const job of run.jobs) {
        jobSampleCount.set(job.name, (jobSampleCount.get(job.name) ?? 0) + 1);

        if (job.conclusion === "timed_out") {
          jobTimedOut.set(job.name, (jobTimedOut.get(job.name) ?? 0) + 1);
        }
        if (job.conclusion === "cancelled" && !runCancelled) {
          jobCancelledReal.set(job.name, (jobCancelledReal.get(job.name) ?? 0) + 1);
        }

        if (job.conclusion === "cancelled" || job.conclusion === "skipped") continue;

        const d = durationMs(job.startedAt, job.completedAt);
        if (d == null) continue;
        const arr = jobDurations.get(job.name) ?? [];
        arr.push(d);
        jobDurations.set(job.name, arr);
      }
    }

    for (const [jobName, durations] of jobDurations) {
      if (durations.length < 5) continue;
      const sorted = [...durations].sort((a, b) => a - b);
      const med = median(sorted);
      const p95 = percentile(sorted, 95);

      if (med > 0 && p95 >= med * 3) {
        const ratio = (p95 / med).toFixed(1);
        const jobId = matchJobId(jobName, workflow);
        const legName = extractLegName(jobName, workflow);
        let msg = `Job "${jobName}" has high duration variance: p95 is ${ratio}x the median`;
        if (legName) msg += ` (leg: ${legName})`;

        const sortedStr = sorted.map((d) => fmtMinutes(d)).join(", ");

        findings.push({
          rule: "flaky-or-hanging",
          severity: "high",
          tier: "audit",
          workflow: workflow.path,
          job: jobId,
          message: msg,
          evidence: `p95=${fmtMinutes(p95)}, median=${fmtMinutes(med)} (ratio ${ratio}x) over ${durations.length} samples. Sorted durations: [${sortedStr}]`,
          remediation: `Add timeout-minutes near ${fmtMinutes(p95)} and investigate the root cause of variance.`,
        });
      }
    }

    const totalRuns = auditData.runs.length;
    for (const [jobName, count] of jobTimedOut) {
      if (count / totalRuns < 0.1) continue;
      const jobId = matchJobId(jobName, workflow);
      const legName = extractLegName(jobName, workflow);
      let msg = `Job "${jobName}" timed out in ${count} of ${totalRuns} run(s)`;
      if (legName) msg += ` (leg: ${legName})`;
      findings.push({
        rule: "flaky-or-hanging",
        severity: "high",
        tier: "audit",
        workflow: workflow.path,
        job: jobId,
        message: msg,
        evidence: `${count} timed_out runs out of ${totalRuns} sampled`,
        remediation: "Investigate why the job is timing out.",
      });
    }

    for (const [jobName, count] of jobCancelledReal) {
      const samples = jobSampleCount.get(jobName) ?? 0;
      if (samples < 5) continue;
      if (count < 2) continue;
      if (count / totalRuns < 0.2) continue;

      const jobId = matchJobId(jobName, workflow);
      const legName = extractLegName(jobName, workflow);
      let msg = `Job "${jobName}" was cancelled in ${count} of ${totalRuns} run(s) (excluding cancel-in-progress)`;
      if (legName) msg += ` (leg: ${legName})`;
      findings.push({
        rule: "flaky-or-hanging",
        severity: "high",
        tier: "audit",
        workflow: workflow.path,
        job: jobId,
        message: msg,
        evidence: `${count} cancelled runs (not from cancel-in-progress) out of ${totalRuns} sampled`,
        remediation: "Investigate why the job is being cancelled.",
      });
    }

    return findings;
  },
};
