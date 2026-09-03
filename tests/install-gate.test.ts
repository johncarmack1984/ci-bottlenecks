import { describe, it, expect } from "bun:test";
import { parseWorkflow } from "../src/parser.ts";
import { runRules, INSTALL_CACHE_WORTH_MS } from "../src/runner.ts";
import { allRules } from "../src/rules/index.ts";
import { stepDisplayName } from "../src/utils.ts";
import type { Finding, JobData, RunData, StepData, WorkflowAuditData } from "../src/types.ts";

// [name, seconds, conclusion?]
type StepSpec = [string, number, string?];

function job(name: string, specs: StepSpec[]): JobData {
  let cursor = Date.UTC(2026, 0, 1, 0, 0, 0);
  const steps: StepData[] = specs.map(([stepName, seconds, conclusion], i) => {
    const startedAt = new Date(cursor).toISOString();
    cursor += seconds * 1000;
    return { name: stepName, number: i + 1, status: "completed", conclusion: conclusion ?? "success", startedAt, completedAt: new Date(cursor).toISOString() };
  });
  return {
    id: Math.floor(Math.random() * 1e6), name, conclusion: "success", createdAt: null,
    startedAt: steps[0]?.startedAt ?? null, completedAt: steps[steps.length - 1]?.completedAt ?? null,
    runnerLabel: "ubuntu-latest", steps,
  };
}

function runs(jobsPerRun: JobData[][]): WorkflowAuditData {
  return {
    runs: jobsPerRun.map((jobs, i): RunData => ({
      id: 1000 + i, name: "CI", workflowId: 1, headSha: "a".repeat(40), event: "push", conclusion: "success",
      createdAt: "2026-01-01T00:00:00Z", runStartedAt: "2026-01-01T00:00:05Z", updatedAt: "2026-01-01T00:10:00Z", jobs,
    })),
  };
}

function lint(yaml: string, audit?: WorkflowAuditData, pedantic = false): Finding[] {
  const wf = parseWorkflow("test.yml", yaml);
  if (!wf) throw new Error("Failed to parse YAML");
  return runRules(allRules, [wf], {
    audit: false,
    pedantic,
    auditDataByWorkflow: audit ? new Map([["test.yml", audit]]) : undefined,
  }).filter((f) => f.rule === "install-no-cache");
}

const NPM_CI = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: npm ci
      - run: npm test
`;

const npmRun = (seconds: number, conclusion?: string, stepName = "Install dependencies") =>
  job("build", [["Set up job", 1], ["Run actions/checkout@v4", 1], [stepName, seconds, conclusion], ["Run npm test", 20]]);

describe("stepDisplayName follows GitHub's naming", () => {
  it("prefers the explicit name", () => {
    expect(stepDisplayName({ index: 0, name: "Install deps", run: "npm ci" })).toBe("Install deps");
  });
  it("names an action step 'Run <uses>'", () => {
    expect(stepDisplayName({ index: 0, uses: "actions/checkout@v4" })).toBe("Run actions/checkout@v4");
  });
  it("names a script step after its first non-empty line", () => {
    expect(stepDisplayName({ index: 0, run: "\n  bun install --frozen-lockfile\n  bun test\n" })).toBe("Run bun install --frozen-lockfile");
  });
  it("returns null when there is nothing to name", () => {
    expect(stepDisplayName({ index: 0 })).toBeNull();
    expect(stepDisplayName({ index: 0, run: "\n\n" })).toBeNull();
  });
});

describe("install-no-cache without measurements", () => {
  it("is a low, unmeasured hint that points at the install step and asks for --audit", () => {
    const f = lint(NPM_CI);
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("low");
    expect(f[0]!.step).toBe(1);
    expect(f[0]!.meta?.ecosystem).toBe("node");
    expect(f[0]!.evidence).toContain("unmeasured");
    expect(f[0]!.remediation).toContain("--audit");
  });
});

describe("install-no-cache measured gate", () => {
  it("promotes a slow install to medium with the measured duration as evidence", () => {
    const f = lint(NPM_CI, runs([[npmRun(44)], [npmRun(45)], [npmRun(46)]]));
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("medium");
    expect(f[0]!.evidence).toBe("Measured: Install dependencies: 45s median over 3 runs. No matching cache action or configuration found");
    expect(f[0]!.remediation).not.toContain("--audit");
    expect(f[0]!.estimatedSavings).toEqual({ minutesPerRun: 0.8, confidence: "estimate" });
  });

  it("drops an install under the payback floor, keeping an info trace only in pedantic mode", () => {
    const fast = runs([[npmRun(3)], [npmRun(4)], [npmRun(3)]]);
    expect(lint(NPM_CI, fast).length).toBe(0);
    const pedantic = lint(NPM_CI, fast, true);
    expect(pedantic.length).toBe(1);
    expect(pedantic[0]!.severity).toBe("info");
    expect(pedantic[0]!.evidence).toContain(`under the ${INSTALL_CACHE_WORTH_MS / 1000}s payback floor`);
  });

  it("treats the floor as inclusive: exactly 10s is worth caching", () => {
    expect(lint(NPM_CI, runs([[npmRun(10)]]))[0]?.severity).toBe("medium");
    expect(lint(NPM_CI, runs([[npmRun(9)]])).length).toBe(0);
  });

  it("ignores failed install samples when taking the median", () => {
    // One good 30s sample and two failed 1s attempts: the failures are not
    // install times, so the median is 30s and the finding fires.
    const f = lint(NPM_CI, runs([[npmRun(30)], [npmRun(1, "failure")], [npmRun(1, "failure")]]));
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("medium");
  });

  it("keeps the static hint when the runs do not contain the step by name", () => {
    const f = lint(NPM_CI, runs([[npmRun(45, undefined, "Run npm ci")]]));
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("low");
    expect(f[0]!.evidence).toContain("unmeasured");
  });

  it("does not let a deleted tool-install step from older runs keep the finding alive", () => {
    const yaml = `
