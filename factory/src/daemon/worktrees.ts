import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DAEMON_COMMIT_FLAGS, git } from './git.ts';

export interface Worktree { path: string; branch: string }

const dirOf = (root: string) => join(resolve(root), '.factory', 'worktrees');

export function createWorktree(root: string, o: { itemId: number; attempt: number; base: string }): Worktree {
  const name = `${o.itemId}-${o.attempt}`;
  const path = join(dirOf(root), name);
  const branch = `factory/${name}`;
  mkdirSync(dirOf(root), { recursive: true });
  git(root, ['worktree', 'add', '--lock', '--reason', `factory item ${o.itemId} attempt ${o.attempt}`, '-b', branch, path, o.base]);
  return { path, branch };
}

export function removeWorktree(root: string, path: string, o: { deleteBranch: string | null }): void {
  try {
    git(root, ['worktree', 'unlock', path]);
  } catch (e) {
    if (!/not locked/.test((e as Error).message)) throw e;
  }
  git(root, ['worktree', 'remove', '--force', path]);
  if (o.deleteBranch !== null) git(root, ['branch', '-D', o.deleteBranch]);
}

export function pruneWorktrees(root: string): void {
  git(root, ['worktree', 'prune']);
}

export function listWorktrees(root: string): Array<Worktree & { locked: boolean; prunable: boolean }> {
  const dir = join(realpathSync(root), '.factory', 'worktrees');
  const out = git(root, ['worktree', 'list', '--porcelain', '-z']);
  return out.split('\0\0').filter(Boolean).flatMap((rec) => {
    const wt = { path: '', branch: '', locked: false, prunable: false };
    for (const f of rec.split('\0')) {
      const [key, ...rest] = f.split(' ');
      const val = rest.join(' ');
      if (key === 'worktree') wt.path = val;
      else if (key === 'branch') wt.branch = val.replace(/^refs\/heads\//, '');
      else if (key === 'locked') wt.locked = true;
      else if (key === 'prunable') wt.prunable = true;
    }
    // Prunable entries have no dir, so compare the parent (.factory/worktrees itself) after realpath.
    let parent = resolve(wt.path, '..');
    try { parent = realpathSync(parent); } catch { /* parent gone: outside our dir */ }
    return parent === dir ? [wt] : [];
  });
}

export function commitAll(path: string, message: string): string | null {
  git(path, ['add', '-A']);
  if (git(path, ['diff', '--cached', '--name-only']) === '') return null;
  git(path, [...DAEMON_COMMIT_FLAGS, 'commit', '-m', message]);
  return headSha(path);
}

export function headSha(path: string): string {
  return git(path, ['rev-parse', 'HEAD']);
}

export function commitsAhead(path: string, base: string): number {
  return Number(git(path, ['rev-list', '--count', `${base}..HEAD`]));
}

export function isClean(path: string): boolean {
  return git(path, ['status', '--porcelain']) === '';
}

export function resetHard(path: string): void {
  git(path, ['reset', '--hard', 'HEAD']);
  git(path, ['clean', '-fd']);
}
