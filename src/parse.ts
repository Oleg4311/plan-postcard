import { parseJsonPlan } from './parse-json.ts';
import { parseTextPlan } from './parse-text.ts';
import { PlanParseError } from './types.ts';
import type { Plan } from './types.ts';

/** Определяет формат (JSON или текст) и разбирает план. */
export function parsePlan(input: string): Plan {
  const t = input.replace(/^﻿/, '').trim();
  if (t === '') throw new PlanParseError('пусто: вставьте вывод EXPLAIN');
  const looksJson = /^[[{]/.test(t) || /^"\s*[[{]/.test(t) || (/"Plan"\s*:/.test(t) && /[[{]/.test(t));
  return looksJson ? parseJsonPlan(t) : parseTextPlan(t);
}

export { parseJsonPlan, parseTextPlan };
