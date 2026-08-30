import { describe, it, expect } from "bun:test";
import { computeCriticalPath } from "../src/dag.ts";
import type { DagNode } from "../src/dag.ts";

describe("computeCriticalPath", () => {
  it("finds critical path in linear chain", () => {
    const nodes: DagNode[] = [
      { jobId: "a", duration: 100, needs: [] },
      { jobId: "b", duration: 200, needs: ["a"] },
      { jobId: "c", duration: 150, needs: ["b"] },
    ];
    const result = computeCriticalPath(nodes);
    expect(result.path).toEqual(["a", "b", "c"]);
    expect(result.totalDuration).toBe(450);
  });

  it("finds critical path in diamond DAG", () => {
    const nodes: DagNode[] = [
      { jobId: "a", duration: 100, needs: [] },
      { jobId: "b", duration: 300, needs: ["a"] },
      { jobId: "c", duration: 50, needs: ["a"] },
      { jobId: "d", duration: 100, needs: ["b", "c"] },
    ];
    const result = computeCriticalPath(nodes);
    expect(result.path).toEqual(["a", "b", "d"]);
    expect(result.totalDuration).toBe(500);
    expect(result.slack.get("c")).toBeGreaterThan(0);
  });

  it("handles independent jobs", () => {
    const nodes: DagNode[] = [
      { jobId: "a", duration: 100, needs: [] },
      { jobId: "b", duration: 200, needs: [] },
      { jobId: "c", duration: 150, needs: [] },
    ];
    const result = computeCriticalPath(nodes);
    expect(result.path).toEqual(["b"]);
    expect(result.totalDuration).toBe(200);
  });

  it("handles single job", () => {
    const nodes: DagNode[] = [
      { jobId: "only", duration: 500, needs: [] },
    ];
    const result = computeCriticalPath(nodes);
    expect(result.path).toEqual(["only"]);
    expect(result.totalDuration).toBe(500);
  });

  it("computes slack correctly", () => {
    const nodes: DagNode[] = [
      { jobId: "build", duration: 300, needs: [] },
      { jobId: "lint", duration: 100, needs: [] },
      { jobId: "deploy", duration: 50, needs: ["build", "lint"] },
    ];
    const result = computeCriticalPath(nodes);
    expect(result.path).toEqual(["build", "deploy"]);
    expect(result.slack.get("lint")).toBe(200);
    expect(result.slack.get("build")).toBe(0);
  });
});
