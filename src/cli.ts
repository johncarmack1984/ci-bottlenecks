import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { parseWorkflow } from "./parser.ts";
import { runRules } from "./runner.ts";
import { allRules } from "./rules/index.ts";
import { formatText } from "./format/text.ts";
import { formatJson } from "./format/json.ts";
import { formatSarif } from "./format/sarif.ts";
import { formatSummary } from "./format/summary.ts";
import { fetchRuns, fetchJobsForRun, detectNwo } from "./api.ts";
import { cachedFetch, DEFAULT_CACHE_DIR } from "./cache.ts";
import type { Finding, Severity, ParsedWorkflow, WorkflowAuditData, RunData } from "./types.ts";

function parseArgs(argv: string[]) {
  const args = {
    audit: false,
    pedantic: false,
    runs: 50,
    formats: [] as string[],
    failOn: "high" as Severity,
    path: ".",
    sarifOutput: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--audit":
        args.audit = true;
        break;
      case "--pedantic":
        args.pedantic = true;
        break;
      case "--runs":
        args.runs = parseInt(argv[++i] ?? "50", 10);
        break;
      case "--format":
        args.formats.push(argv[++i] ?? "text");
        break;
      case "--fail-on":
        args.failOn = (argv[++i] ?? "high") as Severity;
        break;
      case "--sarif-output":
        args.sarifOutput = argv[++i] ?? "";
        break;
      default:
        if (!arg.startsWith("-")) args.path = arg;
    }
  }

  if (args.formats.length === 0) args.formats.push("text");
  return args;
}

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

const SEVERITY_ORDER: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

function meetsThreshold(finding: Finding, threshold: Severity): boolean {
  return SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[threshold];
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

  if (runs.length === 0) {
    process.stderr.write("No completed runs found for this repository.\n");
    return map;
  }

  process.stderr.write(`Fetched ${runs.length} runs, loading job data...\n`);

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const basePath = args.path;

  const workflowFiles = discoverWorkflows(basePath);
  if (workflowFiles.length === 0) {
    process.stderr.write(
      `No workflow files found in ${join(basePath, ".github/workflows")}\n`,
    );
    process.exit(2);
  }

  const workflows: ParsedWorkflow[] = [];
  for (const file of workflowFiles) {
    const source = readFileSync(file, "utf-8");
    const relPath = relative(basePath, file);
    const parsed = parseWorkflow(relPath, source);
    if (parsed) workflows.push(parsed);
  }

  if (workflows.length === 0) {
    process.stderr.write("No valid workflow files parsed.\n");
    process.exit(2);
  }

  let auditDataByWorkflow: Map<string, WorkflowAuditData> | undefined;

  if (args.audit) {
    const nwo = detectNwo();
    if (!nwo) {
      process.stderr.write(
        "Could not detect repository (no git remote). Skipping audit.\n",
      );
    } else {
      process.stderr.write(`Auditing ${nwo} (${args.runs} runs max)...\n`);
      auditDataByWorkflow = await loadAuditData(nwo, workflows, args.runs);
    }
  }

  const findings = runRules(allRules, workflows, {
    audit: args.audit,
    pedantic: args.pedantic,
    auditDataByWorkflow,
  });

  for (const fmt of args.formats) {
    switch (fmt) {
      case "text":
        process.stdout.write(formatText(findings));
        break;
      case "json":
        process.stdout.write(formatJson(findings));
        break;
      case "sarif": {
        const sarif = formatSarif(findings, allRules);
        const sarifStr = JSON.stringify(sarif, null, 2) + "\n";
        if (args.sarifOutput) {
          const dir = args.sarifOutput.split("/").slice(0, -1).join("/");
          if (dir) mkdirSync(dir, { recursive: true });
          writeFileSync(args.sarifOutput, sarifStr);
          process.stderr.write(`SARIF written to ${args.sarifOutput}\n`);
        } else {
          process.stdout.write(sarifStr);
        }
        break;
      }
      case "summary": {
        const md = formatSummary(findings);
        const summaryPath = process.env.GITHUB_STEP_SUMMARY;
        if (summaryPath) {
          writeFileSync(summaryPath, md, { flag: "a" });
          process.stderr.write("Summary written to $GITHUB_STEP_SUMMARY\n");
        } else {
          process.stdout.write(md);
        }
        break;
      }
    }
  }

  const hasAboveThreshold = findings.some((f) =>
    meetsThreshold(f, args.failOn),
  );
  process.exit(hasAboveThreshold ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(2);
});
