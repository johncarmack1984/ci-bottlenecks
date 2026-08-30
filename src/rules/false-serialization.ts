import type { Rule, Finding, ParsedJob } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const GATE_PATTERN = /check|gate|guard|pre_job|changes|filter|lint/i;
const GATE_ACTIONS = ["dorny/paths-filter", "fkirc/skip-duplicate-actions"];

function isGateJob(job: ParsedJob): boolean {
  if (GATE_PATTERN.test(job.id) || (job.name && GATE_PATTERN.test(job.name))) return true;
  return job.steps.some((s) => {
    if (!s.uses) return false;
    const { key } = parseActionRef(s.uses);
    return GATE_ACTIONS.some((ga) => key === ga);
  });
}

function stringifyJobValues(job: ParsedJob): string {
  const parts: string[] = [];
  if (job.env) parts.push(JSON.stringify(job.env));
  if (job.outputs) parts.push(JSON.stringify(job.outputs));
  if (job.if) parts.push(job.if);
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

function artifactHandoff(jobA: ParsedJob, jobB: ParsedJob): boolean {
  const uploads = getArtifactNames(jobA, "actions/upload-artifact");
  const downloads = getArtifactNames(jobB, "actions/download-artifact");
  if (uploads.size === 0 || downloads.size === 0) return false;

  // Unnamed artifacts match anything
  if (uploads.has("") || downloads.has("")) return true;
  for (const d of downloads) {
    if (uploads.has(d)) return true;
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
      for (const depId of jobB.needs) {
        const jobA = ctx.workflow.jobs.get(depId);
        if (!jobA) continue;
        if (isGateJob(jobA)) continue;

        const bValues = stringifyJobValues(jobB);
        if (bValues.includes(`needs.${depId}.outputs`)) continue;
        if (bValues.includes(`needs.${depId}.result`)) continue;
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
