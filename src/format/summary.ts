import type { Finding, Severity } from "../types.ts";

const SEVERITY_EMOJI: Record<Severity, string> = {
  high: ":red_circle:",
  medium: ":orange_circle:",
  low: ":large_blue_circle:",
  info: ":white_circle:",
};

export function formatSummary(findings: Finding[]): string {
  if (findings.length === 0) {
    return "## ci-bottlenecks\n\nNo findings.\n";
  }

  const lines: string[] = ["## ci-bottlenecks\n"];

  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  lines.push(
    `**${findings.length}** finding(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info\n`,
  );

  const byWorkflow = new Map<string, Finding[]>();
  for (const f of findings) {
    const group = byWorkflow.get(f.workflow) ?? [];
    group.push(f);
    byWorkflow.set(f.workflow, group);
  }

  for (const [workflow, group] of byWorkflow) {
    lines.push(`### \`${workflow}\`\n`);
    lines.push("| Severity | Rule | Job | Message |");
    lines.push("|----------|------|-----|---------|");
    for (const f of group) {
      const sev = `${SEVERITY_EMOJI[f.severity]} ${f.severity}`;
      const job = f.job ? `\`${f.job}\`` : "";
      const msg = f.message.replace(/\|/g, "\\|");
      lines.push(`| ${sev} | \`${f.rule}\` | ${job} | ${msg} |`);
    }
    lines.push("");
  }

  const exactSavings = findings.filter(
    (f) => f.estimatedSavings?.minutesPerRun && f.estimatedSavings.confidence === "exact",
  );
  if (exactSavings.length > 0) {
    const totalSavings = exactSavings.reduce(
      (sum, f) => sum + (f.estimatedSavings?.minutesPerRun ?? 0),
      0,
    );
    lines.push(
      `**Estimated savings:** ~${totalSavings.toFixed(1)} minutes per run\n`,
    );
  }

  return lines.join("\n");
}
