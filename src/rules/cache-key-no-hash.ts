import type { Rule, Finding } from "../types.ts";
import { parseActionRef } from "../parser.ts";

function cacheActionType(uses: string): "cache" | "restore" | "save" | null {
  const { key } = parseActionRef(uses);
  if (key !== "actions/cache") return null;
  if (uses.includes("/cache/save")) return "save";
  if (uses.includes("/cache/restore")) return "restore";
  return "cache";
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
        if (!step.uses) continue;
        const actionType = cacheActionType(step.uses);
        if (!actionType) continue;

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
        } else if (actionType !== "save" && step.with?.["restore-keys"] == null) {
          // restore-keys is not an input for actions/cache/save
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
