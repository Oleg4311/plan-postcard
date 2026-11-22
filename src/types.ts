/** Блоки буферов узла плана (BUFFERS). */
export interface Buffers {
  sharedHit?: number;
  sharedRead?: number;
  sharedDirtied?: number;
  sharedWritten?: number;
  localHit?: number;
  localRead?: number;
  localDirtied?: number;
  localWritten?: number;
  tempRead?: number;
  tempWritten?: number;
}

/**
 * Узел плана в одинаковом виде для JSON и текстового формата EXPLAIN:
 * тип нормализован к тому, как его печатает текстовый формат («Parallel Seq Scan», «HashAggregate», «Update»),
 * а соединения хранят вид отдельно (`joinType`).
 */
export interface PlanNode {
  /** Номер в обходе в глубину, с 0. */
  id: number;
  type: string;
  relation?: string;
  schema?: string;
  alias?: string;
  index?: string;
  joinType?: string;
  /** Имя InitPlan/SubPlan/CTE, если узел является их корнем. */
  subplanName?: string;
  parentRel?: string;
  startupCost?: number;
  totalCost?: number;
  planRows?: number;
  planWidth?: number;
  actualStartup?: number;
  actualTotal?: number;
  /** Среднее число строк за один запуск (как в EXPLAIN). */
  actualRows?: number;
  actualLoops?: number;
  neverExecuted?: boolean;
  /** Узел выбран при отключённом enable_* (PostgreSQL 18 помечает такие узлы). */
  disabled?: boolean;
  filter?: string;
  indexCond?: string;
  recheckCond?: string;
  hashCond?: string;
  mergeCond?: string;
  joinFilter?: string;
  rowsRemovedFilter?: number;
  rowsRemovedJoinFilter?: number;
  rowsRemovedRecheck?: number;
  heapFetches?: number;
  sortKey?: string[];
  sortMethod?: string;
  /** Где сортировали: в памяти или на диске. */
  sortSpace?: 'Memory' | 'Disk';
  sortSpaceKb?: number;
  hashBatches?: number;
  hashBuckets?: number;
  memoryKb?: number;
  workersPlanned?: number;
  workersLaunched?: number;
  buffers?: Buffers;
  /** Остальные строки-свойства узла как есть (для показа). */
  props: Record<string, string>;
  children: PlanNode[];
}

export interface Plan {
  root: PlanNode;
  /** Есть ли фактические данные (EXPLAIN ANALYZE). */
  analyzed: boolean;
  planningTime?: number;
  executionTime?: number;
  triggers: { name: string; time?: number; calls?: number }[];
  source: 'json' | 'text';
}

export class PlanParseError extends Error {
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(line ? `${message} (строка ${line})` : message);
    this.name = 'PlanParseError';
    this.line = line;
  }
}

/** Обход в глубину в порядке id. */
export function walk(node: PlanNode, fn: (n: PlanNode, depth: number, parent?: PlanNode) => void, depth = 0, parent?: PlanNode): void {
  fn(node, depth, parent);
  for (const c of node.children) walk(c, fn, depth + 1, node);
}

export function allNodes(plan: Plan): PlanNode[] {
  const out: PlanNode[] = [];
  walk(plan.root, (n) => out.push(n));
  return out;
}

export function numberNodes(root: PlanNode): void {
  let i = 0;
  walk(root, (n) => {
    n.id = i++;
  });
}
