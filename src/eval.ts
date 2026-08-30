import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, relative } from "path";
import { parseWorkflow } from "./parser.ts";
import { runRules } from "./runner.ts";
import { allRules } from "./rules/index.ts";
import type { Finding, ParsedWorkflow } from "./types.ts";

const CODING = join(import.meta.dir, "..", "..", "..");

function discoverWorkflows(): Array<{ path: string; relPath: string }> {
  const results: Array<{ path: string; relPath: string }> = [];

  for (const org of readdirSync(CODING)) {
    if (org.startsWith(".")) continue;
    const orgPath = join(CODING, org);
    try {
      if (!statSync(orgPath).isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      for (const repo of readdirSync(orgPath)) {
        if (repo.startsWith(".")) continue;
        const repoPath = join(orgPath, repo);
        try {
          if (!statSync(repoPath).isDirectory()) continue;
        } catch {
          continue;
        }
        const wfDir = join(repoPath, ".github", "workflows");
        if (!existsSync(wfDir)) continue;
        try {
          for (const file of readdirSync(wfDir)) {
            if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
            const fullPath = join(wfDir, file);
            results.push({
              path: fullPath,
              relPath: relative(CODING, fullPath),
            });
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}

function main() {
  console.log("\n  ci-bottlenecks eval — static tier over local estate\n");

  const workflowFiles = discoverWorkflows();
  console.log(`  Found ${workflowFiles.length} workflow files\n`);

  const workflows: ParsedWorkflow[] = [];
  let parseErrors = 0;
  for (const wf of workflowFiles) {
    try {
      const source = readFileSync(wf.path, "utf-8");
      const parsed = parseWorkflow(wf.relPath, source);
      if (parsed) workflows.push(parsed);
      else parseErrors++;
    } catch {
      parseErrors++;
    }
  }

  if (parseErrors > 0) {
    console.log(`  (${parseErrors} files failed to parse)\n`);
  }

  const staticRules = allRules.filter((r) => r.tier === "static");
  const findings = runRules(staticRules, workflows, {
    audit: false,
    pedantic: true,
  });

  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const group = byRule.get(f.rule) ?? [];
    group.push(f);
    byRule.set(f.rule, group);
  }

  const sorted = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log("  Rule                         Count  Severity");
  console.log("  " + "─".repeat(55));
  for (const [rule, group] of sorted) {
    const ruleObj = staticRules.find((r) => r.id === rule);
    const severity = ruleObj?.severity ?? "?";
    const pedantic = ruleObj?.pedantic ? " (pedantic)" : "";
    console.log(
      `  ${(rule + pedantic).padEnd(30)} ${String(group.length).padStart(5)}  ${severity}`,
    );
  }
  console.log("  " + "─".repeat(55));
  console.log(
    `  Total: ${findings.length} findings across ${workflows.length} workflows\n`,
  );

  const byWorkflow = new Map<string, number>();
  for (const f of findings) {
    byWorkflow.set(f.workflow, (byWorkflow.get(f.workflow) ?? 0) + 1);
  }
  const noisiest = [...byWorkflow.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (noisiest.length > 0) {
    console.log("  Noisiest workflows:");
    for (const [wf, count] of noisiest) {
      console.log(`    ${wf}: ${count}`);
    }
    console.log("");
  }
}

main();
