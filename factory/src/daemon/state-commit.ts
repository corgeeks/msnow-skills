import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FactoryEvent } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import { snapshot } from './db.ts';
import { DAEMON_COMMIT_FLAGS, git, GitError, type Queue } from './git.ts';

const DONE = ['completed', 'failed', 'cancelled'];
// `incorrect old value`: the remote moved after ref advertisement (mid-push race) — same remedy as fetch first.
const NON_FAST_FORWARD = /non-fast-forward|\[rejected\]|fetch first|incorrect old value/;

function milestones(e: FactoryEvent): string[] {
  const item = `#${e.item_id ?? '?'}`;
  const d = e.data;
  switch (e.type) {
    case 'run.created': return [`${item} run ${e.run_id} started`];
    case 'run.updated': {
      const out: string[] = [];
      if (typeof d.status === 'string' && DONE.includes(d.status)) out.push(`${item} run ${e.run_id} ${d.status}`);
      if (typeof d.pr_number === 'number') out.push(`${item} PR #${d.pr_number} opened`);
      return out;
    }
    case 'gate.opened': return [`${item} gate opened (${d.kind ?? e.node})`];
    case 'gate.closed': return [`${item} gate closed (${d.decision})`];
    case 'retro.recorded': return [`${item} retro`];
    default: return [];
  }
}

/** Commits snapshots of the live DB to `main` at milestones (debounced) or on `flush`. */
export function createStateCommitter(o: {
  db: DatabaseSync; bus: Bus; queue: Queue; mainWorktree: string;
  prefix: string; debounceSec: number;
}): { flush(reason?: string): Promise<void>; stop(): void } {
  const pending: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const dbFile = join(o.mainWorktree, '.factory', 'factory.db');
  const g = (args: string[]) => git(o.mainWorktree, args);

  // Steps 1–6 of one commit attempt; runs unqueued inside the flush job (awaiting a queued method here deadlocks).
  function commitOnce(batch: string[]): void {
    g(['fetch', 'origin', '--prune']);
    g(['reset', '--hard', 'origin/main']);
    g(['clean', '-fd']);
    mkdirSync(join(o.mainWorktree, '.factory'), { recursive: true });
    snapshot(o.db, dbFile);
    const check = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const rows = check.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error(`integrity_check failed: ${JSON.stringify(rows)}`);
    } finally { check.close(); }
    g(['add', '.factory/factory.db']);
    try { g(['diff', '--cached', '--quiet']); return; } catch (e) { if (!(e instanceof GitError) || e.status !== 1) throw e; }
    let text = batch.join(', ');
    if (text.length > 200) text = text.slice(0, 199) + '…';
    g([...DAEMON_COMMIT_FLAGS, 'commit', '-m', batch.length ? `${o.prefix} (${text})` : o.prefix]);
    g(['push', 'origin', 'HEAD:main']);
  }

  function flush(reason?: string): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    return o.queue.run(() => {
      const n = pending.length;
      const batch = reason === undefined ? pending.slice() : [...pending, reason];
      try {
        try { commitOnce(batch); } catch (e) {
          if (!(e instanceof GitError && NON_FAST_FORWARD.test(e.stderr))) throw e;
          commitOnce(batch);
        }
        pending.splice(0, n);
      } catch (e) {
        console.error(`factory: state commit failed: ${(e as Error).message}`);
        if (reason !== undefined) pending.splice(n, 0, reason); // the whole batch stays pending
      }
    });
  }

  const unsubscribe = o.bus.subscribe((e) => {
    const m = milestones(e);
    if (!m.length) return;
    pending.push(...m);
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, o.debounceSec * 1000);
    timer.unref();
  });

  return {
    flush,
    stop() { clearTimeout(timer); timer = undefined; unsubscribe(); },
  };
}
