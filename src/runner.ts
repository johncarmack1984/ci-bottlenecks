import type {
  Finding,
  Rule,
  RuleContext,
  ParsedWorkflow,
  WorkflowAuditData,
} from "./types.ts";

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

  return findings;
}
