import type { Rule, Finding } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_TAG_RE = /^v\d/;

export const unpinnedAction: Rule = {
  id: "unpinned-action",
  tier: "static",
  severity: "info",
  describe: "Action uses mutable ref (@main, @master, or no ref)",

  check(ctx): Finding[] {
    const findings: Finding[] = [];
    for (const [jobId, job] of ctx.workflow.jobs) {
      for (const step of job.steps) {
        if (!step.uses) continue;
        const { key, version, isLocal } = parseActionRef(step.uses);

        if (isLocal) continue;
        if (key.startsWith("docker://")) continue;
        if (SHA_RE.test(version)) continue;
        if (VERSION_TAG_RE.test(version)) continue;

        const isMutable = !version || version === "main" || version === "master";
        if (!isMutable) continue;

        const refDesc = version ? `@${version}` : "(no ref)";
        const stepLabel = step.name ?? `step ${step.index}`;
        findings.push({
          rule: "unpinned-action",
          severity: "info",
          tier: "static",
          workflow: ctx.workflow.path,
          job: jobId,
          step: step.index,
          location: step.line ? { line: step.line } : undefined,
          message: `Job "${job.name ?? jobId}", ${stepLabel}: "${key}" uses mutable ref ${refDesc}. This is perf-adjacent: unexpected behavior changes can break caching or builds. zizmor handles the security angle.`,
          evidence: `uses: ${step.uses}`,
          remediation: "Pin to a version tag (e.g. @v4) or a full commit SHA.",
        });
      }
    }
    return findings;
  },
};
