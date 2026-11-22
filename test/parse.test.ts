import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../src/parse.ts';
import { allNodes, PlanParseError } from '../src/types.ts';
import { fixture, pg18 } from './fixtures.ts';
import { sig } from './support/sig.ts';

test('JSON и текст одного плана дают одинаковое дерево (все 56 запросов PostgreSQL 18, с ANALYZE и без)', () => {
  for (const p of pg18.plans) {
    for (const [j, t, analyzed] of [[p.jsonAnalyze, p.textAnalyze, true], [p.jsonCosts, p.textCosts, false]] as const) {
      const a = parsePlan(j);
      const b = parsePlan(t);
      assert.equal(a.source, 'json');
      assert.equal(b.source, 'text');
      assert.equal(a.analyzed, analyzed, `${p.name}: analyzed (json)`);
      assert.equal(b.analyzed, analyzed, `${p.name}: analyzed (text)`);
      assert.deepEqual(sig(b.root, analyzed), sig(a.root, analyzed), `${p.name} (${analyzed ? 'ANALYZE' : 'costs'})`);
    }
  }
});

test('узлы пронумерованы подряд в обходе в глубину, у каждого есть свойства и дети', () => {
  for (const p of pg18.plans) {
    for (const src of [p.jsonAnalyze, p.textAnalyze]) {
      const ids = allNodes(parsePlan(src)).map((n) => n.id);
      assert.deepEqual(ids, ids.map((_, i) => i), p.name);
    }
  }
});

test('сортировка на диске, параллельный план, never executed и DML', () => {
  for (const src of [fixture('sort_spill').jsonAnalyze, fixture('sort_spill').textAnalyze]) {
    const sort = parsePlan(src).root;
    assert.equal(sort.type, 'Sort');
    assert.equal(sort.sortSpace, 'Disk');
    assert.match(sort.sortMethod ?? '', /external merge/);
    assert.ok((sort.sortSpaceKb ?? 0) > 1000);
    assert.deepEqual(sort.sortKey, ['total']);
    assert.ok((sort.buffers?.tempWritten ?? 0) > 0);
  }
  for (const src of [fixture('parallel_count').jsonAnalyze, fixture('parallel_count').textAnalyze]) {
    const nodes = allNodes(parsePlan(src));
    const gather = nodes.find((n) => n.type === 'Gather');
    assert.ok(gather, 'Gather есть');
    assert.equal(gather.workersPlanned, 2);
    assert.ok(nodes.some((n) => n.type === 'Parallel Seq Scan'));
  }
  for (const src of [fixture('nested_loop_never_executed').jsonAnalyze, fixture('nested_loop_never_executed').textAnalyze]) {
    const nl = parsePlan(src).root;
    assert.equal(nl.type, 'Nested Loop');
    assert.equal(nl.joinType, 'Inner');
    assert.equal(nl.children[0]!.neverExecuted ?? false, false);
    assert.equal(nl.children[1]!.neverExecuted, true);
    assert.equal(nl.children[1]!.actualLoops, 0);
  }
  for (const src of [fixture('update_dml').jsonAnalyze, fixture('update_dml').textAnalyze]) {
    const u = parsePlan(src).root;
    assert.equal(u.type, 'Update');
    assert.equal(u.relation, 'orders');
    assert.equal(u.children[0]!.type, 'Index Scan');
  }
});

test('подпланы, CTE, функции и VALUES', () => {
  for (const src of [fixture('subplan').jsonAnalyze, fixture('subplan').textAnalyze]) {
    const sub = allNodes(parsePlan(src)).find((n) => n.parentRel === 'SubPlan');
    assert.ok(sub, 'SubPlan есть');
    assert.equal(sub.subplanName, 'SubPlan 1');
    assert.equal(sub.type, 'Aggregate');
    assert.equal(sub.actualLoops, 49);
  }
  for (const src of [fixture('initplan').jsonAnalyze, fixture('initplan').textAnalyze]) {
    assert.ok(allNodes(parsePlan(src)).some((n) => n.parentRel === 'InitPlan' && /^InitPlan 1/.test(n.subplanName ?? '')));
  }
  for (const src of [fixture('cte_materialized').jsonAnalyze, fixture('cte_materialized').textAnalyze]) {
    const nodes = allNodes(parsePlan(src));
    assert.ok(nodes.some((n) => n.type === 'CTE Scan' && n.props['CTE Name'] === 'x'));
    assert.ok(nodes.some((n) => n.subplanName === 'CTE x'));
  }
  for (const src of [fixture('function_scan').jsonAnalyze, fixture('function_scan').textAnalyze]) {
    const f = parsePlan(src).root;
    assert.equal(f.type, 'Function Scan');
    assert.equal(f.alias, 'g');
    assert.equal(f.props['Function Name'], 'generate_series');
  }
  for (const src of [fixture('values_scan').jsonAnalyze, fixture('values_scan').textAnalyze]) {
    assert.equal(parsePlan(src).root.type, 'Values Scan');
  }
});

