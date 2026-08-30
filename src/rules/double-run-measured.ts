import type { Rule, Finding, RunData } from "../types.ts";
import { durationMs, fmtMinutes } from "../utils.ts";

function runDurationFromJobs(run: RunData): number {
  let total = 0;
  for (const job of run.jobs) {
    const d = durationMs(job.startedAt, job.completedAt);
    if (d != null) total += d;
  }
  // Fall back to run-level times if no job data
  if (total === 0) {
    const d = durationMs(run.createdAt, run.updatedAt);
    if (d != null) total = d;
  }
  return total;
}

export const doubleRunMeasured: Rule = {
  id: "double-run-measured",
  tier: "audit",
  severity: "high",
  describe: "Two runs of the same workflow on the same SHA within 5 minutes",

  check(ctx): Finding[] {
    const { workflow, auditData } = ctx;
    if (!auditData || auditData.runs.length === 0) return [];

    const findings: Finding[] = [];
    const groups = new Map<string, typeof auditData.runs>();

    for (const run of auditData.runs) {
      const key = `${run.name}::${run.headSha}`;
      const arr = groups.get(key) ?? [];
      arr.push(run);
      groups.set(key, arr);
    }

    for (const [, runs] of groups) {
      if (runs.length < 2) continue;

      const sorted = [...runs].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      const first = sorted[0]!;
      const second = sorted[1]!;
      const gapMs = new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime();

      // 5-minute window: double-trigger runs land within seconds; 5 min catches CI queuing delays
      if (gapMs > 5 * 60_000) continue;

      const durations = sorted.map(runDurationFromJobs);
      const totalMinutes = durations.reduce((s, d) => s + d, 0);
      const shorterDuration = Math.min(...durations.filter((d) => d > 0));
      const sha = first.headSha.slice(0, 7);

      findings.push({
        rule: "double-run-measured",
        severity: "high",
        tier: "audit",
        workflow: workflow.path,
        message: `${runs.length} runs on SHA ${sha} within ${fmtMinutes(gapMs)}, costing ${fmtMinutes(totalMinutes)} total`,
        evidence: `${runs.length} runs on SHA ${sha} within ${fmtMinutes(gapMs)}, costing ${fmtMinutes(totalMinutes)} total minutes`,
        remediation: "Restrict the push trigger to the default branch to prevent duplicate runs on PR pushes.",
        estimatedSavings: {
          confidence: "exact",
          minutesPerRun: shorterDuration > 0 ? Math.round(shorterDuration / 60_000) : undefined,
        },
      });
    }

    return findings;
  },
};
