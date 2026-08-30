export interface DagNode {
  jobId: string;
  duration: number;
  needs: string[];
}

export interface CriticalPathResult {
  path: string[];
  totalDuration: number;
  slack: Map<string, number>;
}

export function computeCriticalPath(nodes: DagNode[]): CriticalPathResult {
  const nodeMap = new Map<string, DagNode>();
  for (const n of nodes) nodeMap.set(n.jobId, n);

  const sorted = topoSort(nodes);

  const earliest = new Map<string, number>();
  const predecessor = new Map<string, string | null>();

  for (const id of sorted) {
    const node = nodeMap.get(id)!;
    let es = 0;
    let pred: string | null = null;
    for (const dep of node.needs) {
      const depFinish = (earliest.get(dep) ?? 0) + (nodeMap.get(dep)?.duration ?? 0);
      if (depFinish > es) {
        es = depFinish;
        pred = dep;
      }
    }
    earliest.set(id, es);
    predecessor.set(id, pred);
  }

  let endNode = "";
  let maxFinish = 0;
  for (const id of sorted) {
    const finish = (earliest.get(id) ?? 0) + (nodeMap.get(id)?.duration ?? 0);
    if (finish >= maxFinish) {
      maxFinish = finish;
      endNode = id;
    }
  }

  const path: string[] = [];
  let cur: string | null = endNode;
  while (cur) {
    path.unshift(cur);
    cur = predecessor.get(cur) ?? null;
  }

  const latest = new Map<string, number>();
  for (const id of sorted) latest.set(id, maxFinish);

  for (let i = sorted.length - 1; i >= 0; i--) {
    const id = sorted[i]!;
    const node = nodeMap.get(id)!;
    for (const dep of node.needs) {
      const ls = (latest.get(id) ?? maxFinish) - (nodeMap.get(id)?.duration ?? 0);
      if (ls < (latest.get(dep) ?? maxFinish)) {
        latest.set(dep, ls);
      }
    }
  }

  const slack = new Map<string, number>();
  for (const id of sorted) {
    const node = nodeMap.get(id)!;
    const ls = (latest.get(id) ?? 0) - node.duration;
    const es = earliest.get(id) ?? 0;
    slack.set(id, ls - es);
  }

  return { path, totalDuration: maxFinish, slack };
}

function topoSort(nodes: DagNode[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.jobId, 0);
    adj.set(n.jobId, []);
  }
  for (const n of nodes) {
    for (const dep of n.needs) {
      if (adj.has(dep)) {
        adj.get(dep)!.push(n.jobId);
        inDegree.set(n.jobId, (inDegree.get(n.jobId) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  return result;
}
