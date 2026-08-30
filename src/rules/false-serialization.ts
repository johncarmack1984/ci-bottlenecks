import type { Rule, Finding, ParsedJob } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const GATE_PATTERN = /check|gate|guard|pre_job|changes|filter|lint/i;
const GATE_ACTIONS = ["dorny/paths-filter", "fkirc/skip-duplicate-actions"];

// Only fire when consumer is a pure CI job, not a deploy/publish/release job
const CI_JOB_PATTERN = /\b(build|test|lint|check|clippy|fmt|typecheck|bench|coverage|e2e)\b/i;
const DEPLOY_JOB_PATTERN = /\b(deploy|publish|release|upload|push|pages|tag)\b/i;

function isGateJob(job: ParsedJob): boolean {
  if (GATE_PATTERN.test(job.id) || (job.name && GATE_PATTERN.test(job.name))) return true;
  return job.steps.some((s) => {
    if (!s.uses) return false;
    const { key } = parseActionRef(s.uses);
    return GATE_ACTIONS.some((ga) => key === ga);
  });
}

function isPureCIJob(job: ParsedJob): boolean {
  const label = job.name ?? job.id;
  if (DEPLOY_JOB_PATTERN.test(label)) return false;
  if (job.environment) return false;
  if (job.if && /always\(\)/.test(job.if)) return false;
  if (CI_JOB_PATTERN.test(job.id) || (job.name && CI_JOB_PATTERN.test(job.name))) return true;
  // Check steps for CI-shaped commands
  return job.steps.some((s) =>
    s.run && CI_JOB_PATTERN.test(s.run),
  );
}

function stringifyJobMinusNeeds(job: ParsedJob): string {
  if (!job.raw) return stringifyJobValues(job);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(job.raw)) {
    if (key === "needs") continue;
    parts.push(JSON.stringify(value));
  }
  return parts.join("\n");
}

function stringifyJobValues(job: ParsedJob): string {
  const parts: string[] = [];
  if (job.env) parts.push(JSON.stringify(job.env));
  if (job.outputs) parts.push(JSON.stringify(job.outputs));
  if (job.if) parts.push(job.if);
  if (job.name) parts.push(job.name);
  const runsOn = job["runs-on"];
  parts.push(typeof runsOn === "string" ? runsOn : JSON.stringify(runsOn));
  if (job.strategy) parts.push(JSON.stringify(job.strategy));
  if (job.environment) parts.push(JSON.stringify(job.environment));
  for (const step of job.steps) {
    if (step.run) parts.push(step.run);
    if (step.uses) parts.push(step.uses);
    if (step.with) parts.push(JSON.stringify(step.with));
    if (step.env) parts.push(JSON.stringify(step.env));
    if (step.if) parts.push(step.if);
    if (step.name) parts.push(step.name);
  }
  return parts.join("\n");
}

function expressionToPattern(name: string): RegExp {
  const escaped = name.replace(/\$\{\{[^}]*\}\}/g, "<<<EXPR>>>")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/<<<EXPR>>>/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function getArtifactNames(job: ParsedJob, action: string): Set<string> {
  const names = new Set<string>();
  for (const step of job.steps) {
    if (!step.uses) continue;
    const { key } = parseActionRef(step.uses);
    if (key === action) {
      const name = step.with?.name;
      names.add(name ? String(name) : "");
    }
  }
  return names;
}

function getDownloadPatterns(job: ParsedJob): { names: Set<string>; patterns: Set<string>; hasMergeMultiple: boolean } {
  const names = new Set<string>();
  const patterns = new Set<string>();
  let hasMergeMultiple = false;
  for (const step of job.steps) {
    if (!step.uses) continue;
    const { key } = parseActionRef(step.uses);
    if (key === "actions/download-artifact") {
      const name = step.with?.name;
      const pattern = step.with?.pattern;
      if (step.with?.["merge-multiple"]) hasMergeMultiple = true;
      if (pattern) patterns.add(String(pattern));
      else if (name) names.add(String(name));
      else names.add("");
    }
  }
  return { names, patterns, hasMergeMultiple };
}

function artifactHandoff(jobA: ParsedJob, jobB: ParsedJob): boolean {
  const uploads = getArtifactNames(jobA, "actions/upload-artifact");
  const { names: downloads, patterns, hasMergeMultiple } = getDownloadPatterns(jobB);

  if (uploads.size === 0) return false;
  if (downloads.size === 0 && patterns.size === 0 && !hasMergeMultiple) return false;

  if (uploads.has("") || downloads.has("")) return true;
  if (hasMergeMultiple) return true;

  for (const d of downloads) {
    if (uploads.has(d)) return true;
    const dPattern = expressionToPattern(d);
    for (const u of uploads) {
      if (dPattern.test(u)) return true;
    }
  }

  for (const p of patterns) {
    const globPattern = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*") + "$");
    for (const u of uploads) {
      const plain = u.replace(/\$\{\{[^}]*\}\}/g, "ANYTHING");
      if (globPattern.test(plain) || globPattern.test(u)) return true;
    }
    const pExpr = expressionToPattern(p);
    for (const u of uploads) {
      if (pExpr.test(u)) return true;
    }
  }

  for (const u of uploads) {
    if (u.includes("${{")) {
      const uPattern = expressionToPattern(u);
      for (const d of downloads) {
        if (uPattern.test(d)) return true;
      }
    }
  }

  return false;
}

export const falseSerialization: Rule = {
  id: "false-serialization",
  tier: "static",
  severity: "medium",
  describe: "Job depends on another but consumes nothing from it",

  check(ctx): Finding[] {
    const findings: Finding[] = [];
    for (const [jobBId, jobB] of ctx.workflow.jobs) {
      if (!isPureCIJob(jobB)) continue;

      for (const depId of jobB.needs) {
        const jobA = ctx.workflow.jobs.get(depId);
        if (!jobA) continue;
        if (isGateJob(jobA)) continue;
        // Reusable-workflow producers are opaque
        if (jobA.uses) continue;

        const bValues = stringifyJobMinusNeeds(jobB);

        // Check for any needs reference: needs.X.outputs, needs.X.result, needs.*, toJSON(needs)
        if (bValues.includes(`needs.${depId}.outputs`)) continue;
        if (bValues.includes(`needs.${depId}.result`)) continue;
        if (/needs\.\*/.test(bValues)) continue;
        if (/toJSON\(needs\)/.test(bValues)) continue;
        // Generic needs.<depId> token (e.g. in fromJSON, strategy, runs-on)
        if (new RegExp(`needs\\.${depId}\\b`).test(bValues)) continue;
        if (artifactHandoff(jobA, jobB)) continue;

        const labelB = jobB.name ?? jobBId;
        const labelA = jobA.name ?? depId;
        findings.push({
          rule: "false-serialization",
          severity: "medium",
          tier: "static",
          workflow: ctx.workflow.path,
          job: jobBId,
          location: jobB.line ? { line: jobB.line } : undefined,
          message: `Job "${labelB}" depends on "${labelA}" but consumes nothing from it`,
          evidence: `"${labelB}" waits for "${labelA}" but consumes nothing from it.`,
          remediation: `Remove "${depId}" from the needs list of "${jobBId}" to allow parallel execution, or add an artifact/output hand-off.`,
        });
      }
    }
    return findings;
  },
};
