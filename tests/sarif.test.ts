import { describe, it, expect } from "bun:test";
import { formatSarif } from "../src/format/sarif.ts";
import { allRules } from "../src/rules/index.ts";
import type { Finding } from "../src/types.ts";

describe("SARIF output", () => {
  it("has correct schema and version", () => {
    const sarif = formatSarif([], allRules);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toContain("sarif-schema-2.1.0");
  });

  it("has correct tool name", () => {
    const sarif = formatSarif([], allRules);
    expect(sarif.runs[0]!.tool.driver.name).toBe("ci-bottlenecks");
    expect(sarif.runs[0]!.tool.driver.version).toBe("0.1.1");
  });

  it("includes all rules", () => {
    const sarif = formatSarif([], allRules);
    expect(sarif.runs[0]!.tool.driver.rules.length).toBe(allRules.length);
  });

  it("maps severity to SARIF levels", () => {
    const findings: Finding[] = [
      {
        rule: "test-high",
        severity: "high",
        tier: "static",
        workflow: "ci.yml",
        message: "high finding",
        evidence: "test",
        remediation: "fix it",
      },
      {
        rule: "test-medium",
        severity: "medium",
        tier: "static",
        workflow: "ci.yml",
        message: "medium finding",
        evidence: "test",
        remediation: "fix it",
      },
      {
        rule: "test-low",
        severity: "low",
        tier: "static",
        workflow: "ci.yml",
        message: "low finding",
        evidence: "test",
        remediation: "fix it",
      },
      {
        rule: "test-info",
        severity: "info",
        tier: "static",
        workflow: "ci.yml",
        message: "info finding",
        evidence: "test",
        remediation: "fix it",
      },
    ];

    const sarif = formatSarif(findings, allRules);
    const results = sarif.runs[0]!.results;
    expect(results[0]!.level).toBe("error");
    expect(results[1]!.level).toBe("warning");
    expect(results[2]!.level).toBe("note");
    expect(results[3]!.level).toBe("note");
  });

  it("includes location when available", () => {
    const findings: Finding[] = [
      {
        rule: "no-timeout",
        severity: "medium",
        tier: "static",
        workflow: "ci.yml",
        job: "build",
        location: { line: 10 },
        message: "test",
        evidence: "test",
        remediation: "fix it",
      },
    ];
    const sarif = formatSarif(findings, allRules);
    const loc = sarif.runs[0]!.results[0]!.locations![0]!;
    expect(loc.physicalLocation.artifactLocation.uri).toBe("ci.yml");
    expect(loc.physicalLocation.region?.startLine).toBe(10);
  });
});
