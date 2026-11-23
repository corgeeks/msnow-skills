import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

/** The listening server is the single-instance lock; no pidfile. */
export function acquireInstanceLock(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EADDRINUSE' ? new Error(`daemon already running on 127.0.0.1:${port}`) : e));
    server.listen({ port, host: '127.0.0.1' }, () => resolve());
  });
}

type Hook = () => Promise<void> | void;
const hooks: Hook[] = [];

export function onShutdown(fn: Hook): void {
  hooks.push(fn);
}

interface ShutdownOpts { server: Server; db: DatabaseSync; graceMs?: number }
let opts: ShutdownOpts | undefined;
let shuttingDown = false;

/** Stop accepting, run hooks (reverse order) under one shared deadline, close the DB. */
export async function runShutdown(o: ShutdownOpts | undefined = opts): Promise<void> {
  const graceMs = o?.graceMs ?? 10_000;
  o?.server.close();
  o?.server.closeIdleConnections();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((r) => { timer = setTimeout(r, graceMs); });
  const run = (async () => {
    for (const fn of [...hooks].reverse()) {
      try { await fn(); } catch (e) { console.error('shutdown hook failed:', e); }
    }
  })();
  await Promise.race([run, deadline]);
  clearTimeout(timer);
  o?.db.close();
}

export function installSignalHandlers(o: ShutdownOpts): void {
  opts = o;
  const handler = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runShutdown(o).finally(() => process.exit(0));
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
