import { numberNodes, PlanParseError } from './types.ts';
import type { Buffers, Plan, PlanNode } from './types.ts';

const NODE_RE = /^(?<indent>\s*)(?<arrow>->\s+)?(?<title>.+?)\s+\(cost=(?<sc>[\d.]+)\.\.(?<tc>[\d.]+) rows=(?<rows>\d+) width=(?<width>\d+)\)(?:\s+\(actual (?:time=(?<at>[\d.]+)\.\.(?<att>[\d.]+) )?rows=(?<arows>[\d.]+) loops=(?<loops>\d+)\)|\s+\((?<never>never executed)\))?\s*$/;
const LABEL_RE = /^(?<kind>InitPlan|SubPlan|CTE)\s+(?<rest>\S.*)$/;
const NO_REL = new Set(['Function Scan', 'Values Scan', 'CTE Scan', 'Subquery Scan', 'WorkTable Scan', 'Table Function Scan', 'Named Tuplestore Scan']);
const MODIFY = new Set(['Insert', 'Update', 'Delete', 'Merge']);
const JOIN_WORDS = ['Right Semi', 'Right Anti', 'Left', 'Right', 'Full', 'Semi', 'Anti'];

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s;
}

/** Разбирает заголовок узла: «Parallel Index Scan Backward using i on public.t a» и т. п. */
function parseTitle(title: string, n: PlanNode): void {
  const m = /^(?<type>.*?)(?: using (?<index>\S+))?(?: on (?<target>\S+)(?: (?<alias>\S+))?)?$/.exec(title.trim());
  let type = (m?.groups?.['type'] ?? title).trim();
  const index = m?.groups?.['index'];
  const target = m?.groups?.['target'];
  const alias = m?.groups?.['alias'];
  // соединения: «Hash Left Join», «Nested Loop Semi Join», «Parallel Hash Join»
  const jm = /^(Parallel )?(Hash|Merge|Nested Loop)(?: (.+?))? Join$/.exec(type);
  if (jm) {
    n.joinType = jm[3] && JOIN_WORDS.includes(jm[3]) ? jm[3] : 'Inner';
    type = `${jm[1] ?? ''}${jm[2]}${jm[2] === 'Nested Loop' ? '' : ' Join'}`;
  } else if (type === 'Nested Loop') {
    n.joinType = 'Inner';
  }
  const modify = /^(Insert|Update|Delete|Merge)$/.test(type) ? type : undefined;
  n.type = modify ?? type;
  if (index) n.index = unquote(index);
  if (target) {
    const t = unquote(target);
    if (type === 'Bitmap Index Scan') {
      n.index = unquote(target);
    } else if (NO_REL.has(type)) {
      n.alias = alias ? unquote(alias) : t;
      if (type === 'Function Scan') n.props['Function Name'] = t;
      if (type === 'CTE Scan') n.props['CTE Name'] = t;
    } else {
      const raw = unquote(target);
      const dot = target.includes('.') && !target.startsWith('"') ? raw.indexOf('.') : -1;
      if (dot > 0) {
        n.schema = raw.slice(0, dot);
        n.relation = raw.slice(dot + 1);
      } else {
        n.relation = raw;
      }
      n.alias = alias ? unquote(alias) : n.relation;
    }
  }
  if (MODIFY.has(n.type) && n.relation === undefined && target) n.relation = unquote(target);
}

const toNum = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

function parseBuffers(rest: string): Buffers {
  const b: Buffers = {};
  for (const m of rest.matchAll(/(shared|local|temp)\s+((?:[a-z]+=\d+\s*)+)/g)) {
    for (const kv of m[2]!.matchAll(/([a-z]+)=(\d+)/g)) {
      const key = `${m[1]}${kv[1]![0]!.toUpperCase()}${kv[1]!.slice(1)}` as keyof Buffers;
      b[key] = Number(kv[2]);
    }
  }
  return b;
}

/** Применяет строку-свойство «Ключ: значение» (возможно, несколько через два пробела). */
function applyDetail(n: PlanNode, line: string): void {
  const text = line.trim();
  if (text === '') return;
  if (/^Worker \d+:/.test(text)) {
    const k = text.slice(0, text.indexOf(':'));
    n.props[k] = text.slice(text.indexOf(':') + 1).trim();
    return;
  }
  if (text.startsWith('Buffers:')) {
    n.buffers = { ...n.buffers, ...parseBuffers(text.slice(8)) };
    return;
  }
  const segs = text.split(/\s{2,}(?=[A-Z][A-Za-z ]*: )/);
  for (const seg of segs) {
    const c = seg.indexOf(': ');
    const colonAtEnd = seg.endsWith(':');
    if (c < 0 && !colonAtEnd) continue;
    const key = seg.slice(0, c < 0 ? seg.length - 1 : c).trim();
    const value = c < 0 ? '' : seg.slice(c + 2).trim();
    const int = (s: string): number | undefined => toNum(/^-?[\d.]+/.exec(s)?.[0]);
    switch (key) {
      case 'Disabled': n.disabled = value === 'true'; break;
      case 'Filter': n.filter = value; break;
      case 'Index Cond': n.indexCond = value; break;
      case 'Recheck Cond': n.recheckCond = value; break;
      case 'Hash Cond': n.hashCond = value; break;
      case 'Merge Cond': n.mergeCond = value; break;
      case 'Join Filter': n.joinFilter = value; break;
      case 'Rows Removed by Filter': n.rowsRemovedFilter = int(value); break;
      case 'Rows Removed by Join Filter': n.rowsRemovedJoinFilter = int(value); break;
      case 'Rows Removed by Index Recheck': n.rowsRemovedRecheck = int(value); break;
      case 'Heap Fetches': n.heapFetches = int(value); break;
      case 'Sort Key': n.sortKey = value.split(/,\s*(?![^()]*\))/); break;
      case 'Sort Method': n.sortMethod = value; break;
      case 'Memory':
      case 'Disk':
        if (n.sortMethod !== undefined) {
          n.sortSpace = key;
          n.sortSpaceKb = int(value);
        } else {
          n.props[key] = value;
        }
        break;
      case 'Buckets': n.hashBuckets = int(value); break;
      case 'Batches': n.hashBatches = int(value); break;
      case 'Memory Usage': n.memoryKb = int(value); break;
      case 'Workers Planned': n.workersPlanned = int(value); break;
      case 'Workers Launched': n.workersLaunched = int(value); break;
      default: n.props[key] = value;
    }
  }
}

