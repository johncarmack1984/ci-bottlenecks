import type { Rule, Finding, ParsedStep } from "../types.ts";
import { parseActionRef } from "../parser.ts";

export type Ecosystem = "node" | "python" | "rust" | "bun";

const INSTALL_PATTERNS: { pattern: RegExp; ecosystem: Ecosystem }[] = [
  // npm install -g is a global tool install, not a dependency install
  { pattern: /\bnpm\s+(ci|install)\b(?!\s+-g)/, ecosystem: "node" },
  { pattern: /\bpnpm\s+install\b/, ecosystem: "node" },
  { pattern: /\byarn\s+install\b/, ecosystem: "node" },
  { pattern: /\bbun\s+install\b/, ecosystem: "bun" },
  { pattern: /\bpip\s+install\b/, ecosystem: "python" },
  { pattern: /\bcargo\s+(build|test)\b/, ecosystem: "rust" },
];

const NODE_CACHE_PATHS = /node_modules|\.npm|\.pnpm-store|\.yarn/;
const PIP_CACHE_PATHS = /pip|\.cache\/pip/;
const RUST_CACHE_PATHS = /\.cargo|target\//;
const BUN_CACHE_PATHS = /\.bun\/install\/cache/;

export const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  node: "Node.js (npm/pnpm/yarn)",
  bun: "Bun",
  python: "Python (pip)",
  rust: "Rust (cargo)",
};

/** The dependency ecosystems a `run:` step installs for (usually one, at most a few). */
export function installEcosystemsOf(step: ParsedStep): Ecosystem[] {
  if (!step.run) return [];
  const out: Ecosystem[] = [];
  for (const { pattern, ecosystem } of INSTALL_PATTERNS) {
    if (pattern.test(step.run) && !out.includes(ecosystem)) out.push(ecosystem);
  }
  return out;
}

/** Every step in the job that installs dependencies for `eco`, in YAML order. */
export function installStepsFor(steps: ParsedStep[], eco: Ecosystem): ParsedStep[] {
  return steps.filter((s) => installEcosystemsOf(s).includes(eco));
}

/** The fix once an install is known to be slow enough to be worth caching. */
export function cacheRemediation(eco: Ecosystem): string {
  return `Add a cache mechanism for ${ECOSYSTEM_LABELS[eco]} dependencies (e.g. setup-node with cache input, actions/cache, or an ecosystem-specific cache action).`;
}

function stepKey(step: ParsedStep): { key: string; isLocal: boolean } | null {
  if (!step.uses) return null;
  const ref = parseActionRef(step.uses);
  return { key: ref.key, isLocal: ref.isLocal };
}

function detectCachedEcosystems(steps: ParsedStep[]): Set<Ecosystem> {
  const cached = new Set<Ecosystem>();

  for (const step of steps) {
    const ref = stepKey(step);
    if (!ref) continue;

    // Local composite actions are opaque — treat as cached for all ecosystems
    if (ref.isLocal) {
      cached.add("node");
      cached.add("python");
      cached.add("rust");
      cached.add("bun");
      continue;
    }

    const { key } = ref;

    if (key === "actions/setup-node" && step.with?.cache) cached.add("node");
    if (key === "actions/setup-python" && step.with?.cache) cached.add("python");
    if (key === "Swatinem/rust-cache") cached.add("rust");
    if (key === "mozilla-actions/sccache-action") cached.add("rust");
    if (key === "moonrepo/setup-rust") {
      // Caches by default unless cache: false
      const cacheOpt = step.with?.cache;
      if (cacheOpt !== false && cacheOpt !== "false") cached.add("rust");
    }
    if (key === "astral-sh/setup-uv") cached.add("python");
    if (key === "pdm-project/setup-pdm") cached.add("python");

    // oven-sh/setup-bun only caches the bun binary, not dependencies
    // It is NOT a dependency cache provider

    if (key === "actions/cache" || key === "actions/cache/restore") {
      const paths = typeof step.with?.path === "string" ? step.with.path : "";
      // Expression-based paths are opaque — treat as potentially caching anything
      if (paths.includes("${{")) {
        cached.add("node");
        cached.add("python");
        cached.add("rust");
        cached.add("bun");
        continue;
      }
      if (NODE_CACHE_PATHS.test(paths)) cached.add("node");
      if (PIP_CACHE_PATHS.test(paths)) cached.add("python");
      if (RUST_CACHE_PATHS.test(paths)) cached.add("rust");
      if (BUN_CACHE_PATHS.test(paths)) cached.add("bun");
    }
  }

  return cached;
}

// Statically the rule can see that an install has no cache, but not how long
// the install takes — and a cache restore costs 2-4s per job on its own. So the
// static finding is a `low` hint that says "measure this". The cross-tier gate
// in runner.ts promotes it to `medium` when --audit measures the flagged step
// at or above the payback floor, and drops it when the step measures under.
export const installNoCache: Rule = {
  id: "install-no-cache",
  tier: "static",
  severity: "medium",
  describe: "Package install without a cache mechanism",

  check(ctx): Finding[] {
    const findings: Finding[] = [];

    for (const [jobId, job] of ctx.workflow.jobs) {
      const installed = new Map<Ecosystem, ParsedStep>();
      for (const step of job.steps) {
        for (const eco of installEcosystemsOf(step)) {
          if (!installed.has(eco)) installed.set(eco, step);
        }
      }
      if (installed.size === 0) continue;

      const cached = detectCachedEcosystems(job.steps);

      for (const [eco, firstStep] of installed) {
        if (cached.has(eco)) continue;
        const label = ECOSYSTEM_LABELS[eco];
        findings.push({
          rule: "install-no-cache",
          severity: "low",
          tier: "static",
          workflow: ctx.workflow.path,
          job: jobId,
          step: firstStep.index,
          location: firstStep.line ? { line: firstStep.line } : undefined,
          message: `Job "${job.name ?? jobId}" installs ${label} packages without a cache mechanism`,
          evidence: `${label} install detected but no matching cache action or configuration found; install duration unmeasured`,
          remediation: `Measure before caching: run the audit tier (--audit, or the action's audit: true) to see this install's median duration. A cache restore costs 2-4s per job, so caching only pays for installs of roughly 10s or more. If it qualifies: ${cacheRemediation(eco)}`,
          meta: { ecosystem: eco },
        });
      }
    }
    return findings;
  },
};
