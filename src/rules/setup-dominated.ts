import type { Rule, Finding } from "../types.ts";
import { durationMs, median, fmtMinutes } from "../utils.ts";

const SETUP_PATTERN = /^(Set up job|Run actions\/checkout|Post )|checkout|setup|install|cache|restore|toolchain|bootstrap/i;

function isSetupStep(step: { name: string }): boolean {
  return SETUP_PATTERN.test(step.name);
}

export const setupDominated: Rule = {
  id: "setup-dominated",
  tier: "audit",
  severity: "medium",
  describe: "Setup steps consume most of job time",

  check(ctx): Finding[] {
    const { workflow, auditData } = ctx;
    if (!auditData || auditData.runs.length === 0) return [];

    const findings: Finding[] = [];

    const jobIdByName = new Map<string, string>();
    for (const [jobId, job] of workflow.jobs) {
      jobIdByName.set(job.name ?? jobId, jobId);
    }

    const jobStepDurations = new Map<string, Map<string, number[]>>();
    const jobTotalDurations = new Map<string, number[]>();

    for (const run of auditData.runs) {
      for (const job of run.jobs) {
        let jobTotal = 0;

        if (!jobStepDurations.has(job.name)) {
          jobStepDurations.set(job.name, new Map());
        }
        const stepMap = jobStepDurations.get(job.name)!;

        for (const step of job.steps) {
          const d = durationMs(step.startedAt, step.completedAt);
          if (d == null) continue;
          jobTotal += d;

          const key = `${step.number}:${step.name}`;
          const arr = stepMap.get(key) ?? [];
          arr.push(d);
          stepMap.set(key, arr);
        }

        if (jobTotal > 0) {
          const arr = jobTotalDurations.get(job.name) ?? [];
          arr.push(jobTotal);
          jobTotalDurations.set(job.name, arr);
        }
      }
    }

    for (const [jobName, stepMap] of jobStepDurations) {
      const totals = jobTotalDurations.get(jobName) ?? [];
      const medTotal = median(totals);
      if (medTotal <= 0) continue;

      let setupTotal = 0;
      const breakdown: string[] = [];

      for (const [key, durations] of stepMap) {
        const colonIdx = key.indexOf(":");
        const stepName = key.slice(colonIdx + 1);
        const med = median(durations);

        if (isSetupStep({ name: stepName })) {
          setupTotal += med;
          breakdown.push(`${stepName}: ${fmtMinutes(med)}`);
        }
      }

      // 50%: below this, setup is proportional to work; above it, setup dominates the job
      if (setupTotal < medTotal * 0.5) continue;

      const pct = ((setupTotal / medTotal) * 100).toFixed(0);
      const jobId = jobIdByName.get(jobName);

      findings.push({
        rule: "setup-dominated",
        severity: "medium",
        tier: "audit",
        workflow: workflow.path,
        job: jobId,
        message: `Job "${jobName}" spends ${pct}% of time in setup steps (${fmtMinutes(setupTotal)} of ${fmtMinutes(medTotal)})`,
        evidence: `Setup breakdown: ${breakdown.join(", ")}. Total job median: ${fmtMinutes(medTotal)}`,
        remediation: "Improve caching or use a prebuilt container to reduce setup time.",
      });
    }

    return findings;
  },
};
