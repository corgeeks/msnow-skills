import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createBus } from '../src/daemon/bus.ts';
import { openDb } from '../src/daemon/db.ts';
import { createEngine } from '../src/daemon/engine.ts';
import { createForge } from '../src/daemon/forge.ts';
import { createQueue } from '../src/daemon/git.ts';
import { createApiServer } from '../src/daemon/http.ts';
import { killAllSessions, runSession } from '../src/daemon/omp.ts';
import { resolvePaths } from '../src/daemon/paths.ts';
import { createStateCommitter } from '../src/daemon/state-commit.ts';
import { createStore } from '../src/daemon/store.ts';
import * as worktrees from '../src/daemon/worktrees.ts';
import { DEFAULT_CONFIG } from '../src/shared/config.ts';
import { makeRepos } from './fixtures/git-repos.ts';

const FAKE_OMP = new URL('./fakes/fake-omp.ts', import.meta.url).pathname;
const FAKE_GH = new URL('./fakes/fake-gh.ts', import.meta.url).pathname;

export type Role = 'build' | 'review';
export type Script = (call: { role: Role; n: number }) => Record<string, string>;

export const APPROVE = '```json\n{"verdict":"approve","findings":[]}\n```';
export const defaultScript: Script = ({ role, n }): Record<string, string> => role === 'build'
  ? { FAKE_OMP_SCENARIO: 'edit', FAKE_OMP_EDIT: `echo x > factory/feature-${n}.txt && git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm feat` }
  : { FAKE_OMP_SCENARIO: 'complete', FAKE_OMP_TEXT: APPROVE };

export const gitOut = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

export async function waitFor<T>(pred: () => T, timeoutMs = 15000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`waitFor timed out: ${pred}`);
    await sleep(50);
  }
}

export async function setupFactory(t: TestContext, opts: { script?: Script } = {}) {
  const script = opts.script ?? defaultScript;
  const repos = makeRepos();
  const T = repos.dir;
  const { root, origin } = repos;

  // Seed main with factory/README.md and a test.sh driven by marker files in T.
  const seed = join(T, 'seed');
  gitOut(T, ['clone', '-q', origin, seed]);
  mkdirSync(join(seed, 'factory'));
  writeFileSync(join(seed, 'factory', 'README.md'), '# factory\n');
  writeFileSync(join(seed, 'test.sh'),
    `echo running tests\nif [ -e '${T}/fail' ]; then echo boom; exit 1; fi\n` +
    `if [ -e '${T}/fail-once' ]; then rm '${T}/fail-once'; echo boom-once; exit 1; fi\necho ok\n`);
  gitOut(seed, ['add', '-A']);
  gitOut(seed, ['commit', '-qm', 'seed']);
  gitOut(seed, ['push', '-q', 'origin', 'main']);
  rmSync(seed, { recursive: true, force: true });
  gitOut(root, ['pull', '-q']);

  const paths = resolvePaths(root);
  mkdirSync(paths.liveDir, { recursive: true });
  const db = openDb(paths.liveDb);
  const bus = createBus();
  const store = createStore(db, bus);
  const queue = createQueue();
  const ghState = join(T, 'gh.json');
  const forge = createForge({
    root, mainWorktree: paths.mainWorktree, queue,
    ghCommand: ['env', `FAKE_GH_REMOTE=${origin}`, `FAKE_GH_STATE=${ghState}`, 'GH_PROMPT_DISABLED=1', process.execPath, FAKE_GH],
  });
  await forge.ensureMainWorktree();
  const committer = createStateCommitter({ db, bus, queue, mainWorktree: paths.mainWorktree, prefix: DEFAULT_CONFIG.git.stateCommitPrefix, debounceSec: 3600 });
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    loop: { ...DEFAULT_CONFIG.loop, maxParallel: 1 },
    caps: { ...DEFAULT_CONFIG.caps, sessionMinutes: 1 },
    defaultTestCmd: 'sh test.sh',
  };

  const prompts: { role: Role; n: number; prompt: string }[] = [];
  const counts = { build: 0, review: 0, settled: 0 };
  const recordingRunSession: typeof runSession = (prompt, o) => {
    const role: Role = Object.values(config.roles.executor).includes(o.model) ? 'build' : 'review';
    const n = ++counts[role];
    prompts.push({ role, n, prompt });
    const vars = Object.entries(script({ role, n })).map(([k, v]) => `${k}=${v}`);
    return runSession(prompt, { ...o, command: ['env', ...vars, process.execPath, FAKE_OMP], graceMs: { ready: 2000, exit: 500, abort: 500 } })
      .finally(() => counts.settled++);
  };
  const newEngine = () => createEngine({ store, bus, config, paths, runSession: recordingRunSession, worktrees, forge, committer, tickMs: 50 });

  const server = createApiServer({ store, bus, uiDir: paths.uiDir, root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const f = {
    T, root, origin, port, base, paths, db, store, bus, forge, committer, config, prompts, engine: newEngine(), newEngine,
    sessionsSettled: () => counts.settled,
    waitFor,
    async decide(gateId: number, decision: 'approve' | 'reject' | 'override', note?: string) {
      const res = await fetch(`${base}/api/gates/${gateId}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, note }),
      });
      if (res.status !== 200) throw new Error(`decision ${res.status}: ${await res.text()}`);
      return res.json();
    },
    /** Raw decision call; unlike `decide` it returns non-200 responses instead of throwing. */
    async rawDecide(gateId: number, decision: string, note?: string) {
      const res = await fetch(`${base}/api/gates/${gateId}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, note }),
      });
      return { status: res.status, json: await res.json() as { error?: { code: string; message: string } } };
    },
    gh(): { prs: Record<string, { state: string; branch: string; body: string; comments: string[] }> } {
      return existsSync(ghState) ? JSON.parse(readFileSync(ghState, 'utf8')) : { prs: {} };
    },
    nodes(runId: number) { return store.listNodeRuns(runId); },
    git: (args: string[]) => gitOut(root, args),
    queueItem(title = 'add feature') {
      const item = store.createItem({ title, body: 'b' } as never);
      store.transitionItem(item.id, 'draft', 'ready');
      store.transitionItem(item.id, 'ready', 'queued');
      return item;
    },
  };
  t.after(async () => {
    await f.engine.stop();
    killAllSessions();
    await waitFor(() => counts.settled === prompts.length);
    committer.stop();
    server.close();
    server.closeAllConnections();
    db.close();
    rmSync(T, { recursive: true, force: true });
  });
  await f.engine.start();
  return f;
}
