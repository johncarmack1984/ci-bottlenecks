import type { Rule, Finding, PushTrigger, PullRequestTrigger } from "../types.ts";

function hasGlobChars(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

function findOverlappingPatterns(
  push: PushTrigger,
): string[] | null {
  // Tags-only push (has tags/tags-ignore but no branches) never overlaps with PR
  if ((push.tags || push["tags-ignore"]) && !push.branches) return null;

  // No branch filter on push — fires on ALL branches including PR heads
  if (!Array.isArray(push.branches) || push.branches.length === 0) return [];

  // Glob patterns in push.branches can match PR head branches (feature-*, perf/**)
  const globs = push.branches.filter(hasGlobChars);
  if (globs.length > 0) return globs;

  // All branches are literal names — these are long-lived/protected branches
  // (main, dev, next, v1, etc.) that are not PR head branches.
  // push.branches filters HEAD refs, pull_request.branches filters BASE refs —
  // they are different namespaces, so literal-only lists do not cause double runs.
  return null;
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

    const patterns = findOverlappingPatterns(push);
    if (patterns === null) return [];

    let evidence: string;
    if (patterns.length > 0) {
      const quoted = patterns.map((p) => `"${p}"`).join(", ");
      evidence = `push.branches pattern ${quoted} matches PR head branches, causing runs on both push and pull_request events`;
    } else {
      evidence = `push has no branch filter, so every push (including to PR head branches) fires both triggers`;
    }

    // Build patch that preserves existing tags/paths
    const fmtArr = (v: unknown) => Array.isArray(v) ? v.join(", ") : String(v);
    const patchParts = ["on:", "  push:"];
    patchParts.push("    branches: [main]");
    if (push.tags) patchParts.push(`    tags: [${fmtArr(push.tags)}]`);
    if (push["tags-ignore"]) patchParts.push(`    tags-ignore: [${fmtArr(push["tags-ignore"])}]`);
    if (push.paths) patchParts.push(`    paths: [${fmtArr(push.paths)}]`);
    if (push["paths-ignore"]) patchParts.push(`    paths-ignore: [${fmtArr(push["paths-ignore"])}]`);

    return [
      {
        rule: "double-trigger",
        severity: "high",
        tier: "static",
        workflow: ctx.workflow.path,
        message: `Workflow has both push and pull_request triggers with overlapping branches, causing duplicate CI runs`,
        evidence,
        remediation:
          "Restrict push to the default branch and/or tags, or remove one trigger.",
        patch: patchParts.join("\n"),
      },
    ];
  },
};
