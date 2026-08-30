import type { Rule, Finding, ParsedStep } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const HISTORY_COMMANDS = /\bgit\s+(log|describe|tag|rev-list|blame)\b/;

const RELEASE_TOOLS = new Set([
  "MarcoIeni/release-plz-action",
  "google-github-actions/release-please-action",
  "googleapis/release-please-action",
  "GoogleCloudPlatform/release-please-action",
  "jbolda/covector",
  "changesets/action",
  "cycjimmy/semantic-release-action",
  "gittools/actions",
  "orhun/git-cliff-action",
  "MarcoIeni/cargo-smart-release",
]);

function needsHistory(steps: ParsedStep[]): boolean {
  for (const step of steps) {
    if (step.run && HISTORY_COMMANDS.test(step.run)) return true;

    if (step.uses) {
      const { key } = parseActionRef(step.uses);
      if (RELEASE_TOOLS.has(key)) return true;
    }
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
          evidence: `fetch-depth: 0 set, but no git log/describe/tag/rev-list/blame commands or release tool actions found`,
          remediation:
            "Remove fetch-depth: 0 (or set to 1) to speed up checkout. Re-add if a step genuinely needs history.",
          patch: `# Remove fetch-depth or set shallow:\nfetch-depth: 1`,
        });
      }
    }
    return findings;
  },
};
