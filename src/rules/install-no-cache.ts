import type { Rule, Finding, ParsedStep } from "../types.ts";
import { parseActionRef } from "../parser.ts";

type Ecosystem = "node" | "python" | "rust" | "bun";

const INSTALL_PATTERNS: { pattern: RegExp; ecosystem: Ecosystem }[] = [
  { pattern: /\bnpm\s+(ci|install)\b/, ecosystem: "node" },
  { pattern: /\bpnpm\s+install\b/, ecosystem: "node" },
  { pattern: /\byarn\s+install\b/, ecosystem: "node" },
  { pattern: /\bbun\s+install\b/, ecosystem: "bun" },
  { pattern: /\bpip\s+install\b/, ecosystem: "python" },
  { pattern: /\bcargo\s+(build|test)\b/, ecosystem: "rust" },
];

const NODE_CACHE_PATHS = /node_modules|\.npm|\.pnpm-store|\.yarn/;
const PIP_CACHE_PATHS = /pip|\.cache\/pip/;
const RUST_CACHE_PATHS = /\.cargo|target\//;

function stepKey(step: ParsedStep): string | null {
  if (!step.uses) return null;
  return parseActionRef(step.uses).key;
}

function detectInstallEcosystems(steps: ParsedStep[]): Set<Ecosystem> {
  const ecosystems = new Set<Ecosystem>();
  for (const step of steps) {
    if (!step.run) continue;
    for (const { pattern, ecosystem } of INSTALL_PATTERNS) {
      if (pattern.test(step.run)) ecosystems.add(ecosystem);
    }
  }
  return ecosystems;
}

function detectCachedEcosystems(steps: ParsedStep[]): Set<Ecosystem> {
  const cached = new Set<Ecosystem>();

  for (const step of steps) {
    const key = stepKey(step);
    if (!key) continue;

    if (key === "actions/setup-node" && step.with?.cache) cached.add("node");
    if (key === "actions/setup-python" && step.with?.cache) cached.add("python");
    if (key === "Swatinem/rust-cache") cached.add("rust");
    if (key === "mozilla-actions/sccache-action") cached.add("rust");

    if (key === "oven-sh/setup-bun") {
      const noCache = step.with?.["no-cache"];
      if (noCache === true || noCache === "true") continue;
      cached.add("bun");
    }

    if (key === "actions/cache") {
      const paths = typeof step.with?.path === "string" ? step.with.path : "";
      if (NODE_CACHE_PATHS.test(paths)) cached.add("node");
      if (PIP_CACHE_PATHS.test(paths)) cached.add("python");
      if (RUST_CACHE_PATHS.test(paths)) cached.add("rust");
    }
  }

  return cached;
}

const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  node: "Node.js (npm/pnpm/yarn)",
  bun: "Bun",
  python: "Python (pip)",
  rust: "Rust (cargo)",
};

export const installNoCache: Rule = {
  id: "install-no-cache",
  tier: "static",
  severity: "medium",
  describe: "Package install without a cache mechanism",

  check(ctx): Finding[] {
    const findings: Finding[] = [];

    for (const [jobId, job] of ctx.workflow.jobs) {
      const installed = detectInstallEcosystems(job.steps);
      if (installed.size === 0) continue;

      const cached = detectCachedEcosystems(job.steps);

      for (const eco of installed) {
        if (cached.has(eco)) continue;
        findings.push({
          rule: "install-no-cache",
          severity: "medium",
          tier: "static",
          workflow: ctx.workflow.path,
          job: jobId,
          message: `Job "${job.name ?? jobId}" installs ${ECOSYSTEM_LABELS[eco]} packages without a cache mechanism`,
          evidence: `${ECOSYSTEM_LABELS[eco]} install detected but no matching cache action or configuration found`,
          remediation: `Add a cache mechanism for ${ECOSYSTEM_LABELS[eco]} dependencies (e.g. setup-node with cache input, actions/cache, or an ecosystem-specific cache action).`,
        });
      }
    }
    return findings;
  },
};
