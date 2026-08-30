export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  tier: "static" | "audit";
  workflow: string;
  job?: string;
  step?: number;
  location?: { line: number; column?: number };
  message: string;
  evidence: string;
  remediation: string;
  patch?: string;
  estimatedSavings?: { minutesPerRun?: number; confidence: "exact" | "estimate" };
  pedantic?: boolean;
}

export interface Rule {
  id: string;
  tier: "static" | "audit";
  pedantic?: boolean;
  severity: Severity;
  describe: string;
  check(ctx: RuleContext): Finding[];
}

export interface RuleContext {
  workflow: ParsedWorkflow;
  allWorkflows: ParsedWorkflow[];
  auditData?: WorkflowAuditData;
}

export interface ParsedWorkflow {
  path: string;
  name: string;
  triggers: TriggerConfig;
  jobs: Map<string, ParsedJob>;
  concurrency?: ConcurrencyConfig;
  raw: Record<string, unknown>;
  source: string;
  sourceLines: string[];
  suppressions: WorkflowSuppressions;
}

export interface TriggerConfig {
  push?: PushTrigger;
  pull_request?: PullRequestTrigger;
  pull_request_target?: PullRequestTrigger;
  schedule?: unknown[];
  workflow_dispatch?: unknown;
  release?: unknown;
  [key: string]: unknown;
}

export interface PushTrigger {
  branches?: string[];
  "branches-ignore"?: string[];
  tags?: string[];
  "tags-ignore"?: string[];
  paths?: string[];
  "paths-ignore"?: string[];
}

export interface PullRequestTrigger {
  branches?: string[];
  "branches-ignore"?: string[];
  paths?: string[];
  "paths-ignore"?: string[];
  types?: string[];
}

export interface ConcurrencyConfig {
  group?: string;
  "cancel-in-progress"?: boolean | string;
}

export interface ParsedJob {
  id: string;
  name?: string;
  uses?: string;
  "runs-on": string | string[];
  needs: string[];
  "timeout-minutes"?: number;
  concurrency?: ConcurrencyConfig;
  if?: string;
  environment?: unknown;
  strategy?: {
    matrix?: Record<string, unknown>;
    "max-parallel"?: number;
    "fail-fast"?: boolean;
  };
  outputs?: Record<string, string>;
  steps: ParsedStep[];
  line?: number;
  env?: Record<string, string>;
  raw?: Record<string, unknown>;
}

export interface ParsedStep {
  index: number;
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  env?: Record<string, string>;
  if?: string;
  line?: number;
}

export interface WorkflowSuppressions {
  workflow: string[] | "all";
  jobs: Map<string, string[] | "all">;
  steps: Map<string, string[] | "all">;
}

export interface WorkflowAuditData {
  runs: RunData[];
}

export interface RunData {
  id: number;
  name: string;
  workflowId: number;
  headSha: string;
  conclusion: string;
  createdAt: string;
  runStartedAt: string | null;
  updatedAt: string;
  jobs: JobData[];
}

export interface JobData {
  id: number;
  name: string;
  conclusion: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: StepData[];
}

export interface StepData {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
