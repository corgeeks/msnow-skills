import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { git, GitError, type Queue } from './git.ts';

export interface PrState { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; mergeable: string; mergeStateStatus: string; headRefOid: string; checks: number }

export type Forge = ReturnType<typeof createForge>;

export function createForge(o: { root: string; mainWorktree: string; queue: Queue; ghCommand?: string[] }) {
  const cmd = o.ghCommand ?? ['gh'];
  const run = <T>(fn: () => T | Promise<T>) => o.queue.run(fn);

  const gh = (args: string[]): string => {
    try {
      return execFileSync(cmd[0], [...cmd.slice(1), ...args], {
        cwd: o.root,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const stderr = String((e as { stderr?: string }).stderr ?? '').trim();
      throw new Error(`gh ${args.join(' ')} failed: ${stderr}`);
    }
  };
  const withBody = <T>(body: string, fn: (file: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-gh-'));
    try {
      const file = join(dir, 'body.md');
      writeFileSync(file, body);
      return fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const fetchNow = () => { git(o.root, ['fetch', 'origin', '--prune']); };
  const resetNow = () => {
    git(o.mainWorktree, ['reset', '--hard', 'origin/main']);
    git(o.mainWorktree, ['clean', '-fd']);
  };
  const syncNow = () => { fetchNow(); resetNow(); };

  const viewOnce = (n: number): PrState => {
    const v = JSON.parse(gh(['pr', 'view', String(n), '--json', 'number,state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup']));
    return { number: v.number, state: v.state, mergeable: v.mergeable, mergeStateStatus: v.mergeStateStatus, headRefOid: v.headRefOid, checks: (v.statusCheckRollup ?? []).length };
  };
  const prState = async (n: number): Promise<PrState> => {
    let s = viewOnce(n);
    for (let i = 0; i < 5 && s.mergeable === 'UNKNOWN'; i++) {
      await sleep(2000);
      s = viewOnce(n);
    }
    return s;
  };

  return {
    ensureMainWorktree: () => run(() => {
      fetchNow();
      // Missing dir = not registered; `worktree prune` clears stale admin entries first.
      if (!existsSync(o.mainWorktree)) {
        git(o.root, ['worktree', 'prune']);
        git(o.root, ['worktree', 'add', '--detach', o.mainWorktree, 'origin/main']);
      } else resetNow();
    }),
    fetch: () => run(fetchNow),
    syncMain: () => run(syncNow),
    pushBranch: (worktreePath: string, branch: string) => run(() => { git(worktreePath, ['push', '--force-with-lease', 'origin', branch]); }),
    openPr: async (p: { branch: string; title: string; body: string }) => {
      const out = withBody(p.body, (f) => gh(['pr', 'create', '--base', 'main', '--head', p.branch, '--title', p.title, '--body-file', f]));
      const url = out.trim().split('\n').at(-1)!.trim();
      const m = /\/pull\/(\d+)$/.exec(url);
      if (!m) throw new Error(`gh pr create: no PR URL in output: ${out}`);
      return { number: Number(m[1]), url };
    },
    commentPr: async (n: number, body: string) => { withBody(body, (f) => gh(['pr', 'comment', String(n), '--body-file', f])); },
    prState,
    mergePr: (n: number, headSha: string) => run(async () => {
      gh(['pr', 'merge', String(n), '--squash', '--match-head-commit', headSha]);
      const deadline = Date.now() + 30_000;
      while ((await prState(n)).state !== 'MERGED') {
        if (Date.now() >= deadline) throw new Error(`PR #${n} not merged within 30s`);
        await sleep(1000);
      }
    }),
    closePr: async (n: number, comment?: string) => {
      gh(['pr', 'close', String(n), ...(comment ? ['--comment', comment] : [])]);
    },
    deleteRemoteBranch: (branch: string) => run(() => {
      try {
        git(o.root, ['push', 'origin', '--delete', branch]);
      } catch (e) {
        if (!(e instanceof GitError && /remote ref does not exist/.test(e.stderr))) throw e;
      }
    }),
  };
}
