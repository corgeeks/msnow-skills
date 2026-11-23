import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSession } from './omp.ts';

test('live omp smoke', { skip: process.env.FACTORY_LIVE_OMP !== '1' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-live-'));
  const r = await runSession('Reply with exactly: ok', {
    cwd: dir, model: 'anthropic/claude-haiku-5-5', sessionDir: join(dir, 'sessions'), maxCostUsd: 0.05, timeoutMs: 120_000,
  });
  assert.equal(r.status, 'completed', r.error ?? '');
  assert.ok(r.finalText.length > 0);
  assert.ok(r.costUsd > 0);
  assert.ok(r.sessionFile && existsSync(r.sessionFile));
});
