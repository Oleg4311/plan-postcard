import { exclusiveMs, label, totalRows } from './metrics.ts';
import { allNodes, walk } from './types.ts';
import type { Plan, PlanNode } from './types.ts';

export type ChangeKind = 'access' | 'join' | 'condition' | 'estimate' | 'rows' | 'time' | 'io' | 'memory' | 'parallel';

export interface FieldChange {
  kind: ChangeKind;
  /** Короткое название изменения: «Метод доступа», «Фильтр», «Строк (факт)». */
  title: string;
  a?: string | number;
  b?: string | number;
}

export interface Pair {
  a: PlanNode;
  b: PlanNode;
  changes: FieldChange[];
}

export interface PlanDiff {
  pairs: Pair[];
  removed: PlanNode[];
  added: PlanNode[];
  byA: Map<number, Pair>;
  byB: Map<number, Pair>;
}

const isScanAnchor = (n: PlanNode): boolean => (n.relation !== undefined && /Scan$/.test(n.type)) || (n.children.length === 0 && (n.alias !== undefined || n.props['CTE Name'] !== undefined || n.props['Function Name'] !== undefined || n.index !== undefined));

/** Ключ, по которому сканы двух планов считаются «тем же обращением к данным», даже если способ доступа изменился. */
function anchorKey(n: PlanNode): string {
  const what = n.relation ?? n.props['CTE Name'] ?? n.props['Function Name'] ?? '';
  const idx = n.type === 'Bitmap Index Scan' ? (n.index ?? '') : '';
  return `${what}|${n.alias ?? ''}|${idx}`;
}

function subtree(n: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  walk(n, (x) => out.push(x));
  return out;
}

/**
 * Сопоставляет узлы двух планов. Опора — обращения к таблицам (по имени и псевдониму): они переживают смену метода
 * доступа и порядка соединений. Внутренние узлы сопоставляются по общим таблицам под ними, остальное — по структуре.
 */
export function diffPlans(planA: Plan, planB: Plan): PlanDiff {
  const nodesA = allNodes(planA);
  const nodesB = allNodes(planB);
  const aToB = new Map<number, PlanNode>();
  const bToA = new Map<number, PlanNode>();
  const link = (a: PlanNode, b: PlanNode) => {
    aToB.set(a.id, b);
    bToA.set(b.id, a);
  };

  // 1. обращения к данным
  const groupsB = new Map<string, PlanNode[]>();
  for (const b of nodesB) if (isScanAnchor(b)) (groupsB.get(anchorKey(b)) ?? groupsB.set(anchorKey(b), []).get(anchorKey(b))!).push(b);
  for (const a of nodesA) {
    if (!isScanAnchor(a)) continue;
    const g = groupsB.get(anchorKey(a));
    const b = g?.find((x) => !bToA.has(x.id));
    if (b) link(a, b);
  }

  // 2. внутренние узлы по общим таблицам под ними (от листьев к корню)
  const anchorsB = new Map<number, Set<number>>();
  for (const b of nodesB) anchorsB.set(b.id, new Set(subtree(b).filter(isScanAnchor).map((x) => x.id)));
  const postOrder: PlanNode[] = [];
  const post = (n: PlanNode) => {
    n.children.forEach(post);
    postOrder.push(n);
  };
  post(planA.root);
  for (const sameTypeOnly of [true, false]) for (const a of postOrder) {
    if (aToB.has(a.id) || isScanAnchor(a)) continue;
    const mapped = new Set<number>();
    for (const d of subtree(a)) {
      const m = aToB.get(d.id);
      if (m && isScanAnchor(d)) mapped.add(m.id);
    }
    if (mapped.size === 0) continue;
    let best: PlanNode | undefined;
    let bestScore = 0;
    for (const b of nodesB) {
      if (bToA.has(b.id) || isScanAnchor(b) || (sameTypeOnly && a.type !== b.type)) continue;
      const set = anchorsB.get(b.id)!;
      let inter = 0;
      for (const x of mapped) if (set.has(x)) inter++;
      if (inter === 0) continue;
      const jaccard = inter / (mapped.size + set.size - inter);
      if (jaccard < 0.5) continue;
      const score = jaccard + (a.type === b.type ? 0.5 : 0) + (a.joinType === b.joinType ? 0.05 : 0) - 0.001 * Math.abs(a.children.length - b.children.length);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best) link(a, best);
  }

  // 3. поддеревья без обращений к таблицам (Result, Values и т. п.): сопоставляем по одинаковой форме
  const shape = (n: PlanNode): string => `${n.type}(${n.children.map(shape).join(',')})`;
  const hasAnchor = (n: PlanNode) => subtree(n).some(isScanAnchor);
  const linkSubtrees = (a: PlanNode, b: PlanNode) => {
    link(a, b);
    a.children.forEach((c, i) => linkSubtrees(c, b.children[i]!));
  };
  for (const a of nodesA) {
    if (aToB.has(a.id) || hasAnchor(a) || subtree(a).some((x) => aToB.has(x.id))) continue;
    const sa = shape(a);
    const b = nodesB.find((x) => !bToA.has(x.id) && !hasAnchor(x) && !subtree(x).some((y) => bToA.has(y.id)) && shape(x) === sa);
    if (b) linkSubtrees(a, b);
  }
  // 4. корни всегда сравниваются между собой
  if (!aToB.has(planA.root.id) && !bToA.has(planB.root.id)) link(planA.root, planB.root);

  // 5. структура: дети сопоставленных родителей с одинаковым типом, по порядку
  const fill = (a: PlanNode) => {
    const b = aToB.get(a.id);
    if (b) {
      const freeA = a.children.filter((c) => !aToB.has(c.id));
      const freeB = b.children.filter((c) => !bToA.has(c.id));
      for (const ca of freeA) {
        const cb = freeB.find((x) => !bToA.has(x.id) && x.type === ca.type && !isScanAnchor(x) === !isScanAnchor(ca));
        if (cb) link(ca, cb);
      }
    }
    a.children.forEach(fill);
  };
  fill(planA.root);

  const pairs: Pair[] = [];
  const byA = new Map<number, Pair>();
  const byB = new Map<number, Pair>();
  for (const a of nodesA) {
    const b = aToB.get(a.id);
    if (!b) continue;
    const pair: Pair = { a, b, changes: nodeChanges(a, b, planA.analyzed && planB.analyzed) };
    pairs.push(pair);
    byA.set(a.id, pair);
    byB.set(b.id, pair);
  }
  return { pairs, removed: nodesA.filter((n) => !aToB.has(n.id)), added: nodesB.filter((n) => !bToA.has(n.id)), byA, byB };
}

