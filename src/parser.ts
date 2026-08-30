import { parse, parseDocument, isMap, isSeq, isScalar } from "yaml";
import type {
  ParsedWorkflow,
  ParsedJob,
  ParsedStep,
  TriggerConfig,
  ConcurrencyConfig,
  WorkflowSuppressions,
} from "./types.ts";

function buildLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLine(lineOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function buildPositionMap(
  source: string,
): Map<string, number> {
  const lineOffsets = buildLineOffsets(source);
  const positions = new Map<string, number>();

  let doc;
  try {
    doc = parseDocument(source);
  } catch {
    return positions;
  }

  if (!isMap(doc.contents)) return positions;

  const jobsItem = doc.contents.items.find(
    (item) => isScalar(item.key) && item.key.value === "jobs",
  );

  if (!jobsItem || !isMap(jobsItem.value)) return positions;

  for (const jobItem of jobsItem.value.items) {
    if (!isScalar(jobItem.key) || !jobItem.key.range) continue;
    const jobId = String(jobItem.key.value);
    positions.set(
      `jobs.${jobId}`,
      offsetToLine(lineOffsets, jobItem.key.range[0]),
    );

    if (!isMap(jobItem.value)) continue;

    const stepsItem = jobItem.value.items.find(
      (item) => isScalar(item.key) && item.key.value === "steps",
    );
    if (!stepsItem || !isSeq(stepsItem.value)) continue;

    for (let i = 0; i < stepsItem.value.items.length; i++) {
      const stepNode = stepsItem.value.items[i];
      if (stepNode && typeof stepNode === "object" && "range" in stepNode && stepNode.range) {
        positions.set(
          `jobs.${jobId}.steps[${i}]`,
          offsetToLine(lineOffsets, (stepNode.range as number[])[0]),
        );
      }
    }
  }

  return positions;
}

function parseSuppressionComment(text: string): string[] | "all" | null {
  const match = text.match(
    /# ci-bottlenecks:\s*ignore(?:\[([^\]]+)\])?/,
  );
  if (!match) return null;
  if (match[1]) return match[1].split(",").map((s) => s.trim());
  return "all";
}

function parseSuppressions(
  sourceLines: string[],
  positions: Map<string, number>,
): WorkflowSuppressions {
  const result: WorkflowSuppressions = {
    workflow: [],
    jobs: new Map(),
    steps: new Map(),
  };

  for (let i = 0; i < Math.min(20, sourceLines.length); i++) {
    const line = sourceLines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      const sup = parseSuppressionComment(line);
      if (sup) {
        if (sup === "all") {
          result.workflow = "all";
        } else if (result.workflow !== "all") {
          (result.workflow as string[]).push(...sup);
        }
      }
    } else {
      break;
    }
  }

  for (const [key, lineNum] of positions) {
    const sourceLine = sourceLines[lineNum - 1];
    if (!sourceLine) continue;
    const sup = parseSuppressionComment(sourceLine);
    if (!sup) continue;

    if (key.startsWith("jobs.") && !key.includes(".steps[")) {
      const jobId = key.slice(5);
      result.jobs.set(jobId, sup);
    } else if (key.includes(".steps[")) {
      const match = key.match(/^jobs\.(.+)\.steps\[(\d+)\]$/);
      if (match) {
        result.steps.set(`${match[1]}:${match[2]}`, sup);
      }
    }
  }

  return result;
}

function parseTriggers(on: unknown): TriggerConfig {
  if (typeof on === "string") {
    return { [on]: {} };
  }
  if (Array.isArray(on)) {
    const config: TriggerConfig = {};
    for (const t of on) config[String(t)] = {};
    return config;
  }
  if (on && typeof on === "object") {
    const raw = on as Record<string, unknown>;
    const config: TriggerConfig = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) {
        config[key] = {};
      } else {
        config[key] = value as TriggerConfig[string];
      }
    }
    return config;
  }
  return {};
}

function parseConcurrency(raw: unknown): ConcurrencyConfig | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return { group: raw };
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      group: obj.group as string | undefined,
      "cancel-in-progress": obj["cancel-in-progress"] as boolean | undefined,
    };
  }
  return undefined;
}

