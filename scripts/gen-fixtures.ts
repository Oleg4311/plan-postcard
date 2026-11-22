// Образцы планов с настоящего PostgreSQL: node scripts/gen-fixtures.ts [url]
// Без аргумента запускает встроенный PostgreSQL. Результат: fixtures/pg<мажорная версия>.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { generatePlans } from '../test/support/gen-plans.ts';
import { startPg } from '../test/support/pg.ts';

const external = process.argv[2];
const pg = external ? { url: external, stop: async () => {} } : await startPg();
try {
  const { version, plans } = await generatePlans(pg.url);
  const major = version.split('.')[0];
  mkdirSync('fixtures', { recursive: true });
  writeFileSync(`fixtures/pg${major}.json`, JSON.stringify({ version, generatedAt: new Date().toISOString().slice(0, 10), plans }, null, 1) + '\n');
  console.log(`PostgreSQL ${version}: ${plans.length} запросов → fixtures/pg${major}.json`);
} finally {
  await pg.stop();
}
