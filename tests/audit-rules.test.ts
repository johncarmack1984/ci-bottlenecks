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
    startedAt: new Date(base + startMin * 60000).toISOString(),
    completedAt: new Date(base + endMin * 60000).toISOString(),
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


describe("critical-path", () => {
  it("finds critical path with measured data", () => {
    const runs: RunData[] = Array.from({ length: 5 }, (_, i) =>
      makeRun({
        id: i + 1,
        jobs: [
          makeJob("build", 0, 5),
          makeJob("test", 5, 8),
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
    expect(cp[0]!.message).toContain("test");
  });
});

describe("flaky-or-hanging", () => {
  it("flags job with high variance", () => {
    const runs: RunData[] = [];
    for (let i = 0; i < 10; i++) {
      const duration = i < 8 ? 3 : 30;
      runs.push(
        makeRun({
          id: i + 1,
          jobs: [makeJob("build", 0, duration)],
        }),
      );
    }

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
    expect(flaky.length).toBeGreaterThan(0);
  });

  it("flags cancelled jobs", () => {
    const runs: RunData[] = [
      makeRun({
        id: 1,
        jobs: [makeJob("build", 0, 5, { conclusion: "cancelled" })],
      }),
      ...Array.from({ length: 4 }, (_, i) =>
        makeRun({
          id: i + 2,
          jobs: [makeJob("build", 0, 5)],
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
    expect(flaky.length).toBeGreaterThan(0);
    expect(flaky.some((f) => f.message.includes("cancelled"))).toBe(true);
  });
});

describe("queue-dominated", () => {
  it("flags when queue time exceeds run time", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const runs: RunData[] = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      name: "CI",
      workflowId: 1,
      headSha: `sha${i}`,
      conclusion: "success",
      createdAt: new Date(base).toISOString(),
      runStartedAt: new Date(base).toISOString(),
      updatedAt: new Date(base + 15 * 60000).toISOString(),
      jobs: [
        {
          id: i + 100,
          name: "build",
          conclusion: "success",
          startedAt: new Date(base + 10 * 60000).toISOString(),
          completedAt: new Date(base + 15 * 60000).toISOString(),
          steps: [],
        },
      ],
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
    expect(qd.length).toBe(1);
  });
});

describe("setup-dominated", () => {
  it("flags when setup steps exceed 50% of job time", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const makeSteps = (): StepData[] => [
      {
        name: "Set up job",
        number: 1,
        status: "completed",
        conclusion: "success",
        startedAt: new Date(base).toISOString(),
        completedAt: new Date(base + 60_000).toISOString(),
      },
      {
        name: "Checkout",
        number: 2,
        status: "completed",
        conclusion: "success",
        startedAt: new Date(base + 60_000).toISOString(),
        completedAt: new Date(base + 120_000).toISOString(),
      },
      {
        name: "Setup Node",
        number: 3,
        status: "completed",
        conclusion: "success",
        startedAt: new Date(base + 120_000).toISOString(),
        completedAt: new Date(base + 210_000).toISOString(),
      },
      {
        name: "Run tests",
        number: 4,
        status: "completed",
        conclusion: "success",
        startedAt: new Date(base + 210_000).toISOString(),
        completedAt: new Date(base + 300_000).toISOString(),
      },
    ];

    const runs: RunData[] = Array.from({ length: 3 }, (_, i) =>
      makeRun({
        id: i + 1,
        headSha: `sha${i}`,
        jobs: [
          {
            id: i + 100,
            name: "build",
            conclusion: "success",
            startedAt: new Date(base).toISOString(),
            completedAt: new Date(base + 300_000).toISOString(),
            steps: makeSteps(),
          },
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
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm test
`;

    const findings = checkAudit(yaml, { runs });
    const sd = findings.filter((f) => f.rule === "setup-dominated");
    expect(sd.length).toBe(1);
    expect(sd[0]!.message).toContain("build");
    expect(sd[0]!.message).toContain("%");
  });

  it("does not flag when setup is under 50%", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const makeSteps = (): StepData[] => [
      {
        name: "Set up job",
        number: 1,
        status: "completed",
        conclusion: "success",
        startedAt: new Date(base).toISOString(),
        completedAt: new Date(base + 10_000).toISOString(),
      },
      {
        name: "Run tests",
        number: 4,
        status: "completed",
        conclusion: "success",
        startedAt: new Date(base + 10_000).toISOString(),
        completedAt: new Date(base + 300_000).toISOString(),
      },
    ];

    const runs: RunData[] = Array.from({ length: 3 }, (_, i) =>
      makeRun({
        id: i + 1,
        headSha: `sha${i}`,
        jobs: [
          {
            id: i + 100,
            name: "build",
            conclusion: "success",
            startedAt: new Date(base).toISOString(),
            completedAt: new Date(base + 300_000).toISOString(),
            steps: makeSteps(),
          },
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
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

    const findings = checkAudit(yaml, { runs });
    const sd = findings.filter((f) => f.rule === "setup-dominated");
    expect(sd.length).toBe(0);
  });
});

describe("double-run-measured", () => {
  it("flags same SHA runs within 5 minutes", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const runs: RunData[] = [
      makeRun({
        id: 1,
        headSha: "abc1234567890",
        createdAt: new Date(base).toISOString(),
        updatedAt: new Date(base + 5 * 60000).toISOString(),
        jobs: [makeJob("build", 0, 5)],
      }),
      makeRun({
        id: 2,
        headSha: "abc1234567890",
        createdAt: new Date(base + 60000).toISOString(),
        updatedAt: new Date(base + 6 * 60000).toISOString(),
        jobs: [makeJob("build", 0, 5)],
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
    expect(dr[0]!.estimatedSavings?.confidence).toBe("exact");
  });
});
