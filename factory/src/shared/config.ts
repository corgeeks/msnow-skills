import { readFileSync } from 'node:fs';
import type { Config } from './types.ts';

export const DEFAULT_CONFIG: Config = {
  port: 7317,
  roles: {
    planner: 'anthropic/claude-opus-5-5',
    executor: { heavy: 'anthropic/claude-opus-5-5', standard: 'anthropic/claude-sonnet-5-5', light: 'anthropic/claude-haiku-5-5' },
    reviewer: { anthropic: 'openai-codex/gpt-6.2-sol', 'openai-codex': 'anthropic/claude-opus-5-5' },
  },
  caps: { sessionMinutes: 30, sessionCostUsd: 5, itemCostUsd: 2 },
  loop: { maxBuildAttempts: 3, maxReviewRounds: 2, maxParallel: 2 },
  git: { stateCommitPrefix: 'factory: state', stateCommitDebounceSec: 60 },
  defaultTestCmd: 'npm test --prefix factory',
};

// Maps whose keys are open (any string key, string value).
const OPEN_MAPS = new Set(['roles.reviewer']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(def: unknown, raw: unknown, path: string): unknown {
  const at = path || '<root>';
  if (isObject(def)) {
    if (!isObject(raw)) throw new Error(`config: ${at} must be an object`);
    const out: Record<string, unknown> = OPEN_MAPS.has(path) ? {} : { ...def };
    for (const [k, v] of Object.entries(raw)) {
      const p = path ? `${path}.${k}` : k;
      if (OPEN_MAPS.has(path)) {
        if (typeof v !== 'string') throw new Error(`config: ${p} must be a string`);
        out[k] = v;
      } else if (!Object.hasOwn(def, k)) {
        throw new Error(`config: unknown key ${p}`);
      } else {
        out[k] = merge(def[k], v, p);
      }
    }
    return out;
  }
  if (typeof raw !== typeof def) throw new Error(`config: ${at} must be a ${typeof def}`);
  return raw;
}

export function parseConfig(raw: unknown): Config {
  const c = merge(DEFAULT_CONFIG, raw, '') as Config;
  if (!(c.caps.itemCostUsd > 0)) throw new Error('config: caps.itemCostUsd must be greater than 0');
  return c;
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw e;
  }
  return parseConfig(JSON.parse(text));
}
