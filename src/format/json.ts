import type { Finding } from "../types.ts";

export function formatJson(findings: Finding[]): string {
  return JSON.stringify(findings, null, 2) + "\n";
}
