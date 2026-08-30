import type { Rule, Finding, ParsedJob, RuleContext } from "../types.ts";
import { parseActionRef } from "../parser.ts";

const MACOS_COMMANDS = /\b(xcodebuild|xcrun|codesign|notarytool|security|brew|swift|fastlane)\b/;
const MACOS_KEYWORDS = /\b(tauri\s+ios|tauri\s+macos|apple-|ios|darwin|mac|osx)\b/i;
const MACOS_EXTENSIONS = /\.(app|dmg|pkg)\b/;
const MACOS_RUN_PATTERNS = /\b(pod\s+(install|trunk)|xcode|--mac\b|electron-builder\s+--mac|flutter\s+build\s+macos)\b/i;
const MACOS_ACTION_PATTERNS = /tauri-action|electron-builder|fastlane|xcode|cocoapods/i;

const MACOS_JOB_TOKENS = new Set(["mac", "osx", "darwin", "ios", "apple", "xcode", "cocoapods", "macos"]);
const LINT_JOB_TOKENS = new Set(["lint", "fmt", "format", "docs", "typecheck", "markdown", "markdownlint", "clippy"]);

const PRIMARY_TOOL_PATTERN = /\b(cargo|npm|pnpm|bun|yarn|go|python|pytest|pip|make|cmake|gradle|mvn|dotnet|ruby|gem|bundle|biome)\b/;

function tokenize(label: string): string[] {
  return label
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .split(/[_\-\s/.]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

function matchesTokens(label: string, tokens: Set<string>): boolean {
  return tokenize(label).some((t) => tokens.has(t));
}

function hasMacOSWork(job: ParsedJob): boolean {
  if (matchesTokens(job.id, MACOS_JOB_TOKENS)) return true;
  if (job.name && matchesTokens(job.name, MACOS_JOB_TOKENS)) return true;

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

function isLinuxRunner(runsOn: string | string[]): boolean {
  const values = Array.isArray(runsOn) ? runsOn : [runsOn];
  return values.some((v) => /\bubuntu-|\blinux\b/i.test(v));
}

function getPrimaryTools(job: ParsedJob): Set<string> {
  const tools = new Set<string>();
  for (const step of job.steps) {
    if (!step.run) continue;
    const m = step.run.match(PRIMARY_TOOL_PATTERN);
    if (m) tools.add(m[1]!);
  }
  return tools;
}

function hasLinuxTwin(job: ParsedJob, ctx: RuleContext): boolean {
  const macTools = getPrimaryTools(job);
  if (macTools.size === 0) return false;
  for (const [otherId, otherJob] of ctx.workflow.jobs) {
    if (otherId === job.id) continue;
    if (!isLinuxRunner(otherJob["runs-on"])) continue;
    const otherTools = getPrimaryTools(otherJob);
    for (const tool of macTools) {
      if (otherTools.has(tool)) return true;
    }
  }
  return false;
}

function isLintShaped(job: ParsedJob): boolean {
  if (matchesTokens(job.id, LINT_JOB_TOKENS)) return true;
  if (job.name && matchesTokens(job.name, LINT_JOB_TOKENS)) return true;
  return false;
}

export const macosNotNeeded: Rule = {
  id: "macos-not-needed",
  tier: "static",
  severity: "low",
  describe: "macOS runner used without macOS-specific work",

  check(ctx): Finding[] {
    const findings: Finding[] = [];
    for (const [jobId, job] of ctx.workflow.jobs) {
      if (!isMacOSRunner(job["runs-on"])) continue;
      if (hasMacOSWork(job)) continue;
      if (!hasLinuxTwin(job, ctx)) continue;

      const lintShaped = isLintShaped(job);
      if (!lintShaped) continue;

      const label = job.name ?? jobId;
      const runner = Array.isArray(job["runs-on"]) ? job["runs-on"].join(", ") : job["runs-on"];
      const severity = lintShaped ? "medium" : "low";
      findings.push({
        rule: "macos-not-needed",
        severity,
        tier: "static",
        workflow: ctx.workflow.path,
        job: jobId,
        location: job.line ? { line: job.line } : undefined,
        message: `Job "${label}" runs on ${runner} with no macOS-specific work detected and a Linux equivalent exists`,
        evidence: "macOS minutes bill at 10× Linux. This job could run on an ubuntu runner.",
        remediation: "Switch to an ubuntu runner unless macOS is required.",
        patch: `# In job "${jobId}":\nruns-on: ubuntu-latest`,
      });
    }
    return findings;
  },
};
