import type { Rule, Finding } from "../types.ts";

function hasCancelInProgress(
  concurrency: { "cancel-in-progress"?: boolean } | undefined,
): boolean {
  return concurrency?.["cancel-in-progress"] === true;
}

export const noConcurrency: Rule = {
  id: "no-concurrency",
  tier: "static",
  severity: "medium",
  describe:
    "Workflow triggered on push/PR with no concurrency + cancel-in-progress",

  check(ctx): Finding[] {
    const { triggers } = ctx.workflow;
    const hasPushOrPR =
      triggers.push !== undefined ||
      triggers.pull_request !== undefined ||
      triggers.pull_request_target !== undefined;
    if (!hasPushOrPR) return [];

    if (hasCancelInProgress(ctx.workflow.concurrency)) return [];

    for (const [, job] of ctx.workflow.jobs) {
      if (hasCancelInProgress(job.concurrency)) return [];
    }

    return [
      {
        rule: "no-concurrency",
        severity: "medium",
        tier: "static",
        workflow: ctx.workflow.path,
        message:
          "Workflow is triggered by push/PR but has no concurrency group with cancel-in-progress",
        evidence:
          "No concurrency block with cancel-in-progress: true at workflow or job level",
        remediation:
          "Add a concurrency block to cancel outdated runs when new commits are pushed.",
        patch: `concurrency:\n  group: \${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: true`,
      },
    ];
  },
};
