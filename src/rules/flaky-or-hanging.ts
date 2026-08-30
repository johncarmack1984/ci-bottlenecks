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
    const jobTimedOut = new Map<string, number>();
    const jobCancelledReal = new Map<string, number>();

    for (const run of auditData.runs) {
      const runCancelled = run.conclusion === "cancelled";
      for (const job of run.jobs) {
        if (job.conclusion === "timed_out") {
          jobTimedOut.set(job.name, (jobTimedOut.get(job.name) ?? 0) + 1);
        }
        // Only count job cancellation when the run itself wasn't cancelled
        // (superseded by cancel-in-progress is not a real failure)
        if (job.conclusion === "cancelled" && !runCancelled) {
          jobCancelledReal.set(job.name, (jobCancelledReal.get(job.name) ?? 0) + 1);
        }

        // Exclude cancelled/skipped from duration stats
        if (job.conclusion === "cancelled" || job.conclusion === "skipped") continue;

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

    // 5 samples: below this the p95 is a single data point and the ratio is noise
    // 3× threshold: normal CI jitter is ~1.5×; 3× reliably indicates a bimodal distribution
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

    // 10% threshold: below this, one fluke in a small sample dominates
    const totalRuns = auditData.runs.length;
    for (const [jobName, count] of jobTimedOut) {
      if (count / totalRuns < 0.1) continue;
      const jobId = jobIdByName.get(jobName);
      findings.push({
        rule: "flaky-or-hanging",
        severity: "high",
        tier: "audit",
        workflow: workflow.path,
        job: jobId,
        message: `Job "${jobName}" timed out in ${count} of ${totalRuns} run(s)`,
        evidence: `${count} timed_out runs out of ${totalRuns} sampled`,
        remediation: "Investigate why the job is timing out.",
      });
    }

    for (const [jobName, count] of jobCancelledReal) {
      if (count / totalRuns < 0.1) continue;
      const jobId = jobIdByName.get(jobName);
      findings.push({
        rule: "flaky-or-hanging",
        severity: "high",
        tier: "audit",
        workflow: workflow.path,
        job: jobId,
        message: `Job "${jobName}" was cancelled in ${count} of ${totalRuns} run(s) (excluding cancel-in-progress)`,
        evidence: `${count} cancelled runs (not from cancel-in-progress) out of ${totalRuns} sampled`,
        remediation: "Investigate why the job is being cancelled.",
      });
    }

    return findings;
  },
};
