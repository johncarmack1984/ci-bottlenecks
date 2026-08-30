import type { Rule, Finding } from "../types.ts";

const DEFAULT_BRANCHES = new Set(["main", "master"]);

function isDefaultBranchOnly(branches: string[] | undefined): boolean {
  if (!branches || branches.length === 0) return false;
  return branches.every((b) => DEFAULT_BRANCHES.has(b));
}

function branchesOverlap(
  pushBranches: string[] | undefined,
  prBranches: string[] | undefined,
): boolean {
  if (isDefaultBranchOnly(pushBranches)) return false;
  if (!pushBranches || !prBranches) return true;
  const prSet = new Set(prBranches);
  return pushBranches.some((b) => prSet.has(b));
}

export const doubleTrigger: Rule = {
  id: "double-trigger",
  tier: "static",
  severity: "high",
  describe: "Push and pull_request triggers overlap, causing duplicate runs",

  check(ctx): Finding[] {
    const { triggers } = ctx.workflow;
    if (!triggers.push || !triggers.pull_request) return [];

    const push = triggers.push;
    const pr = triggers.pull_request;

    if (!branchesOverlap(push.branches, pr.branches)) return [];

    const pushDesc = push.branches
      ? `[${push.branches.join(", ")}]`
      : "(all branches)";
    const prDesc = pr.branches
      ? `[${pr.branches.join(", ")}]`
      : "(all branches)";

    return [
      {
        rule: "double-trigger",
        severity: "high",
        tier: "static",
        workflow: ctx.workflow.path,
        message: `Workflow has both push and pull_request triggers with overlapping branches, causing duplicate CI runs`,
        evidence: `push.branches: ${pushDesc}, pull_request.branches: ${prDesc}`,
        remediation:
          "Restrict push to the default branch and/or tags, or remove one trigger.",
        patch: `on:\n  push:\n    branches: [main]`,
      },
    ];
  },
};