test('условия, удалённые строки, буферы, хеш и соединения', () => {
  for (const src of [fixture('hash_join').jsonAnalyze, fixture('hash_join').textAnalyze]) {
    const [hj, scan, hash] = [parsePlan(src).root, ...parsePlan(src).root.children];
    assert.equal(hj!.type, 'Hash Join');
    assert.equal(hj!.hashCond, '(o.customer_id = c.id)');
    assert.equal(scan!.type, 'Seq Scan');
    assert.equal(scan!.alias, 'o');
    assert.equal(scan!.filter, "(total > '900'::numeric)");
    assert.equal(scan!.rowsRemovedFilter, 180200);
    assert.ok((scan!.buffers?.sharedHit ?? 0) > 1000);
    assert.equal(hash!.type, 'Hash');
    assert.equal(hash!.hashBatches, 1);
    assert.ok((hash!.hashBuckets ?? 0) >= 1024);
    assert.ok((hash!.memoryKb ?? 0) > 100);
  }
  for (const src of [fixture('misestimate').jsonAnalyze, fixture('misestimate').textAnalyze]) {
    const scan = allNodes(parsePlan(src)).find((n) => /Seq Scan/.test(n.type))!;
    assert.ok((scan.actualRows ?? 0) * (scan.actualLoops ?? 1) > 5 * (scan.planRows ?? 1), 'оптимизатор сильно недооценил строки');
  }
});

test('планы разных видов соединений: Left/Semi/Anti и обратный индексный проход', () => {
  const txt = `Hash Right Semi Join  (cost=1.00..2.00 rows=10 width=4)
  Hash Cond: (a.id = b.id)
  ->  Index Scan Backward using a_idx on public.a  (cost=0.00..1.00 rows=10 width=4)
  ->  Hash  (cost=1.00..1.00 rows=1 width=4)
        ->  Parallel Index Only Scan using b_idx on b  (cost=0.00..1.00 rows=1 width=4)`;
  const p = parsePlan(txt);
  assert.equal(p.root.type, 'Hash Join');
  assert.equal(p.root.joinType, 'Right Semi');
  assert.equal(p.root.children[0]!.type, 'Index Scan Backward');
  assert.equal(p.root.children[0]!.schema, 'public');
  assert.equal(p.root.children[0]!.relation, 'a');
  assert.equal(p.root.children[1]!.children[0]!.type, 'Parallel Index Only Scan');
  assert.equal(p.analyzed, false);
  const nl = parsePlan('Nested Loop Left Join  (cost=0.00..1.00 rows=1 width=4)\n  ->  Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)\n  ->  Seq Scan on u  (cost=0.00..1.00 rows=1 width=4)');
  assert.equal(nl.root.type, 'Nested Loop');
  assert.equal(nl.root.joinType, 'Left');
});

test('вставка из psql: заголовок, ведущие пробелы, рамка строк и CRLF', () => {
  const t = fixture('hash_join').textAnalyze;
  const psql = ` QUERY PLAN\n${'-'.repeat(60)}\n${t.split('\n').map((l) => ' ' + l).join('\r\n')}\n(12 rows)\n`;
  const a = parsePlan(psql);
  const b = parsePlan(t);
  assert.deepEqual(sig(a.root, true), sig(b.root, true));
  assert.equal(a.executionTime, b.executionTime);
  assert.equal(a.planningTime, b.planningTime);
  // JSON из psql -t и pgAdmin: с заголовком, в кавычках, с BOM
  const j = fixture('hash_join').jsonAnalyze;
  assert.ok(parsePlan(`QUERY PLAN\n----\n${j}\n(1 row)`).root.type === 'Hash Join');
  assert.ok(parsePlan('﻿' + j).root.type === 'Hash Join');
  assert.ok(parsePlan(JSON.stringify(j)).root.type === 'Hash Join');
  assert.ok(parsePlan(JSON.stringify(JSON.parse(j)[0])).root.type === 'Hash Join', 'объект без внешнего массива');
});

