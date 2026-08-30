import type { Rule, Finding, ParsedWorkflow, PushTrigger, PullRequestTrigger } from "../types.ts";

function triggerHasPathFilter(trigger: PushTrigger | PullRequestTrigger | undefined): boolean {
  if (!trigger) return false;
  return Boolean(trigger.paths?.length || trigger["paths-ignore"]?.length);
}

function workflowHasPathFilters(wf: ParsedWorkflow): boolean {
  const { triggers } = wf;
  if (triggerHasPathFilter(triggers.push as PushTrigger)) return true;
  if (triggerHasPathFilter(triggers.pull_request as PullRequestTrigger)) return true;
  if (triggerHasPathFilter(triggers.pull_request_target as PullRequestTrigger)) return true;
  return false;
}

export const noPathFilter: Rule = {
  id: "no-path-filter",
  tier: "static",
  severity: "low",
  pedantic: true,
  describe: "Push/PR workflow without path filters",

  check(ctx): Finding[] {
    const { triggers } = ctx.workflow;
    const hasPushOrPR = triggers.push || triggers.pull_request;
    if (!hasPushOrPR) return [];

    if (workflowHasPathFilters(ctx.workflow)) return [];

    const othersHaveFilters = ctx.allWorkflows.some(
      (wf) => wf.path !== ctx.workflow.path && workflowHasPathFilters(wf),
    );
    if (!othersHaveFilters) return [];

    const triggerNames: string[] = [];
    if (triggers.push) triggerNames.push("push");
    if (triggers.pull_request) triggerNames.push("pull_request");

    return [
      {
        rule: "no-path-filter",
        severity: "low",
        tier: "static",
        pedantic: true,
        workflow: ctx.workflow.path,
        message: `Workflow "${ctx.workflow.name}" triggers on ${triggerNames.join(" and ")} without path filters, while other workflows in the repo use them`,
        evidence: `No paths or paths-ignore on ${triggerNames.join("/")} triggers.`,
        remediation: "Add paths or paths-ignore to avoid running this workflow on unrelated changes.",
      },
    ];
  },
};
