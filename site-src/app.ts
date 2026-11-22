// Интерфейс: весь вывод строится через textContent, планы пользователя никогда не попадают в разметку.
import { compare, decodeShare, encodeShare, exclusiveMs, label, misestimate, parsePlan, planTotalMs, PlanParseError, postcardSvg, totalRows } from '../src/index.ts';
import type { Comparison, Insight, Plan, PlanNode } from '../src/index.ts';

declare const EXAMPLES: Record<string, { a: string; b: string }>;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const MAX_HASH = 8000;

const fmtMs = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2).replace('.', ',')} с` : v >= 10 ? `${Math.round(v)} мс` : `${v.toFixed(2).replace('.', ',')} мс`);
const fmtInt = (v: number): string => Math.round(v).toLocaleString('ru-RU');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SEV_LABEL = { info: 'Заметка', warn: 'Внимание', bad: 'Серьёзно' } as const;
const KIND_LABEL: Record<string, string> = { access: 'Доступ', join: 'Соединение', structure: 'Состав', order: 'Порядок', fixed: 'Исправлено', introduced: 'Появилось', estimate: 'Оценка', time: 'Время', io: 'Ввод-вывод' };

function renderNode(n: PlanNode, plan: Plan, side: 'a' | 'b', c: Comparison): HTMLLIElement {
  const li = el('li');
  const box = el('div', 'node');
  const pair = side === 'a' ? c.diff.byA.get(n.id) : c.diff.byB.get(n.id);
  const status = !pair ? (side === 'a' ? 'removed' : 'added') : pair.changes.some((x) => x.kind !== 'time' && x.kind !== 'io') ? 'changed' : 'same';
  const head = el('div');
  head.append(el('span', 'name', label(n)));
  const stText = { same: '= без изменений', changed: '≠ изменён', added: '+ добавлен', removed: '− убран' }[status];
  head.append(el('span', `st st-${status}`, stText));
  box.append(head);

  const parts: string[] = [];
  if (n.neverExecuted) parts.push('не выполнялся');
  else if (plan.analyzed && n.actualTotal !== undefined) {
    const ex = exclusiveMs(n);
    const total = planTotalMs(plan);
    parts.push(`собственное время ${fmtMs(ex)}${total ? ` (${Math.round((ex / total) * 100)}%)` : ''}`);
  }
  if (plan.analyzed && !n.neverExecuted && n.actualRows !== undefined) {
    const m = misestimate(n);
    parts.push(`строк ${fmtInt(totalRows(n))}${n.actualLoops && n.actualLoops > 1 ? ` (${fmtInt(n.actualLoops)} запусков)` : ''}, оценка ${fmtInt(n.planRows ?? 0)}${m && m.factor >= 10 ? ` ×${fmtInt(m.factor)} ошибка` : ''}`);
  } else if (n.planRows !== undefined) parts.push(`оценка строк ${fmtInt(n.planRows)}`);
  if (n.totalCost !== undefined) parts.push(`стоимость ${fmtInt(n.totalCost)}`);
  box.append(el('div', 'meta', parts.join(' · ')));

  if (plan.analyzed && !n.neverExecuted) {
    const total = planTotalMs(plan);
    if (total) {
      const pct = Math.min(100, (exclusiveMs(n) / total) * 100);
      if (pct > 0.5) {
        const bar = el('span', 'timebar');
        bar.setAttribute('aria-hidden', 'true');
        const fill = el('i');
        fill.style.width = `${pct}%`;
        bar.append(fill);
        box.append(bar);
      }
    }
  }
  if (pair && pair.changes.length) {
    const ul = el('ul', 'chg');
    for (const ch of pair.changes.slice(0, 6)) ul.append(el('li', undefined, `${ch.title}: ${ch.a ?? '—'} → ${ch.b ?? '—'}`));
    box.append(ul);
  }
  const mine: Insight[] = (side === 'a' ? c.insightsA : c.insightsB).filter((i) => i.nodeId === n.id);
  for (const i of mine) box.append(el('span', `ins ${i.severity}`, `${SEV_LABEL[i.severity]}: ${i.title}`));
  li.append(box);
  if (n.children.length) {
    const ul = el('ul');
    for (const ch of n.children) ul.append(renderNode(ch, plan, side, c));
    li.append(ul);
  }
  return li;
}

function renderInsights(target: HTMLElement, list: Insight[]): void {
  target.replaceChildren();
  if (list.length === 0) {
    target.append(el('li', undefined, 'Подсказок нет.'));
    return;
  }
  for (const i of list) {
    const li = el('li');
    li.append(el('span', `tag ${i.severity === 'bad' ? 't-introduced' : i.severity === 'warn' ? 't-io' : 't-time'}`, SEV_LABEL[i.severity]));
    li.append(document.createTextNode(`${i.title} — ${i.node}. ${i.detail}`));
    target.append(li);
  }
}

let current: { c: Comparison; svg: string } | null = null;

function showError(msg: string): void {
  $('error').hidden = false;
  $('error').textContent = msg;
  $('result').hidden = true;
}

async function run(updateHash: boolean): Promise<void> {
  $('error').hidden = true;
  const ta = $<HTMLTextAreaElement>('plan-a').value;
  const tb = $<HTMLTextAreaElement>('plan-b').value;
  let a: Plan;
  let b: Plan;
  try {
    a = parsePlan(ta);
  } catch (e) {
    return showError(`План A: ${e instanceof PlanParseError ? e.message : 'не удалось разобрать'}`);
  }
  try {
    b = parsePlan(tb);
  } catch (e) {
    return showError(`План B: ${e instanceof PlanParseError ? e.message : 'не удалось разобрать'}`);
  }
  const c = compare(a, b);
  const svg = postcardSvg(c);
  current = { c, svg };

  const head = $('headline');
  head.className = `headline ${c.verdict}`;
  head.textContent = c.headline;
  const list = $('findings');
  list.replaceChildren();
  for (const f of c.findings) {
    const li = el('li');
    li.append(el('span', `tag t-${f.kind}`, KIND_LABEL[f.kind] ?? f.kind));
    li.append(document.createTextNode(f.text));
    list.append(li);
  }
  $('no-findings').hidden = c.findings.length > 0;

  const ua = $('tree-a');
  const ub = $('tree-b');
  ua.replaceChildren(renderNode(a.root, a, 'a', c));
  ub.replaceChildren(renderNode(b.root, b, 'b', c));
  renderInsights($('ins-a'), c.insightsA);
  renderInsights($('ins-b'), c.insightsB);

  const card = $('card');
  card.replaceChildren();
  const img = el('img');
  img.alt = c.headline;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  card.append(img);

  $('result').hidden = false;
  const note = $('share-note');
  if (updateHash) {
    const enc = await encodeShare(ta, tb);
    if (enc.length > MAX_HASH) {
      history.replaceState(null, '', location.pathname + location.search);
      note.textContent = 'Планы слишком велики для ссылки: скачайте открытку или отправьте сами планы.';
      ($('link') as HTMLInputElement).value = '';
    } else {
      history.replaceState(null, '', `#${enc}`);
      ($('link') as HTMLInputElement).value = location.href;
      note.textContent = `Ссылка содержит оба плана (${enc.length} знаков) и открывается у адресата без сервера.`;
    }
  }
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function svgToPng(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    canvas.getContext('2d')!.drawImage(img, 0, 0, 1200, 630);
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('не удалось создать PNG'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('go').addEventListener('click', () => void run(true));
$('swap').addEventListener('click', () => {
  const a = $<HTMLTextAreaElement>('plan-a');
  const b = $<HTMLTextAreaElement>('plan-b');
  [a.value, b.value] = [b.value, a.value];
  if (!$('result').hidden) void run(true);
});
$('clear').addEventListener('click', () => {
  $<HTMLTextAreaElement>('plan-a').value = '';
  $<HTMLTextAreaElement>('plan-b').value = '';
  $('result').hidden = true;
  $('error').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
});
document.querySelectorAll<HTMLElement>('[data-ex]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const ex = EXAMPLES[btn.dataset['ex']!]!;
    $<HTMLTextAreaElement>('plan-a').value = ex.a;
    $<HTMLTextAreaElement>('plan-b').value = ex.b;
    void run(true);
  }),
);
$('copy').addEventListener('click', async () => {
  const link = $('link') as HTMLInputElement;
  if (!link.value) {
    $('share-note').textContent = 'Нет ссылки: планы слишком велики.';
    return;
  }
  try {
    await navigator.clipboard.writeText(link.value);
    $('share-note').textContent = 'Ссылка скопирована.';
  } catch {
    link.select();
    $('share-note').textContent = 'Выделено: скопируйте ссылку (Ctrl+C).';
  }
});
$('dl-svg').addEventListener('click', () => {
  if (current) download('plan-postcard.svg', new Blob([current.svg], { type: 'image/svg+xml' }));
});
$('dl-png').addEventListener('click', async () => {
  if (!current) return;
  try {
    download('plan-postcard.png', await svgToPng(current.svg));
  } catch (e) {
    $('share-note').textContent = `PNG не получился: ${(e as Error).message}. Скачайте SVG.`;
  }
});

// открытие по ссылке
if (location.hash.startsWith('#v1.')) {
  decodeShare(location.hash)
    .then(({ a, b }) => {
      $<HTMLTextAreaElement>('plan-a').value = a;
      $<HTMLTextAreaElement>('plan-b').value = b;
      return run(false).then(() => {
        ($('link') as HTMLInputElement).value = location.href;
      });
    })
    .catch((e: Error) => showError(`Не удалось открыть ссылку: ${e.message}`));
}
