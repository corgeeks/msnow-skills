import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../src/daemon/git.ts';

// Bare `origin` plus a user clone `root` with one commit on main. Caller removes `dir`.
export function makeRepos(): { dir: string; origin: string; root: string; mainWorktree: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-repos-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, ['init', '--bare', '-b', 'main', origin]);
  git(dir, ['clone', origin, root]);
  git(root, ['config', 'user.name', 'tester']);
  git(root, ['config', 'user.email', 'tester@localhost']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(root, 'README.md'), '# test\n');
  writeFileSync(join(root, '.gitignore'), '.factory/main/\n.factory/live/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['push', '-u', 'origin', 'main']);
  return { dir, origin, root, mainWorktree: join(root, '.factory', 'main') };
}
