import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffPlans } from '../src/diff.ts';
import { compareInsights, insights, timesWord } from '../src/insights.ts';
import { exclusiveMs, inclusiveMs, label, misestimate } from '../src/metrics.ts';
import { parsePlan } from '../src/parse.ts';
import { compare } from '../src/summary.ts';
import { allNodes, numberNodes } from '../src/types.ts';
import type { Plan, PlanNode } from '../src/types.ts';
import { fixture, pg18 } from './fixtures.ts';

const jp = (name: string): Plan => parsePlan(fixture(name).jsonAnalyze);
const codes = (p: Plan) => insights(p).map((i) => i.code);

const pairs = pg18.plans.map((p) => p.name).filter((n) => !n.includes('@idx') && pg18.plans.some((p) => p.name === n + '@idx'));

test('диф плана с самим собой: каждый узел сопоставлен с собой, изменений нет', () => {
  for (const p of pg18.plans) {
    const a = parsePlan(p.jsonAnalyze);
    const b = parsePlan(p.jsonAnalyze);
    const d = diffPlans(a, b);
    assert.equal(d.pairs.length, allNodes(a).length, p.name);
    assert.equal(d.removed.length + d.added.length, 0, p.name);
    for (const pair of d.pairs) {
      assert.equal(pair.a.id, pair.b.id, `${p.name}: узел ${pair.a.type}`);
      assert.deepEqual(pair.changes, [], `${p.name}: ${pair.a.type}`);
    }
  }
});

test('диф JSON и текста одного плана: структура совпадает один в один', () => {
  for (const p of pg18.plans) {
    const d = diffPlans(parsePlan(p.jsonAnalyze), parsePlan(p.textAnalyze));
    assert.equal(d.removed.length + d.added.length, 0, p.name);
    for (const pair of d.pairs) {
      assert.equal(pair.a.id, pair.b.id, p.name);
      const structural = pair.changes.filter((c) => ['access', 'join', 'condition'].includes(c.kind));
      assert.deepEqual(structural, [], `${p.name}: ${pair.a.type}`);
    }
  }
});

test('диф симметричен: число пар одинаково, добавленные и убранные меняются местами (все пары «до/после индекса» и все пары подряд)', () => {
  const list = [...pairs.map((n) => [n, n + '@idx'] as const), ...pg18.plans.slice(1).map((p, i) => [pg18.plans[i]!.name, p.name] as const)];
  for (const [x, y] of list) {
    const a = jp(x);
    const b = jp(y);
    const ab = diffPlans(a, b);
    const ba = diffPlans(jp(y), jp(x));
    assert.equal(ab.pairs.length + ab.removed.length, allNodes(a).length, `${x}→${y}: всё покрыто`);
    assert.equal(ab.pairs.length + ab.added.length, allNodes(b).length, `${x}→${y}: всё покрыто`);
    assert.equal(ab.pairs.length, ba.pairs.length, `${x}↔${y}`);
    assert.equal(ab.removed.length, ba.added.length, `${x}↔${y}`);
    assert.equal(ab.added.length, ba.removed.length, `${x}↔${y}`);
  }
});

/** Оборачивает корень плана в новый узел. */
function wrap(p: Plan, type: string): Plan {
  const root: PlanNode = { id: 0, type, props: {}, children: [p.root], startupCost: 1, totalCost: 2, planRows: 1, planWidth: 4 };
  numberNodes(root);
  return { ...p, root };
}

test('метаморфический: лишний узел сверху плана — это один «добавленный» узел, остальное сопоставлено с собой', () => {
  for (const p of pg18.plans) {
    const a = parsePlan(p.jsonAnalyze);
    const b = wrap(parsePlan(p.jsonAnalyze), 'Unique');
    const d = diffPlans(a, b);
    assert.deepEqual(d.added.map((n) => n.type), ['Unique'], p.name);
    assert.equal(d.removed.length, 0, p.name);
    assert.equal(d.pairs.length, allNodes(a).length, p.name);
  }
});

