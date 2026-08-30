import type { Rule, Finding, ParsedJob } from "../types.ts";
import { parseActionRef } from "../parser.ts";

type Toolchain = "rust" | "node" | "python" | "go" | "java" | "bun";

const TOOLCHAIN_MAP: Record<string, Toolchain> = {
  "dtolnay/rust-toolchain": "rust",
  "actions-rust-lang/setup-rust-toolchain": "rust",
  "Swatinem/rust-cache": "rust",
  "actions/setup-node": "node",
  "actions/setup-python": "python",
  "actions/setup-go": "go",
  "actions/setup-java": "java",
  "oven-sh/setup-bun": "bun",
};

const BUILD_PATTERNS: Record<Toolchain, RegExp> = {
  rust: /\bcargo\s+(build|test|clippy)\b/,
  node: /\b(npm|pnpm|bun)\s+run\s+build\b|\byarn\s+build\b/,
  python: /(?!)/, // no standard build command
  go: /(?!)/,
  java: /(?!)/,
  bun: /\bbun\s+run\s+build\b/,
};

interface JobProfile {
  jobId: string;
  toolchains: Set<Toolchain>;
  builds: boolean;
  hasCheckout: boolean;
  uploadsArtifact: boolean;
  downloadsArtifact: boolean;
}

function profileJob(job: ParsedJob): JobProfile {
  const toolchains = new Set<Toolchain>();
  let builds = false;
  let hasCheckout = false;
  let uploadsArtifact = false;
  let downloadsArtifact = false;

  for (const step of job.steps) {
    if (step.uses) {
      const { key } = parseActionRef(step.uses);
      if (key === "actions/checkout") hasCheckout = true;
      if (key === "actions/upload-artifact") uploadsArtifact = true;
      if (key === "actions/download-artifact") downloadsArtifact = true;
      const tc = TOOLCHAIN_MAP[key];
      if (tc) toolchains.add(tc);
    }
    if (step.run) {
      for (const [tc, pattern] of Object.entries(BUILD_PATTERNS) as [Toolchain, RegExp][]) {
        if (pattern.test(step.run)) {
          builds = true;
          toolchains.add(tc);
        }
      }
    }
  }

  return { jobId: job.id, toolchains, builds, hasCheckout, uploadsArtifact, downloadsArtifact };
}

export const repeatedSetup: Rule = {
  id: "repeated-setup",
  tier: "static",
  severity: "medium",
  describe: "Multiple jobs repeat checkout + toolchain + build with no artifact hand-off",

  check(ctx): Finding[] {
    const profiles = new Map<string, JobProfile>();
    for (const [jobId, job] of ctx.workflow.jobs) {
      profiles.set(jobId, profileJob(job));
    }

    // Group by toolchain set
    const byToolchain = new Map<string, JobProfile[]>();
    for (const profile of profiles.values()) {
      if (!profile.hasCheckout || profile.toolchains.size === 0 || !profile.builds) continue;
      if (profile.downloadsArtifact) continue;
      const key = [...profile.toolchains].sort().join("+");
      const group = byToolchain.get(key) ?? [];
      group.push(profile);
      byToolchain.set(key, group);
    }

    const findings: Finding[] = [];
    for (const [tc, group] of byToolchain) {
      if (group.length < 3) continue;

      const hasAnyUpload = group.some((p) => p.uploadsArtifact);
      if (hasAnyUpload) continue;

      const jobNames = group.map((p) => p.jobId).join(", ");
      findings.push({
        rule: "repeated-setup",
        severity: "medium",
        tier: "static",
        workflow: ctx.workflow.path,
        message: `${group.length} jobs (${jobNames}) repeat checkout + ${tc} setup + build with no artifact hand-off`,
        evidence: `Jobs ${jobNames} each independently check out, install the ${tc} toolchain, and build.`,
        remediation: "Build once and upload the artifact, then download in consumer jobs; or merge jobs that share a compilation cache.",
      });
    }
    return findings;
  },
};