name: desktop
on: push
jobs:
  unused-deps:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - uses: taiki-e/install-action@v2
        with:
          tool: cargo-machete
      - run: cargo machete
`;
    const before = job("unused-deps", [["Run oven-sh/setup-bun@v2", 2], ["Run bun install --frozen-lockfile", 1], ["Run cargo install cargo-machete", 42], ["Run cargo machete", 3]]);
    const after = job("unused-deps", [["Run oven-sh/setup-bun@v2", 2], ["Run bun install --frozen-lockfile", 1], ["Run taiki-e/install-action@v2", 1], ["Run cargo machete", 3]]);
    expect(lint(yaml, runs([[before], [before], [after]])).length).toBe(0);
  });

  it("measures each ecosystem's own install steps: slow npm fires, fast bun does not", () => {
    const yaml = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: oven-sh/setup-bun@v2
      - name: Install web dependencies
        run: npm ci
      - name: Install tooling
        run: bun install --frozen-lockfile
      - run: npm test
`;
    const r = job("build", [["Run oven-sh/setup-bun@v2", 2], ["Install web dependencies", 40], ["Install tooling", 1], ["Run npm test", 20]]);
    const f = lint(yaml, runs([[r], [r], [r]]));
    expect(f.length).toBe(1);
    expect(f[0]!.meta?.ecosystem).toBe("node");
    expect(f[0]!.severity).toBe("medium");
  });

  it("measures every install step of the ecosystem and sums their medians for the stake", () => {
    const yaml = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm ci --prefix docs
      - run: npm test
`;
    const r = job("build", [["Run actions/checkout@v4", 1], ["Run npm ci", 30], ["Run npm ci --prefix docs", 30], ["Run npm test", 20]]);
    const f = lint(yaml, runs([[r]]));
    expect(f.length).toBe(1);
    expect(f[0]!.evidence).toContain("Run npm ci: 30s median over 1 run, Run npm ci --prefix docs: 30s median over 1 run");
    expect(f[0]!.estimatedSavings?.minutesPerRun).toBe(1);
  });

  it("matches matrix legs by job-name prefix", () => {
    const yaml = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: npm ci
      - run: npm test
`;
    const leg = (n: number) => job(`build (${n})`, [["Run actions/checkout@v4", 1], ["Install dependencies", 40], ["Run npm test", 20]]);
    const f = lint(yaml, runs([[leg(20), leg(22)]]));
    expect(f.length).toBe(1);
    expect(f[0]!.evidence).toContain("40s median over 2 runs");
  });
});