function parseJob(
  id: string,
  raw: Record<string, unknown>,
  positions: Map<string, number>,
): ParsedJob {
  const steps: ParsedStep[] = [];
  const rawSteps = raw.steps;
  if (Array.isArray(rawSteps)) {
    for (let i = 0; i < rawSteps.length; i++) {
      const s = rawSteps[i];
      if (!s || typeof s !== "object") continue;
      const step = s as Record<string, unknown>;
      steps.push({
        index: i,
        name: step.name as string | undefined,
        uses: step.uses as string | undefined,
        with: step.with as Record<string, unknown> | undefined,
        run: typeof step.run === "string" ? step.run : undefined,
        env: step.env as Record<string, string> | undefined,
        if: step.if as string | undefined,
        line: positions.get(`jobs.${id}.steps[${i}]`),
      });
    }
  }

  const needs: string[] = [];
  if (typeof raw.needs === "string") needs.push(raw.needs);
  else if (Array.isArray(raw.needs)) needs.push(...raw.needs.map(String));

  const runsOn = raw["runs-on"];
  let runsOnValue: string | string[];
  if (typeof runsOn === "string") runsOnValue = runsOn;
  else if (Array.isArray(runsOn)) runsOnValue = runsOn.map(String);
  else runsOnValue = JSON.stringify(runsOn ?? "");

  const strategy = raw.strategy as Record<string, unknown> | undefined;

  return {
    id,
    name: raw.name as string | undefined,
    "runs-on": runsOnValue,
    needs,
    "timeout-minutes": raw["timeout-minutes"] as number | undefined,
    concurrency: parseConcurrency(raw.concurrency),
    if: raw.if as string | undefined,
    strategy: strategy
      ? {
          matrix: strategy.matrix as Record<string, unknown> | undefined,
          "max-parallel": strategy["max-parallel"] as number | undefined,
          "fail-fast": strategy["fail-fast"] as boolean | undefined,
        }
      : undefined,
    outputs: raw.outputs as Record<string, string> | undefined,
    steps,
    line: positions.get(`jobs.${id}`),
    env: raw.env as Record<string, string> | undefined,
  };
}

export function parseWorkflow(
  path: string,
  source: string,
): ParsedWorkflow | null {
  let raw: Record<string, unknown>;
  try {
    raw = parse(source, { uniqueKeys: false, maxAliasCount: 100 });
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const positions = buildPositionMap(source);
  const sourceLines = source.split("\n");

  const name =
    (raw.name as string) ??
    path
      .split("/")
      .pop()
      ?.replace(/\.ya?ml$/, "") ??
    path;

  const on = raw.on ?? raw.true;
  const triggers = parseTriggers(on);

  const jobs = new Map<string, ParsedJob>();
  const rawJobs = raw.jobs;
  if (rawJobs && typeof rawJobs === "object") {
    for (const [jobId, jobDef] of Object.entries(
      rawJobs as Record<string, unknown>,
    )) {
      if (!jobDef || typeof jobDef !== "object") continue;
      jobs.set(
        jobId,
        parseJob(jobId, jobDef as Record<string, unknown>, positions),
      );
    }
  }

  const suppressions = parseSuppressions(sourceLines, positions);

  return {
    path,
    name,
    triggers,
    jobs,
    concurrency: parseConcurrency(raw.concurrency),
    raw,
    source,
    sourceLines,
    suppressions,
  };
}

export function parseActionRef(uses: string): {
  key: string;
  version: string;
  isLocal: boolean;
} {
  if (uses.startsWith("./") || uses.startsWith("../"))
    return { key: uses, version: "", isLocal: true };
  if (uses.startsWith("docker://"))
    return { key: uses, version: "", isLocal: false };

  const commentMatch = uses.match(/^(.+?)\s*#\s*(.+)$/);
  const clean = (commentMatch ? commentMatch[1]! : uses).trim();

  const atIdx = clean.indexOf("@");
  if (atIdx === -1) return { key: clean, version: "", isLocal: false };

  const actionPath = clean.substring(0, atIdx);
  const ref = clean.substring(atIdx + 1);
  const parts = actionPath.split("/");
  const key = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : actionPath;
  const version = commentMatch?.[2]?.trim() || ref;

  return { key, version, isLocal: false };
}
