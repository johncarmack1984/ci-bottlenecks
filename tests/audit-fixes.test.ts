import { describe, it, expect } from "bun:test";
import { parseWorkflow } from "../src/parser.ts";
import { runRules } from "../src/runner.ts";
import { allRules } from "../src/rules/index.ts";
import type { Finding, WorkflowAuditData, RunData, JobData, StepData } from "../src/types.ts";

function makeRun(overrides: Partial<RunData> & { jobs?: JobData[] }): RunData {
  return {
    id: Math.floor(Math.random() * 100000),
    name: "CI",
    workflowId: 1,
    headSha: "abc1234",
    event: "push",
    conclusion: "success",
    createdAt: "2024-01-01T00:00:00Z",
    runStartedAt: "2024-01-01T00:00:30Z",
    updatedAt: "2024-01-01T00:10:00Z",
    jobs: [],
    ...overrides,
  };
}

function makeJob(name: string, startMin: number, endMin: number, overrides?: Partial<JobData>): JobData {
  const base = new Date("2024-01-01T00:00:00Z").getTime();
  return {
    id: Math.floor(Math.random() * 100000),
    name,
    conclusion: "success",
    createdAt: null,
    startedAt: new Date(base + startMin * 60000).toISOString(),
    completedAt: new Date(base + endMin * 60000).toISOString(),
    runnerLabel: null,
    steps: [],
    ...overrides,
  };
}

function checkAudit(yaml: string, auditData: WorkflowAuditData): Finding[] {
  const wf = parseWorkflow("test.yml", yaml);
  if (!wf) throw new Error("Failed to parse YAML");
  return runRules(allRules, [wf], {
    audit: true,
    pedantic: false,
    auditDataByWorkflow: new Map([["test.yml", auditData]]),
  });
}

// Item 12: setup-dominated classifies by name only

