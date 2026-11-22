import { spawn } from 'node:child_process';

export interface SessionOptions {
  cwd: string;                 // worktree path
  model: string;               // e.g. "anthropic/claude-sonnet-5-5"
  sessionDir: string;          // paths.sessionsDir
  maxCostUsd: number;          // passed as --max-cost
  timeoutMs: number;           // enforced by the runner, NOT --max-time
  appendSystemPrompt?: string; // passed as --append-system-prompt
  command?: string[];          // default ['omp']; tests pass ['node', 'test/fakes/fake-omp.ts']
  onActivity?: (text: string) => void;
  graceMs?: { ready?: number; exit?: number; abort?: number }; // defaults 30000 / 10000 / 15000; tests shrink them
}
export type SessionStatus = 'completed' | 'aborted' | 'error' | 'timeout' | 'cost_cap' | 'crashed';
export interface SessionOutcome {
  status: SessionStatus;
  error: string | null;
  finalText: string;           // text of the last assistant message_end
  costUsd: number;             // get_session_stats.data.cost (0 if unavailable)
  sessionId: string | null;
  sessionFile: string | null;  // get_state.data.sessionFile
}

const live = new Set<number>();
const STDERR_MAX = 64 * 1024;

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
}

export function killAllSessions(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const pid of live) killGroup(pid, signal);
}

function activityLine(toolName: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const summary = a.path ?? a.command ?? a.pattern ?? Object.values(a).find((v) => typeof v === 'string') ?? '';
  return `${toolName} ${String(summary)}`.slice(0, 160);
}
// Loose view of omp RPC frames; every field is optional and read defensively.
type Frame = {
  type?: string; id?: string; toolName?: string; args?: Record<string, unknown>; status?: string; success?: boolean;
  message?: { role?: string; content?: { type?: string; text?: string }[] };
  error?: { code?: string; message?: string };
  data?: { sessionFile?: string; sessionId?: string; cost?: unknown };
};

export function runSession(prompt: string, opts: SessionOptions): Promise<SessionOutcome> {
  const grace = { ready: opts.graceMs?.ready ?? 30_000, exit: opts.graceMs?.exit ?? 10_000, abort: opts.graceMs?.abort ?? 15_000 };
  const [cmd, ...pre] = opts.command ?? ['omp'];
  const args = [...pre, '--mode', 'rpc', '--no-ui', '--approval-mode', 'yolo', '--model', opts.model, '--cwd', opts.cwd,
    '--session-dir', opts.sessionDir, '--max-cost', String(opts.maxCostUsd)];
  if (opts.appendSystemPrompt !== undefined) args.push('--append-system-prompt', opts.appendSystemPrompt);

  const { promise, resolve } = Promise.withResolvers<SessionOutcome>();
  {
    const child = spawn(cmd, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });
    const pid = child.pid;
    if (pid !== undefined) live.add(pid);

    let status: SessionStatus | null = null;
    let error: string | null = null;
    let resulted = false;
    let finalText = '';
    let costUsd = 0;
    let sessionId: string | null = null;
    let sessionFile: string | null = null;
    let stderr = Buffer.alloc(0);
    let badLines = 0;
    let buf = '';
    let spawnError: string | null = null;

    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      timers.add(t);
      return t;
    };
    const cancel = (t: NodeJS.Timeout | undefined) => { if (t) { clearTimeout(t); timers.delete(t); } };
    const kill = () => { if (pid !== undefined) killGroup(pid, 'SIGKILL'); };
    const send = (o: object) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n'); };
    child.stdin.on('error', () => {}); // EPIPE after a crash

    let timeoutT: NodeJS.Timeout | undefined;
    let abortT: NodeJS.Timeout | undefined;
    let readyT: NodeJS.Timeout | undefined = later(grace.ready, () => {
      error = `no ready frame within ${grace.ready}ms`;
      kill();
    });

    const pending = new Map<string, (r: Frame) => void>();
    let closeT: NodeJS.Timeout | undefined;
    let stdinClosed = false;
    const closeStdin = () => {
      if (stdinClosed) return;
      stdinClosed = true;
      cancel(closeT);
      child.stdin.end();
      later(grace.exit, kill);
    };

    const finish = () => {
      let left = 2;
      const done = () => { if (--left === 0) closeStdin(); };
      pending.set('s1', (r) => {
        if (r.success) { sessionFile = r.data?.sessionFile ?? null; sessionId = r.data?.sessionId ?? null; }
        done();
      });
      pending.set('s2', (r) => {
        if (r.success && typeof r.data?.cost === 'number') costUsd = r.data.cost;
        done();
      });
      closeT = later(grace.exit, closeStdin);
      send({ id: 's1', type: 'get_state' });
      send({ id: 's2', type: 'get_session_stats' });
    };

    const onFrame = (f: Frame) => {
      switch (f.type) {
        case 'ready':
          if (!readyT) return;
          cancel(readyT);
          readyT = undefined;
          send({ id: 'p1', type: 'prompt', message: prompt });
          timeoutT = later(opts.timeoutMs, () => {
            status = 'timeout';
            error = `session timed out after ${opts.timeoutMs}ms`;
            send({ type: 'abort' });
            abortT = later(grace.abort, kill);
          });
          return;
        case 'tool_execution_start':
          opts.onActivity?.(activityLine(String(f.toolName), f.args));
          return;
        case 'message_end':
          if (f.message?.role === 'assistant') {
            finalText = (f.message.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
          }
          return;
        case 'prompt_result':
          if (f.id !== 'p1' || resulted) return;
          resulted = true;
          cancel(timeoutT);
          cancel(abortT);
          if (status !== 'timeout') {
            if (f.status === 'completed') status = 'completed';
            else if (f.status === 'aborted') status = 'aborted';
            else {
              status = f.error?.code === 'cost_cap' ? 'cost_cap' : 'error';
              error = String(f.error?.message ?? 'unknown error');
            }
          }
          finish();
          return;
        case 'response': {
          const cb = pending.get(f.id ?? '');
          if (cb) { pending.delete(f.id ?? ''); cb(f); }
          return;
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let f: unknown;
        try { f = JSON.parse(line); } catch { badLines++; continue; }
        if (f && typeof f === 'object') onFrame(f as Frame); // fields are optional and checked at use
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_MAX) stderr = stderr.subarray(stderr.length - STDERR_MAX);
    });
    child.on('error', (e) => { spawnError = e.message; });
    child.on('exit', () => {
      if (pid === undefined) return;
      live.delete(pid);
      kill(); // reap stragglers in the group that could hold our pipes open
    });
    child.on('close', (code, signal) => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (pid !== undefined) live.delete(pid);
      if (!resulted && status !== 'timeout') {
        const parts = [error, spawnError, `exited before prompt_result (code ${code}, signal ${signal})`];
        if (badLines) parts.push(`${badLines} unparseable stdout lines`);
        const tail = stderr.toString('utf8').slice(-2000).trim();
        if (tail) parts.push(`stderr: ${tail}`);
        status = 'crashed';
        error = parts.filter(Boolean).join('; ');
      }
      resolve({ status: status!, error, finalText, costUsd, sessionId, sessionFile });
    });
  }
  return promise;
}
