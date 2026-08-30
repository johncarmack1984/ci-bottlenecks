import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, relative, resolve } from "path";
import { parseWorkflow } from "./parser.ts";
import { runRules } from "./runner.ts";
import { allRules } from "./rules/index.ts";
import { formatText } from "./format/text.ts";
import { formatJson } from "./format/json.ts";
import { formatSarif } from "./format/sarif.ts";
import { formatSummary } from "./format/summary.ts";
import { detectNwo } from "./api.ts";
import { discoverWorkflows, loadAuditData } from "./shared.ts";
import type { Finding, Severity, ParsedWorkflow, WorkflowAuditData } from "./types.ts";

const VERSION = "0.1.0";

const VALID_FORMATS = new Set(["text", "json", "sarif", "summary"]);
const VALID_SEVERITIES = new Set(["high", "medium", "low", "info", "none"]);

function printUsage() {
  process.stdout.write(`ci-bottlenecks v${VERSION}

Find performance problems in GitHub Actions pipelines.

Usage: ci-bottlenecks [path] [options]

Options:
  --audit              Enable audit tier (pulls measured data from GitHub API)
  --pedantic           Enable pedantic rules
  --runs N             Maximum number of completed runs to sample for audit (default: 50)
  --format FORMAT      Output format: text, json, sarif, summary (repeatable, default: text)
  --fail-on SEVERITY   Minimum severity to fail: high, medium, low, info, none (default: none)
  --repo OWNER/NAME    Override repository detection for audit mode
  --record DIR         Write anonymized audit snapshots to DIR for eval fixtures
  --sarif-output PATH  Write SARIF to a file instead of stdout
  -h, --help           Show this help message
  --version            Print version and exit

Exit codes:
  0  No findings at or above the --fail-on threshold (or --fail-on none)
  1  Findings found at or above the threshold
  2  Error (no workflows found, parse failure, etc.)
`);
}

function parseArgs(argv: string[]) {
  const args = {
    audit: false,
    pedantic: false,
    runs: 50,
    formats: [] as string[],
    failOn: "none" as Severity | "none",
    path: ".",
    sarifOutput: "",
    repo: "",
    record: "",
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--version":
        args.version = true;
        break;
      case "--audit":
        args.audit = true;
        break;
      case "--pedantic":
        args.pedantic = true;
        break;
      case "--runs":
        args.runs = parseInt(argv[++i] ?? "50", 10);
        break;
      case "--format": {
        const fmt = argv[++i] ?? "text";
        if (!VALID_FORMATS.has(fmt)) {
          process.stderr.write(`Unknown format: "${fmt}". Valid formats: ${[...VALID_FORMATS].join(", ")}\n`);
          process.exit(2);
        }
        args.formats.push(fmt);
        break;
      }
      case "--fail-on": {
        const sev = argv[++i] ?? "none";
        if (!VALID_SEVERITIES.has(sev)) {
          process.stderr.write(`Unknown severity: "${sev}". Valid values: ${[...VALID_SEVERITIES].join(", ")}\n`);
          process.exit(2);
        }
        args.failOn = sev as Severity | "none";
        break;
      }
      case "--sarif-output":
        args.sarifOutput = argv[++i] ?? "";
        break;
      case "--repo":
        args.repo = argv[++i] ?? "";
        break;
      case "--record":
        args.record = argv[++i] ?? "";
        break;
      default:
        if (!arg.startsWith("-")) args.path = arg;
    }
  }

  if (args.formats.length === 0) args.formats.push("text");
  return args;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

function meetsThreshold(finding: Finding, threshold: Severity | "none"): boolean {
  if (threshold === "none") return false;
  return SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[threshold];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (args.version) {
    process.stdout.write(`ci-bottlenecks v${VERSION}\n`);
    process.exit(0);
  }

  const basePath = resolve(args.path);

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
    if (parsed) {
      workflows.push(parsed);
    } else {
      process.stderr.write(`Warning: failed to parse ${relPath}\n`);
    }
  }

  if (workflows.length === 0) {
    process.stderr.write("No valid workflow files parsed.\n");
    process.exit(2);
  }

  let auditDataByWorkflow: Map<string, WorkflowAuditData> | undefined;

  if (args.audit) {
    let nwo: string | null = args.repo || null;
    if (!nwo) {
      nwo = detectNwo(basePath);
      if (!nwo && process.env.GITHUB_REPOSITORY) {
        nwo = process.env.GITHUB_REPOSITORY;
      }
    }
    if (!nwo) {
      process.stderr.write(
        "Could not detect repository. Use --repo owner/name or set GITHUB_REPOSITORY.\n",
      );
    } else {
      process.stderr.write(`Auditing ${nwo} (${args.runs} runs max)...\n`);
      auditDataByWorkflow = await loadAuditData(nwo, workflows, args.runs, (msg) =>
        process.stderr.write(`${msg}\n`),
      );
    }
  }

  const findings = runRules(allRules, workflows, {
    audit: args.audit,
    pedantic: args.pedantic,
    auditDataByWorkflow,
  });

  if (args.record && auditDataByWorkflow) {
    writeRecordedSnapshots(args.record, workflows, auditDataByWorkflow);
  }

  for (const fmt of args.formats) {
    switch (fmt) {
      case "text":
        process.stdout.write(formatText(findings, auditDataByWorkflow));
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

function writeRecordedSnapshots(
  dir: string,
  workflows: ParsedWorkflow[],
  auditDataByWorkflow: Map<string, WorkflowAuditData>,
) {
  mkdirSync(dir, { recursive: true });
  for (const wf of workflows) {
    const data = auditDataByWorkflow.get(wf.path);
    if (!data || data.runs.length === 0) continue;

    const anonymized = {
      runs: data.runs.map((run) => ({
        id: run.id,
        name: run.name,
        workflowId: run.workflowId,
        headSha: run.headSha.replace(/./g, "a"),
        conclusion: run.conclusion,
        createdAt: run.createdAt,
        runStartedAt: run.runStartedAt,
        updatedAt: run.updatedAt,
        jobs: run.jobs.map((job) => ({
          id: job.id,
          name: job.name,
          conclusion: job.conclusion,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          runnerLabel: job.runnerLabel,
          steps: job.steps.map((step) => ({
            name: step.name,
            number: step.number,
            status: step.status,
            conclusion: step.conclusion,
            startedAt: step.startedAt,
            completedAt: step.completedAt,
          })),
        })),
      })),
    };

    const slug = wf.path.replace(/[/\\]/g, "_").replace(/\.ya?ml$/, "");
    writeFileSync(join(dir, `${slug}.timing.json`), JSON.stringify(anonymized, null, 2) + "\n");
    process.stderr.write(`Recorded ${slug}.timing.json (${data.runs.length} runs)\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(2);
});
