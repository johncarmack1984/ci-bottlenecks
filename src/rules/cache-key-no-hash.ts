import type { Rule, Finding } from "../types.ts";
import { parseActionRef } from "../parser.ts";

function isCacheAction(uses: string): boolean {
  // parseActionRef normalizes actions/cache/restore to key="actions/cache"
  return parseActionRef(uses).key === "actions/cache";
}

function hasHashOrExpression(value: string): boolean {
  return value.includes("hashFiles(") || value.includes("${{");
}

export const cacheKeyNoHash: Rule = {
  id: "cache-key-no-hash",
  tier: "static",
  severity: "high",
  describe: "Cache key without hashFiles or dynamic component",

  check(ctx): Finding[] {
    const findings: Finding[] = [];

    for (const [jobId, job] of ctx.workflow.jobs) {
      for (const step of job.steps) {
        if (!step.uses || !isCacheAction(step.uses)) continue;

        const key = step.with?.key;
        if (typeof key !== "string") continue;

        const label = step.name ?? step.uses;

        if (!hasHashOrExpression(key)) {
          findings.push({
            rule: "cache-key-no-hash",
            severity: "high",
            tier: "static",
            workflow: ctx.workflow.path,
            job: jobId,
            step: step.index,
            location: step.line ? { line: step.line } : undefined,
            message: `Step "${label}" in job "${job.name ?? jobId}" uses a static cache key that will never invalidate`,
            evidence: `key: "${key}" contains no hashFiles() or \${{ }} expression`,
            remediation:
              "Add hashFiles() over your lockfile or dependency manifest to the cache key.",
            patch: `key: \${{ runner.os }}-cache-\${{ hashFiles('**/lockfile') }}`,
          });
        } else if (step.with?.["restore-keys"] == null) {
          findings.push({
            rule: "cache-key-no-hash",
            severity: "low",
            tier: "static",
            workflow: ctx.workflow.path,
            job: jobId,
            step: step.index,
            location: step.line ? { line: step.line } : undefined,
            message: `Step "${label}" in job "${job.name ?? jobId}" has a dynamic cache key but no restore-keys fallback`,
            evidence: `key contains a hash but restore-keys is not set`,
            remediation:
              "Add restore-keys so a partial cache hit can still speed up the build.",
            patch: `restore-keys: |\n  \${{ runner.os }}-cache-`,
          });
        }
      }
    }
    return findings;
  },
};
