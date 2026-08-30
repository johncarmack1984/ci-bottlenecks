import { getInput, getBooleanInput, setOutput, warning, info, setFailed, summary } from "./actions-shim.ts";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { parseWorkflow } from "./parser.ts";
import { runRules } from "./runner.ts";
import { allRules } from "./rules/index.ts";
import { formatText } from "./format/text.ts";
import { formatSarif } from "./format/sarif.ts";
import { formatSummary } from "./format/summary.ts";
import { discoverWorkflows, loadAuditData } from "./shared.ts";
import type { Severity, WorkflowAuditData } from "./types.ts";

async function run() {
  const basePath = getInput("path") || ".";
  const audit = getBooleanInput("audit");
  const pedantic = getBooleanInput("pedantic");
  const maxRuns = parseInt(getInput("runs") || "25", 10);
  const failOn = (getInput("fail-on") || "none") as Severity | "none";
  const formats = (getInput("format") || "text,summary,sarif")
    .split(",")
    .map((s) => s.trim());
  const token = getInput("token");

  if (token) {
    process.env.GITHUB_TOKEN = token;
  }

  const workflowFiles = discoverWorkflows(basePath);
  if (workflowFiles.length === 0) {
    warning(
      `No workflow files found in ${join(basePath, ".github/workflows")}`,
    );
    setOutput("findings", "0");
    return;
  }

  const workflows = workflowFiles.map((file) => {
    const source = readFileSync(file, "utf-8");
    const relPath = relative(basePath, file);
    return parseWorkflow(relPath, source);
  }).filter((wf) => wf != null);

  let auditDataByWorkflow: Map<string, WorkflowAuditData> | undefined;

  if (audit) {
    const nwo = process.env.GITHUB_REPOSITORY;
    if (nwo) {
      if (!token) {
        warning("audit mode requested but no token provided, skipping audit.");
      } else {
        info(`Auditing ${nwo} (${maxRuns} runs max)...`);
        auditDataByWorkflow = await loadAuditData(nwo, workflows, maxRuns);
      }
    } else {
      warning("GITHUB_REPOSITORY not set, skipping audit.");
    }
  }

  const findings = runRules(allRules, workflows, {
    audit,
    pedantic,
    auditDataByWorkflow,
  });

  setOutput("findings", String(findings.length));

  if (formats.includes("text")) {
    info(formatText(findings));
  }

  if (formats.includes("summary")) {
    const md = formatSummary(findings);
    summary.addRaw(md);
    await summary.write();
  }

  if (formats.includes("sarif")) {
    const sarif = formatSarif(findings, allRules);
    const sarifDir = basePath === "." ? "" : basePath;
    const sarifPath = sarifDir ? join(sarifDir, "ci-bottlenecks.sarif") : "ci-bottlenecks.sarif";
    if (sarifDir) mkdirSync(sarifDir, { recursive: true });
    writeFileSync(sarifPath, JSON.stringify(sarif, null, 2));
    setOutput("sarif-path", sarifPath);
    info(`SARIF written to ${sarifPath}`);
  }

  const SEVERITY_ORDER: Record<Severity, number> = {
    high: 0,
    medium: 1,
    low: 2,
    info: 3,
  };

  const hasAboveThreshold = failOn !== "none" && findings.some(
    (f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[failOn as Severity],
  );

  if (hasAboveThreshold) {
    setFailed(
      `${findings.length} finding(s) at or above "${failOn}" severity`,
    );
  }
}

run().catch((e) => {
  setFailed(`ci-bottlenecks failed: ${e.message}`);
});
