import { readFileSync } from 'node:fs';
import type { PlanSet } from './support/gen-plans.ts';

export interface FixtureFile {
  version: string;
  generatedAt: string;
  plans: PlanSet[];
}

export const pg18: FixtureFile = JSON.parse(readFileSync(new URL('../fixtures/pg18.json', import.meta.url), 'utf8'));

export function fixture(name: string): PlanSet {
  const p = pg18.plans.find((x) => x.name === name);
  if (!p) throw new Error(`нет образца ${name}`);
  return p;
}
