// Живая сверка на настоящем PostgreSQL: планы создаются прямо сейчас (во встроенном сервере или в сервисе CI: PLANS_TEST_URL),
// поэтому тест проверяет разбор на той версии, которая запущена: в CI это 14, 16 и 17.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { diffPlans } from '../src/diff.ts';
import { insights } from '../src/insights.ts';
import { parsePlan } from '../src/parse.ts';
import { compare } from '../src/summary.ts';
import { allNodes } from '../src/types.ts';
import { generatePlans } from './support/gen-plans.ts';
import type { PlanSet } from './support/gen-plans.ts';
import { startPg } from './support/pg.ts';
import type { TestPg } from './support/pg.ts';
import { sig } from './support/sig.ts';

let pg: TestPg;
let version = '';
let plans: PlanSet[] = [];
before(async () => {
  pg = await startPg();
  ({ version, plans } = await generatePlans(pg.url));
});
after(async () => {
  await pg.stop();
});

const get = (name: string): PlanSet => plans.find((p) => p.name === name)!;

test('на этой версии PostgreSQL JSON и текст каждого плана дают одинаковое дерево', () => {
  assert.ok(plans.length >= 50, `версия ${version}: планов ${plans.length}`);
  for (const p of plans) {
    for (const [j, t, analyzed] of [[p.jsonAnalyze, p.textAnalyze, true], [p.jsonCosts, p.textCosts, false]] as const) {
      assert.deepEqual(sig(parsePlan(t).root, analyzed), sig(parsePlan(j).root, analyzed), `${version}: ${p.name} (${analyzed ? 'ANALYZE' : 'costs'})`);
    }
  }
});

test('на этой версии находятся характерные узлы и свойства', () => {
  const sort = parsePlan(get('sort_spill').textAnalyze).root;
  assert.equal(sort.sortSpace, 'Disk');
  const sub = allNodes(parsePlan(get('subplan').jsonAnalyze)).find((n) => n.parentRel === 'SubPlan');
  assert.ok(sub, 'SubPlan');
  assert.equal(allNodes(parsePlan(get('update_dml').textAnalyze))[0]!.type, 'Update');
  assert.ok(allNodes(parsePlan(get('nested_loop_never_executed').textAnalyze)).some((n) => n.neverExecuted));
});

test('на этой версии сравнение пары «до/после индекса» даёт осмысленный результат и подсказки', () => {
  const c = compare(parsePlan(get('subplan').jsonAnalyze), parsePlan(get('subplan@idx').jsonAnalyze));
  assert.equal(c.verdict, 'faster');
  assert.ok((c.speedup ?? 0) > 20);
  assert.ok(c.findings.some((f) => f.kind === 'access'));
  assert.ok(insights(parsePlan(get('sort_spill').jsonAnalyze)).some((i) => i.code === 'sort-spill'));
  const d = diffPlans(parsePlan(get('hash_join').jsonAnalyze), parsePlan(get('hash_join').textAnalyze));
  assert.equal(d.added.length + d.removed.length, 0);
});