describe("setup-dominated: does not classify by position", () => {
  it("does not count 'Run tests' as setup even if step number <= 3", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const makeSteps = (): StepData[] => [
      {
        name: "Set up job", number: 1, status: "completed", conclusion: "success",
        startedAt: new Date(base).toISOString(),
        completedAt: new Date(base + 5_000).toISOString(),
      },
      {
        name: "Run actions/checkout@v4", number: 2, status: "completed", conclusion: "success",
        startedAt: new Date(base + 5_000).toISOString(),
        completedAt: new Date(base + 10_000).toISOString(),
      },
      {
        name: "Run tests", number: 3, status: "completed", conclusion: "success",
        startedAt: new Date(base + 10_000).toISOString(),
        completedAt: new Date(base + 310_000).toISOString(),
      },
    ];

    const runs: RunData[] = Array.from({ length: 3 }, (_, i) =>
      makeRun({
        id: i + 1,
        headSha: `sha${i}`,
        jobs: [{
          id: i + 100, name: "build", conclusion: "success",
          createdAt: null,
          startedAt: new Date(base).toISOString(),
          completedAt: new Date(base + 310_000).toISOString(),
          runnerLabel: null,
          steps: makeSteps(),
        }],
      }),
    );

    const yaml = `
name: CI
on: push
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

    const findings = checkAudit(yaml, { runs });
    const sd = findings.filter((f) => f.rule === "setup-dominated");
    // "Run tests" at position 3 should NOT be counted as setup
    // Setup is only "Set up job" (5s) + "Run actions/checkout" (5s) = 10s of 310s = ~3%
    expect(sd.length).toBe(0);
  });
});

// Item 13: critical-path suppresses zero-duration

describe("critical-path: suppresses zero total", () => {
  it("does not report when no jobs matched audit data", () => {
    const runs: RunData[] = Array.from({ length: 5 }, (_, i) =>
      makeRun({
        id: i + 1,
        jobs: [makeJob("other-job-name", 0, 5)],
      }),
    );

    const yaml = `
name: CI
on: push
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo build
`;

    const findings = checkAudit(yaml, { runs });
    const cp = findings.filter((f) => f.rule === "critical-path");
    expect(cp.length).toBe(0);
  });
});

describe("critical-path: matches matrix legs", () => {
  it("aggregates matrix leg durations", () => {
    const runs: RunData[] = Array.from({ length: 5 }, (_, i) =>
      makeRun({
        id: i + 1,
        jobs: [
          makeJob("build (ubuntu-latest)", 0, 5),
          makeJob("build (macos-latest)", 0, 8),
          makeJob("test", 8, 12),
        ],
      }),
    );

    const yaml = `
name: CI
on: push
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - run: cargo build
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build]
    steps:
      - run: cargo test
`;

    const findings = checkAudit(yaml, { runs });
    const cp = findings.filter((f) => f.rule === "critical-path");
    expect(cp.length).toBe(1);
    expect(cp[0]!.message).toContain("build");
    expect(cp[0]!.message).not.toContain("0s");
  });
});

// Item 14: flaky-or-hanging cancelled handling

describe("flaky-or-hanging: cancel-in-progress not flagged", () => {
  it("does not flag superseded runs", () => {
    const runs: RunData[] = [
      // 8 healthy runs
      ...Array.from({ length: 8 }, (_, i) =>
        makeRun({
          id: i + 1,
          conclusion: "success",
          headSha: `sha${i}`,
          jobs: [makeJob("build", 0, 10)],
        }),
      ),
      // 4 superseded runs (whole run cancelled by cancel-in-progress)
      ...Array.from({ length: 4 }, (_, i) =>
        makeRun({
          id: i + 100,
          conclusion: "cancelled",
          headSha: `sha${i + 100}`,
          jobs: [makeJob("build", 0, 0.5, { conclusion: "cancelled" })],
        }),
      ),
    ];

    const yaml = `
name: CI
on: push
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo build
`;

    const findings = checkAudit(yaml, { runs });
    const flaky = findings.filter((f) => f.rule === "flaky-or-hanging");
    // Should not flag because: cancelled runs are from cancel-in-progress (run.conclusion = cancelled)
    // and cancelled durations are excluded from variance stats
    expect(flaky.length).toBe(0);
  });
});

describe("flaky-or-hanging: still flags genuine timeouts", () => {
  it("flags timed_out jobs when run is not cancelled", () => {
    const runs: RunData[] = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeRun({
          id: i + 1,
          conclusion: "success",
          headSha: `sha${i}`,
          jobs: [makeJob("build", 0, 10)],
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeRun({
          id: i + 100,
          conclusion: "failure",
          headSha: `sha${i + 100}`,
          jobs: [makeJob("build", 0, 60, { conclusion: "timed_out" })],
        }),
      ),
    ];

    const yaml = `
name: CI
on: push
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo build
`;

    const findings = checkAudit(yaml, { runs });
    const flaky = findings.filter((f) => f.rule === "flaky-or-hanging");
    expect(flaky.some((f) => f.message.includes("timed out"))).toBe(true);
  });
});

// Item 15: double-run-measured uses job durations

describe("double-run-measured: uses job durations", () => {
  it("reports duration from job times, not run created/updated", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const runs: RunData[] = [
      makeRun({
        id: 1,
        headSha: "abc1234567890",
        createdAt: new Date(base).toISOString(),
        updatedAt: new Date(base + 100 * 60000).toISOString(),
        jobs: [makeJob("build", 1, 6)],
      }),
      makeRun({
        id: 2,
        headSha: "abc1234567890",
        createdAt: new Date(base + 60000).toISOString(),
        updatedAt: new Date(base + 101 * 60000).toISOString(),
        jobs: [makeJob("build", 1, 6)],
      }),
    ];

    const yaml = `
name: CI
on: push
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo build
`;

    const findings = checkAudit(yaml, { runs });
    const dr = findings.filter((f) => f.rule === "double-run-measured");
    expect(dr.length).toBe(1);
    // Duration should be based on job times (5m each = 10m total)
    // not run updated_at - created_at (100m each = 200m total)
    expect(dr[0]!.message).toContain("10.0m");
  });
});

// Item 16: queue-dominated uses runStartedAt

describe("queue-dominated: uses runStartedAt for re-runs", () => {
  it("uses max(createdAt, runStartedAt)", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const runs: RunData[] = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      name: "CI",
      workflowId: 1,
      headSha: `sha${i}`,
      event: "push",
      conclusion: "success",
      createdAt: new Date(base).toISOString(),
      // runStartedAt is 9 minutes after createdAt (simulates a re-run)
      runStartedAt: new Date(base + 9 * 60000).toISOString(),
      updatedAt: new Date(base + 15 * 60000).toISOString(),
      jobs: [{
        id: i + 100,
        name: "build",
        conclusion: "success",
        createdAt: null,
        startedAt: new Date(base + 10 * 60000).toISOString(),
        completedAt: new Date(base + 15 * 60000).toISOString(),
        runnerLabel: null,
        steps: [],
      }],
    }));

    const yaml = `
name: CI
on: push
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: cargo build
`;

    const findings = checkAudit(yaml, { runs });
    const qd = findings.filter((f) => f.rule === "queue-dominated");
    // Queue time = earliest job start (10m) - max(createdAt, runStartedAt=9m) = 1m
    // Run time = 15m - 10m = 5m
    // 1m / 5m = 20% < 50% threshold, so should NOT fire
    expect(qd.length).toBe(0);
  });
});
