import type { PlanNode } from '../../src/types.ts';

const round = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 100) / 100);

/** Структура узла, которая обязана совпасть у JSON и текста одного и того же плана. */
export function sig(n: PlanNode, analyzed: boolean, inParallel = false): unknown {
  // под Gather число строк зависит от того, сколько рабочих успело взять работу (частичные агрегаты дают по строке на рабочего)
  const par = inParallel || n.type === 'Gather' || n.type === 'Gather Merge';
  return {
    type: n.type,
    relation: n.relation,
    alias: n.alias,
    index: n.index,
    joinType: n.joinType,
    subplanName: n.subplanName,
    parentRel: n.parentRel,
    startupCost: n.startupCost,
    totalCost: n.totalCost,
    planRows: n.planRows,
    planWidth: n.planWidth,
    workersPlanned: n.workersPlanned,
    sortMethod: n.sortMethod,
    hashBatches: n.hashBatches,
    // при параллельном выполнении строки делятся между рабочими случайно: сравниваем сумму «строки × запуски»
    ...(analyzed ? { totalRows: par ? 'любое' : round((n.actualRows ?? 0) * (n.actualLoops ?? 0)), neverExecuted: n.neverExecuted ?? false } : {}),
    children: n.children.map((c) => sig(c, analyzed, par)),
  };
}