test('старый формат (PostgreSQL 9.x–12): целые строки, «Planning time», «Total runtime»', () => {
  const old = `Sort  (cost=100.00..101.00 rows=10 width=8) (actual time=1.5..1.6 rows=10 loops=1)
  Sort Key: x
  Sort Method: quicksort  Memory: 25kB
  ->  Seq Scan on t  (cost=0.00..90.00 rows=10 width=8) (actual time=0.1..1.0 rows=10 loops=1)
Planning time: 0.2 ms
Execution time: 2.0 ms`;
  const p = parsePlan(old);
  assert.equal(p.planningTime, 0.2);
  assert.equal(p.executionTime, 2.0);
  assert.equal(p.root.sortSpace, 'Memory');
  assert.equal(p.root.sortSpaceKb, 25);
  const older = parsePlan('Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.0..0.0 rows=1 loops=1)\nTotal runtime: 0.05 ms');
  assert.equal(older.executionTime, 0.05);
});

test('ANALYZE без времени (TIMING OFF), триггеры, имя в кавычках', () => {
  const p = parsePlan(`Seq Scan on "Mixed Case" m  (cost=0.00..1.00 rows=1 width=4) (actual rows=3 loops=1)
Trigger trg_audit: time=0.12 calls=3
Execution Time: 0.5 ms`);
  assert.equal(p.root.actualRows, 3);
  assert.equal(p.root.actualTotal, undefined);
  assert.equal(p.triggers[0]!.name, 'trg_audit');
  assert.equal(p.triggers[0]!.calls, 3);
});

test('ошибки: пусто, мусор, JSON без Plan, текст без стоимости, обрыв', () => {
  const bad = (s: string, re: RegExp) => assert.throws(() => parsePlan(s), (e: unknown) => e instanceof PlanParseError && re.test((e as Error).message), s.slice(0, 30));
  bad('', /пусто/);
  bad('   \n  ', /пусто/);
  bad('hello world', /не найден ни один узел/);
  bad('{"a": 1}', /нет поля "Plan"/);
  bad('[1,2', /JSON/);
  bad('Seq Scan on t\n  Filter: (x > 1)', /без COSTS OFF|cost/);
  bad('  ->  Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)', /стрелки/);
  bad('Hash Join  (cost=0.00..1.00 rows=1 width=4)\nSeq Scan on t  (cost=0.00..1.00 rows=1 width=4)', /отступ|узел без/);
});

test('случайная порча планов: разбор либо удаётся, либо даёт PlanParseError; никаких зависаний и чужих ошибок', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 1500; i++) {
    const p = pg18.plans[Math.floor(rnd() * pg18.plans.length)]!;
    const src = [p.jsonAnalyze, p.textAnalyze, p.jsonCosts, p.textCosts][Math.floor(rnd() * 4)]!;
    let mutated = src;
    switch (Math.floor(rnd() * 5)) {
      case 0: mutated = src.slice(0, Math.floor(rnd() * src.length)); break;
      case 1: { const ls = src.split('\n'); ls.splice(Math.floor(rnd() * ls.length), 1); mutated = ls.join('\n'); break; }
      case 2: { const ls = src.split('\n'); const k = Math.floor(rnd() * ls.length); ls.splice(k, 0, ls[k]!); mutated = ls.join('\n'); break; }
      case 3: { const k = Math.floor(rnd() * src.length); mutated = src.slice(0, k) + src.slice(k + 1 + Math.floor(rnd() * 5)); break; }
      default: { const ls = src.split('\n'); const k = Math.floor(rnd() * ls.length); ls[k] = ' '.repeat(Math.floor(rnd() * 8)) + ls[k]!.trim(); mutated = ls.join('\n'); }
    }
    try {
      const plan = parsePlan(mutated);
      const ids = allNodes(plan).map((n) => n.id);
      assert.deepEqual(ids, ids.map((_, j) => j));
    } catch (e) {
      assert.ok(e instanceof PlanParseError, `не PlanParseError: ${(e as Error).stack}\n${mutated.slice(0, 200)}`);
    }
  }
});

test('очень глубокая вложенность не роняет разбор стеком', () => {
  const deep = (d: number) => {
    let s = '{"Node Type":"Result"}';
    for (let i = 0; i < d; i++) s = `{"Node Type":"Limit","Plans":[${s}]}`;
    return `[{"Plan":${s}}]`;
  };
  assert.ok(parsePlan(deep(100)).root.children.length === 1);
  assert.throws(() => parsePlan(deep(500)), PlanParseError);
});
