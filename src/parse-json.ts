import { numberNodes, PlanParseError } from './types.ts';
import type { Buffers, Plan, PlanNode } from './types.ts';

type J = Record<string, unknown>;

const PARALLEL_CAPABLE = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan', 'Hash Join', 'Hash', 'Append', 'Foreign Scan', 'Custom Scan']);
const KNOWN = new Set([
  'Node Type', 'Parent Relationship', 'Parallel Aware', 'Async Capable', 'Relation Name', 'Schema', 'Alias', 'Index Name', 'Join Type', 'Subplan Name',
  'Startup Cost', 'Total Cost', 'Plan Rows', 'Plan Width', 'Actual Startup Time', 'Actual Total Time', 'Actual Rows', 'Actual Loops', 'Plans',
  'Filter', 'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Rows Removed by Filter', 'Rows Removed by Join Filter', 'Rows Removed by Index Recheck',
  'Heap Fetches', 'Sort Key', 'Sort Method', 'Sort Space Used', 'Sort Space Type', 'Hash Batches', 'HashAgg Batches', 'Hash Buckets', 'Peak Memory Usage', 'Original Hash Batches', 'Original Hash Buckets',
  'Workers Planned', 'Workers Launched', 'Workers', 'Operation', 'Strategy', 'Partial Mode', 'Scan Direction', 'Disabled',
  'Shared Hit Blocks', 'Shared Read Blocks', 'Shared Dirtied Blocks', 'Shared Written Blocks', 'Local Hit Blocks', 'Local Read Blocks', 'Local Dirtied Blocks', 'Local Written Blocks',
  'Temp Read Blocks', 'Temp Written Blocks', 'Shared I/O Read Time', 'Shared I/O Write Time', 'Local I/O Read Time', 'Local I/O Write Time', 'Temp I/O Read Time', 'Temp I/O Write Time', 'I/O Read Time', 'I/O Write Time',
]);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function normType(j: J): string {
  const t = str(j['Node Type']) ?? '?';
  if (t === 'ModifyTable') return str(j['Operation']) ?? 'ModifyTable';
  if (t === 'Aggregate') {
    const base = { Plain: 'Aggregate', Sorted: 'GroupAggregate', Hashed: 'HashAggregate', Mixed: 'MixedAggregate' }[str(j['Strategy']) ?? 'Plain'] ?? 'Aggregate';
    const mode = str(j['Partial Mode']);
    return mode === 'Partial' ? `Partial ${base}` : mode === 'Finalize' ? `Finalize ${base}` : base;
  }
  let out = t;
  if ((t === 'Index Scan' || t === 'Index Only Scan') && str(j['Scan Direction']) === 'Backward') out += ' Backward';
  if (j['Parallel Aware'] === true && PARALLEL_CAPABLE.has(t)) out = `Parallel ${out}`;
  return out;
}

function buffers(j: J): Buffers | undefined {
  const map: [keyof Buffers, string][] = [
    ['sharedHit', 'Shared Hit Blocks'], ['sharedRead', 'Shared Read Blocks'], ['sharedDirtied', 'Shared Dirtied Blocks'], ['sharedWritten', 'Shared Written Blocks'],
    ['localHit', 'Local Hit Blocks'], ['localRead', 'Local Read Blocks'], ['localDirtied', 'Local Dirtied Blocks'], ['localWritten', 'Local Written Blocks'],
    ['tempRead', 'Temp Read Blocks'], ['tempWritten', 'Temp Written Blocks'],
  ];
  const b: Buffers = {};
  let any = false;
  for (const [k, jk] of map) {
    const v = num(j[jk]);
    if (v !== undefined) {
      b[k] = v;
      any = true;
    }
  }
  return any ? b : undefined;
}

