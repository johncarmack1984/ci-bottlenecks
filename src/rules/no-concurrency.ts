import type { Rule, Finding, ConcurrencyConfig } from "../types.ts";

function hasCancelInProgress(
  concurrency: ConcurrencyConfig | undefined,
): boolean {
  if (!concurrency) return false;
  const cip = concurrency["cancel-in-progress"];
  if (cip === true) return true;
  // Expression like ${{ github.ref != 'refs/heads/main' }} counts as configured
  if (typeof cip === "string" && cip.includes("${{")) return true;
  return false;
}

function hasDeliberateConcurrency(
  concurrency: ConcurrencyConfig | undefined,
): boolean {
  if (!concurrency) return false;
  // Explicit false with a group is a deliberate serialization decision
  if (concurrency.group && concurrency["cancel-in-progress"] === false) return true;
  return hasCancelInProgress(concurrency);
}

function isTagsOnlyPush(triggers: Record<string, unknown>): boolean {
  const push = triggers.push;
  if (!push || typeof push !== "object") return false;
  const p = push as Record<string, unknown>;
  return !!(p.tags || p["tags-ignore"]) && !p.branches;
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

    // Tags-only release workflows are exempt
    if (isTagsOnlyPush(triggers) && !triggers.pull_request && !triggers.pull_request_target) return [];

    if (hasDeliberateConcurrency(ctx.workflow.concurrency)) return [];

    for (const [, job] of ctx.workflow.jobs) {
      if (hasDeliberateConcurrency(job.concurrency)) return [];
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
