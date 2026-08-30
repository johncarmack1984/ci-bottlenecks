import type { Finding, Severity } from "../types.ts";

const SEVERITY_ORDER: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

function severityLabel(severity: Severity): string {
  if (!useColor()) return severity.toUpperCase();
  const labels: Record<Severity, string> = {
    high: "\x1b[31mHIGH\x1b[0m",
    medium: "\x1b[33mMEDIUM\x1b[0m",
    low: "\x1b[36mLOW\x1b[0m",
    info: "\x1b[2mINFO\x1b[0m",
  };
  return labels[severity];
}

function c(code: string, text: string): string {
  return useColor() ? `${code}${text}\x1b[0m` : text;
}

function fmtLocation(f: Finding): string {
  const parts = [f.workflow];
  if (f.job) parts.push(f.job);
  if (f.location) parts.push(`line ${f.location.line}`);
  return parts.join(":");
}

export function formatText(findings: Finding[]): string {
  if (findings.length === 0) return "No findings.\n";

  const sorted = [...findings].sort((a, b) => {
    const wc = a.workflow.localeCompare(b.workflow);
    if (wc !== 0) return wc;
    return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  });

  const byWorkflow = new Map<string, Finding[]>();
  for (const f of sorted) {
    const group = byWorkflow.get(f.workflow) ?? [];
    group.push(f);
    byWorkflow.set(f.workflow, group);
  }

  const lines: string[] = [];
  for (const [workflow, group] of byWorkflow) {
    lines.push(`\n${c("\x1b[1m", workflow)}`);
    for (const f of group) {
      lines.push(
        `  ${severityLabel(f.severity)}  ${f.rule}  ${fmtLocation(f)}`,
      );
      lines.push(`    ${f.message}`);
      lines.push(`    ${c("\x1b[2m", "evidence:")} ${f.evidence}`);
      lines.push(`    ${c("\x1b[2m", "fix:")} ${f.remediation}`);
      if (f.patch) {
        lines.push(`    ${c("\x1b[2m", "patch:")}`);
        for (const patchLine of f.patch.split("\n")) {
          lines.push(`      ${patchLine}`);
        }
      }
      if (f.estimatedSavings?.minutesPerRun) {
        lines.push(
          `    ${c("\x1b[32m", `~${f.estimatedSavings.minutesPerRun}min/run saved (${f.estimatedSavings.confidence})`)}`,
        );
      }
    }
  }

  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  lines.push("");
  lines.push(
    `${findings.length} finding(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info`,
  );

  return lines.join("\n") + "\n";
}
