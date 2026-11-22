import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FactoryEvent } from '../shared/types.ts';
import { createBus } from './bus.ts';
import { openDb } from './db.ts';
import { createQueue, git } from './git.ts';
import { createStateCommitter } from './state-commit.ts';
import { createStore } from './store.ts';
import { makeRepos } from '../../test/fixtures/git-repos.ts';

function setup() {
  const r = makeRepos();
  git(r.root, ['worktree', 'add', '--detach', r.mainWorktree, 'origin/main']);
  const db = openDb(join(r.dir, 'live', 'factory.db'));
  const bus = createBus();
  const store = createStore(db, bus);
  const queue = createQueue();
  const committer = createStateCommitter({ db, bus, queue, mainWorktree: r.mainWorktree, prefix: 'factory: state', debounceSec: 0.05 });
  const subjects = () => git(r.origin, ['log', '--format=%s', 'main']).split('\n');
  // Timer fires at 50 ms; the queued job is synchronous, so draining the queue afterwards waits for it.
  const settle = async () => { await sleep(200); await queue.run(() => {}); };
  return {
    ...r, db, bus, store, committer, subjects, settle,
    [Symbol.dispose]: () => { committer.stop(); db.close(); rmSync(r.dir, { recursive: true, force: true }); },
  };
}

// pre-push hook (shared by the linked worktree) that races a foreign commit onto origin main.
function racingHook(s: ReturnType<typeof setup>, everyTime: boolean) {
  const marker = join(s.dir, 'hook-ran');
  const hook = join(s.root, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
${everyTime ? '' : `[ -e '${marker}' ] && exit 0\n`}touch '${marker}'
d=$(mktemp -d)
git clone -q '${s.origin}' "$d/c" && cd "$d/c" &&
  git -c user.name=x -c user.email=x@localhost -c commit.gpgsign=false commit -q --allow-empty -m "foreign $$" &&
  git push -q origin HEAD:main
rm -rf "$d"
exit 0
`);
  chmodSync(hook, 0o755);
  return hook;
}

const ev = (type: FactoryEvent['type'], data: Record<string, unknown> = {}): FactoryEvent =>
  ({ seq: 0, item_id: 1, run_id: 1, node: 'n', type, data, at: '' });

test('debounces milestones into one commit with a verified snapshot', async () => {
  using s = setup();
  const before = s.subjects().length;
  s.store.createItem({ title: 'x' });
  s.store.createRun({ item_id: 1, template: 't' });
  s.store.openGate({ run_id: 1, node: 'merge', kind: 'merge', question: 'q' });
  await s.settle();
  const subj = s.subjects();
  assert.equal(subj.length, before + 1);
  assert.equal(subj[0], 'factory: state (#1 run 1 started, #1 gate opened (merge))');
  const copy = join(s.dir, 'copy.db');
  writeFileSync(copy, execFileSync('git', ['show', 'main:.factory/factory.db'], { cwd: s.origin }));
  const c = new DatabaseSync(copy, { readOnly: true });
  for (const t of ['work_items', 'runs', 'gates', 'events']) {
    const q = `SELECT count(*) AS n FROM ${t}`;
    assert.deepEqual(c.prepare(q).get(), s.db.prepare(q).get(), t);
  }
  c.close();
});

test('maps run.updated milestones and ignores other events', async () => {
  using s = setup();
  const before = s.subjects().length;
  s.store.createItem({ title: 'x' }); // item.created: ignored
  s.bus.publish(ev('item.updated', { status: 'done' }));
  s.bus.publish(ev('node.updated', { status: 'completed' }));
  s.bus.publish(ev('run.updated', { status: 'running' }));
  await s.settle();
  assert.equal(s.subjects().length, before);
  s.bus.publish(ev('run.updated', { status: 'failed', pr_number: 7 }));
  s.bus.publish({ ...ev('gate.closed', { decision: 'approve' }), item_id: null });
  s.bus.publish(ev('retro.recorded'));
  await s.settle();
  assert.equal(s.subjects()[0], 'factory: state (#1 run 1 failed, #1 PR #7 opened, #? gate closed (approve), #1 retro)');
});

test('flush(reason) commits immediately; nothing staged makes no commit', async () => {
  using s = setup();
  const before = s.subjects().length;
  s.store.createItem({ title: 'x' });
  await s.committer.flush('merged #1');
  assert.equal(s.subjects()[0], 'factory: state (merged #1)');
  await s.committer.flush();
  await s.committer.flush('again');
  assert.equal(s.subjects().length, before + 1);
});

test('retries once after a non-fast-forward rejection', async () => {
  using s = setup();
  racingHook(s, false);
  s.store.createItem({ title: 'x' });
  await s.committer.flush('merged #1');
  const subj = s.subjects();
  assert.equal(subj[0], 'factory: state (merged #1)');
  assert.match(subj[1], /^foreign /);
});

test('double failure logs, keeps summaries, and a later flush includes them', async (t) => {
  using s = setup();
  const errors = t.mock.method(console, 'error', () => {});
  const hook = racingHook(s, true);
  s.store.createItem({ title: 'x' });
  s.store.createRun({ item_id: 1, template: 't' });
  await s.committer.flush('merged #1');
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /^factory: state commit failed: /);
  assert.ok(!s.subjects().some((m) => m.startsWith('factory: state')));
  rmSync(hook);
  await s.committer.flush();
  assert.equal(s.subjects()[0], 'factory: state (#1 run 1 started, merged #1)');
});

test('truncates the summary list to 200 chars', async () => {
  using s = setup();
  s.store.createItem({ title: 'x' });
  for (let i = 0; i < 40; i++) s.bus.publish(ev('run.created'));
  await s.committer.flush();
  const text = /^factory: state \((.*)\)$/.exec(s.subjects()[0])![1];
  assert.equal(text.length, 200);
  assert.ok(text.endsWith('…'));
});

test('stop() ignores later milestones', async () => {
  using s = setup();
  const before = s.subjects().length;
  s.committer.stop();
  s.store.createItem({ title: 'x' });
  s.store.createRun({ item_id: 1, template: 't' });
  await s.settle();
  assert.equal(s.subjects().length, before);
});
