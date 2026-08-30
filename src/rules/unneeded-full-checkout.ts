import type { Rule, Finding, ParsedStep, ParsedJob } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const HISTORY_COMMANDS = /\bgit\s+(log|describe|tag|rev-list|blame|diff|fetch|merge-base|shortlog|cherry|bisect|branch|checkout|switch|merge|rebase|cliff|worktree)\b/;

const HISTORY_RUN_PATTERNS = /\b(semantic-release|release-it|standard-version|lerna\s|nx\s+affected|changeset|goreleaser|git-cliff|cargo\s+release|sonar|gitleaks|trufflehog|commitlint|mike\s+deploy)\b/;

const OPAQUE_TOOLS = /\b(make|just|turbo|nx)\b/;
const OPAQUE_RUNNERS = /\b(npm|pnpm|bun|yarn)\s+run\b/;
const OPAQUE_SCRIPTS = /\.\/scripts\//;

const RELEASE_TOOLS = new Set([
  "MarcoIeni/release-plz-action",
  "release-plz/action",
  "google-github-actions/release-please-action",
  "googleapis/release-please-action",
  "GoogleCloudPlatform/release-please-action",
  "jbolda/covector",
  "changesets/action",
  "cycjimmy/semantic-release-action",
  "gittools/actions",
  "orhun/git-cliff-action",
  "MarcoIeni/cargo-smart-release",
  "goreleaser/goreleaser-action",
  "nrwl/nx-set-shas",
  "SonarSource/sonarcloud-github-action",
  "SonarSource/sonarqube-scan-action",
  "gitleaks/gitleaks-action",
  "dorny/paths-filter",
  "tj-actions/changed-files",
]);

const RELEASE_JOB_TOKENS = new Set([
  "release", "publish", "deploy", "version", "changelog",
  "tag", "covector", "changeset", "semantic", "bump",
]);

const RELEASE_WORKFLOW_PATTERN = /\b(release|publish|deploy)\b/i;

function tokenize(label: string): string[] {
  return label
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .split(/[_\-\s/.]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

function isReleaseJob(job: ParsedJob): boolean {
  const tokens = tokenize(job.id);
  if (tokens.some((t) => RELEASE_JOB_TOKENS.has(t))) return true;
  if (job.name) {
    const nameTokens = tokenize(job.name);
    if (nameTokens.some((t) => RELEASE_JOB_TOKENS.has(t))) return true;
  }
  return false;
}

function hasFetchTags(step: ParsedStep): boolean {
  return step.with?.["fetch-tags"] === true || step.with?.["fetch-tags"] === "true";
}

function needsHistory(steps: ParsedStep[], job: ParsedJob, workflowName: string): boolean {
  if (isReleaseJob(job)) return true;
  if (RELEASE_WORKFLOW_PATTERN.test(workflowName)) return true;

  for (const step of steps) {
    if (step.run) {
      if (HISTORY_COMMANDS.test(step.run)) return true;
      if (HISTORY_RUN_PATTERNS.test(step.run)) return true;
      if (OPAQUE_TOOLS.test(step.run)) return true;
      if (OPAQUE_RUNNERS.test(step.run)) return true;
      if (OPAQUE_SCRIPTS.test(step.run)) return true;
    }

    if (step.uses) {
      const { key, isLocal } = parseActionRef(step.uses);
      if (RELEASE_TOOLS.has(key)) return true;
      if (isLocal) return true;
      if (/covector/i.test(key)) return true;
    }

    if (hasFetchTags(step)) return true;
  }

  return false;
}

export const unneededFullCheckout: Rule = {
  id: "unneeded-full-checkout",
  tier: "static",
  severity: "low",
  describe: "Full git history checkout without steps needing it",

  check(ctx): Finding[] {
    const findings: Finding[] = [];

    for (const [jobId, job] of ctx.workflow.jobs) {
      for (const step of job.steps) {
        if (!step.uses) continue;
        const { key } = parseActionRef(step.uses);
        if (key !== "actions/checkout") continue;

        const depth = step.with?.["fetch-depth"];
        if (depth !== 0 && depth !== "0") continue;

        if (needsHistory(job.steps, job, ctx.workflow.name)) continue;

        const label = step.name ?? step.uses;
        findings.push({
          rule: "unneeded-full-checkout",
          severity: "low",
          tier: "static",
          workflow: ctx.workflow.path,
          job: jobId,
          step: step.index,
          location: step.line ? { line: step.line } : undefined,
          message: `Step "${label}" in job "${job.name ?? jobId}" fetches full git history but no step appears to need it`,
          evidence: `fetch-depth: 0 set, but no git history commands, release tools, or local actions found`,
          remediation:
            "Remove fetch-depth: 0 (or set to 1) to speed up checkout. Re-add if a step genuinely needs history.",
          patch: `# Remove fetch-depth or set shallow:\nfetch-depth: 1`,
        });
      }
    }
    return findings;
  },
};
