import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#go')).toBeVisible();
});

test('пример с индексом: заголовок о ускорении, главные изменения и деревья с пометками', async ({ page }) => {
  await page.getByRole('button', { name: 'Пример: индекс против подзапроса' }).click();
  await expect(page.locator('#headline')).toContainText('План B быстрее A');
  await expect(page.locator('#headline')).toHaveClass(/faster/);
  await expect(page.locator('#findings')).toContainText('Seq Scan on orders o → Bitmap Heap Scan on orders o');
  await expect(page.locator('#findings')).toContainText('добавлено: Bitmap Index Scan');
  await expect(page.locator('#tree-a .st-changed').first()).toBeVisible();
  await expect(page.locator('#tree-b .st-added')).toHaveCount(1);
  await expect(page.locator('#tree-b')).toContainText('Bitmap Index Scan');
  await expect(page.locator('#ins-a')).toContainText('Прочитано 9 800 000 строк');
  await expect(page.locator('#ins-b')).not.toContainText('Прочитано');
});

test('пример с сортировкой на диске: подсказка исправлена', async ({ page }) => {
  await page.getByRole('button', { name: 'Пример: сортировка уходит с диска' }).click();
  await expect(page.locator('#findings')).toContainText('Исправлено: Сортировка ушла на диск');
  await expect(page.locator('#ins-a')).toContainText('Сортировка ушла на диск');
  await expect(page.locator('#ins-b')).not.toContainText('Сортировка ушла на диск');
});

test('своя вставка: текст и JSON в одном сравнении, смена мест меняет вывод на «медленнее»', async ({ page }) => {
  await page.getByRole('button', { name: 'Пример: хеш-соединение' }).click();
  await expect(page.locator('#headline')).toContainText(/быстрее|медленнее|одинаково/);
  const before = await page.locator('#headline').innerText();
  await page.getByRole('button', { name: 'Поменять местами' }).click();
  const after = await page.locator('#headline').innerText();
  expect(after).not.toBe(before);
  if (/быстрее/.test(before)) expect(after).toMatch(/медленнее/);
  if (/медленнее/.test(before)) expect(after).toMatch(/быстрее/);
});

test('ошибки: пустой ввод, мусор и план без стоимости показываются понятно', async ({ page }) => {
  await page.locator('#go').click();
  await expect(page.locator('#error')).toContainText('План A: пусто');
  await page.locator('#plan-a').fill('Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)');
  await page.locator('#plan-b').fill('hello');
  await page.locator('#go').click();
  await expect(page.locator('#error')).toContainText('План B');
  await expect(page.locator('#error')).toContainText('не найден ни один узел');
  await page.locator('#plan-b').fill('Seq Scan on t  (cost=0.00..0.50 rows=1 width=4)');
  await page.locator('#go').click();
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#headline')).toContainText('оценк'); // без ANALYZE честно сказано, что это оценка
});

test('вредный текст в плане не превращается в разметку', async ({ page }) => {
  await page.locator('#plan-a').fill('Seq Scan on "<img src=x onerror=window.__xss=1>" t  (cost=0.00..1.00 rows=1 width=4)');
  await page.locator('#plan-b').fill('Seq Scan on "<b>bold</b>" t  (cost=0.00..1.00 rows=1 width=4)');
  await page.locator('#go').click();
  await expect(page.locator('#result')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('#tree-a img, #tree-b b').count()).toBe(0);
  await expect(page.locator('#tree-a')).toContainText('<img src=x');
});

test('ссылка: открывается в новой вкладке и воспроизводит то же сравнение', async ({ page, context }) => {
  await page.getByRole('button', { name: 'Пример: индекс против подзапроса' }).click();
  await expect(page.locator('#headline')).toContainText('План B быстрее A');
  const link = await page.locator('#link').inputValue();
  expect(link).toMatch(/#v1\./);
  const headline = await page.locator('#headline').innerText();
  const other = await context.newPage();
  await other.goto(link);
  await expect(other.locator('#headline')).toHaveText(headline);
  await expect(other.locator('#plan-a')).not.toHaveValue('');
  // повреждённая ссылка
  const broken = await context.newPage();
  await broken.goto(link.replace(/.{20}$/, 'AAAAAAAAAAAAAAAAAAAA'));
  await expect(broken.locator('#error')).toContainText('Не удалось открыть ссылку');
});

test('открытка: SVG и PNG скачиваются', async ({ page }) => {
  await page.getByRole('button', { name: 'Пример: сортировка уходит с диска' }).click();
  await expect(page.locator('#headline')).toContainText('быстрее');
  const [svg] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать открытку (SVG)' }).click()]);
  expect(svg.suggestedFilename()).toBe('plan-postcard.svg');
  const [png] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать открытку (PNG)' }).click()]);
  expect(png.suggestedFilename()).toBe('plan-postcard.png');
  const stream = await png.createReadStream();
  const chunks: Buffer[] = [];
  for await (const ch of stream) chunks.push(ch as Buffer);
  const buf = Buffer.concat(chunks);
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  expect(buf.length).toBeGreaterThan(5000);
});

test('«Очистить» убирает ввод, результат и ссылку', async ({ page }) => {
  await page.getByRole('button', { name: 'Пример: индекс против подзапроса' }).click();
  await expect(page.locator('#result')).toBeVisible();
  await page.getByRole('button', { name: 'Очистить' }).click();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#plan-a')).toHaveValue('');
  expect(page.url()).not.toContain('#v1.');
});

test('доступность (axe): светлая и тёмная тема, с результатами', async ({ page }) => {
  await page.getByRole('button', { name: 'Пример: индекс против подзапроса' }).click();
  await expect(page.locator('#result')).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const r = await new AxeBuilder({ page }).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`), scheme).toEqual([]);
  }
});

test('на узком экране нет горизонтальной прокрутки страницы', async ({ page }) => {
  await page.getByRole('button', { name: 'Пример: хеш-соединение' }).click();
  await expect(page.locator('#result')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
