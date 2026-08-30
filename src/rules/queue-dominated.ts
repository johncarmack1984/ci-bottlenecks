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

    const findings: Finding[] = [];

    const jobQueueTimes = new Map<string, number[]>();
    const jobRunTimes = new Map<string, number[]>();
    const jobLabels = new Map<string, string>();
    let hasJobCreatedAt = false;

    for (const run of auditData.runs) {
      for (const job of run.jobs) {
        if (!job.startedAt || !job.completedAt) continue;
        if (job.conclusion === "skipped") continue;

        const started = new Date(job.startedAt).getTime();
        const completed = new Date(job.completedAt).getTime();
        const runTime = completed - started;
        if (runTime <= 0) continue;

        let queueTime: number | null = null;

        if (job.createdAt) {
          hasJobCreatedAt = true;
          const created = new Date(job.createdAt).getTime();
          queueTime = started - created;
        }

        if (queueTime != null && queueTime > 0) {
          const qt = jobQueueTimes.get(job.name) ?? [];
          qt.push(queueTime);
          jobQueueTimes.set(job.name, qt);
        }

        const rt = jobRunTimes.get(job.name) ?? [];
        rt.push(runTime);
        jobRunTimes.set(job.name, rt);

        if (job.runnerLabel && !jobLabels.has(job.name)) {
          jobLabels.set(job.name, job.runnerLabel);
        }
      }
    }

    if (hasJobCreatedAt) {
      for (const [jobName, queueTimes] of jobQueueTimes) {
        if (queueTimes.length < 5) continue;
        const medQueue = median(queueTimes);
        if (medQueue < 60_000) continue;

        const runTimes = jobRunTimes.get(jobName) ?? [];
        const medRun = median(runTimes);
        if (medRun <= 0) continue;

        const pct = ((medQueue / medRun) * 100).toFixed(0);
        const label = jobLabels.get(jobName);
        const labelStr = label ? ` (runner: ${label})` : "";

        const jobId = matchJobId(jobName, workflow);

        findings.push({
          rule: "queue-dominated",
          severity: "medium",
          tier: "audit",
          workflow: workflow.path,
          job: jobId,
          message: `Job "${jobName}"${labelStr} spends more time queued than running: median queue ${fmtMinutes(medQueue)} vs median run ${fmtMinutes(medRun)} (${pct}%)`,
          evidence: `median queue ${fmtMinutes(medQueue)} vs median run ${fmtMinutes(medRun)} (${pct}%) over ${queueTimes.length} samples`,
          remediation: "Check runner label availability, self-hosted capacity, and concurrency limits.",
          estimatedSavings: { minutesPerRun: Math.round(medQueue / 60_000 * 10) / 10, confidence: "estimate" },
        });
      }

      if (findings.length > 0) return findings;
    }

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
      const runStarted = run.runStartedAt ? new Date(run.runStartedAt).getTime() : createdAt;
      const effectiveStart = Math.max(createdAt, runStarted);

      const qt = earliestStart - effectiveStart;
      const rt = latestEnd - earliestStart;

      if (qt > 0) queueTimes.push(qt);
      if (rt > 0) runTimes.push(rt);
    }

    if (queueTimes.length < 5 || runTimes.length === 0) return [];

    const medQueue = median(queueTimes);
    const medRun = median(runTimes);

    if (medQueue < 60_000) return [];
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
        estimatedSavings: { minutesPerRun: Math.round(medQueue / 60_000 * 10) / 10, confidence: "estimate" },
      },
    ];
  },
};

function matchJobId(jobName: string, workflow: { jobs: Map<string, { name?: string }> }): string | undefined {
  for (const [jobId, job] of workflow.jobs) {
    const label = job.name ?? jobId;
    if (label === jobName) return jobId;
    if (jobName.startsWith(`${label} (`)) return jobId;
  }
  return undefined;
}