test('реальные пары: Sort убран, Limit остался; изменение метода доступа найдено', () => {
  const c = compare(jp('sort_topn'), jp('sort_topn@idx'));
  assert.deepEqual(c.diff.removed.map((n) => n.type), ['Sort']);
  assert.equal(c.diff.byA.get(0)!.b.type, 'Limit', 'корень Limit сопоставлен с Limit');
  assert.ok(c.findings.some((f) => f.kind === 'access' && /Seq Scan on orders → Index Scan Backward using orders_total_idx/.test(f.text)), JSON.stringify(c.findings));
  assert.equal(c.verdict, 'faster');
  assert.match(c.headline, /^План B быстрее A в [\d\s ]+ раз/);

  const s = compare(jp('subplan'), jp('subplan@idx'));
  assert.ok((s.speedup ?? 0) > 100);
  assert.ok(s.findings.some((f) => f.kind === 'access' && /Seq Scan on orders o → Bitmap Heap Scan on orders o/.test(f.text)));
  assert.ok(s.findings.some((f) => f.kind === 'structure' && /добавлено: Bitmap Index Scan/.test(f.text)));

  const e = compare(jp('exists_semijoin'), jp('exists_semijoin@idx'));
  assert.ok(e.findings.some((f) => f.kind === 'join' && /Inner → Semi/.test(f.text)));
});

test('подсказки: сортировка на диске исправлена индексом, отсев при Seq Scan, ошибка оценки', () => {
  const spill = compare(jp('sort_spill'), jp('sort_spill@idx'));
  assert.ok(spill.fixed.some((i) => i.code === 'sort-spill'));
  assert.ok(codes(jp('sort_spill')).includes('sort-spill'));
  assert.ok(codes(jp('hash_join')).includes('seq-scan-filter'));
  assert.ok(codes(jp('misestimate')).includes('misestimate'));
  const hj = compare(jp('hash_join'), jp('hash_join@idx'));
  assert.ok(hj.fixed.some((i) => i.code === 'seq-scan-filter'));
});

test('ложных срабатываний нет там, где они были бы ошибкой: Limit обрывает чтение, параллельное время суммируется', () => {
  assert.ok(!codes(jp('sort_topn@idx')).includes('misestimate'), 'под Limit фактическое число строк обрезано намеренно');
  assert.ok(!codes(jp('sort_topn')).includes('misestimate'));
  for (const name of ['parallel_count', 'parallel_sort', 'agg_group@idx']) {
    const p = jp(name);
    for (const i of insights(p).filter((x) => x.code === 'dominant-node')) {
      const n = allNodes(p).find((x) => x.id === i.nodeId)!;
      assert.ok(exclusiveMs(n) <= (p.executionTime ?? 0), `${name}: доля не должна превышать 100%`);
    }
  }
  assert.deepEqual(codes(jp('nested_loop_never_executed')), []);
  assert.deepEqual(codes(jp('index_scan')).filter((c) => c !== 'dominant-node'), []);
});

test('собственное время: сумма по узлам равна времени корня (план без параллельности)', () => {
  for (const name of ['hash_join', 'sort_spill', 'seqscan_filter', 'sort_topn']) {
    const p = jp(name);
    const sum = allNodes(p).reduce((s, n) => s + exclusiveMs(n), 0);
    assert.ok(Math.abs(sum - inclusiveMs(p.root)) < 1e-6, `${name}: ${sum} против ${inclusiveMs(p.root)}`);
  }
});

