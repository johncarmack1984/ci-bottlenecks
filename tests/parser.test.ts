import { describe, it, expect } from "bun:test";
import { parseWorkflow, parseActionRef } from "../src/parser.ts";

describe("parseWorkflow", () => {
  it("parses a basic workflow", () => {
    const yaml = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const wf = parseWorkflow("ci.yml", yaml);
    expect(wf).not.toBeNull();
    expect(wf!.name).toBe("CI");
    expect(wf!.triggers.push).toBeDefined();
    expect(wf!.jobs.size).toBe(1);
    expect(wf!.jobs.get("build")!.steps.length).toBe(2);
  });

  it("handles string trigger", () => {
    const wf = parseWorkflow("t.yml", "name: T\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
    expect(wf!.triggers.push).toBeDefined();
  });

  it("handles array trigger", () => {
    const wf = parseWorkflow("t.yml", "name: T\non: [push, pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
    expect(wf!.triggers.push).toBeDefined();
    expect(wf!.triggers.pull_request).toBeDefined();
  });

  it("handles object trigger with branch filters", () => {
    const yaml = `
name: T
on:
  push:
    branches: [main]
  pull_request:
    branches: [main, develop]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const wf = parseWorkflow("t.yml", yaml);
    expect(wf!.triggers.push).toBeDefined();
    expect((wf!.triggers.push as any).branches).toEqual(["main"]);
    expect((wf!.triggers.pull_request as any).branches).toEqual(["main", "develop"]);
  });

  it("returns null for empty content", () => {
    expect(parseWorkflow("bad.yml", "")).toBeNull();
  });

  it("returns null for non-object YAML", () => {
    expect(parseWorkflow("bad.yml", "just a string")).toBeNull();
  });

  it("extracts job properties", () => {
    const yaml = `
name: T
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [build]
    steps:
      - run: echo hi
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const wf = parseWorkflow("t.yml", yaml);
    const test = wf!.jobs.get("test")!;
    expect(test["timeout-minutes"]).toBe(30);
    expect(test.needs).toEqual(["build"]);
    expect(test["runs-on"]).toBe("ubuntu-latest");
  });

  it("extracts matrix strategy", () => {
    const yaml = `
name: T
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu, macos]
      max-parallel: 2
      fail-fast: false
    steps:
      - run: echo hi
`;
    const wf = parseWorkflow("t.yml", yaml);
    const test = wf!.jobs.get("test")!;
    expect(test.strategy?.matrix).toBeDefined();
    expect(test.strategy?.["max-parallel"]).toBe(2);
    expect(test.strategy?.["fail-fast"]).toBe(false);
  });

  it("extracts concurrency config", () => {
    const yaml = `
name: T
on: push
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const wf = parseWorkflow("t.yml", yaml);
    expect(wf!.concurrency).toBeDefined();
    expect(wf!.concurrency!["cancel-in-progress"]).toBe(true);
  });

  it("extracts line numbers for jobs", () => {
    const yaml = `name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const wf = parseWorkflow("t.yml", yaml);
    expect(wf!.jobs.get("build")!.line).toBe(4);
  });

  it("extracts step with properties", () => {
    const yaml = `
name: T
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        with:
          path: ~/.cache
          key: my-key-\${{ hashFiles('lock') }}
`;
    const wf = parseWorkflow("t.yml", yaml);
    const step = wf!.jobs.get("a")!.steps[0]!;
    expect(step.uses).toBe("actions/cache@v4");
    expect(step.with?.path).toBe("~/.cache");
  });

  it("parses top-of-file suppression", () => {
    const yaml = `# ci-bottlenecks: ignore
name: T
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const wf = parseWorkflow("t.yml", yaml);
    expect(wf!.suppressions.workflow).toBe("all");
  });

  it("parses rule-specific top-of-file suppression", () => {
    const yaml = `# ci-bottlenecks: ignore[no-timeout]
name: T
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const wf = parseWorkflow("t.yml", yaml);
    expect(wf!.suppressions.workflow).toEqual(["no-timeout"]);
  });
});

describe("parseActionRef", () => {
  it("parses standard action ref", () => {
    const ref = parseActionRef("actions/checkout@v4");
    expect(ref.key).toBe("actions/checkout");
    expect(ref.version).toBe("v4");
    expect(ref.isLocal).toBe(false);
  });

  it("normalizes subpath actions", () => {
    const ref = parseActionRef("actions/cache/restore@v4");
    expect(ref.key).toBe("actions/cache");
    expect(ref.version).toBe("v4");
  });

  it("detects local actions", () => {
    const ref = parseActionRef("./.github/actions/my-action");
    expect(ref.isLocal).toBe(true);
  });

  it("handles SHA refs", () => {
    const ref = parseActionRef("actions/checkout@abc123def456abc123def456abc123def456abc1");
    expect(ref.version).toBe("abc123def456abc123def456abc123def456abc1");
  });

  it("handles version comment", () => {
    const ref = parseActionRef("actions/checkout@abc123 # v4");
    expect(ref.key).toBe("actions/checkout");
    expect(ref.version).toBe("v4");
  });

  it("handles docker refs", () => {
    const ref = parseActionRef("docker://node:18");
    expect(ref.isLocal).toBe(false);
    expect(ref.key).toBe("docker://node:18");
  });
});
