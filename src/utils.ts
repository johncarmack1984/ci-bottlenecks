export function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return ms > 0 ? ms : null;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function fmtMinutes(ms: number): string {
  const m = ms / 60_000;
  return m < 1 ? `${(ms / 1000).toFixed(0)}s` : `${m.toFixed(1)}m`;
}

import type { ParsedStep } from "./types.ts";

/**
 * The name GitHub gives a step in the Actions API and the run log: the
 * explicit `name:`, else `Run <uses>` for an action, else `Run <first line
 * of run>` for a script. Audit-tier code matches measured steps to the YAML
 * by this string, so it has to follow GitHub's convention exactly.
 */
export function stepDisplayName(step: ParsedStep): string | null {
  if (step.name) return step.name;
  if (step.uses) return `Run ${step.uses.trim()}`;
  if (step.run) {
    const first = step.run.split("\n").find((l) => l.trim().length > 0);
    return first ? `Run ${first.trim()}` : null;
  }
  return null;
}
