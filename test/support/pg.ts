import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestPg {
  url: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/** Внешний сервер из PLANS_TEST_URL (в CI) или встроенный PostgreSQL. */
export async function startPg(): Promise<TestPg> {
  if (process.env.PLANS_TEST_URL) return { url: process.env.PLANS_TEST_URL, async stop() {} };
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'plan-postcard-pg-'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  return {
    url: `postgres://postgres:pw@127.0.0.1:${port}/postgres`,
    async stop() {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
