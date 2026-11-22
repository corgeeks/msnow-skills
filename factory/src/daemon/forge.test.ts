import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createForge } from './forge.ts';
import { createQueue, DAEMON_COMMIT_FLAGS, git } from './git.ts';
import { makeRepos } from '../../test/fixtures/git-repos.ts';

const fakeGh = join(import.meta.dirname, '../../test/fakes/fake-gh.ts');

function setup() {
  const r = makeRepos();
  const statePath = join(r.dir, 'gh-state.json');
  process.env.FAKE_GH_REMOTE = r.origin;
  process.env.FAKE_GH_STATE = statePath;
  const forge = createForge({ root: r.root, mainWorktree: r.mainWorktree, queue: createQueue(), ghCommand: [process.execPath, fakeGh] });
  const ghState = () => JSON.parse(readFileSync(statePath, 'utf8'));
  return { ...r, statePath, forge, ghState, [Symbol.dispose]: () => rmSync(r.dir, { recursive: true, force: true }) };
}

// Pushes a branch `factory/1-1` with one new file from a linked worktree; returns its SHA.
function makeBranch(s: ReturnType<typeof setup>, file = 'feature.txt') {
  const wt = join(s.dir, 'wt');
  git(s.root, ['worktree', 'add', '-b', 'factory/1-1', wt, 'origin/main']);
  writeFileSync(join(wt, file), 'hello\n');
  git(wt, ['add', file]);
  git(wt, [...DAEMON_COMMIT_FLAGS, 'commit', '-m', 'feature']);
  return { wt, sha: git(wt, ['rev-parse', 'HEAD']) };
}

test('ensureMainWorktree creates, re-syncs, and follows origin without touching root', async () => {
  using s = setup();
  const rootSnap = () => [git(s.root, ['rev-parse', 'HEAD']), git(s.root, ['symbolic-ref', 'HEAD']), git(s.root, ['status', '--porcelain'])];
  const before = rootSnap();
  await s.forge.ensureMainWorktree();
  assert.equal(git(s.mainWorktree, ['rev-parse', 'HEAD']), git(s.root, ['rev-parse', 'origin/main']));
  assert.throws(() => git(s.mainWorktree, ['symbolic-ref', '-q', 'HEAD']));
  await s.forge.ensureMainWorktree();

  const other = join(s.dir, 'other');
  git(s.dir, ['clone', s.origin, other]);
  writeFileSync(join(other, 'new.txt'), 'x\n');
  git(other, ['add', '.']);
  git(other, [...DAEMON_COMMIT_FLAGS, 'commit', '-m', 'new']);
  git(other, ['push', 'origin', 'main']);
  await s.forge.ensureMainWorktree();
  assert.equal(git(s.mainWorktree, ['rev-parse', 'HEAD']), git(other, ['rev-parse', 'HEAD']));
  assert.deepEqual(rootSnap(), before);
});

test('syncMain discards dirty and untracked files', async () => {
  using s = setup();
  await s.forge.ensureMainWorktree();
  writeFileSync(join(s.mainWorktree, 'README.md'), 'dirty\n');
  writeFileSync(join(s.mainWorktree, 'junk.txt'), 'junk\n');
  await s.forge.syncMain();
  assert.equal(readFileSync(join(s.mainWorktree, 'README.md'), 'utf8'), '# test\n');
  assert.equal(existsSync(join(s.mainWorktree, 'junk.txt')), false);
});

test('branch flow: push, open, comment, view, merge, sync', async () => {
  using s = setup();
  await s.forge.ensureMainWorktree();
  const { wt, sha } = makeBranch(s);
  await s.forge.pushBranch(wt, 'factory/1-1');
  const pr = await s.forge.openPr({ branch: 'factory/1-1', title: 'Feature', body: 'body text' });
  assert.deepEqual(pr, { number: 1, url: 'https://github.com/fake/repo/pull/1' });
  await s.forge.commentPr(1, 'a comment');
  assert.deepEqual(s.ghState().prs['1'].comments, ['a comment']);
  assert.deepEqual(await s.forge.prState(1), { number: 1, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: sha, checks: 0 });

  await assert.rejects(s.forge.mergePr(1, '0'.repeat(40)), /head commit mismatch/);
  assert.equal((await s.forge.prState(1)).state, 'OPEN');
  await s.forge.mergePr(1, sha);
  assert.equal((await s.forge.prState(1)).state, 'MERGED');
  await s.forge.syncMain();
  assert.equal(readFileSync(join(s.mainWorktree, 'feature.txt'), 'utf8'), 'hello\n');
});

test('prState retries while mergeable is UNKNOWN', async () => {
  using s = setup();
  const { wt } = makeBranch(s);
  await s.forge.pushBranch(wt, 'factory/1-1');
  await s.forge.openPr({ branch: 'factory/1-1', title: 'T', body: 'b' });
  const st = s.ghState();
  st.prs['1'].unknownViews = 1;
  writeFileSync(s.statePath, JSON.stringify(st));
  const t0 = Date.now();
  assert.equal((await s.forge.prState(1)).mergeable, 'MERGEABLE');
  assert.ok(Date.now() - t0 >= 1900);
});

test('closePr records CLOSED; deleteRemoteBranch is idempotent', async () => {
  using s = setup();
  const { wt } = makeBranch(s);
  await s.forge.pushBranch(wt, 'factory/1-1');
  await s.forge.openPr({ branch: 'factory/1-1', title: 'T', body: 'b' });
  await s.forge.closePr(1, 'nope');
  assert.equal((await s.forge.prState(1)).state, 'CLOSED');
  assert.deepEqual(s.ghState().prs['1'].comments, ['nope']);

  await s.forge.deleteRemoteBranch('factory/1-1');
  assert.equal(git(s.root, ['ls-remote', 'origin', 'refs/heads/factory/1-1']), '');
  await s.forge.deleteRemoteBranch('factory/1-1');
});

test('syncMain waits for a job already holding the queue', async () => {
  const r = makeRepos();
  try {
    const queue = createQueue();
    const forge = createForge({ root: r.root, mainWorktree: r.mainWorktree, queue });
    await forge.ensureMainWorktree();
    const order: string[] = [];
    let release!: () => void;
    const held = queue.run(() => new Promise<void>((res) => { release = () => { order.push('job'); res(); }; }));
    const sync = forge.syncMain().then(() => order.push('sync'));
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(order, []);
    release();
    await Promise.all([held, sync]);
    assert.deepEqual(order, ['job', 'sync']);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
