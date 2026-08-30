import { readdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { parseWorkflow } from "./parser.ts";
import { runRules } from "./runner.ts";
import { allRules } from "./rules/index.ts";
import type { Finding, ParsedWorkflow, WorkflowAuditData } from "./types.ts";

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
  yaml: string;
  timingData?: WorkflowAuditData;
}

interface RuleScore {
  rule: string;
  total: number;
  passed: number;
  failed: number;
  tp: { total: number; hit: number };
  fp: { total: number; guarded: number };
  fn: number;
  miss: number;
  xfail: number;
  xpass: number;
  precision: number | null;
  recall: number | null;
}

function parseManifest(source: string): { manifests: EvalManifest[]; why: string } {
  const manifests: EvalManifest[] = [];
  let why = "";

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
  }

  return { manifests, why };
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
      const { manifests, why } = parseManifest(yaml);
      if (manifests.length === 0) continue;

      const timingBase = file.replace(/\.ya?ml$/, ".timing.json");
      const timingPath = join(ruleDir, timingBase);
      let timingData: WorkflowAuditData | undefined;
      if (existsSync(timingPath)) {
        try {
          timingData = JSON.parse(readFileSync(timingPath, "utf-8"));
        } catch { /* skip */ }
      }

      cases.push({ path: filePath, manifests, why, yaml, timingData });
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
  } catch { /* no siblings */ }

  const opts: Parameters<typeof runRules>[2] = {
    audit: isAudit,
    pedantic: hasPedantic,
  };

  if (isAudit && evalCase.timingData) {
    opts.auditDataByWorkflow = new Map([[evalCase.path, evalCase.timingData]]);
  }

  return runRules(allRules, allWorkflows, opts).filter((f) => f.workflow === evalCase.path);
}

