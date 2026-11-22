// Генерация реальных планов на настоящем PostgreSQL: каждый запрос в четырёх видах (TEXT/JSON, с ANALYZE и без).
// Используется и для коммитимых образцов (scripts/gen-fixtures.ts), и для живой сверки на PostgreSQL 14/16/17 в CI.
import pg from 'pg';

export interface QuerySpec {
  name: string;
  sql: string;
  /** SET-команды перед запросом (сбрасываются после). */
  settings?: string[];
  /** Выполнять в транзакции с откатом (для INSERT/UPDATE/DELETE). */
  rollback?: boolean;
}

export const SCHEMA = `
DROP TABLE IF EXISTS items, orders, customers, events, corr CASCADE;
CREATE TABLE customers (id int PRIMARY KEY, name text NOT NULL, region text NOT NULL, created date NOT NULL) WITH (autovacuum_enabled = false);
CREATE TABLE orders (id int PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL, total numeric NOT NULL, created timestamptz NOT NULL) WITH (autovacuum_enabled = false);
CREATE TABLE items (order_id int NOT NULL, sku text NOT NULL, qty int NOT NULL) WITH (autovacuum_enabled = false);
CREATE TABLE events (id int NOT NULL, ts date NOT NULL, kind text NOT NULL) PARTITION BY RANGE (ts);
CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE corr (a int NOT NULL, b int NOT NULL) WITH (autovacuum_enabled = false);
INSERT INTO customers SELECT g, 'user' || g, (ARRAY['eu','us','asia','ru'])[1 + g % 4], date '2020-01-01' + (g % 1500) FROM generate_series(1, 20000) g;
INSERT INTO orders SELECT g, 1 + (g * 7919) % 20000, (ARRAY['new','paid','shipped','cancelled'])[1 + (g % 4)], (g * 37) % 1000, timestamptz '2025-01-01' + (g % 700) * interval '1 day' FROM generate_series(1, 200000) g;
INSERT INTO items SELECT 1 + g % 200000, 'sku' || (g % 500), 1 + g % 5 FROM generate_series(1, 400000) g;
INSERT INTO events SELECT g, date '2025-01-01' + (g % 700), (ARRAY['click','view','buy'])[1 + g % 3] FROM generate_series(1, 30000) g;
INSERT INTO corr SELECT g % 1000, g % 1000 FROM generate_series(1, 100000) g;
`;

const PARALLEL = ['max_parallel_workers_per_gather = 2', 'parallel_setup_cost = 0', 'parallel_tuple_cost = 0', 'min_parallel_table_scan_size = 0', 'min_parallel_index_scan_size = 0'];

/** Запросы до создания индексов: сканирование и соединения без индексов. */
export const BEFORE_INDEX: QuerySpec[] = [
  { name: 'seqscan_filter', sql: "SELECT * FROM orders WHERE status = 'new'" },
  { name: 'hash_join', sql: 'SELECT c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 900' },
  { name: 'merge_join', sql: 'SELECT c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 900', settings: ['enable_hashjoin = off', 'enable_nestloop = off'] },
  { name: 'agg_group', sql: 'SELECT status, count(*), sum(total) FROM orders GROUP BY status' },
  { name: 'sort_spill', sql: 'SELECT * FROM orders ORDER BY total', settings: ["work_mem = '64kB'"] },
  { name: 'sort_topn', sql: 'SELECT * FROM orders ORDER BY total DESC LIMIT 10' },
  { name: 'cte_materialized', sql: "WITH x AS MATERIALIZED (SELECT customer_id, total FROM orders WHERE status = 'paid') SELECT customer_id, sum(total) FROM x GROUP BY customer_id ORDER BY 2 DESC LIMIT 5" },
  { name: 'subplan', sql: 'SELECT c.id, (SELECT max(o.total) FROM orders o WHERE o.customer_id = c.id) AS m FROM customers c WHERE c.id < 50', settings: ['enable_hashagg = off'] },
  { name: 'initplan', sql: 'SELECT count(*) FROM orders WHERE total > (SELECT avg(total) FROM orders)' },
  { name: 'exists_semijoin', sql: "SELECT count(*) FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.total > 990)" },
  { name: 'parallel_count', sql: 'SELECT count(*) FROM orders WHERE total > 500', settings: PARALLEL },
  { name: 'parallel_sort', sql: 'SELECT * FROM orders WHERE total > 900 ORDER BY total', settings: PARALLEL },
  { name: 'window', sql: 'SELECT id, row_number() OVER (PARTITION BY customer_id ORDER BY created) FROM orders WHERE customer_id < 100' },
  { name: 'partition_prune', sql: "SELECT count(*) FROM events WHERE ts >= '2026-03-01' AND kind = 'buy'" },
  { name: 'partition_all', sql: "SELECT kind, count(*) FROM events GROUP BY kind" },
  { name: 'misestimate', sql: 'SELECT count(*) FROM corr WHERE a < 100 AND b < 100' },
  { name: 'limit_only', sql: 'SELECT * FROM orders LIMIT 5' },
  { name: 'function_scan', sql: 'SELECT * FROM generate_series(1, 10) g' },
  { name: 'values_scan', sql: "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) v(x, y)" },
  { name: 'union_all', sql: 'SELECT id FROM customers WHERE id < 5 UNION ALL SELECT id FROM orders WHERE id < 5' },
  { name: 'update_dml', sql: "UPDATE orders SET status = 'paid' WHERE id = 1", rollback: true },
  { name: 'delete_dml', sql: 'DELETE FROM items WHERE order_id = 7', rollback: true },
  { name: 'one_time_false', sql: 'SELECT * FROM orders WHERE false' },
  { name: 'three_way_join', sql: "SELECT c.region, count(*) FROM orders o JOIN customers c ON c.id = o.customer_id JOIN items i ON i.order_id = o.id WHERE o.total > 950 GROUP BY c.region" },
];

