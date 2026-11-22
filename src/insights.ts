import { exclusiveMs, label, misestimate, planTotalMs, totalRows } from './metrics.ts';
import type { PlanDiff } from './diff.ts';
import { allNodes, walk } from './types.ts';
import type { Plan, PlanNode } from './types.ts';

export type Severity = 'info' | 'warn' | 'bad';

export interface Insight {
  /** Устойчивый код правила: по нему сравниваются планы («исправлено», «появилось»). */
  code: string;
  severity: Severity;
  nodeId: number;
  node: string;
  title: string;
  detail: string;
}

const fmtInt = (v: number): string => Math.round(v).toLocaleString('ru-RU');

/** «в 3,2 раза», «в 5 раз», «в 21 раз»: склонение по числу. */
export function timesWord(r: number): string {
  const rounded = r >= 10 ? Math.round(r) : Math.round(r * 10) / 10;
  const shown = String(rounded).replace('.', ',');
  if (!Number.isInteger(rounded)) return `в ${shown} раза`;
  const m10 = rounded % 10;
  const m100 = rounded % 100;
  const w = m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14) ? 'раза' : 'раз';
  return `в ${rounded.toLocaleString('ru-RU')} ${w}`;
}
const fmtMb = (kb: number): string => (kb >= 1024 ? `${(kb / 1024).toFixed(1).replace('.', ',')} МБ` : `${Math.round(kb)} КБ`);

/** Подсказки по одному плану. Каждое правило опирается на числа из самого плана и говорит, на что именно смотреть. */
export function insights(plan: Plan): Insight[] {
  const out: Insight[] = [];
  const total = planTotalMs(plan);
  // узлы под Limit и Merge Join могут не дочитывать вход до конца: фактическое число строк там не показатель ошибки оценки
  const early = new Set<number>();
  const parallel = new Set<number>();
  walk(plan.root, (n, _d, parent) => {
    if (parent && (early.has(parent.id) || parent.type === 'Limit' || parent.type === 'Merge Join')) early.add(n.id);
    if (parent && (parallel.has(parent.id) || parent.type === 'Gather' || parent.type === 'Gather Merge')) parallel.add(n.id);
  });
  const add = (code: string, severity: Severity, n: PlanNode, title: string, detail: string) => out.push({ code, severity, nodeId: n.id, node: label(n), title, detail });

  for (const n of allNodes(plan)) {
    // 1. Ошибка оценки числа строк
    const m = misestimate(n);
    if (m && m.factor >= 10 && Math.max(m.planRows, m.actualRows) >= 100 && !early.has(n.id)) {
      add(
        'misestimate',
        m.factor >= 100 ? 'bad' : 'warn',
        n,
        `Оптимизатор ошибся ${timesWord(m.factor)}: ждал ${fmtInt(m.planRows)} строк, получил ${fmtInt(m.actualRows)}`,
        m.direction === 'under'
          ? 'Оценка занижена: план строился для малого числа строк (часто выбирает вложенные циклы и индексы там, где нужен хеш). Проверьте ANALYZE, коррелирующие столбцы (CREATE STATISTICS), условия с функциями.'
          : 'Оценка завышена: возможно, выбран тяжёлый метод ради строк, которых нет. Проверьте статистику и условия.',
      );
    }
    // 2. Последовательное чтение с отсевом почти всего
    if (/Seq Scan/.test(n.type) && n.rowsRemovedFilter !== undefined && n.actualRows !== undefined) {
      const kept = totalRows(n);
      const removed = n.rowsRemovedFilter * (n.actualLoops ?? 1);
      if (removed >= 10000 && removed / (removed + kept) >= 0.9) {
        add('seq-scan-filter', removed >= 100000 ? 'warn' : 'info', n, `Прочитано ${fmtInt(removed + kept)} строк, оставлено ${fmtInt(kept)} (${kept / (removed + kept) < 0.01 ? 'менее 1' : Math.round((kept / (removed + kept)) * 100)}%)`, `Фильтр ${n.filter ?? ''} отбрасывает почти всё: индекс по условию может сильно сократить чтение.`);
      }
    }
    // 3. Сортировка на диске
    if (n.sortSpace === 'Disk') {
      add('sort-spill', 'warn', n, `Сортировка ушла на диск: ${fmtMb(n.sortSpaceKb ?? 0)}`, `Метод ${n.sortMethod ?? ''}. Не хватило work_mem: увеличьте его для этого запроса (SET work_mem) или сократите набор до сортировки.`);
    }
    // 4. Хеш в несколько пакетов
    if ((n.hashBatches ?? 1) > 1) {
      add('hash-spill', 'warn', n, `Хеш разбит на ${n.hashBatches} пакетов: данные сбрасывались на диск`, 'Таблица хеша не поместилась в work_mem. Увеличьте work_mem или уменьшите вход хеша.');
    }
    // 5. Параллельных процессов меньше, чем планировалось
    if (n.workersPlanned !== undefined && n.workersLaunched !== undefined && n.workersLaunched < n.workersPlanned) {
      add('workers-short', 'warn', n, `Запущено ${n.workersLaunched} из ${n.workersPlanned} рабочих процессов`, 'Не хватило max_parallel_workers или слотов: запрос выполнился медленнее запланированного.');
    }
    // 6. Index Only Scan, который ходит в кучу
    if (/Index Only Scan/.test(n.type) && n.heapFetches !== undefined && n.actualRows !== undefined) {
      const rows = totalRows(n);
      if (rows >= 100 && n.heapFetches >= 0.5 * rows) {
        add('heap-fetches', 'warn', n, `Index Only Scan прочитал таблицу ${fmtInt(n.heapFetches)} раз из ${fmtInt(rows)} строк`, 'Карта видимости не заполнена: запустите VACUUM, тогда чтение будет идти только по индексу.');
      }
    }
    // 7. Растровый поиск с потерями
    if (n.rowsRemovedRecheck !== undefined && n.rowsRemovedRecheck >= 10000) {
      add('lossy-bitmap', 'info', n, `Перепроверка отбросила ${fmtInt(n.rowsRemovedRecheck)} строк`, 'Растровая карта стала неточной (lossy): не хватило work_mem.');
    }
    // 8. Подзапрос, выполняемый для каждой строки
    if (n.parentRel === 'SubPlan' && (n.actualLoops ?? 0) >= 100) {
      add('subplan-loops', (n.actualLoops ?? 0) >= 10000 ? 'bad' : 'warn', n, `Подзапрос выполнен ${fmtInt(n.actualLoops ?? 0)} раз`, 'Коррелированный подзапрос запускается для каждой строки внешнего запроса: перепишите через соединение или LATERAL.');
    }
    // 9. Вложенный цикл с огромным числом запусков внутренней стороны
    if (n.type === 'Nested Loop' && n.children[1] && (n.children[1].actualLoops ?? 0) >= 10000) {
      const inner = n.children[1];
      add('nested-loop-many', 'warn', n, `Вложенный цикл: внутренняя сторона (${label(inner)}) выполнена ${fmtInt(inner.actualLoops ?? 0)} раз`, 'Если строк снаружи много, хеш-соединение или слияние обычно быстрее. Проверьте оценку числа строк снаружи.');
    }
    // 10. Узел выбран при отключённом enable_*
    if (n.disabled) {
      add('disabled-node', 'info', n, 'Узел выбран при отключённом enable_*', 'Для этого узла не нашлось плана без отключённого метода: проверьте SET enable_… в сессии.');
    }
    // 11. Временные файлы
    const temp = (n.buffers?.tempRead ?? 0) + (n.buffers?.tempWritten ?? 0);
    if (temp >= 1000 && n.sortSpace !== 'Disk' && (n.hashBatches ?? 1) <= 1) {
      add('temp-io', 'info', n, `Временные файлы: ${fmtInt(temp)} блоков`, 'Узел писал или читал временные данные: возможно, не хватает work_mem.');
    }
    // 12. Холодный кэш
    const read = n.buffers?.sharedRead ?? 0;
    if (n === plan.root && read >= 1000) {
      add('cold-cache', 'info', n, `С диска прочитано ${fmtInt(read)} блоков (кэш был холодным)`, 'Время первого запуска включает чтение с диска; повторите запрос для сравнения «в тёплом кэше».');
    }
  }
  // 13. Один узел съедает больше половины времени
  if (total !== undefined && total > 5) {
    let top: PlanNode | undefined;
    let topMs = 0;
    for (const n of allNodes(plan)) {
      const e = exclusiveMs(n);
      if (e > topMs) {
        top = n;
        topMs = e;
      }
    }
    if (top && topMs >= 0.5 * total && topMs <= total && top !== plan.root && !parallel.has(top.id)) {
      add('dominant-node', 'info', top, `Больше половины времени (${Math.round((topMs / total) * 100)}%) уходит на один узел`, 'Оптимизировать стоит прежде всего его: остальное даёт мало. Для параллельных узлов доля считается по суммарному времени процессов.');
    }
  }
  return out;
}