const ms = (v: number): number => Math.round(v * 100) / 100;

function nodeChanges(a: PlanNode, b: PlanNode, analyzed: boolean): FieldChange[] {
  const out: FieldChange[] = [];
  const push = (kind: ChangeKind, title: string, x: string | number | undefined, y: string | number | undefined) => {
    if (x !== y) out.push({ kind, title, a: x, b: y });
  };
  if (a.type !== b.type || a.index !== b.index) {
    const scan = /Scan/.test(a.type) || /Scan/.test(b.type);
    push(scan ? 'access' : 'join', scan ? 'Метод доступа' : 'Операция', label(a), label(b));
  } else if (a.joinType !== b.joinType) {
    push('join', 'Вид соединения', a.joinType, b.joinType);
  }
  push('condition', 'Фильтр', a.filter, b.filter);
  push('condition', 'Условие индекса', a.indexCond, b.indexCond);
  push('condition', 'Условие хеша', a.hashCond, b.hashCond);
  push('condition', 'Условие слияния', a.mergeCond, b.mergeCond);
  push('condition', 'Фильтр соединения', a.joinFilter, b.joinFilter);
  if (a.sortKey?.join(', ') !== b.sortKey?.join(', ')) push('condition', 'Ключ сортировки', a.sortKey?.join(', '), b.sortKey?.join(', '));
  if (a.planRows !== undefined && b.planRows !== undefined && Math.abs(a.planRows - b.planRows) > 0.05 * Math.max(a.planRows, b.planRows, 1)) push('estimate', 'Оценка строк', a.planRows, b.planRows);
  if (analyzed) {
    if (!a.neverExecuted && !b.neverExecuted) {
      const ra = totalRows(a);
      const rb = totalRows(b);
      if (Math.abs(ra - rb) > 0.01 * Math.max(ra, rb, 1)) push('rows', 'Строк (факт)', Math.round(ra), Math.round(rb));
      if ((a.actualLoops ?? 1) !== (b.actualLoops ?? 1) && !/Parallel|Gather/.test(a.type + b.type)) push('rows', 'Запусков', a.actualLoops, b.actualLoops);
    } else if (a.neverExecuted !== b.neverExecuted) {
      push('rows', 'Выполнялся', a.neverExecuted ? 'нет' : 'да', b.neverExecuted ? 'нет' : 'да');
    }
    const ea = exclusiveMs(a);
    const eb = exclusiveMs(b);
    if (Math.abs(ea - eb) >= 0.5 && Math.abs(ea - eb) > 0.2 * Math.max(ea, eb)) push('time', 'Собственное время, мс', ms(ea), ms(eb));
  }
  push('memory', 'Сортировка', a.sortMethod && `${a.sortMethod} (${a.sortSpace ?? '?'} ${a.sortSpaceKb ?? '?'} КБ)`, b.sortMethod && `${b.sortMethod} (${b.sortSpace ?? '?'} ${b.sortSpaceKb ?? '?'} КБ)`);
  push('memory', 'Пакетов хеша', a.hashBatches, b.hashBatches);
  push('io', 'Удалено фильтром', a.rowsRemovedFilter, b.rowsRemovedFilter);
  push('io', 'Обращений к куче', a.heapFetches, b.heapFetches);
  const tmp = (n: PlanNode) => (n.buffers?.tempRead ?? 0) + (n.buffers?.tempWritten ?? 0);
  if (tmp(a) !== tmp(b)) push('io', 'Временные блоки', tmp(a), tmp(b));
  if ((a.buffers?.sharedRead ?? 0) !== (b.buffers?.sharedRead ?? 0)) push('io', 'Чтений с диска (блоков)', a.buffers?.sharedRead ?? 0, b.buffers?.sharedRead ?? 0);
  push('parallel', 'Рабочих процессов', a.workersLaunched, b.workersLaunched);
  push('parallel', 'Запланировано рабочих', a.workersPlanned, b.workersPlanned);
  return out;
}
