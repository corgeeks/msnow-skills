import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { MIGRATIONS } from './db.ts';
import { git } from './git.ts';
import { testedSha } from './template-change.ts';
import { ConflictError, CycleError, NotFoundError, type Store } from './store.ts';
import type { Bus } from './bus.ts';
import { ITEM_STATUSES, TIERS, type FactoryEvent } from '../shared/types.ts';

class BadRequest extends Error {}
class TooLarge extends Error {}

type Body = Record<string, unknown>;
type Ctx = { req: http.IncomingMessage; res: http.ServerResponse; m: RegExpMatchArray; q: URLSearchParams; body: () => Promise<Body> };
type Route = { method: string; pattern: RegExp; handler: (c: Ctx) => unknown };

const MAX_BODY = 1 << 20;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// ── hand validation ──
const bad = (msg: string): never => { throw new BadRequest(msg); };
function opt(b: Body, k: string, ok: (v: unknown) => boolean, what: string, nullable = false): void {
  const v = b[k];
  if (v === undefined || (nullable && v === null)) return;
  if (!ok(v)) bad(`${k} must be ${what}`);
}
const isStr = (v: unknown) => typeof v === 'string';
const isInt = (v: unknown) => Number.isInteger(v);
const isIn = (xs: readonly string[]) => (v: unknown) => xs.includes(v as string);
const isArr = (each: (v: unknown) => boolean) => (v: unknown) => Array.isArray(v) && v.every(each);

function itemFields(b: Body): void {
  if (!isStr(b.title) || !b.title) bad('title is required');
  opt(b, 'type', isStr, 'a string');
  opt(b, 'body', isStr, 'a string');
  opt(b, 'spec_path', isStr, 'a string', true);
  opt(b, 'tier', isIn(TIERS), TIERS.join('|'), true);
  opt(b, 'test_cmd', isStr, 'a string', true);
  opt(b, 'priority', isInt, 'an integer');
  opt(b, 'status', isIn(ITEM_STATUSES), ITEM_STATUSES.join('|'));
  opt(b, 'source_ref', isStr, 'a string', true);
}
function intParam(q: URLSearchParams, k: string): number | undefined {
  const v = q.get(k);
  if (v === null || v === '') return undefined;
  if (!/^\d+$/.test(v)) bad(`${k} must be an integer`);
  return Number(v);
}