export const INDEXES = ['CREATE INDEX orders_customer_idx ON orders (customer_id)', 'CREATE INDEX items_order_idx ON items (order_id)', 'CREATE INDEX orders_total_idx ON orders (total)', 'VACUUM ANALYZE orders', 'ANALYZE items', 'ANALYZE customers', 'ANALYZE corr', 'ANALYZE events'];

/** Запросы после создания индексов: те же формы запросов, другой план. */
export const AFTER_INDEX: QuerySpec[] = [
  { name: 'index_scan', sql: 'SELECT * FROM orders WHERE customer_id = 42' },
  { name: 'bitmap_scan', sql: 'SELECT * FROM orders WHERE customer_id < 300' },
  { name: 'index_only_scan', sql: 'SELECT customer_id FROM orders WHERE customer_id = 42' },
  { name: 'nested_loop_index', sql: 'SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.id < 20' },
  { name: 'nested_loop_never_executed', sql: 'SELECT * FROM (SELECT * FROM orders WHERE id < 0 OFFSET 0) o JOIN customers c ON c.id = o.customer_id', settings: ['enable_hashjoin = off', 'enable_mergejoin = off'] },
  { name: 'three_way_join_idx', sql: "SELECT c.region, count(*) FROM orders o JOIN customers c ON c.id = o.customer_id JOIN items i ON i.order_id = o.id WHERE o.total > 950 GROUP BY c.region" },
  { name: 'sort_topn_idx', sql: 'SELECT * FROM orders ORDER BY total DESC LIMIT 10' },
  { name: 'hash_join_idx', sql: 'SELECT c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 900' },
];

export interface PlanSet {
  name: string;
  sql: string;
  jsonAnalyze: string;
  textAnalyze: string;
  jsonCosts: string;
  textCosts: string;
}

async function explain(c: pg.Client, spec: QuerySpec, opts: string): Promise<string> {
  if (spec.rollback) await c.query('BEGIN'); // EXPLAIN ANALYZE выполняет запрос: каждый раз с чистого состояния
  let r;
  try {
    r = await c.query(`EXPLAIN (${opts}) ${spec.sql}`);
  } finally {
    if (spec.rollback) await c.query('ROLLBACK');
  }
  const col = r.fields[0]!.name;
  return r.rows.map((row: Record<string, unknown>) => (typeof row[col] === 'string' ? row[col] : JSON.stringify(row[col]))).join('\n');
}

export async function generatePlans(url: string, onlyPhase?: 'before' | 'after'): Promise<{ version: string; plans: PlanSet[] }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const version = (await c.query<{ server_version: string }>('SHOW server_version')).rows[0]!.server_version;
    await c.query(SCHEMA);
    await c.query('ANALYZE');
    await c.query("SET jit = off; SET max_parallel_workers_per_gather = 0; SET track_io_timing = off; SET default_statistics_target = 100");
    const plans: PlanSet[] = [];
    const run = async (specs: QuerySpec[]) => {
      for (const spec of specs) {
        for (const s of spec.settings ?? []) await c.query(`SET ${s}`);
        const set: PlanSet = {
          name: spec.name,
          sql: spec.sql,
          jsonAnalyze: await explain(c, spec, 'ANALYZE, BUFFERS, FORMAT JSON'),
          textAnalyze: await explain(c, spec, 'ANALYZE, BUFFERS'),
          jsonCosts: await explain(c, spec, 'FORMAT JSON'),
          textCosts: await explain(c, spec, 'COSTS'),
        };
        for (const s of spec.settings ?? []) await c.query(`RESET ${s.split('=')[0]!.trim()}`);
        plans.push(set);
      }
    };
    if (onlyPhase !== 'after') await run(BEFORE_INDEX);
    for (const ddl of INDEXES) await c.query(ddl);
    if (onlyPhase !== 'before') await run([...BEFORE_INDEX.map((q) => ({ ...q, name: q.name + '@idx' })), ...AFTER_INDEX]);
    return { version, plans };
  } finally {
    await c.end();
  }
}
