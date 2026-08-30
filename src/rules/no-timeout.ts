import type { Rule, Finding } from "../types.ts";

export const noTimeout: Rule = {
  id: "no-timeout",
  tier: "static",
  severity: "medium",
  describe: "Job without timeout-minutes (default is 6 hours)",

  check(ctx): Finding[] {
    const findings: Finding[] = [];
    for (const [jobId, job] of ctx.workflow.jobs) {
      if (job["timeout-minutes"] != null) continue;
      const label = job.name ?? jobId;
      findings.push({
        rule: "no-timeout",
        severity: "medium",
        tier: "static",
        workflow: ctx.workflow.path,
        job: jobId,
        location: job.line ? { line: job.line } : undefined,
        message: `Job "${label}" has no timeout-minutes (GitHub default is 6 hours)`,
        evidence: "timeout-minutes is not set",
        remediation: "Add timeout-minutes to the job to prevent runaway builds.",
        patch: `# In job "${jobId}":\ntimeout-minutes: 30`,
      });
    }
    return findings;
  },
};
