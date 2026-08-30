import type { Rule, Finding, ParsedStep } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const HISTORY_COMMANDS = /\bgit\s+(log|describe|tag|rev-list|blame|diff|merge-base|shortlog|cherry|bisect|branch|checkout|switch|merge|rebase|cliff)\b/;

const HISTORY_RUN_PATTERNS = /\b(semantic-release|release-it|standard-version|lerna\s|nx\s+affected|changeset|goreleaser|git-cliff|cargo\s+release|sonar|gitleaks|trufflehog|commitlint|mike\s+deploy)\b/;

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
]);

function needsHistory(steps: ParsedStep[]): boolean {
  for (const step of steps) {
    if (step.run) {
      if (HISTORY_COMMANDS.test(step.run)) return true;
      if (HISTORY_RUN_PATTERNS.test(step.run)) return true;
    }

    if (step.uses) {
      const { key, isLocal } = parseActionRef(step.uses);
      if (RELEASE_TOOLS.has(key)) return true;
      // Local composite actions and opaque scripts are conservative
      if (isLocal) return true;
    }
  }

  // Opaque build tools that might need history
  for (const step of steps) {
    if (step.run && /\b(make|just)\b/.test(step.run)) return true;
    if (step.run && /\.\/scripts\//.test(step.run)) return true;
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

        if (needsHistory(job.steps)) continue;

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
