import type {
  Finding,
  Rule,
  RuleContext,
  ParsedWorkflow,
  WorkflowAuditData,
} from "./types.ts";
import { durationMs, median } from "./utils.ts";

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

function getInstallStepMedians(auditData: WorkflowAuditData, jobId: string, workflow: ParsedWorkflow): Map<string, number> {
  const job = workflow.jobs.get(jobId);
  if (!job) return new Map();

  const jobName = job.name ?? jobId;
  const stepDurations = new Map<string, number[]>();

  for (const run of auditData.runs) {
    for (const j of run.jobs) {
      if (j.name !== jobName && !j.name.startsWith(`${jobName} (`)) continue;
      for (const step of j.steps) {
        if (/\b(install|npm ci)\b/i.test(step.name)) {
          const d = durationMs(step.startedAt, step.completedAt);
          if (d != null) {
            const arr = stepDurations.get(step.name) ?? [];
            arr.push(d);
            stepDurations.set(step.name, arr);
          }
        }
      }
    }
  }

  const result = new Map<string, number>();
  for (const [name, durations] of stepDurations) {
    result.set(name, median(durations));
  }
  return result;
}

function crossTierGate(findings: Finding[], workflows: ParsedWorkflow[], auditDataByWorkflow?: Map<string, WorkflowAuditData>): Finding[] {
  if (!auditDataByWorkflow || auditDataByWorkflow.size === 0) return findings;

  const result: Finding[] = [];
  const setupDominatedJobs = new Set<string>();

  for (const f of findings) {
    if (f.rule === "setup-dominated" && f.job) {
      setupDominatedJobs.add(`${f.workflow}:${f.job}`);
    }
  }

  for (const f of findings) {
    if (f.rule === "install-no-cache" && f.job) {
      const key = `${f.workflow}:${f.job}`;
      if (setupDominatedJobs.has(key)) continue;

      const wf = workflows.find((w) => w.path === f.workflow);
      if (wf) {
        const auditData = auditDataByWorkflow.get(f.workflow);
        if (auditData) {
          const stepMedians = getInstallStepMedians(auditData, f.job, wf);
          const allUnder5s = stepMedians.size > 0 && [...stepMedians.values()].every((m) => m < 5_000);
          if (allUnder5s) {
            const medStr = [...stepMedians.entries()].map(([name, m]) => `${name}: ${Math.round(m / 1000)}s`).join(", ");
            result.push({
              ...f,
              severity: "info",
              evidence: `${f.evidence}. Measured: ${medStr} — caching would save nothing`,
            });
            continue;
          }
        }
      }
    }
    result.push(f);
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

  return crossTierGate(findings, workflows, options.auditDataByWorkflow);
}
