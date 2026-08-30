import type { Finding, Severity } from "../types.ts";

const SEVERITY_ORDER: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "\x1b[31mHIGH\x1b[0m",
  medium: "\x1b[33mMEDIUM\x1b[0m",
  low: "\x1b[36mLOW\x1b[0m",
  info: "\x1b[2mINFO\x1b[0m",
};

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
    lines.push(`\n\x1b[1m${workflow}\x1b[0m`);
    for (const f of group) {
      lines.push(
        `  ${SEVERITY_LABEL[f.severity]}  ${f.rule}  ${fmtLocation(f)}`,
      );
      lines.push(`    ${f.message}`);
      lines.push(`    \x1b[2mevidence:\x1b[0m ${f.evidence}`);
      lines.push(`    \x1b[2mfix:\x1b[0m ${f.remediation}`);
      if (f.patch) {
        lines.push(`    \x1b[2mpatch:\x1b[0m`);
        for (const patchLine of f.patch.split("\n")) {
          lines.push(`      ${patchLine}`);
        }
      }
      if (f.estimatedSavings?.minutesPerRun) {
        lines.push(
          `    \x1b[32m~${f.estimatedSavings.minutesPerRun}min/run saved (${f.estimatedSavings.confidence})\x1b[0m`,
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