function main() {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes("--json");

  const casesDir = join(import.meta.dir, "..", "tests", "eval", "cases");
  const allCases = discoverCases(casesDir);

  if (allCases.length === 0) {
    console.error("No eval cases found in tests/eval/cases/");
    process.exit(2);
  }

  const scores = new Map<string, RuleScore>();

  function getScore(rule: string): RuleScore {
    if (!scores.has(rule)) {
      scores.set(rule, {
        rule,
        total: 0,
        passed: 0,
        failed: 0,
        tp: { total: 0, hit: 0 },
        fp: { total: 0, guarded: 0 },
        fn: 0,
        miss: 0,
        xfail: 0,
        xpass: 0,
        precision: null,
        recall: null,
      });
    }
    return scores.get(rule)!;
  }

  const failures: { path: string; rule: string; expected: string; got: string; why: string }[] = [];
  const xpasses: { path: string; rule: string; why: string }[] = [];
  let totalXfail = 0;

  for (const evalCase of allCases) {
    const findings = runCase(evalCase);
    const relPath = evalCase.path.replace(casesDir + "/", "");

    for (const manifest of evalCase.manifests) {
      const score = getScore(manifest.rule);
      const ruleFindings = findings.filter((f) => f.rule === manifest.rule);
      const fired = ruleFindings.length > 0;
      const expected = manifest.expect === "fire";

      score.total++;

      if (manifest.kind === "tp") score.tp.total++;
      if (manifest.kind === "fp") score.fp.total++;
      if (manifest.kind === "fn") score.fn++;
      if (manifest.kind === "miss") score.miss++;

      if (manifest.status === "xfail") {
        const passed = fired === expected;
        if (passed) {
          score.xpass++;
          xpasses.push({ path: relPath, rule: manifest.rule, why: evalCase.why });
        } else {
          score.xfail++;
          totalXfail++;
        }
        continue;
      }

      const passed = fired === expected;
      if (passed) {
        score.passed++;
        if (manifest.kind === "tp") score.tp.hit++;
        if (manifest.kind === "fp") score.fp.guarded++;
      } else {
        score.failed++;
        failures.push({
          path: relPath,
          rule: manifest.rule,
          expected: manifest.expect,
          got: fired ? `fired (${ruleFindings.length})` : "silent",
          why: evalCase.why,
        });
      }
    }
  }

  for (const score of scores.values()) {
    const truePositives = score.tp.hit;
    const falsePositives = score.fp.total - score.fp.guarded;
    const falseNegatives = score.tp.total - score.tp.hit;

    if (truePositives + falsePositives > 0) {
      score.precision = truePositives / (truePositives + falsePositives);
    }
    if (truePositives + falseNegatives > 0) {
      score.recall = truePositives / (truePositives + falseNegatives);
    }
  }

  const sortedScores = [...scores.values()].sort((a, b) => a.rule.localeCompare(b.rule));

  if (!jsonFlag) {
    console.log("\n=== ci-bottlenecks eval scorecard ===\n");
    console.log(
      "Rule".padEnd(25) +
      "Cases".padStart(6) +
      "Pass".padStart(6) +
      "Fail".padStart(6) +
      "TP hit".padStart(8) +
      "FP guard".padStart(9) +
      "FN".padStart(5) +
      "Miss".padStart(6) +
      "XFail".padStart(7) +
      "XPass".padStart(7) +
      "Prec".padStart(7) +
      "Recall".padStart(8),
    );
    console.log("-".repeat(103));

    for (const s of sortedScores) {
      const prec = s.precision != null ? `${(s.precision * 100).toFixed(0)}%` : "-";
      const rec = s.recall != null ? `${(s.recall * 100).toFixed(0)}%` : "-";
      console.log(
        s.rule.padEnd(25) +
        String(s.total).padStart(6) +
        String(s.passed).padStart(6) +
        String(s.failed).padStart(6) +
        `${s.tp.hit}/${s.tp.total}`.padStart(8) +
        `${s.fp.guarded}/${s.fp.total}`.padStart(9) +
        String(s.fn).padStart(5) +
        String(s.miss).padStart(6) +
        String(s.xfail).padStart(7) +
        String(s.xpass).padStart(7) +
        prec.padStart(7) +
        rec.padStart(8),
      );
    }

    const totals = sortedScores.reduce(
      (acc, s) => ({
        total: acc.total + s.total,
        passed: acc.passed + s.passed,
        failed: acc.failed + s.failed,
        tpHit: acc.tpHit + s.tp.hit,
        tpTotal: acc.tpTotal + s.tp.total,
        fpGuarded: acc.fpGuarded + s.fp.guarded,
        fpTotal: acc.fpTotal + s.fp.total,
        fn: acc.fn + s.fn,
        miss: acc.miss + s.miss,
        xfail: acc.xfail + s.xfail,
        xpass: acc.xpass + s.xpass,
      }),
      { total: 0, passed: 0, failed: 0, tpHit: 0, tpTotal: 0, fpGuarded: 0, fpTotal: 0, fn: 0, miss: 0, xfail: 0, xpass: 0 },
    );

    console.log("-".repeat(103));
    console.log(
      "TOTAL".padEnd(25) +
      String(totals.total).padStart(6) +
      String(totals.passed).padStart(6) +
      String(totals.failed).padStart(6) +
      `${totals.tpHit}/${totals.tpTotal}`.padStart(8) +
      `${totals.fpGuarded}/${totals.fpTotal}`.padStart(9) +
      String(totals.fn).padStart(5) +
      String(totals.miss).padStart(6) +
      String(totals.xfail).padStart(7) +
      String(totals.xpass).padStart(7),
    );

    if (failures.length > 0) {
      console.log("\n=== FAILURES ===\n");
      for (const f of failures) {
        console.log(`  FAIL ${f.path}`);
        console.log(`    rule: ${f.rule}, expected: ${f.expected}, got: ${f.got}`);
        console.log(`    why: ${f.why}`);
      }
    }

    if (xpasses.length > 0) {
      console.log("\n=== XPASS (promote these) ===\n");
      for (const x of xpasses) {
        console.log(`  XPASS ${x.path}`);
        console.log(`    rule: ${x.rule}`);
        console.log(`    why: ${x.why}`);
      }
    }

    console.log(`\nTotal: ${totals.total} cases, ${totals.passed} passed, ${totals.failed} failed, ${totals.xfail} xfail, ${totals.xpass} xpass`);
  }

  const scorecardPath = join(import.meta.dir, "..", "tests", "eval", "scorecard.json");
  const scorecardData = {
    generated: new Date().toISOString(),
    rules: sortedScores.map((s) => ({
      rule: s.rule,
      cases: s.total,
      passed: s.passed,
      failed: s.failed,
      tp: s.tp,
      fp: s.fp,
      fn: s.fn,
      miss: s.miss,
      xfail: s.xfail,
      xpass: s.xpass,
      precision: s.precision,
      recall: s.recall,
    })),
  };

  if (jsonFlag) {
    console.log(JSON.stringify(scorecardData, null, 2));
  }

  writeFileSync(scorecardPath, JSON.stringify(scorecardData, null, 2) + "\n");

  if (failures.length > 0) {
    process.exit(1);
  }
  if (xpasses.length > 0) {
    console.error(`\n${xpasses.length} xfail case(s) now pass — promote them by removing status=xfail`);
    process.exit(1);
  }
}

main();
