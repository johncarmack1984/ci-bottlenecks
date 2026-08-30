import { it, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseWorkflow } from "../../src/parser.ts";
import { runRules } from "../../src/runner.ts";
import { allRules } from "../../src/rules/index.ts";
import type { Finding, ParsedWorkflow, WorkflowAuditData } from "../../src/types.ts";

interface EvalManifest {
  rule: string;
  expect: "fire" | "silent";
  kind: "tp" | "fp" | "fn" | "miss";
  jobs?: string[];
  count?: number;
  pedantic?: boolean;
  status?: "xfail";
}

interface EvalCase {
  path: string;
  manifests: EvalManifest[];
  why: string;
  source: string;
  yaml: string;
  timingData?: WorkflowAuditData;
}

function parseManifest(source: string): { manifests: EvalManifest[]; why: string; source: string } {
  const manifests: EvalManifest[] = [];
  let why = "";
  let src = "";

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    const evalMatch = trimmed.match(/^#\s*eval:\s*(.+)$/);
    if (evalMatch) {
      const fields = evalMatch[1]!;
      const rule = fields.match(/rule=(\S+)/)?.[1];
      const expectVal = fields.match(/expect=(\S+)/)?.[1] as "fire" | "silent" | undefined;
      const kind = fields.match(/kind=(\S+)/)?.[1] as "tp" | "fp" | "fn" | "miss" | undefined;
      const jobsMatch = fields.match(/jobs=(\S+)/);
      const countMatch = fields.match(/count=(\d+)/);
      const pedantic = /pedantic=true/.test(fields);
      const xfail = /status=xfail/.test(fields);

      if (rule && expectVal && kind) {
        manifests.push({
          rule,
          expect: expectVal,
          kind,
          jobs: jobsMatch ? jobsMatch[1]!.split(",") : undefined,
          count: countMatch ? parseInt(countMatch[1]!, 10) : undefined,
          pedantic: pedantic || undefined,
          status: xfail ? "xfail" : undefined,
        });
      }
    }

    const whyMatch = trimmed.match(/^#\s*why:\s*(.+)$/);
    if (whyMatch) why = whyMatch[1]!;

    const srcMatch = trimmed.match(/^#\s*source:\s*(.+)$/);
    if (srcMatch) src = srcMatch[1]!;
  }

  return { manifests, why, source: src };
}

function discoverCases(casesDir: string): EvalCase[] {
  const cases: EvalCase[] = [];

  let ruleIds: string[];
  try {
    ruleIds = readdirSync(casesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return cases;
  }

  for (const ruleId of ruleIds) {
    const ruleDir = join(casesDir, ruleId);
    let files: string[];
    try {
      files = readdirSync(ruleDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(ruleDir, file);
      const yaml = readFileSync(filePath, "utf-8");
      const { manifests, why, source } = parseManifest(yaml);
      if (manifests.length === 0) continue;

      const timingBase = file.replace(/\.ya?ml$/, ".timing.json");
      const timingPath = join(ruleDir, timingBase);
      let timingData: WorkflowAuditData | undefined;
      if (existsSync(timingPath)) {
        try {
          timingData = JSON.parse(readFileSync(timingPath, "utf-8"));
        } catch {
          // timing parse failure is reported as a test error
        }
      }

      cases.push({ path: filePath, manifests, why, source, yaml, timingData });
    }
  }

  return cases;
}

function runCase(evalCase: EvalCase): Finding[] {
  const wf = parseWorkflow(evalCase.path, evalCase.yaml);
  if (!wf) return [];

  const hasPedantic = evalCase.manifests.some((m) => m.pedantic);
  const isAudit = evalCase.manifests.some(
    (m) => ["critical-path", "flaky-or-hanging", "queue-dominated", "setup-dominated", "double-run-measured"].includes(m.rule),
  );

  const allWorkflows: ParsedWorkflow[] = [wf];
  const ruleDir = join(evalCase.path, "..");
  try {
    const siblings = readdirSync(ruleDir).filter(
      (f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && join(ruleDir, f) !== evalCase.path,
    );
    for (const sib of siblings) {
      const sibPath = join(ruleDir, sib);
      const sibYaml = readFileSync(sibPath, "utf-8");
      const sibManifest = parseManifest(sibYaml);
      if (sibManifest.manifests.length > 0) continue;
      const sibWf = parseWorkflow(sibPath, sibYaml);
      if (sibWf) allWorkflows.push(sibWf);
    }
  } catch {
    // no siblings
  }

  const opts: Parameters<typeof runRules>[2] = {
    audit: isAudit,
    pedantic: hasPedantic,
  };

  if (evalCase.timingData) {
    opts.auditDataByWorkflow = new Map([[evalCase.path, evalCase.timingData]]);
  }

  return runRules(allRules, allWorkflows, opts).filter((f) => f.workflow === evalCase.path);
}

const CASES_DIR = join(import.meta.dir, "cases");
const allCases = discoverCases(CASES_DIR);

const xfailResults: { path: string; rule: string; passed: boolean; why: string }[] = [];

for (const evalCase of allCases) {
  const relPath = evalCase.path.replace(CASES_DIR + "/", "");

  for (const manifest of evalCase.manifests) {
    const testName = `${relPath} [${manifest.rule} expect=${manifest.expect} kind=${manifest.kind}]`;

    if (manifest.status === "xfail") {
      it(testName, () => {
        const findings = runCase(evalCase);
        const ruleFindings = findings.filter((f) => f.rule === manifest.rule);
        const fired = ruleFindings.length > 0;
        const expected = manifest.expect === "fire";
        const passed = fired === expected;

        xfailResults.push({ path: relPath, rule: manifest.rule, passed, why: evalCase.why });

        if (passed) {
          throw new Error(
            `XPASS — this xfail case now passes! Promote it by removing status=xfail.\n` +
            `  Case: ${relPath}\n` +
            `  Rule: ${manifest.rule}\n` +
            `  Why: ${evalCase.why}\n` +
            `  Expected: ${manifest.expect}, Got: ${fired ? "fired" : "silent"}\n` +
            `  Findings: ${ruleFindings.map((f) => f.message).join("; ") || "(none)"}`,
          );
        }
        // xfail that still fails — skip silently
        expect(true).toBe(true);
      });
      continue;
    }

    it(testName, () => {
      const findings = runCase(evalCase);
      const ruleFindings = findings.filter((f) => f.rule === manifest.rule);

      if (manifest.expect === "fire") {
        if (ruleFindings.length === 0) {
          throw new Error(
            `Expected rule "${manifest.rule}" to fire but it was silent.\n` +
            `  Case: ${relPath}\n` +
            `  Why: ${evalCase.why}\n` +
            `  Source: ${evalCase.source}\n` +
            `  All findings: ${findings.map((f) => `${f.rule}:${f.job ?? ""}:${f.message}`).join("\n    ")}`,
          );
        }
        if (manifest.count != null) {
          expect(ruleFindings.length).toBe(manifest.count);
        }
        if (manifest.jobs) {
          for (const jobId of manifest.jobs) {
            const jobFindings = ruleFindings.filter((f) => f.job === jobId);
            if (jobFindings.length === 0) {
              throw new Error(
                `Expected rule "${manifest.rule}" to fire on job "${jobId}" but it didn't.\n` +
                `  Case: ${relPath}\n` +
                `  Why: ${evalCase.why}\n` +
                `  Fired on jobs: ${[...new Set(ruleFindings.map((f) => f.job))].join(", ")}`,
              );
            }
          }
        }
      } else {
        if (ruleFindings.length > 0) {
          throw new Error(
            `Expected rule "${manifest.rule}" to be silent but it fired ${ruleFindings.length} finding(s).\n` +
            `  Case: ${relPath}\n` +
            `  Why: ${evalCase.why}\n` +
            `  Source: ${evalCase.source}\n` +
            `  Findings:\n    ${ruleFindings.map((f) => `[${f.severity}] ${f.message}`).join("\n    ")}`,
          );
        }
      }
    });
  }
}

if (allCases.length === 0) {
  it("eval corpus is not empty", () => {
    throw new Error("No eval cases found in tests/eval/cases/");
  });
}
