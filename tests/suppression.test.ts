import { describe, it, expect } from "bun:test";
import { parseWorkflow } from "../src/parser.ts";
import { runRules } from "../src/runner.ts";
import { allRules } from "../src/rules/index.ts";
import type { Finding } from "../src/types.ts";

function check(yaml: string): Finding[] {
  const wf = parseWorkflow("test.yml", yaml);
  if (!wf) throw new Error("Failed to parse YAML");
  return runRules(allRules, [wf], { audit: false, pedantic: false });
}

describe("suppression", () => {
  it("top-of-file ignore suppresses all findings", () => {
    const f = check(`# ci-bottlenecks: ignore
name: T
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
`);
    expect(f.length).toBe(0);
  });

  it("top-of-file ignore[rule] suppresses only that rule", () => {
    const f = check(`# ci-bottlenecks: ignore[no-timeout]
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(f.some((finding) => finding.rule === "no-timeout")).toBe(false);
    expect(f.length).toBeGreaterThan(0);
  });

  it("non-matching suppression does not block other rules", () => {
    const f = check(`# ci-bottlenecks: ignore[double-trigger]
name: T
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(f.some((finding) => finding.rule === "no-timeout")).toBe(true);
    expect(f.some((finding) => finding.rule === "no-concurrency")).toBe(true);
  });

  it("job-level suppression works", () => {
    const yaml = `name: T
on: push
jobs:
  build: # ci-bottlenecks: ignore[no-timeout]
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const wf = parseWorkflow("test.yml", yaml);
    const f = runRules(allRules, [wf!], { audit: false, pedantic: false });
    expect(f.some((finding) => finding.rule === "no-timeout")).toBe(false);
  });
});
