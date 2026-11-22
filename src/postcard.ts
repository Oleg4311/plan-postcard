import { timesWord } from './insights.ts';
import type { Comparison } from './summary.ts';

const W = 1200;
const H = 630;

export function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const COLOR = { faster: '#14602f', slower: '#9c1c14', same: '#4b4a44', unknown: '#4b4a44' } as const;
const DOT: Record<string, string> = { access: '#0b5cad', join: '#0b5cad', structure: '#6b4f00', order: '#6b4f00', fixed: '#14602f', introduced: '#9c1c14', estimate: '#6b4f00', time: '#4b4a44', io: '#4b4a44' };

/** Открытка 1200×630 (размер превью в мессенджерах): главный вывод и несколько главных изменений. Чистая функция: возвращает текст SVG. */
export function postcardSvg(c: Comparison): string {
  const color = COLOR[c.verdict];
  const big =
    c.verdict === 'faster' ? `B быстрее ${timesWord(c.speedup!)}` : c.verdict === 'slower' ? `B медленнее ${timesWord(1 / c.speedup!)}` : c.verdict === 'same' ? 'Примерно одинаково' : 'Сравнить нечем';
  const val = (v: number | undefined) => (v === undefined ? '—' : c.basis === 'time' ? (v >= 1000 ? `${(v / 1000).toFixed(2).replace('.', ',')} с` : v >= 10 ? `${Math.round(v)} мс` : `${v.toFixed(2).replace('.', ',')} мс`) : `${Math.round(v).toLocaleString('ru-RU')} ед.`);
  const sub = c.valueA !== undefined && c.valueB !== undefined ? `A ${val(c.valueA)}  →  B ${val(c.valueB)}${c.basis === 'cost' ? '  (оценка стоимости)' : ''}` : 'в планах нет времени и стоимости';
  const rows = c.findings.slice(0, 4);
  const items = rows
    .map((f, i) => {
      const y = 330 + i * 62;
      return `<circle cx="84" cy="${y - 9}" r="9" fill="${DOT[f.kind] ?? '#4b4a44'}"/><text x="112" y="${y}" font-size="30" fill="#1c1c1a">${esc(clip(f.text, 62))}</text>`;
    })
    .join('');
  const extra = c.findings.length > 4 ? `<text x="112" y="${330 + 4 * 62}" font-size="24" fill="#585750">и ещё ${c.findings.length - 4}</text>` : '';
  const none = rows.length === 0 ? `<text x="84" y="350" font-size="30" fill="#585750">Заметных отличий в структуре планов нет</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.headline)}" font-family="system-ui, 'Segoe UI', Roboto, sans-serif">
<title>${esc(c.headline)}</title>
<rect width="${W}" height="${H}" fill="#f6f6f2"/>
<rect x="0" y="0" width="16" height="${H}" fill="${color}"/>
<text x="84" y="92" font-size="30" fill="#585750">Сравнение планов EXPLAIN PostgreSQL</text>
<text x="84" y="190" font-size="78" font-weight="700" fill="${color}">${esc(big)}</text>
<text x="84" y="250" font-size="36" fill="#1c1c1a">${esc(sub)}</text>
<line x1="84" y1="282" x2="${W - 84}" y2="282" stroke="#d8d6cc" stroke-width="2"/>
${items}${extra}${none}
<text x="84" y="${H - 28}" font-size="22" fill="#585750">plan-postcard · планы разбираются в браузере и никуда не отправляются</text>
</svg>
`;
}
