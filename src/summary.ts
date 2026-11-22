import { diffPlans } from './diff.ts';
import type { PlanDiff } from './diff.ts';
import { compareInsights, insights, timesWord } from './insights.ts';
import type { Insight } from './insights.ts';
import { label, misestimate, planTotalMs } from './metrics.ts';
import { allNodes } from './types.ts';
import type { Plan, PlanNode } from './types.ts';

export type FindingKind = 'access' | 'join' | 'structure' | 'order' | 'fixed' | 'introduced' | 'estimate' | 'time' | 'io';

export interface Finding {
  kind: FindingKind;
  text: string;
}

export interface Comparison {
  a: Plan;
  b: Plan;
  diff: PlanDiff;
  insightsA: Insight[];
  insightsB: Insight[];
  fixed: Insight[];
  introduced: Insight[];
  remaining: Insight[];
  /** Время или оценка стоимости, по которым сравнивали. */
  basis: 'time' | 'cost' | 'none';
  valueA?: number;
  valueB?: number;
  /** Во сколько раз B быстрее A (меньше 1 — медленнее). */
  speedup?: number;
  verdict: 'faster' | 'slower' | 'same' | 'unknown';
  headline: string;
  findings: Finding[];
}

const fmtMs = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2).replace('.', ',')} с` : v >= 10 ? `${Math.round(v)} мс` : `${v.toFixed(2).replace('.', ',')} мс`);
const fmtRatio = (r: number): string => (r >= 10 ? Math.round(r) : r.toFixed(1)).toString().replace('.', ',');

/** Относительные таблицы в порядке появления в плане: порядок соединения. */
function tableOrder(p: Plan): string[] {
  return allNodes(p)
    .filter((n) => n.relation !== undefined && /Scan$/.test(n.type))
    .map((n) => n.alias ?? n.relation!);
}

function worstMisestimate(p: Plan): { factor: number; node: PlanNode } | undefined {
  let best: { factor: number; node: PlanNode } | undefined;
  for (const n of allNodes(p)) {
    const m = misestimate(n);
    if (m && (!best || m.factor > best.factor)) best = { factor: m.factor, node: n };
  }
  return best;
}

export function compare(a: Plan, b: Plan): Comparison {
  const diff = diffPlans(a, b);
  const insightsA = insights(a);
  const insightsB = insights(b);
  const { fixed, introduced, remaining } = compareInsights(insightsA, insightsB, diff);

  // основа сравнения
  const ta = planTotalMs(a);
  const tb = planTotalMs(b);
  let basis: Comparison['basis'] = 'none';
  let valueA: number | undefined;
  let valueB: number | undefined;
  if (a.analyzed && b.analyzed && ta !== undefined && tb !== undefined) {
    basis = 'time';
    valueA = ta;
    valueB = tb;
  } else if (a.root.totalCost !== undefined && b.root.totalCost !== undefined) {
    basis = 'cost';
    valueA = a.root.totalCost;
    valueB = b.root.totalCost;
  }
  let speedup: number | undefined;
  let verdict: Comparison['verdict'] = 'unknown';
  if (valueA !== undefined && valueB !== undefined && valueA > 0 && valueB > 0) {
    speedup = valueA / valueB;
    verdict = speedup > 1.05 ? 'faster' : speedup < 1 / 1.05 ? 'slower' : 'same';
  }
  const unit = basis === 'time' ? (v: number) => fmtMs(v) : (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ед.`;
  const what = basis === 'time' ? 'быстрее' : 'дешевле по оценке';
  const whatSlow = basis === 'time' ? 'медленнее' : 'дороже по оценке';
  let headline: string;
  if (verdict === 'faster') headline = `План B ${what} A ${timesWord(speedup!)}: ${unit(valueA!)} → ${unit(valueB!)}`;
  else if (verdict === 'slower') headline = `План B ${whatSlow} A ${timesWord(1 / speedup!)}: ${unit(valueA!)} → ${unit(valueB!)}`;
  else if (verdict === 'same') headline = `Планы ${basis === 'time' ? 'работают' : 'стоят'} примерно одинаково: ${unit(valueA!)} и ${unit(valueB!)}`;
  else headline = 'Не удалось сравнить время или стоимость: в планах нет нужных чисел';
  if (basis === 'cost') headline += ' (без ANALYZE это оценка оптимизатора, а не измерение)';

  const findings: Finding[] = [];
  // способ доступа и соединения
  for (const p of diff.pairs) {
    for (const c of p.changes) {
      if (c.kind === 'access') findings.push({ kind: 'access', text: `${c.a} → ${c.b}` });
      else if (c.kind === 'join') findings.push({ kind: 'join', text: `${c.title}: ${c.a} → ${c.b}` });
    }
  }
  // добавленные и убранные узлы
  const count = (list: PlanNode[]) => {
    const m = new Map<string, number>();
    for (const n of list) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return [...m].map(([t, k]) => (k > 1 ? `${t} ×${k}` : t)).join(', ');
  };
  if (diff.added.length || diff.removed.length) {
    const parts: string[] = [];
    if (diff.removed.length) parts.push(`убрано: ${count(diff.removed)}`);
    if (diff.added.length) parts.push(`добавлено: ${count(diff.added)}`);
    findings.push({ kind: 'structure', text: `Состав плана: ${parts.join('; ')}` });
  }
  const oa = tableOrder(a);
  const ob = tableOrder(b);
  if (oa.length > 1 && oa.length === ob.length && oa.join() !== ob.join() && [...oa].sort().join() === [...ob].sort().join()) {
    findings.push({ kind: 'order', text: `Порядок таблиц в плане: ${oa.join(', ')} → ${ob.join(', ')}` });
  }
  for (const i of fixed) findings.push({ kind: 'fixed', text: `Исправлено: ${i.title} (${i.node})` });
  for (const i of introduced) findings.push({ kind: 'introduced', text: `Появилось: ${i.title} (${i.node})` });
  // оценки
  const wa = worstMisestimate(a);
  const wb = worstMisestimate(b);
  if (wa && wb && (wa.factor >= 10 || wb.factor >= 10) && Math.abs(Math.log10(wa.factor) - Math.log10(wb.factor)) >= 0.5) {
    findings.push({ kind: 'estimate', text: `Наибольшая ошибка оценки строк: ×${fmtRatio(wa.factor)} → ×${fmtRatio(wb.factor)}` });
  }
  // время самого изменившегося узла
  if (basis === 'time') {
    let best: { c: string; d: number } | undefined;
    for (const p of diff.pairs) {
      for (const c of p.changes) {
        if (c.kind === 'time' && typeof c.a === 'number' && typeof c.b === 'number' && (!best || Math.abs(c.b - c.a) > Math.abs(best.d))) best = { c: `${label(p.b)}: ${fmtMs(c.a)} → ${fmtMs(c.b)} собственного времени`, d: c.b - c.a };
      }
    }
    if (best) findings.push({ kind: 'time', text: best.c });
  }
  const sa = a.root.buffers?.sharedRead ?? 0;
  const sb = b.root.buffers?.sharedRead ?? 0;
  if (Math.max(sa, sb) >= 1000 && Math.abs(sa - sb) >= 0.5 * Math.max(sa, sb)) findings.push({ kind: 'io', text: `Чтений с диска: ${sa.toLocaleString('ru-RU')} → ${sb.toLocaleString('ru-RU')} блоков (разный прогрев кэша искажает время)` });

  return { a, b, diff, insightsA, insightsB, fixed, introduced, remaining, basis, valueA, valueB, speedup, verdict, headline, findings };
}
