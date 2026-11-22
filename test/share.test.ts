import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../src/parse.ts';
import { postcardSvg, esc } from '../src/postcard.ts';
import { decodeShare, encodeShare, MAX_SHARED_BYTES } from '../src/share.ts';
import { compare } from '../src/summary.ts';
import { fixture } from './fixtures.ts';

test('ссылка: круговой обход для реальных планов, юникода и пустых строк', async () => {
  const a = fixture('hash_join').textAnalyze;
  const b = fixture('hash_join@idx').jsonAnalyze;
  for (const [x, y] of [[a, b], ['', ''], ['План «тест» 😀\n\t"кавычки"', '\u0000￿'], [a.repeat(20), b.repeat(20)]] as const) {
    const s = await encodeShare(x, y);
    assert.match(s, /^v1\.[A-Za-z0-9_-]+$/, 'только символы, безопасные для адреса');
    assert.deepEqual(await decodeShare('#' + s), { a: x, b: y });
  }
});

test('ссылка на два реальных плана достаточно короткая для адресной строки', async () => {
  const s = await encodeShare(fixture('three_way_join').textAnalyze, fixture('three_way_join_idx').textAnalyze);
  assert.ok(s.length < 4000, `длина ${s.length}`);
});

test('поврежденные ссылки дают понятные ошибки', async () => {
  const good = await encodeShare('a', 'b');
  const rej = async (s: string, re: RegExp) => assert.rejects(() => decodeShare(s), (e: Error) => re.test(e.message), s.slice(0, 20));
  await rej('', /не ссылка/);
  await rej('v2.abc', /не ссылка/);
  await rej('v1.!!!!', /повреждена/);
  await rej(good.slice(0, 6), /повреждена/);
  await rej('v1.' + Buffer.from('not deflate').toString('base64url'), /повреждена/);
  const notJson = Buffer.from(await (async () => { const cs = new CompressionStream('deflate-raw'); const w = cs.writable.getWriter(); void w.write(new TextEncoder().encode('plain text')); void w.close(); const r = cs.readable.getReader(); const out: number[] = []; for (;;) { const { done, value } = await r.read(); if (done) break; out.push(...value); } return Uint8Array.from(out); })()).toString('base64url');
  await rej('v1.' + notJson, /не JSON/);
});

test('«бомба»: небольшая ссылка, которая распаковывается в гигантский текст, отвергается', async () => {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  void (async () => {
    for (let i = 0; i < 8; i++) await w.write(chunk);
    await w.close();
  })();
  const r = cs.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
  }
  const bomb = Buffer.concat(parts).toString('base64url');
  assert.ok(bomb.length < 30000, 'сжатая «бомба» мала');
  assert.ok(8 * 1024 * 1024 > MAX_SHARED_BYTES);
  await assert.rejects(() => decodeShare('v1.' + bomb), /слишком велика/);
});

test('открытка: корректный SVG, заголовок и главные изменения; текст экранируется', () => {
  const c = compare(parsePlan(fixture('sort_spill').jsonAnalyze), parsePlan(fixture('sort_spill@idx').jsonAnalyze));
  const svg = postcardSvg(c);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
  assert.match(svg, /B быстрее в 2,8 раза/);
  assert.match(svg, /Исправлено: Сортировка ушла на диск/);
  // разметка сбалансирована: каждый открытый тег закрыт
  const tags = [...svg.matchAll(/<(\/?)([a-z]+)([^>]*?)(\/?)>/g)];
  const stack: string[] = [];
  for (const [, close, name, , selfClose] of tags) {
    if (selfClose) continue;
    if (close) assert.equal(stack.pop(), name);
    else stack.push(name!);
  }
  assert.deepEqual(stack, []);

  // вредная таблица в плане не должна превратиться в разметку
  const evil = parsePlan('Seq Scan on "<script>alert(1)</script>" t  (cost=0.00..1.00 rows=1 width=4)');
  const evil2 = parsePlan('Index Scan using "x\\"onload=alert(1)" on "<img src=x>" t  (cost=0.00..0.50 rows=1 width=4)');
  const out = postcardSvg(compare(evil, evil2));
  assert.ok(!/<script|<img/.test(out), 'теги из плана экранированы');
  assert.match(out, /&lt;script&gt;|&lt;img/);
  assert.equal(esc('a&b<c>"d'), 'a&amp;b&lt;c&gt;&quot;d');
});

test('открытка для сравнения без чисел и для «примерно одинаково»', () => {
  const none = compare(parsePlan('Result  (cost=0.00..0.01 rows=1 width=4)'), parsePlan('Result  (cost=0.00..0.01 rows=1 width=4)'));
  assert.match(postcardSvg(none), /Примерно одинаково|Сравнить нечем/);
  const same = compare(parsePlan(fixture('hash_join').jsonAnalyze), parsePlan(fixture('hash_join').jsonAnalyze));
  assert.match(postcardSvg(same), /Примерно одинаково/);
  assert.match(postcardSvg(same), /Заметных отличий в структуре планов нет/);
});
