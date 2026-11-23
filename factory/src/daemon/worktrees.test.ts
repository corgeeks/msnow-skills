import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitAll, commitsAhead, createWorktree, headSha, isClean, listWorktrees, pruneWorktrees, removeWorktree, resetHard,
} from './worktrees.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function fixture(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'wt-'));
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  sh(tmp, 'clone', '-q', 'origin.git', 'root');
  const root = join(tmp, 'root');
  writeFileSync(join(root, 'a'), 'a');
  sh(root, 'add', 'a');
  sh(root, ...ID, 'commit', '-qm', 'init');
  sh(root, 'push', '-q', 'origin', 'HEAD:main');
  sh(root, 'fetch', '-q');
  return root;
}

test('create, list, duplicate', () => {
  const root = fixture();
  const wt = createWorktree(root, { itemId: 7, attempt: 1, base: 'origin/main' });
  assert.deepEqual(wt, { path: join(root, '.factory/worktrees/7-1'), branch: 'factory/7-1' });
  assert.ok(existsSync(wt.path));
  assert.equal(headSha(wt.path), sh(root, 'rev-parse', 'origin/main'));
  assert.throws(() => createWorktree(root, { itemId: 7, attempt: 1, base: 'origin/main' }));
  sh(root, 'worktree', 'add', '-q', join(root, '..', 'outside'));
  sh(root, 'worktree', 'add', '-q', '--lock', '--reason', 'two words', '-b', 'x', join(root, '.factory/worktrees/x'));
  assert.deepEqual(listWorktrees(root), [
    { path: realpathSync(wt.path), branch: 'factory/7-1', locked: true, prunable: false },
    { path: realpathSync(join(root, '.factory/worktrees/x')), branch: 'x', locked: true, prunable: false },
  ]);
});

test('commitAll, isClean, resetHard', () => {
  const root = fixture();
  const { path } = createWorktree(root, { itemId: 1, attempt: 1, base: 'origin/main' });
  assert.equal(commitAll(path, 'noop'), null);
  writeFileSync(join(path, 'b'), 'b');
  assert.equal(isClean(path), false);
  const sha = commitAll(path, 'add b');
  assert.match(sha!, /^[0-9a-f]{40}$/);
  assert.equal(sha, headSha(path));
  assert.equal(sh(path, 'log', '-1', '--format=%an <%ae>'), 'factory <factory@localhost>');
  assert.throws(() => sh(root, 'config', '--local', 'user.name'));
  assert.equal(commitsAhead(path, 'origin/main'), 1);
  writeFileSync(join(path, 'b'), 'changed');
  writeFileSync(join(path, 'junk'), 'j');
  resetHard(path);
  assert.ok(isClean(path));
  assert.ok(!existsSync(join(path, 'junk')));
  assert.equal(headSha(path), sha);
});

test('removeWorktree locked+dirty, with and without branch delete', () => {
  const root = fixture();
  const a = createWorktree(root, { itemId: 7, attempt: 1, base: 'origin/main' });
  writeFileSync(join(a.path, 'dirty'), 'x');
  removeWorktree(root, a.path, { deleteBranch: a.branch });
  assert.ok(!existsSync(a.path));
  assert.deepEqual(listWorktrees(root), []);
  assert.equal(sh(root, 'branch', '--list', a.branch), '');
  const b = createWorktree(root, { itemId: 7, attempt: 2, base: 'origin/main' });
  removeWorktree(root, b.path, { deleteBranch: null });
  assert.notEqual(sh(root, 'branch', '--list', b.branch), '');
});

test('pruneWorktrees', () => {
  const root = fixture();
  const locked = createWorktree(root, { itemId: 1, attempt: 1, base: 'origin/main' });
  const open = createWorktree(root, { itemId: 2, attempt: 1, base: 'origin/main' });
  sh(root, 'worktree', 'unlock', open.path);
  rmSync(open.path, { recursive: true });
  rmSync(locked.path, { recursive: true });
  assert.equal(listWorktrees(root).find((w) => w.branch === open.branch)?.prunable, true);
  pruneWorktrees(root);
  assert.deepEqual(listWorktrees(root).map((w) => w.branch), [locked.branch]);
});

test('git failure carries stderr', () => {
  const root = fixture();
  assert.throws(() => createWorktree(root, { itemId: 1, attempt: 1, base: 'nope' }), /invalid reference|not a valid/);
});
