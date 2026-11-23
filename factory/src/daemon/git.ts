import { execFileSync } from 'node:child_process';

// Daemon identity for every factory-made commit; unsigned (global signers block unattended).
export const DAEMON_COMMIT_FLAGS = ['-c', 'user.name=factory', '-c', 'user.email=factory@localhost', '-c', 'commit.gpgsign=false'];

/** Env overrides that turn off global commit/tag signing for every git child process. Appends after any existing GIT_CONFIG_COUNT entries so earlier config is kept (later entries win per key). */
export function gitSigningOffEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const start = Number.parseInt(base.GIT_CONFIG_COUNT ?? '', 10) || 0;
  const pairs = [['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${start + i}`] = k; env[`GIT_CONFIG_VALUE_${start + i}`] = v; });
  return env;
}

export class GitError extends Error {
  stderr: string;
  args: string[];
  status: number | null;
  constructor(args: string[], stderr: string, status: number | null) {
    super(`git ${args.join(' ')} failed: ${stderr}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.status = status;
  }
}

export function git(cwd: string, args: string[], o?: { env?: NodeJS.ProcessEnv }): string {
  try {
    return execFileSync('git', args, {
      cwd,
      env: o?.env ?? process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; status?: number | null };
    const stderr = (err.stderr ?? '').trim();
    throw new GitError(args, stderr, typeof err.status === 'number' ? err.status : null);
  }
}

export interface Queue { run<T>(fn: () => Promise<T> | T): Promise<T> }

export function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(fn) {
      const p = tail.then(() => fn());
      tail = p.catch(() => {}); // keep the chain alive after a failure
      return p;
    },
  };
}
