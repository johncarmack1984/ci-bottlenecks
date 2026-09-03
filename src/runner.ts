import type {
  Finding,
  Rule,
  RuleContext,
  ParsedJob,
  ParsedWorkflow,
  WorkflowAuditData,
} from "./types.ts";
import { durationMs, fmtMinutes, median, stepDisplayName } from "./utils.ts";
import {
  cacheRemediation,
  installStepsFor,
  type Ecosystem,
} from "./rules/install-no-cache.ts";

function isSuppressed(
  finding: Finding,
  workflow: ParsedWorkflow,
): boolean {
  const sup = workflow.suppressions;

  if (sup.workflow === "all") return true;
  if (
    Array.isArray(sup.workflow) &&
    sup.workflow.includes(finding.rule)
  )
    return true;

  if (finding.job) {
    const jobSup = sup.jobs.get(finding.job);
    if (jobSup === "all") return true;
    if (Array.isArray(jobSup) && jobSup.includes(finding.rule))
      return true;
  }

  if (finding.job && finding.step != null) {
    const stepKey = `${finding.job}:${finding.step}`;
    const stepSup = sup.steps.get(stepKey);
    if (stepSup === "all") return true;
    if (Array.isArray(stepSup) && stepSup.includes(finding.rule))
      return true;
  }

  return false;
}

export interface RunOptions {
  audit: boolean;
  pedantic: boolean;
  auditDataByWorkflow?: Map<string, WorkflowAuditData>;
}

// A dependency cache only pays for itself when the install it shortcuts is
// slower than the restore + save round trip. actions/cache measured 2-4s per
// job for a bun cache on ubuntu-latest (lux, 2026-09-02); 10s leaves a margin
// so a finding never asks for a cache that is a wash at best.
export const INSTALL_CACHE_WORTH_MS = 10_000;

interface MeasuredStep {
  name: string;
  medianMs: number;
  samples: number;
}

/**
 * Median duration of each of the job's install steps for `eco`, matched to
 * the sampled runs by GitHub's step display name. Only steps present in the
 * YAML being linted are measured, so a step deleted since the runs happened
 * (a `cargo install` replaced by a prebuilt binary, say) cannot keep a finding
 * alive, and a job's tool installs never stand in for its dependency install.
 */
function measureInstallSteps(
  auditData: WorkflowAuditData,
  job: ParsedJob,
  eco: Ecosystem,
): MeasuredStep[] {
  const targets = new Map<string, number[]>();
  for (const step of installStepsFor(job.steps, eco)) {
    const name = stepDisplayName(step);
    if (name && !targets.has(name)) targets.set(name, []);
  }
  if (targets.size === 0) return [];

  const jobName = job.name ?? job.id;
  for (const run of auditData.runs) {
    for (const j of run.jobs) {
      if (j.name !== jobName && !j.name.startsWith(`${jobName} (`)) continue;
      for (const step of j.steps) {
        const samples = targets.get(step.name);
        if (!samples || step.conclusion !== "success") continue;
        const d = durationMs(step.startedAt, step.completedAt);
        if (d != null) samples.push(d);
      }
    }
  }

  const measured: MeasuredStep[] = [];
  for (const [name, samples] of targets) {
    if (samples.length === 0) continue;
    measured.push({ name, medianMs: median(samples), samples: samples.length });
  }
  return measured;
}

function crossTierGate(findings: Finding[], workflows: ParsedWorkflow[], auditDataByWorkflow?: Map<string, WorkflowAuditData>, pedantic?: boolean): Finding[] {
  const result: Finding[] = [];
  const setupDominatedJobs = new Set<string>();

  for (const f of findings) {
    if (f.rule === "setup-dominated" && f.job) {
      setupDominatedJobs.add(`${f.workflow}:${f.job}`);
    }
  }

  for (const f of findings) {
    if (f.rule !== "install-no-cache" || !f.job) {
      result.push(f);
      continue;
    }

    // setup-dominated already names this job's slow setup steps, install included.
    if (setupDominatedJobs.has(`${f.workflow}:${f.job}`)) continue;

    const wf = workflows.find((w) => w.path === f.workflow);
    const job = wf?.jobs.get(f.job);
    const auditData = auditDataByWorkflow?.get(f.workflow);
    const eco = f.meta?.ecosystem as Ecosystem | undefined;
    const measured = job && auditData && eco ? measureInstallSteps(auditData, job, eco) : [];

    // Unmeasured (no sampled run contains the step: no runs yet, or it was
    // renamed since). The detector saw an install without a cache, but has no
    // idea whether a cache would pay, so it says nothing unless asked.
    if (measured.length === 0 || !eco) {
      if (pedantic) {
        result.push({
          ...f,
          severity: "info",
          evidence: `${f.evidence}; no sampled run contains this step, so its duration is unmeasured`,
          remediation: `Nothing to do until it measures. A cache restore costs 2-4s per job, so caching only pays for installs of roughly ${INSTALL_CACHE_WORTH_MS / 1000}s or more.`,
        });
      }
      continue;
    }

    const summary = measured
      .map((m) => `${m.name}: ${fmtMinutes(m.medianMs)} median over ${m.samples} run${m.samples === 1 ? "" : "s"}`)
      .join(", ");

    if (measured.every((m) => m.medianMs < INSTALL_CACHE_WORTH_MS)) {
      if (pedantic) {
        result.push({
          ...f,
          severity: "info",
          evidence: `Measured: ${summary} — under the ${INSTALL_CACHE_WORTH_MS / 1000}s payback floor, a cache would save nothing`,
          remediation: "Nothing to do; the install is already faster than a cache restore.",
        });
      }
      continue;
    }

    const totalMs = measured.reduce((sum, m) => sum + m.medianMs, 0);
    result.push({
      ...f,
      severity: "medium",
      evidence: `Measured: ${summary}. No matching cache action or configuration found`,
      remediation: cacheRemediation(eco),
      estimatedSavings: { minutesPerRun: Math.round((totalMs / 60_000) * 10) / 10, confidence: "estimate" },
    });
  }

  return result;
}

export function runRules(
  rules: Rule[],
  workflows: ParsedWorkflow[],
  options: RunOptions,
): Finding[] {
  const findings: Finding[] = [];

  const activeRules = rules.filter((r) => {
    if (r.tier === "audit" && !options.audit) return false;
    if (r.pedantic && !options.pedantic) return false;
    return true;
  });

  for (const workflow of workflows) {
    for (const rule of activeRules) {
      const ctx: RuleContext = {
        workflow,
        allWorkflows: workflows,
        auditData: options.auditDataByWorkflow?.get(workflow.path),
      };

      let ruleFindings: Finding[];
      try {
        ruleFindings = rule.check(ctx);
      } catch (e) {
        process.stderr.write(`Rule "${rule.id}" threw on ${workflow.path}: ${e instanceof Error ? e.message : e}\n`);
        continue;
      }

      for (const f of ruleFindings) {
        if (!isSuppressed(f, workflow)) {
          findings.push(f);
        }
      }
    }
  }

  return crossTierGate(findings, workflows, options.auditDataByWorkflow, options.pedantic);
}
