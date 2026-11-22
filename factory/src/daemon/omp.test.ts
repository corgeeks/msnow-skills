import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { killAllSessions, runSession, type SessionOptions } from './omp.ts';

const fake = fileURLToPath(new URL('../../test/fakes/fake-omp.ts', import.meta.url));

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_OMP_')) delete process.env[k];
});

function opts(extra: Partial<SessionOptions> = {}): SessionOptions {
  const dir = mkdtempSync(join(tmpdir(), 'omp-test-'));
  return { cwd: dir, model: 'm/x', sessionDir: dir, maxCostUsd: 1.5, timeoutMs: 10_000, command: ['node', fake], ...extra };
}

function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

// Real subprocess: poll until the fake (identified by its unique --cwd temp dir) is running, then return its pid.
async function fakePid(cwd: string): Promise<number> {
  for (;;) {
    try { return Number(execFileSync('pgrep', ['-f', '--', cwd]).toString().trim().split('\n')[0]); } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('complete: status, text, cost, session, activity', async () => {
  process.env.FAKE_OMP_SCENARIO = 'complete';
  const lines: string[] = [];
  const r = await runSession('hi', opts({ onActivity: (t) => lines.push(t) }));
  assert.deepEqual(r, { status: 'completed', error: null, finalText: 'ok', costUsd: 0.01, sessionId: 'fake-session', sessionFile: '/fake/session.jsonl' });
  assert.deepEqual(lines, ['read a.txt', 'bash ls']);
  process.env.FAKE_OMP_TEXT = 'custom text';
  assert.equal((await runSession('hi', opts())).finalText, 'custom text');
});

test('activity lines from FAKE_OMP_TOOLS', async () => {
  process.env.FAKE_OMP_TOOLS = JSON.stringify([
    { toolName: 'bash', args: { command: 'x'.repeat(300) } },
    { toolName: 'edit', args: { path: 'p.ts', command: 'c' } },
    { toolName: 'web', args: { n: 1, url: 'http://u' } },
    { toolName: 'todo', args: {} },
  ]);
  const lines: string[] = [];
  await runSession('hi', opts({ onActivity: (t) => lines.push(t) }));
  assert.equal(lines[0].length, 160);
  assert.deepEqual(lines.slice(1), ['edit p.ts', 'web http://u', 'todo ']);
});

test('cost_cap and error', async () => {
  process.env.FAKE_OMP_SCENARIO = 'cost_cap';
  const c = await runSession('hi', opts());
  assert.equal(c.status, 'cost_cap');
  assert.equal(c.error, 'cost cap reached');
  process.env.FAKE_OMP_SCENARIO = 'error';
  const e = await runSession('hi', opts());
  assert.equal(e.status, 'error');
  assert.equal(e.error, 'fake failure');
});

test('hang: timeout despite late aborted', async () => {
  process.env.FAKE_OMP_SCENARIO = 'hang';
  const t0 = Date.now();
  const r = await runSession('hi', opts({ timeoutMs: 200 }));
  assert.equal(r.status, 'timeout');
  assert.match(r.error ?? '', /timed out/);
  assert.ok(Date.now() - t0 < 1000);
});

test('hang_ignore_abort: SIGKILL, still timeout, pid gone', async () => {
  process.env.FAKE_OMP_SCENARIO = 'hang_ignore_abort';
  const o = opts({ timeoutMs: 200, graceMs: { abort: 300, exit: 300 } });
  const p = runSession('hi', o);
  const pid = await fakePid(o.cwd);
  const r = await p;
  assert.equal(r.status, 'timeout');
  assert.ok(gone(pid));
});

test('no_ready: crashed, pid gone', async () => {
  process.env.FAKE_OMP_SCENARIO = 'no_ready';
  const o = opts({ graceMs: { ready: 300 } });
  const p = runSession('hi', o);
  const pid = await fakePid(o.cwd);
  const r = await p;
  assert.equal(r.status, 'crashed');
  assert.match(r.error ?? '', /no ready/);
  assert.ok(gone(pid));
});

test('crash: crashed with stderr tail', async () => {
  process.env.FAKE_OMP_SCENARIO = 'crash';
  const r = await runSession('hi', opts());
  assert.equal(r.status, 'crashed');
  assert.match(r.error ?? '', /fake-omp start scenario=crash/);
  assert.match(r.error ?? '', /code 3/);
});

test('edit: commits in the worktree', async () => {
  process.env.FAKE_OMP_SCENARIO = 'edit';
  // commit.gpgsign=false: a developer's global signing config would otherwise block on the signer.
  process.env.FAKE_OMP_EDIT = 'echo x > f && git add f && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm x';
  const o = opts();
  execSync('git init -q', { cwd: o.cwd });
  const r = await runSession('hi', o);
  assert.equal(r.status, 'completed');
  assert.equal(execSync('git log --format=%s', { cwd: o.cwd }).toString().trim(), 'x');
});

test('argv flags', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'omp-argv-')), 'argv.json');
  process.env.FAKE_OMP_ARGV_FILE = file;
  const o = opts();
  await runSession('hi', o);
  let argv: string[] = JSON.parse(readFileSync(file, 'utf8'));
  const val = (f: string) => argv[argv.indexOf(f) + 1];
  assert.ok(!argv.includes('--max-time'));
  assert.ok(!argv.includes('--append-system-prompt'));
  assert.equal(val('--max-cost'), '1.5');
  assert.equal(val('--model'), 'm/x');
  assert.equal(val('--cwd'), o.cwd);
  await runSession('hi', opts({ appendSystemPrompt: 'be brief' }));
  argv = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(val('--append-system-prompt'), 'be brief');
});

test('killAllSessions: pending session resolves crashed', async () => {
  process.env.FAKE_OMP_SCENARIO = 'hang_ignore_abort';
  const o = opts();
  const p = runSession('hi', o);
  await fakePid(o.cwd);
  killAllSessions();
  const r = await p;
  assert.equal(r.status, 'crashed');
  assert.match(r.error ?? '', /SIGTERM/);
  killAllSessions();
});
