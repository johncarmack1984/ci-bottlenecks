import type { Rule, Finding, PushTrigger, PullRequestTrigger } from "../types.ts";

const DEFAULT_BRANCHES = new Set(["main", "master"]);

function isDefaultBranchOnly(branches: string[] | undefined): boolean {
  if (!Array.isArray(branches) || branches.length === 0) return false;
  return branches.every((b) => DEFAULT_BRANCHES.has(b));
}

function isSingleDefaultBranch(branches: string[] | undefined): boolean {
  if (!Array.isArray(branches) || branches.length !== 1) return false;
  return DEFAULT_BRANCHES.has(branches[0]!);
}

function branchesOverlap(
  push: PushTrigger,
  pr: PullRequestTrigger,
): boolean {
  // Tags-only push (has tags/tags-ignore but no branches) never overlaps with PR
  if ((push.tags || push["tags-ignore"]) && !push.branches) return false;

  if (isDefaultBranchOnly(push.branches)) return false;

  // A single literal push.branches entry is effectively the default branch for that repo
  if (isSingleDefaultBranch(push.branches)) return false;

  if (!Array.isArray(push.branches) || !Array.isArray(pr.branches)) return true;
  const prSet = new Set(pr.branches);
  return push.branches.some((b) => prSet.has(b));
}

function prTriggersOnPush(pr: PullRequestTrigger): boolean {
  if (!Array.isArray(pr.types)) return true;
  return pr.types.some((t) => t === "synchronize" || t === "opened");
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

    if (!prTriggersOnPush(pr)) return [];
    if (!branchesOverlap(push, pr)) return [];

    const pushDesc = push.branches
      ? `[${push.branches.join(", ")}]`
      : "(all branches)";
    const prDesc = pr.branches
      ? `[${pr.branches.join(", ")}]`
      : "(all branches)";

    // Build patch that preserves existing tags/paths
    const patchParts = ["on:", "  push:"];
    patchParts.push("    branches: [main]");
    if (push.tags) patchParts.push(`    tags: [${push.tags.join(", ")}]`);
    if (push["tags-ignore"]) patchParts.push(`    tags-ignore: [${push["tags-ignore"].join(", ")}]`);
    if (push.paths) patchParts.push(`    paths: [${push.paths.join(", ")}]`);
    if (push["paths-ignore"]) patchParts.push(`    paths-ignore: [${push["paths-ignore"].join(", ")}]`);

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
        patch: patchParts.join("\n"),
      },
    ];
  },
};