async function readBody(req: http.IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > MAX_BODY) throw new TooLarge('body exceeds 1 MiB');
    chunks.push(c);
  }
  let v: unknown;
  try { v = n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { bad('invalid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad('body must be a JSON object');
  return v as Body;
}

function send(res: http.ServerResponse, status: number, v: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(v));
}
const sendErr = (res: http.ServerResponse, status: number, code: string, message: string) =>
  send(res, status, { error: { code, message } });

/** Override is allowed only if the run's latest test passed on exactly the commit the run branch points at. */
function checkOverride(store: Store, root: string, gateId: number): void {
  const gate = store.getGate(gateId);
  if (gate.kind !== 'failure') bad('override applies to failure gates only');
  const run = store.getRun(gate.run_id);
  const sha = testedSha(store.listNodeRuns(run.id));
  if (!sha) bad('override needs a passing latest test with a recorded head_sha');
  let tip: string | undefined;
  try { tip = git(root, ['rev-parse', '--verify', `refs/heads/${run.branch}`]); } catch { /* branch missing */ }
  if (tip !== sha) bad(`branch ${run.branch} is at ${tip ?? 'nothing'}, not the tested commit ${sha}`);
}

export function createApiServer(opts: { store: Store; bus: Bus; uiDir: string; root: string }): http.Server {
  const { store, bus, root } = opts;
  const uiDir = resolve(opts.uiDir);

  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: () => ({ ok: true, pid: process.pid, schemaVersion: MIGRATIONS.length }) },
    {
      method: 'GET', pattern: /^\/api\/items$/, handler: ({ q }) => {
        const status = q.get('status') || undefined;
        if (status !== undefined && !isIn(ITEM_STATUSES)(status)) bad(`unknown status ${status}`);
        return store.listItems({ status: status as never, parent_id: intParam(q, 'parent'), type: q.get('type') || undefined });
      },
    },
    { method: 'GET', pattern: /^\/api\/items\/(\d+)$/, handler: ({ m }) => store.getItemDetail(Number(m[1])) },
    {
      method: 'POST', pattern: /^\/api\/items$/, handler: async ({ body }) => {
        const b = await body();
        itemFields(b);
        opt(b, 'parent_id', isInt, 'an integer', true);
        opt(b, 'depends_on', isArr(isInt), 'an array of integers');
        return store.createItem(b as never);
      },
    },
    {
      method: 'POST', pattern: /^\/api\/items\/batch$/, handler: async ({ body }) => {
        const b = await body();
        if (!Array.isArray(b.items)) bad('items must be an array');
        for (const it of b.items as unknown[]) {
          if (!it || typeof it !== 'object' || Array.isArray(it)) bad('each item must be an object');
          const o = it as Body;
          if (!isStr(o.ref) || !o.ref) bad('each item needs a ref');
          itemFields(o);
          opt(o, 'parent_ref', isStr, 'a string');
          opt(o, 'depends_on_refs', isArr(isStr), 'an array of strings');
        }
        return store.createItemsBatch(b.items as never);
      },
    },
    {
      method: 'PATCH', pattern: /^\/api\/items\/(\d+)$/, handler: async ({ m, body }) => {
        const { status, from, ...rest } = await body();
        const itemId = Number(m[1]);
        opt({ title: rest.title }, 'title', (v) => isStr(v) && v !== '', 'a non-empty string');
        opt(rest, 'body', isStr, 'a string');
        opt(rest, 'tier', isIn(TIERS), TIERS.join('|'), true);
        opt(rest, 'test_cmd', isStr, 'a string', true);
        opt(rest, 'priority', isInt, 'an integer');
        const unknown = Object.keys(rest).filter((k) => !['title', 'body', 'tier', 'test_cmd', 'priority'].includes(k));
        if (unknown.length) bad(`unknown fields: ${unknown.join(', ')}`);
        if (status !== undefined) {
          if (!isIn(ITEM_STATUSES)(status)) bad(`unknown status ${String(status)}`);
          if (!isIn(ITEM_STATUSES)(from)) bad('status change requires a valid from');
        }
        let item = Object.keys(rest).length ? store.updateItem(itemId, rest) : store.getItem(itemId);
        if (status !== undefined) item = store.transitionItem(itemId, from as never, status as never);
        return item;
      },
    },
    {
      method: 'POST', pattern: /^\/api\/items\/(\d+)\/deps$/, handler: async ({ m, body }) => {
        const b = await body();
        if (!isInt(b.depends_on)) bad('depends_on must be an integer');
        const itemId = Number(m[1]);
        store.getItem(itemId);
        store.getItem(b.depends_on as number);
        store.addDep(itemId, b.depends_on as number);
        return { ok: true };
      },
    },
    {
      method: 'DELETE', pattern: /^\/api\/items\/(\d+)\/deps\/(\d+)$/, handler: ({ m }) => {
        store.removeDep(Number(m[1]), Number(m[2]));
        return { ok: true };
      },
    },
    { method: 'GET', pattern: /^\/api\/runs$/, handler: ({ q }) => store.listRuns({ item_id: intParam(q, 'item') }) },
    {
      method: 'GET', pattern: /^\/api\/runs\/(\d+)$/, handler: ({ m }) => {
        const run = store.getRun(Number(m[1]));
        return { run, node_runs: store.listNodeRuns(run.id), gates: store.listGates({ run_id: run.id }) };
      },
    },
    { method: 'GET', pattern: /^\/api\/gates$/, handler: ({ q }) => store.listGates({ open: q.get('open') === '1' }) },
    {
      method: 'POST', pattern: /^\/api\/gates\/(\d+)\/decision$/, handler: async ({ m, body }) => {
        const b = await body();
        if (b.decision !== 'approve' && b.decision !== 'reject' && b.decision !== 'override') bad('decision must be approve|reject|override');
        opt(b, 'note', isStr, 'a string');
        if (b.decision === 'override') checkOverride(store, root, Number(m[1])); // before decideGate's closed-gate 409
        return store.decideGate(Number(m[1]), b.decision as never, b.note as string | undefined);
      },
    },
    { method: 'GET', pattern: /^\/api\/events$/, handler: ({ q }) => store.listEvents({ after: intParam(q, 'after'), limit: intParam(q, 'limit') }) },
  ];

  function events(req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams): void {
    const raw = req.headers['last-event-id'] ?? q.get('after');
    const after = raw != null && /^\d+$/.test(String(raw)) ? Number(raw) : undefined;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    let last = after ?? 0;
    let buffer: FactoryEvent[] | null = [];
    const frame = (e: FactoryEvent) => {
      if (e.seq <= last) return;
      last = e.seq;
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsub = bus.subscribe((e) => (buffer ? buffer.push(e) : frame(e)));
    const unsubActivity = bus.subscribeActivity((a) => res.write(`event: activity\ndata: ${JSON.stringify(a)}\n\n`));
    if (after !== undefined) {
      for (let page = store.listEvents({ after: last }); page.length; page = store.listEvents({ after: last })) page.forEach(frame);
    }
    buffer.forEach(frame);
    buffer = null;

    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    res.on('close', () => { unsub(); unsubActivity(); clearInterval(ping); });
  }

  function serveStatic(pathname: string, res: http.ServerResponse): void {
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { return void res.writeHead(400).end(); }
    const file = resolve(join(uiDir, rel));
    if (file !== uiDir && !file.startsWith(uiDir + sep)) return void res.writeHead(403).end('Forbidden');
    const isFile = existsSync(file) && statSync(file).isFile();
    if (!isFile && extname(file)) return void res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    const target = isFile ? file : join(uiDir, 'index.html');
    if (!existsSync(target)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return void res.end('<!doctype html><p>UI not built — run <code>npm run build:ui --prefix factory</code></p>');
    }
    const cache = target === join(uiDir, 'index.html') ? 'no-cache'
      : target.startsWith(join(uiDir, 'assets') + sep) ? 'max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream', 'Cache-Control': cache });
    res.end(readFileSync(target));
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          const m = r.method === method ? url.pathname.match(r.pattern) : null;
          if (m) return send(res, 200, await r.handler({ req, res, m, q: url.searchParams, body: () => readBody(req) }));
        }
        return sendErr(res, 404, 'not_found', `no route ${method} ${url.pathname}`);
      }
      if (method !== 'GET' && method !== 'HEAD') return sendErr(res, 404, 'not_found', `no route ${method} ${url.pathname}`);
      if (url.pathname === '/events') return events(req, res, url.searchParams);
      serveStatic(url.pathname, res);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof BadRequest) return sendErr(res, 400, 'bad_request', e.message);
      if (e instanceof TooLarge) { res.setHeader('Connection', 'close'); return sendErr(res, 413, 'too_large', e.message); }
      if (e instanceof NotFoundError) return sendErr(res, 404, 'not_found', e.message);
      if (e instanceof ConflictError) return sendErr(res, 409, 'conflict', e.message);
      if (e instanceof CycleError) return sendErr(res, 409, 'cycle', e.message);
      console.error(e);
      sendErr(res, 500, 'internal', 'internal error');
    }
  });
}
