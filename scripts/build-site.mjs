// Сборка страницы: esbuild собирает app.ts вместе с разбором планов; примеры берутся из настоящих планов PostgreSQL (fixtures).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('site', { recursive: true, force: true });
mkdirSync('site');
await build({ entryPoints: ['site-src/app.ts'], outfile: 'site/app.js', bundle: true, format: 'esm', target: 'es2022', minify: true });
copyFileSync('site-src/index.html', 'site/index.html');

const fx = JSON.parse(readFileSync('fixtures/pg18.json', 'utf8'));
const get = (name, key) => fx.plans.find((p) => p.name === name)[key];
const examples = {
  subplan: { a: get('subplan', 'textAnalyze'), b: get('subplan@idx', 'textAnalyze') },
  sort: { a: get('sort_spill', 'jsonAnalyze'), b: get('sort_spill@idx', 'jsonAnalyze') },
  join: { a: get('hash_join', 'textAnalyze'), b: get('hash_join@idx', 'textAnalyze') },
};
writeFileSync('site/examples.js', `// Реальные планы PostgreSQL ${fx.version} (fixtures/pg18.json)\nvar EXAMPLES = ${JSON.stringify(examples)};\n`);

let commit = process.env.GITHUB_SHA;
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    commit = undefined;
  }
}
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (commit) writeFileSync('site/version.json', JSON.stringify({ commit, version, builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log('site/ готов');
