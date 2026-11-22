import { execFileSync } from 'node:child_process';

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
