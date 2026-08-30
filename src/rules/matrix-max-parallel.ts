import type { Rule, Finding } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const DEPLOY_PUBLISH = /\b(deploy|publish|release|push)\b/i;

function hasRateLimitedStep(job: { steps: { run?: string; uses?: string }[] }): boolean {
  for (const step of job.steps) {
    if (step.run && DEPLOY_PUBLISH.test(step.run)) return true;
    if (step.uses) {
      const { key } = parseActionRef(step.uses);
      if (DEPLOY_PUBLISH.test(key)) return true;
    }
  }
  return false;
}

export const matrixMaxParallel: Rule = {
  id: "matrix-max-parallel",
  tier: "static",
  severity: "low",
  pedantic: true,
  describe: "max-parallel limits matrix concurrency without obvious reason",

  check(ctx): Finding[] {
    const findings: Finding[] = [];
    for (const [jobId, job] of ctx.workflow.jobs) {
      if (!job.strategy?.matrix || job.strategy["max-parallel"] == null) continue;
      if (hasRateLimitedStep(job)) continue;

      const label = job.name ?? jobId;
      findings.push({
        rule: "matrix-max-parallel",
        severity: "low",
        tier: "static",
        pedantic: true,
        workflow: ctx.workflow.path,
        job: jobId,
        location: job.line ? { line: job.line } : undefined,
        message: `Job "${label}" sets max-parallel: ${job.strategy["max-parallel"]} without an obvious rate-limited step`,
        evidence: `max-parallel is ${job.strategy["max-parallel"]} but no deploy/publish step was detected.`,
        remediation: "Remove max-parallel to let all matrix legs run concurrently, or document why throttling is needed.",
      });
    }
    return findings;
  },
};
