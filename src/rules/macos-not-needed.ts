import type { Rule, Finding, ParsedJob } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const MACOS_COMMANDS = /\b(xcodebuild|xcrun|codesign|notarytool|security|brew|swift|fastlane)\b/;
const MACOS_KEYWORDS = /\b(tauri\s+ios|tauri\s+macos|apple-|ios|darwin|mac|osx)\b/i;
const MACOS_EXTENSIONS = /\.(app|dmg|pkg)\b/;
const MACOS_RUN_PATTERNS = /\b(pod\s+(install|trunk)|xcode|--mac\b|electron-builder\s+--mac|flutter\s+build\s+macos)\b/i;
const MACOS_ACTION_PATTERNS = /tauri-action|electron-builder|fastlane|xcode|cocoapods/i;

const MACOS_JOB_PATTERN = /\b(mac|osx|darwin|ios|apple|xcode|cocoapods|macos)\b/i;

function hasMacOSWork(job: ParsedJob): boolean {
  if (MACOS_JOB_PATTERN.test(job.id)) return true;
  if (job.name && MACOS_JOB_PATTERN.test(job.name)) return true;

  for (const step of job.steps) {
    const run = step.run ?? "";
    if (MACOS_COMMANDS.test(run) || MACOS_KEYWORDS.test(run) || MACOS_EXTENSIONS.test(run) || MACOS_RUN_PATTERNS.test(run)) return true;

    if (step.uses) {
      if (MACOS_KEYWORDS.test(step.uses) || MACOS_ACTION_PATTERNS.test(step.uses)) return true;
      const { key } = parseActionRef(step.uses);
      if (key === "actions/upload-artifact") return true;
      if (MACOS_ACTION_PATTERNS.test(key)) return true;
    }

    if (step.with) {
      const withValues = Object.values(step.with).map(String).join(" ");
      if (MACOS_COMMANDS.test(withValues) || MACOS_KEYWORDS.test(withValues) || MACOS_EXTENSIONS.test(withValues) || MACOS_RUN_PATTERNS.test(withValues)) return true;
    }
  }

  if (job.strategy?.matrix) {
    const matrixStr = JSON.stringify(job.strategy.matrix);
    if (/macos|darwin|ios|mac|osx/i.test(matrixStr)) return true;
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
  severity: "medium",
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
        severity: "medium",
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