function prop(v: unknown): string {
  return Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

function node(j: J, depth: number): PlanNode {
  if (depth > 200) throw new PlanParseError('план слишком глубокий');
  if (typeof j !== 'object' || j === null || typeof j['Node Type'] !== 'string') throw new PlanParseError('в JSON-плане у узла нет поля "Node Type"');
  const n: PlanNode = { id: 0, type: normType(j), props: {}, children: [] };
  const set = <K extends keyof PlanNode>(k: K, v: PlanNode[K] | undefined) => {
    if (v !== undefined) n[k] = v;
  };
  set('relation', str(j['Relation Name']));
  set('schema', str(j['Schema']));
  set('alias', str(j['Alias']));
  set('index', str(j['Index Name']));
  const jt = str(j['Join Type']);
  set('joinType', jt);
  set('subplanName', str(j['Subplan Name']));
  // «Outer»/«Inner»/«Member» в тексте не выражаются (там важен порядок детей); сохраняем только InitPlan и SubPlan
  const rel = str(j['Parent Relationship']);
  if (rel === 'InitPlan' || rel === 'SubPlan') n.parentRel = rel;
  set('startupCost', num(j['Startup Cost']));
  set('totalCost', num(j['Total Cost']));
  set('planRows', num(j['Plan Rows']));
  set('planWidth', num(j['Plan Width']));
  set('actualStartup', num(j['Actual Startup Time']));
  set('actualTotal', num(j['Actual Total Time']));
  set('actualRows', num(j['Actual Rows']));
  set('actualLoops', num(j['Actual Loops']));
  if (n.actualLoops === 0) n.neverExecuted = true;
  if (j['Disabled'] === true) n.disabled = true;
  set('filter', str(j['Filter']));
  set('indexCond', str(j['Index Cond']));
  set('recheckCond', str(j['Recheck Cond']));
  set('hashCond', str(j['Hash Cond']));
  set('mergeCond', str(j['Merge Cond']));
  set('joinFilter', str(j['Join Filter']));
  set('rowsRemovedFilter', num(j['Rows Removed by Filter']));
  set('rowsRemovedJoinFilter', num(j['Rows Removed by Join Filter']));
  set('rowsRemovedRecheck', num(j['Rows Removed by Index Recheck']));
  set('heapFetches', num(j['Heap Fetches']));
  if (Array.isArray(j['Sort Key'])) n.sortKey = j['Sort Key'].map(String);
  set('sortMethod', str(j['Sort Method']));
  const space = str(j['Sort Space Type']);
  if (space === 'Memory' || space === 'Disk') n.sortSpace = space;
  set('sortSpaceKb', num(j['Sort Space Used']));
  set('hashBatches', num(j['Hash Batches']) ?? num(j['HashAgg Batches']));
  set('hashBuckets', num(j['Hash Buckets']));
  set('memoryKb', num(j['Peak Memory Usage']));
  set('workersPlanned', num(j['Workers Planned']));
  set('workersLaunched', num(j['Workers Launched']));
  set('buffers', buffers(j));
  for (const [k, v] of Object.entries(j)) if (!KNOWN.has(k) && v !== null && v !== undefined) n.props[k] = prop(v);
  const kids = j['Plans'];
  if (Array.isArray(kids)) for (const k of kids) n.children.push(node(k as J, depth + 1));
  return n;
}

/** Достаёт JSON из вывода psql/pgAdmin: отбрасывает заголовок «QUERY PLAN» и рамки. */
export function extractJson(text: string): string {
  const start = text.search(/[[{]/);
  if (start < 0) throw new PlanParseError('в тексте нет JSON');
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (end < start) throw new PlanParseError('JSON не закрыт');
  return text.slice(start, end + 1);
}

export function parseJsonPlan(text: string): Plan {
  let doc: unknown;
  try {
    // psql -t и некоторые клиенты отдают JSON как строку в кавычках
    doc = JSON.parse(text.trimStart().startsWith('"') ? text.trim() : extractJson(text));
  } catch (e) {
    if (e instanceof PlanParseError) throw e;
    throw new PlanParseError(`неверный JSON: ${(e as Error).message}`);
  }
  // psql -t может обернуть строку в кавычки: тогда это строка с JSON внутри
  if (typeof doc === 'string') return parseJsonPlan(doc);
  const top = (Array.isArray(doc) ? doc[0] : doc) as J | undefined;
  if (!top || typeof top !== 'object' || typeof top['Plan'] !== 'object' || top['Plan'] === null) throw new PlanParseError('в JSON нет поля "Plan": это не результат EXPLAIN (FORMAT JSON)');
  const root = node(top['Plan'] as J, 0);
  numberNodes(root);
  const triggers = Array.isArray(top['Triggers'])
    ? (top['Triggers'] as J[]).map((t) => ({ name: str(t['Trigger Name']) ?? '?', time: num(t['Time']), calls: num(t['Calls']) }))
    : [];
  return {
    root,
    analyzed: num(top['Execution Time']) !== undefined || root.actualTotal !== undefined,
    planningTime: num(top['Planning Time']),
    executionTime: num(top['Execution Time']),
    triggers,
    source: 'json',
  };
}