export function parseTextPlan(text: string): Plan {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  type Entry = { node: PlanNode; col: number };
  const stack: Entry[] = [];
  let root: PlanNode | undefined;
  let pendingLabel: { name: string; kind: string; col: number } | undefined;
  let footer = false;
  let baseCol = 0; // отступ корня: psql добавляет к каждой строке пробел
  let planningTime: number | undefined;
  let executionTime: number | undefined;
  let analyzed = false;
  const triggers: Plan['triggers'] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\s+$/, '');
    if (raw === '' || /^\s*-+(\+-+)*\s*$/.test(raw) || /^\s*QUERY PLAN\s*$/.test(raw) || /^\(\d+ rows?\)$/.test(raw.trim())) continue;
    const lineNo = i + 1;
    const nm = NODE_RE.exec(raw);
    const col0 = raw.length - raw.trimStart().length;

    if (footer || (root && col0 <= baseCol && !nm)) {
      footer = true;
      const t = raw.trim();
      const pt = /^Planning [Tt]ime:\s*([\d.]+) ms/.exec(t);
      const et = /^(?:Execution [Tt]ime|Total runtime):\s*([\d.]+) ms/.exec(t);
      const tg = /^Trigger (.+?):\s*(?:time=([\d.]+))?\s*(?:calls=(\d+))?$/.exec(t);
      if (pt) planningTime = Number(pt[1]);
      else if (et) {
        executionTime = Number(et[1]);
        analyzed = true;
      } else if (tg) triggers.push({ name: tg[1]!, time: toNum(tg[2]), calls: toNum(tg[3]) });
      continue;
    }

    if (nm?.groups) {
      const g = nm.groups;
      const arrowCol = g['arrow'] ? (g['indent']?.length ?? 0) : 0;
      const titleCol = (g['indent']?.length ?? 0) + (g['arrow']?.length ?? 0);
      const n: PlanNode = { id: 0, type: '', props: {}, children: [] };
      parseTitle(g['title']!, n);
      n.startupCost = Number(g['sc']);
      n.totalCost = Number(g['tc']);
      n.planRows = Number(g['rows']);
      n.planWidth = Number(g['width']);
      if (g['arows'] !== undefined) {
        analyzed = true;
        if (g['at'] !== undefined) {
          n.actualStartup = Number(g['at']);
          n.actualTotal = Number(g['att']);
        }
        n.actualRows = Number(g['arows']);
        n.actualLoops = Number(g['loops']);
        if (n.actualLoops === 0) n.neverExecuted = true;
      } else if (g['never']) {
        analyzed = true;
        n.neverExecuted = true;
        n.actualStartup = 0;
        n.actualTotal = 0;
        n.actualRows = 0;
        n.actualLoops = 0;
      }
      if (!root) {
        if (g['arrow']) throw new PlanParseError('первая строка плана не должна начинаться со стрелки "->"', lineNo);
        root = n;
        baseCol = titleCol;
        stack.push({ node: n, col: titleCol });
        continue;
      }
      if (!g['arrow']) throw new PlanParseError('узел без "->" после корня: неверные отступы', lineNo);
      const labelCol = pendingLabel?.col ?? Infinity;
      const useLabel = pendingLabel !== undefined && arrowCol > labelCol;
      while (stack.length > 1 && stack[stack.length - 1]!.col >= arrowCol) stack.pop();
      const parent = stack[stack.length - 1]!.node;
      if (useLabel && pendingLabel) {
        n.subplanName = pendingLabel.name;
        n.parentRel = pendingLabel.kind === 'CTE' ? 'InitPlan' : pendingLabel.kind;
        pendingLabel = undefined;
      } else {
        pendingLabel = undefined;
      }
      parent.children.push(n);
      stack.push({ node: n, col: titleCol });
      continue;
    }

    // служебные строки подпланов: «SubPlan 1», «InitPlan 1 (returns $0)», «CTE x»
    const lm = LABEL_RE.exec(raw.trim());
    if (lm?.groups && root) {
      const text = raw.trim();
      pendingLabel = { name: lm.groups['kind'] === 'CTE' ? `CTE ${lm.groups['rest']}` : text, kind: lm.groups['kind']!, col: col0 };
      while (stack.length > 1 && stack[stack.length - 1]!.col >= col0) stack.pop();
      continue;
    }

    if (!root) continue; // шапка до первого узла
    // свойство узла
    while (stack.length > 1 && stack[stack.length - 1]!.col >= col0) stack.pop();
    applyDetail(stack[stack.length - 1]!.node, raw);
  }
  if (!root) throw new PlanParseError('не найден ни один узел плана: нужен вывод EXPLAIN с оценками стоимости (cost=…), без COSTS OFF');
  numberNodes(root);
  return { root, analyzed, planningTime, executionTime, triggers, source: 'text' };
}
