import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRetro } from './retro.ts';
import type { NodeRun, Run } from '../shared/types.ts';

const T0 = '2026-01-01T00:00:00.000Z';
const T60 = '2026-01-01T00:01:00.000Z';
const run: Run = {
  id: 1, item_id: 1, template: 'change', attempt: 1, status: 'merged' as Run['status'],
  branch: null, worktree: null, pr_number: null, pr_url: null, head_sha: null,
  cost_usd: 0, started_at: T0, ended_at: T60,
};
let nextId = 1;
function nr(p: Partial<NodeRun>): NodeRun {
  return {
    id: nextId++, run_id: 1, node: 'build', iteration: 1, status: 'completed', model: null,
    session_file: null, cost_usd: 0, output: null, started_at: null, ended_at: null, ...p,
  };
}

test('happy path', () => {
  const rows = [nr({ node: 'build', cost_usd: 0.01 }), nr({ node: 'test', cost_usd: 0.02 }), nr({ node: 'review' }),
    nr({ node: 'pr' }), nr({ node: 'merge_gate' }), nr({ node: 'merge' })];
  assert.deepEqual(computeRetro(run, rows, ['f1']), {
    run_id: 1, failures: [], findings: ['f1'], rework_count: 0, cost_usd: 0.03, duration_s: 60, notes: '',
  });
});

test('test failure then retry; other run ignored; order-independent', () => {
  const rows = [nr({ node: 'build' }), nr({ node: 'test', status: 'failed', output: 'exit 1\nlots of noise' }),
    nr({ node: 'build', iteration: 2 }), nr({ node: 'test', iteration: 2 }),
    nr({ run_id: 2, node: 'build', iteration: 9, status: 'failed', cost_usd: 5 })];
  const r = computeRetro(run, rows, []);
  assert.deepEqual(r.failures, ['test #1: exit 1']);
  assert.equal(r.rework_count, 1);
  assert.equal(r.cost_usd, 0);
  assert.deepEqual(computeRetro(run, [...rows].reverse(), []), r);
});

test('failed build output formatting and truncation', () => {
  const r = computeRetro(run, [nr({ status: 'failed', output: 'timeout' }), nr({ status: 'failed' }),
    nr({ status: 'failed', output: 'x'.repeat(400) })], []);
  assert.deepEqual(r.failures.slice(0, 2), ['build #1: timeout', 'build #1: no output']);
  assert.equal(r.failures[2].length, 300);
});

test('review-only rework', () => {
  const r = computeRetro(run, [nr({}), nr({ node: 'review', output: 'changes' }), nr({ iteration: 2 })], []);
  assert.equal(r.rework_count, 1);
  assert.deepEqual(r.failures, []);
});

test('duration fallbacks', () => {
  const rows = [nr({ ended_at: '2026-01-01T00:00:30.000Z' }), nr({ node: 'test', ended_at: '2026-01-01T00:00:45.000Z' })];
  assert.equal(computeRetro({ ...run, ended_at: null }, rows, []).duration_s, 45);
  assert.equal(computeRetro({ ...run, ended_at: null }, [], []).duration_s, 0);
  assert.equal(computeRetro({ ...run, started_at: null }, rows, []).duration_s, 0);
});

test('findings are copied', () => {
  const f = ['a'];
  computeRetro(run, [], f).findings.push('b');
  assert.deepEqual(f, ['a']);
});
