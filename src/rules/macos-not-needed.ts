import type { Rule, Finding, ParsedJob } from "../types.ts";

const MACOS_COMMANDS = /\b(xcodebuild|xcrun|codesign|notarytool|security|brew|swift)\b/;
const MACOS_KEYWORDS = /\b(tauri\s+ios|tauri\s+macos|apple-|ios|darwin)\b/i;
const MACOS_EXTENSIONS = /\.(app|dmg|pkg)\b/;

function hasMacOSWork(job: ParsedJob): boolean {
  for (const step of job.steps) {
    const run = step.run ?? "";
    if (MACOS_COMMANDS.test(run) || MACOS_KEYWORDS.test(run) || MACOS_EXTENSIONS.test(run)) return true;

    if (step.uses) {
      if (MACOS_KEYWORDS.test(step.uses)) return true;
    }

    if (step.with) {
      const withValues = Object.values(step.with).map(String).join(" ");
      if (MACOS_COMMANDS.test(withValues) || MACOS_KEYWORDS.test(withValues) || MACOS_EXTENSIONS.test(withValues)) return true;
    }
  }

  if (job.strategy?.matrix) {
    const matrixStr = JSON.stringify(job.strategy.matrix);
    if (/macos|darwin|ios/i.test(matrixStr)) return true;
  }

  return false;
}

function isMacOSRunner(runsOn: string | string[]): boolean {
  const values = Array.isArray(runsOn) ? runsOn : [runsOn];
  return values.some((v) => /\bmacos-/.test(v));
}

export const macosNotNeeded: Rule = {
  id: "macos-not-needed",
  tier: "static",
  severity: "high",
  describe: "macOS runner used without macOS-specific work",

  check(ctx): Finding[] {
    const findings: Finding[] = [];
    for (const [jobId, job] of ctx.workflow.jobs) {
      if (!isMacOSRunner(job["runs-on"])) continue;
      if (hasMacOSWork(job)) continue;

      const label = job.name ?? jobId;
      const runner = Array.isArray(job["runs-on"]) ? job["runs-on"].join(", ") : job["runs-on"];
      findings.push({
        rule: "macos-not-needed",
        severity: "high",
        tier: "static",
        workflow: ctx.workflow.path,
        job: jobId,
        location: job.line ? { line: job.line } : undefined,
        message: `Job "${label}" runs on ${runner} but has no macOS-specific steps`,
        evidence: "macOS minutes bill at 10× Linux.",
        remediation: "Switch to an ubuntu runner unless macOS is required.",
        patch: `# In job "${jobId}":\nruns-on: ubuntu-latest`,
      });
    }
    return findings;
  },
};