/**
 * Сравнение подсказок двух планов по сопоставленным узлам: подсказка исправлена, если у её узла есть пара в B без такой же подсказки
 * (или узла в B нет вовсе), и появилась, если у узла B нет пары в A или у пары не было такой подсказки.
 * «Один узел съедает время» сравнивается на уровне плана: она либо есть, либо нет.
 */
export function compareInsights(a: Insight[], b: Insight[], diff: PlanDiff): { fixed: Insight[]; introduced: Insight[]; remaining: Insight[] } {
  const has = (list: Insight[], code: string, nodeId: number) => list.some((i) => i.code === code && i.nodeId === nodeId);
  const fixed: Insight[] = [];
  const introduced: Insight[] = [];
  const remaining: Insight[] = [];
  for (const i of a) {
    if (i.code === 'dominant-node') {
      if (!b.some((x) => x.code === i.code)) fixed.push(i);
      continue;
    }
    const pair = diff.byA.get(i.nodeId);
    if (pair && has(b, i.code, pair.b.id)) remaining.push(...b.filter((x) => x.code === i.code && x.nodeId === pair.b.id));
    else fixed.push(i);
  }
  for (const i of b) {
    if (i.code === 'dominant-node') {
      if (!a.some((x) => x.code === i.code)) introduced.push(i);
      else if (!remaining.includes(i)) remaining.push(i);
      continue;
    }
    const pair = diff.byB.get(i.nodeId);
    if (!pair || !has(a, i.code, pair.a.id)) introduced.push(i);
  }
  return { fixed, introduced, remaining };
}
