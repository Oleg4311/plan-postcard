// Скриншот страницы с результатом для README: node scripts/screenshot.mjs (страница собрана: npm run site)
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const server = spawn(process.execPath, ['scripts/serve.mjs'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto('http://127.0.0.1:4185/');
  await page.getByRole('button', { name: 'Пример: индекс против подзапроса' }).click();
  await page.locator('#headline').waitFor();
  await page.locator('main').screenshot({ path: 'docs/screenshot.png' });
  await browser.close();
} finally {
  server.kill();
}
