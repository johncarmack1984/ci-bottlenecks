import type { Rule, Finding } from "../types.ts";
import { durationMs, median, fmtMinutes } from "../utils.ts";

const WORK_PATTERN = /^(Build\b|Test\b|Run cargo\s+(build|test|clippy|fmt)|Run\s+bun\s+run|Run\s+npm\s+(run|test)|Run\s+node|Run\s+make|Run\s+just|Unused|cargo clippy|cargo test|cargo fmt)/i;
const POST_RUN_CACHE_PATTERN = /^Post Run\b/i;
const TOOL_INSTALL_PATTERN = /\bcargo\s+install\b|\bnpm\s+install\s+-g\b|\bpip\s+install\b/i;

const SETUP_PATTERN = /(?:^Set up job$|^Run actions\/checkout\b|^Post\s)|(?<!\S)(?:checkout|setup|install|cache|restore|toolchain|bootstrap)(?!\S)/i;

function isSetupStep(stepName: string): "setup" | "cache-save" | "work" | "tool-install" {
  if (WORK_PATTERN.test(stepName)) return "work";
  if (POST_RUN_CACHE_PATTERN.test(stepName)) return "cache-save";
  if (TOOL_INSTALL_PATTERN.test(stepName)) return "tool-install";

  if (/\binstaller-signed\b/i.test(stepName)) return "work";

  if (SETUP_PATTERN.test(stepName)) return "setup";
  return "work";
}

export const setupDominated: Rule = {
  id: "setup-dominated",
  tier: "audit",
  severity: "medium",
  describe: "Setup steps consume most of job time",

  check(ctx): Finding[] {
    const { workflow, auditData } = ctx;
    if (!auditData || auditData.runs.length === 0) return [];

    const findings: Finding[] = [];

    const jobIdByName = new Map<string, string>();
    for (const [jobId, job] of workflow.jobs) {
      jobIdByName.set(job.name ?? jobId, jobId);
    }

    const jobRunShares = new Map<string, number[]>();
    const jobRunSetupMs = new Map<string, number[]>();
    const jobRunTotalMs = new Map<string, number[]>();
    const jobStepMedians = new Map<string, Map<string, number[]>>();
    const jobCacheSaveMedians = new Map<string, Map<string, number[]>>();

    for (const run of auditData.runs) {
      for (const job of run.jobs) {
        if (job.conclusion === "cancelled" || job.conclusion === "skipped") continue;

        let jobTotal = 0;
        let setupTotal = 0;
        const stepDurations = new Map<string, number>();
        const cacheSaveDurations = new Map<string, number>();

        for (const step of job.steps) {
          const d = durationMs(step.startedAt, step.completedAt);
          if (d == null) continue;
          jobTotal += d;

          const cls = isSetupStep(step.name);
          if (cls === "setup" || cls === "tool-install") {
            setupTotal += d;
            stepDurations.set(step.name, (stepDurations.get(step.name) ?? 0) + d);
          } else if (cls === "cache-save") {
            cacheSaveDurations.set(step.name, d);
          }
        }

        if (jobTotal <= 0) continue;

        const share = Math.min(setupTotal / jobTotal, 1);

        const shares = jobRunShares.get(job.name) ?? [];
        shares.push(share);
        jobRunShares.set(job.name, shares);

        const setups = jobRunSetupMs.get(job.name) ?? [];
        setups.push(setupTotal);
        jobRunSetupMs.set(job.name, setups);

        const totals = jobRunTotalMs.get(job.name) ?? [];
        totals.push(jobTotal);
        jobRunTotalMs.set(job.name, totals);

        if (!jobStepMedians.has(job.name)) jobStepMedians.set(job.name, new Map());
        const sm = jobStepMedians.get(job.name)!;
        for (const [name, dur] of stepDurations) {
          const arr = sm.get(name) ?? [];
          arr.push(dur);
          sm.set(name, arr);
        }

        if (!jobCacheSaveMedians.has(job.name)) jobCacheSaveMedians.set(job.name, new Map());
        const csm = jobCacheSaveMedians.get(job.name)!;
        for (const [name, dur] of cacheSaveDurations) {
          const arr = csm.get(name) ?? [];
          arr.push(dur);
          csm.set(name, arr);
        }
      }
    }

    for (const [jobName, shares] of jobRunShares) {
      const medShare = median(shares);
      if (medShare < 0.5) continue;

      const medTotal = median(jobRunTotalMs.get(jobName) ?? []);
      const medSetup = median(jobRunSetupMs.get(jobName) ?? []);

      if (medTotal < 120_000 && medSetup < 60_000) continue;
      if (medSetup < 60_000) continue;

      const pct = Math.min(Math.round(medShare * 100), 100);
      const jobId = jobIdByName.get(jobName);

      const stepMap = jobStepMedians.get(jobName) ?? new Map();
      const breakdown: { name: string; med: number; isToolInstall: boolean }[] = [];
      for (const [name, durations] of stepMap) {
        breakdown.push({
          name,
          med: median(durations),
          isToolInstall: isSetupStep(name) === "tool-install",
        });
      }
      breakdown.sort((a, b) => b.med - a.med);

      const top5 = breakdown.slice(0, 5);
      const rest = breakdown.length - 5;
      const evidenceParts = top5.map((s) => `${s.name}: ${fmtMinutes(s.med)}`);
      if (rest > 0) evidenceParts.push(`+${rest} more`);

      const cacheSaveMap = jobCacheSaveMedians.get(jobName) ?? new Map();
      const cacheSaveParts: string[] = [];
      for (const [name, durations] of cacheSaveMap) {
        cacheSaveParts.push(`${name}: ${fmtMinutes(median(durations))}`);
      }

      let evidence = `Setup breakdown: ${evidenceParts.join(", ")}. Total job median: ${fmtMinutes(medTotal)}`;
      if (cacheSaveParts.length > 0) {
        evidence += `. Cache save: ${cacheSaveParts.join(", ")}`;
      }

      const toolInstalls = breakdown.filter((s) => s.isToolInstall);
      let remediation = "Improve caching or use a prebuilt container to reduce setup time.";
      if (toolInstalls.length > 0) {
        remediation = `Use a prebuilt-binary installer (taiki-e/install-action, cargo-binstall) or cache the binary for: ${toolInstalls.map((s) => s.name).join(", ")}. ${remediation}`;
      }

      findings.push({
        rule: "setup-dominated",
        severity: "medium",
        tier: "audit",
        workflow: workflow.path,
        job: jobId,
        message: `Job "${jobName}" spends ${pct}% of time in setup steps (${fmtMinutes(medSetup)} of ${fmtMinutes(medTotal)})`,
        evidence,
        remediation,
        estimatedSavings: { minutesPerRun: Math.round(medSetup / 60_000 * 10) / 10, confidence: "estimate" },
      });
    }

    return findings;
  },
};
