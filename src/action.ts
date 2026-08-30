import * as core from "@actions/core";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { parseWorkflow } from "./parser.ts";
import { runRules } from "./runner.ts";
import { allRules } from "./rules/index.ts";
import { formatText } from "./format/text.ts";
import { formatSarif } from "./format/sarif.ts";
import { formatSummary } from "./format/summary.ts";
import { fetchRuns, fetchJobsForRun } from "./api.ts";
import { cachedFetch, DEFAULT_CACHE_DIR } from "./cache.ts";
import type { Severity, ParsedWorkflow, WorkflowAuditData, RunData } from "./types.ts";

function discoverWorkflows(basePath: string): string[] {
  const wfDir = join(basePath, ".github", "workflows");
  if (!existsSync(wfDir)) return [];
  try {
    return readdirSync(wfDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => join(wfDir, f));
  } catch {
    return [];
  }
}

async function loadAuditData(
  nwo: string,
  workflows: ParsedWorkflow[],
  maxRuns: number,
): Promise<Map<string, WorkflowAuditData>> {
  const cacheDir = DEFAULT_CACHE_DIR;
  const map = new Map<string, WorkflowAuditData>();

  const runs = await cachedFetch(
    cacheDir,
    `${nwo.replace("/", "_")}/runs`,
    60 * 60 * 1000,
    () => fetchRuns(nwo, maxRuns),
  );

  const enrichedRuns: RunData[] = [];
  for (const run of runs.slice(0, maxRuns)) {
    const jobs = await cachedFetch(
      cacheDir,
      `${nwo.replace("/", "_")}/jobs/${run.id}`,
      0,
      () => fetchJobsForRun(nwo, run.id),
    );
    enrichedRuns.push({ ...run, jobs });
  }

  for (const wf of workflows) {
    const wfRuns = enrichedRuns.filter((r) => {
      const wfFileName = wf.path.split("/").pop()?.replace(/\.ya?ml$/, "");
      return r.name === wf.name || r.name === wfFileName;
    });
    if (wfRuns.length > 0) {
      map.set(wf.path, { runs: wfRuns });
    }
  }

  return map;
}

async function run() {
  const basePath = core.getInput("path") || ".";
  const audit = core.getBooleanInput("audit");
  const pedantic = core.getBooleanInput("pedantic");
  const maxRuns = parseInt(core.getInput("runs") || "50", 10);
  const failOn = (core.getInput("fail-on") || "high") as Severity;
  const formats = (core.getInput("format") || "text,summary,sarif")
    .split(",")
    .map((s) => s.trim());
  const token = core.getInput("token");

  if (token) {
    process.env.GITHUB_TOKEN = token;
  }

  const workflowFiles = discoverWorkflows(basePath);
  if (workflowFiles.length === 0) {
    core.warning(
      `No workflow files found in ${join(basePath, ".github/workflows")}`,
    );
    core.setOutput("findings", "0");
    return;
  }

  const workflows: ParsedWorkflow[] = [];
  for (const file of workflowFiles) {
    const source = readFileSync(file, "utf-8");
    const relPath = relative(basePath, file);
    const parsed = parseWorkflow(relPath, source);
    if (parsed) workflows.push(parsed);
  }

  let auditDataByWorkflow: Map<string, WorkflowAuditData> | undefined;

  if (audit) {
    const nwo = process.env.GITHUB_REPOSITORY;
    if (nwo) {
      core.info(`Auditing ${nwo} (${maxRuns} runs max)...`);
      auditDataByWorkflow = await loadAuditData(nwo, workflows, maxRuns);
    } else {
      core.warning("GITHUB_REPOSITORY not set, skipping audit.");
    }
  }

  const findings = runRules(allRules, workflows, {
    audit,
    pedantic,
    auditDataByWorkflow,
  });

  core.setOutput("findings", String(findings.length));

  if (formats.includes("text")) {
    core.info(formatText(findings));
  }

  if (formats.includes("summary")) {
    const md = formatSummary(findings);
    core.summary.addRaw(md);
    await core.summary.write();
  }

  if (formats.includes("sarif")) {
    const sarif = formatSarif(findings, allRules);
    const sarifPath = "ci-bottlenecks.sarif";
    mkdirSync(".", { recursive: true });
    writeFileSync(sarifPath, JSON.stringify(sarif, null, 2));
    core.setOutput("sarif-path", sarifPath);
    core.info(`SARIF written to ${sarifPath}`);
  }

  const SEVERITY_ORDER: Record<Severity, number> = {
    high: 0,
    medium: 1,
    low: 2,
    info: 3,
  };

  const hasAboveThreshold = findings.some(
    (f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[failOn],
  );

  if (hasAboveThreshold) {
    core.setFailed(
      `${findings.length} finding(s) at or above "${failOn}" severity`,
    );
  }
}

run().catch((e) => {
  core.setFailed(`ci-bottlenecks failed: ${e.message}`);
});