test('синтетические планы: рабочие, хеш в пакетах, куча у Index Only Scan, подзапрос тысячи раз, отключённый узел', () => {
  const p = parsePlan(`Gather  (cost=1.00..100.00 rows=10 width=4) (actual time=1.0..50.0 rows=10 loops=1)
  Workers Planned: 4
  Workers Launched: 1
  ->  Hash Join  (cost=1.00..90.00 rows=10 width=4) (actual time=1.0..40.0 rows=10 loops=2)
        Hash Cond: (a.id = b.id)
        ->  Index Only Scan using a_idx on a  (cost=0.00..10.00 rows=500 width=4) (actual time=0.1..20.0 rows=500 loops=2)
              Heap Fetches: 900
        ->  Hash  (cost=1.00..1.00 rows=1 width=4) (actual time=0.1..0.1 rows=1 loops=2)
              Buckets: 1024  Batches: 8  Memory Usage: 100kB
              ->  Seq Scan on b  (cost=0.00..1.00 rows=1 width=4) (actual time=0.0..0.1 rows=1 loops=2)
                    Disabled: true
Execution Time: 60.0 ms`);
  const c = new Set(insights(p).map((i) => i.code));
  for (const want of ['workers-short', 'hash-spill', 'heap-fetches', 'disabled-node']) assert.ok(c.has(want), `${want} в ${[...c]}`);
  const sub = parsePlan(`Seq Scan on t  (cost=0.00..100.00 rows=10 width=4) (actual time=0.0..90.0 rows=10 loops=1)
  SubPlan 1
    ->  Seq Scan on u  (cost=0.00..1.00 rows=1 width=4) (actual time=0.0..0.01 rows=1 loops=20000)
Execution Time: 91.0 ms`);
  const i = insights(sub).find((x) => x.code === 'subplan-loops');
  assert.equal(i?.severity, 'bad');
  assert.match(i!.title, /20[\s ]000 раз/);
  const nl = parsePlan(`Nested Loop  (cost=0.00..10.00 rows=1 width=4) (actual time=0.0..90.0 rows=100 loops=1)
  ->  Seq Scan on o  (cost=0.00..1.00 rows=1 width=4) (actual time=0.0..1.0 rows=12000 loops=1)
  ->  Index Scan using i on c  (cost=0.00..1.00 rows=1 width=4) (actual time=0.0..0.005 rows=1 loops=12000)
Execution Time: 91.0 ms`);
  assert.ok(insights(nl).some((x) => x.code === 'nested-loop-many'));
});

test('подписи узлов и ошибка оценки', () => {
  assert.equal(label(jp('update_dml').root.children[0]!), 'Index Scan using orders_pkey on orders');
  assert.equal(label(jp('update_dml').root), 'Update on orders');
  const hj = jp('hash_join');
  assert.equal(label(hj.root), 'Hash Join');
  assert.equal(label(parsePlan('Hash Left Join  (cost=0.00..1.00 rows=1 width=4)\n  ->  Seq Scan on a x  (cost=0.00..1.00 rows=1 width=4)').root), 'Hash Left Join');
  const m = misestimate(jp('misestimate').root.children[0]!)!;
  assert.ok(m.factor > 5 && m.direction === 'under');
  assert.equal(misestimate(parsePlan(fixture('seqscan_filter').jsonCosts).root), undefined, 'без ANALYZE ошибки оценки нет');
});

test('склонение «в N раз»', () => {
  const cases: [number, string][] = [[1.4, 'в 1,4 раза'], [2, 'в 2 раза'], [5, 'в 5 раз'], [11, 'в 11 раз'], [21, 'в 21 раз'], [22, 'в 22 раза'], [112, 'в 112 раз'], [1334, 'в 1 334 раза'], [9.96, 'в 10 раз']];
  for (const [v, want] of cases) assert.equal(timesWord(v).replace(/\s/g, ' '), want.replace(/\s/g, ' '), String(v));
});

test('сравнение без ANALYZE идёт по стоимости и честно об этом говорит; планы одинаковой скорости не выдаются за разные', () => {
  const a = parsePlan(fixture('seqscan_filter').jsonCosts);
  const b = parsePlan(fixture('index_scan').jsonCosts);
  const c = compare(a, b);
  assert.equal(c.basis, 'cost');
  assert.match(c.headline, /оценк/);
  const same = compare(jp('hash_join'), jp('hash_join'));
  assert.equal(same.verdict, 'same');
  assert.match(same.headline, /одинаково/);
  // планы разной природы: A с ANALYZE, B без — сравнивать время нельзя
  const mixed = compare(jp('hash_join'), parsePlan(fixture('hash_join').jsonCosts));
  assert.equal(mixed.basis, 'cost');
});

test('compareInsights: подсказка узла, у которого нет пары, считается исправленной; новая — появившейся', () => {
  const a = jp('sort_spill');
  const b = jp('sort_spill@idx');
  const d = diffPlans(a, b);
  const r = compareInsights(insights(a), insights(b), d);
  assert.ok(r.fixed.some((i) => i.code === 'sort-spill'));
  const back = compareInsights(insights(b), insights(a), diffPlans(b, a));
  assert.ok(back.introduced.some((i) => i.code === 'sort-spill'));
});
