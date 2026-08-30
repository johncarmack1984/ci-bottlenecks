import type { Rule, Finding } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const RUST_CACHE_PATHS = /(?:\/\.cargo|\/target|~\/\.cargo|target\/)/;
const SCCACHE_PATHS = /sccache/;

function stepActionKey(step: { uses?: string }): string | null {
  if (!step.uses) return null;
  return parseActionRef(step.uses).key;
}

function cachePaths(step: { with?: Record<string, unknown> }): string {
  const path = step.with?.path;
  if (typeof path === "string") return path;
  return "";
}

export const doubleCache: Rule = {
  id: "double-cache",
  tier: "static",
  severity: "medium",
  describe: "Redundant cache mechanisms in the same job",

  check(ctx): Finding[] {
    const findings: Finding[] = [];

    for (const [jobId, job] of ctx.workflow.jobs) {
      let hasRustCache = false;
      let hasSccache = false;
      const manualCacheSteps: { index: number; paths: string; name: string }[] =
        [];

      for (const step of job.steps) {
        const key = stepActionKey(step);
        if (!key) continue;

        if (key === "Swatinem/rust-cache") hasRustCache = true;
        if (key === "mozilla-actions/sccache-action") hasSccache = true;
        if (key === "actions/cache") {
          const paths = cachePaths(step);
          manualCacheSteps.push({
            index: step.index,
            paths,
            name: step.name ?? step.uses!,
          });
        }
      }

      for (const manual of manualCacheSteps) {
        if (hasRustCache && RUST_CACHE_PATHS.test(manual.paths)) {
          findings.push({
            rule: "double-cache",
            severity: "medium",
            tier: "static",
            workflow: ctx.workflow.path,
            job: jobId,
            step: manual.index,
            message: `Job "${job.name ?? jobId}" uses both Swatinem/rust-cache and a manual actions/cache targeting Rust paths`,
            evidence: `Swatinem/rust-cache present alongside actions/cache with path "${manual.paths}"`,
            remediation:
              "Remove the manual actions/cache step; Swatinem/rust-cache already handles cargo/target caching.",
          });
        }

        if (hasSccache && SCCACHE_PATHS.test(manual.paths)) {
          findings.push({
            rule: "double-cache",
            severity: "medium",
            tier: "static",
            workflow: ctx.workflow.path,
            job: jobId,
            step: manual.index,
            message: `Job "${job.name ?? jobId}" uses both mozilla-actions/sccache-action and a manual actions/cache targeting sccache paths`,
            evidence: `sccache-action present alongside actions/cache with path "${manual.paths}"`,
            remediation:
              "Remove the manual actions/cache step; sccache-action manages its own cache.",
          });
        }
      }
    }
    return findings;
  },
};
