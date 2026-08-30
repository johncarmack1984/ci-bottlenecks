import type { Rule, Finding } from "../types.ts";
import { median, fmtMinutes } from "../utils.ts";

export const queueDominated: Rule = {
  id: "queue-dominated",
  tier: "audit",
  severity: "medium",
  describe: "Jobs spend more time queued than running",

  check(ctx): Finding[] {
    const { workflow, auditData } = ctx;
    if (!auditData || auditData.runs.length === 0) return [];

    const queueTimes: number[] = [];
    const runTimes: number[] = [];

    for (const run of auditData.runs) {
      if (run.jobs.length === 0) continue;

      const jobStarts = run.jobs
        .map((j) => j.startedAt)
        .filter((s): s is string => s != null)
        .map((s) => new Date(s).getTime());

      const jobEnds = run.jobs
        .map((j) => j.completedAt)
        .filter((s): s is string => s != null)
        .map((s) => new Date(s).getTime());

      if (jobStarts.length === 0 || jobEnds.length === 0) continue;

      const earliestStart = Math.min(...jobStarts);
      const latestEnd = Math.max(...jobEnds);
      const createdAt = new Date(run.createdAt).getTime();

      const qt = earliestStart - createdAt;
      const rt = latestEnd - earliestStart;

      if (qt > 0) queueTimes.push(qt);
      if (rt > 0) runTimes.push(rt);
    }

    if (queueTimes.length === 0 || runTimes.length === 0) return [];

    const medQueue = median(queueTimes);
    const medRun = median(runTimes);

    if (medRun <= 0 || medQueue < medRun * 0.5) return [];

    const pct = ((medQueue / medRun) * 100).toFixed(0);

    return [
      {
        rule: "queue-dominated",
        severity: "medium",
        tier: "audit",
        workflow: workflow.path,
        message: `Runs spend more time queued than running: median queue ${fmtMinutes(medQueue)} vs median run ${fmtMinutes(medRun)} (${pct}%)`,
        evidence: `median queue ${fmtMinutes(medQueue)} vs median run ${fmtMinutes(medRun)} (${pct}%) over ${queueTimes.length} runs`,
        remediation: "Check runner label availability, self-hosted capacity, and concurrency limits.",
      },
    ];
  },
};
