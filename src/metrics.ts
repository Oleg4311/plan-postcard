import { allNodes, walk } from './types.ts';
import type { Plan, PlanNode } from './types.ts';

const PARALLEL_ROOTS = new Set(['Gather', 'Gather Merge']);

/** Время узла вместе с детьми, мс: среднее за запуск × число запусков. Для параллельных узлов это суммарное время всех процессов. */
export function inclusiveMs(n: PlanNode): number {
  if (n.neverExecuted || n.actualTotal === undefined) return 0;
  return n.actualTotal * (n.actualLoops ?? 1);
}

/**
 * Собственное время узла без детей. Для Gather ребёнок считается по времени одного процесса (это и есть ожидание Gather);
 * внутри параллельной части время суммарное по процессам, поэтому доли там могут превышать 100%.
 */
export function exclusiveMs(n: PlanNode): number {
  if (n.neverExecuted || n.actualTotal === undefined) return 0;
  const own = inclusiveMs(n);
  const kids = n.children.reduce((s, c) => s + (PARALLEL_ROOTS.has(n.type) ? (c.actualTotal ?? 0) : inclusiveMs(c)), 0);
  return Math.max(0, own - kids);
}

export interface Misestimate {
  /** Во сколько раз оценка отличается от факта (всегда ≥ 1). */
  factor: number;
  direction: 'under' | 'over';
  planRows: number;
  actualRows: number;
}

/** Ошибка оценки числа строк на один запуск. Не определена без ANALYZE и для узлов, которые не выполнялись. */
export function misestimate(n: PlanNode): Misestimate | undefined {
  if (n.planRows === undefined || n.actualRows === undefined || n.neverExecuted) return undefined;
  const est = Math.max(n.planRows, 1);
  const act = Math.max(n.actualRows, 1);
  const factor = Math.max(est / act, act / est);
  return { factor, direction: act > est ? 'under' : 'over', planRows: n.planRows, actualRows: n.actualRows };
}

/** Строки, вышедшие из узла за всё время: среднее × запуски. */
export function totalRows(n: PlanNode): number {
  return (n.actualRows ?? 0) * (n.actualLoops ?? 1);
}

/** Целое время выполнения плана, мс: «Execution Time», а без него время корня. */
export function planTotalMs(p: Plan): number | undefined {
  return p.executionTime ?? (p.root.actualTotal !== undefined ? p.root.actualTotal * (p.root.actualLoops ?? 1) : undefined);
}

export interface PlanStats {
  nodes: number;
  scans: number;
  joins: number;
  sorts: number;
  maxDepth: number;
  totalCost?: number;
  sharedHit: number;
  sharedRead: number;
  tempBlocks: number;
}

export function stats(p: Plan): PlanStats {
  const s: PlanStats = { nodes: 0, scans: 0, joins: 0, sorts: 0, maxDepth: 0, totalCost: p.root.totalCost, sharedHit: 0, sharedRead: 0, tempBlocks: 0 };
  walk(p.root, (n, depth) => {
    s.nodes++;
    s.maxDepth = Math.max(s.maxDepth, depth);
    if (/Scan/.test(n.type) && !/^(Bitmap Index|CTE|Subquery|Function|Values)/.test(n.type)) s.scans++;
    if (n.joinType !== undefined) s.joins++;
    if (/Sort/.test(n.type)) s.sorts++;
  });
  // буферы корня уже включают детей
  const b = p.root.buffers;
  s.sharedHit = b?.sharedHit ?? 0;
  s.sharedRead = b?.sharedRead ?? 0;
  s.tempBlocks = (b?.tempRead ?? 0) + (b?.tempWritten ?? 0);
  return s;
}

/** Узлы по убыванию собственного времени. */
export function hottest(p: Plan, limit = 3): { node: PlanNode; ms: number }[] {
  return allNodes(p)
    .map((node) => ({ node, ms: exclusiveMs(node) }))
    .filter((x) => x.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

/** Подпись узла для людей: «Index Scan using orders_pkey on orders o». */
export function label(n: PlanNode): string {
  let s = n.joinType && n.joinType !== 'Inner' ? n.type.replace(/ Join$/, ` ${n.joinType} Join`) : n.type;
  if (n.index && !n.type.startsWith('Bitmap Heap')) s += n.type === 'Bitmap Index Scan' ? ` on ${n.index}` : ` using ${n.index}`;
  if (n.relation && n.type !== 'Bitmap Index Scan') s += ` on ${n.relation}${n.alias && n.alias !== n.relation ? ` ${n.alias}` : ''}`;
  else if (n.alias && !n.relation && /Scan$/.test(n.type)) s += ` on ${n.alias}`;
  return s;
}
