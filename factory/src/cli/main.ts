#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { loadConfig } from '../shared/config.ts';
import { resolvePaths } from '../daemon/paths.ts';
import { TIERS, type BatchItem, type BatchResult, type Gate, type ItemDetail, type ItemSummary, type RunDetail } from '../shared/types.ts';
import { ApiError, createClient, DaemonUnreachableError, type Client } from './client.ts';
import { buildImportBatch } from './import.ts';

const USAGE = `usage: factory <command> [--port n]

commands:
  daemon [--port n]                       run the daemon in the foreground
  status [--json]                         counts, active items, open gates, waiting items
  show <id> [--json]                      item detail with runs and gates
  add --title T [--type task] [--parent id] [--body B] [--spec path]
      [--tier heavy|standard|light] [--test-cmd c] [--depends-on 1,2] [--ready]
  import <prd-dir> [--dry-run]            import a PRD directory
  start <id...> | --all                   queue ready leaves (ready -> queued)
  approve <gate-id> [--note N]
  reject <gate-id> [--note N]

If \`factory\` is not on PATH: node factory/src/cli/main.ts <command>
`;

class UsageError extends Error {}

const out = (s: string) => void process.stdout.write(s + '\n');
const err = (s: string) => void process.stderr.write(s + '\n');

type Opts = NonNullable<ParseArgsConfig['options']>;
const COMMANDS: Record<string, Opts> = {
  daemon: {},
  status: { json: { type: 'boolean' } },
  show: { json: { type: 'boolean' } },
  add: {
    title: { type: 'string' }, type: { type: 'string' }, parent: { type: 'string' }, body: { type: 'string' },
    spec: { type: 'string' }, tier: { type: 'string' }, 'test-cmd': { type: 'string' },
    'depends-on': { type: 'string' }, ready: { type: 'boolean' },
  },
  import: { 'dry-run': { type: 'boolean' } },
  start: { all: { type: 'boolean' } },
  approve: { note: { type: 'string' } },
  reject: { note: { type: 'string' } },
};

function int(s: string | undefined, what: string): number {
  if (s === undefined || !/^\d+$/.test(s)) throw new UsageError(`${what} must be an integer`);
  return Number(s);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0; }
  try {
    if (cmd === undefined || !Object.hasOwn(COMMANDS, cmd)) throw new UsageError(cmd === undefined ? 'missing command' : `unknown command ${cmd}`);
    let parsed;
    try {
      parsed = parseArgs({ args: rest, strict: true, allowPositionals: true, options: { port: { type: 'string' }, ...COMMANDS[cmd] } });
    } catch (e) { throw new UsageError((e as Error).message); }
    const pos = parsed.positionals;
    const v: Record<string, string | boolean | undefined> = parsed.values;
    const port = v.port !== undefined ? int(v.port as string, '--port') : undefined;
    if (cmd === 'daemon') return await daemon(port);
    const api = createClient(port ?? loadConfig(resolvePaths().configFile).port);
    const one = (what: string) => {
      if (pos.length !== 1) throw new UsageError(`${cmd} takes exactly one ${what}`);
      return pos[0];
    };

    switch (cmd) {
      case 'status': return await status(api, v.json === true, pos);
      case 'show': {
        const id = int(one('id'), 'id');
        const d: ItemDetail = await api.get(`/api/items/${id}`);
        const runs: RunDetail[] = [];
        for (const r of d.runs) runs.push(await api.get(`/api/runs/${r.id}`));
        if (v.json) { out(JSON.stringify({ ...d, runs })); return 0; }
        const it = d.item;
        out(`#${it.id} ${it.type} ${it.title} [${it.status}]`);
        out(`  parent: ${it.parent_id ?? '-'}  tier: ${it.tier ?? '-'}  priority: ${it.priority}  source: ${it.source_ref ?? '-'}`);
        if (it.spec_path) out(`  spec: ${it.spec_path}`);
        if (it.test_cmd) out(`  test: ${it.test_cmd}`);
        if (it.body) out(`  body: ${it.body.split('\n').join('\n        ')}`);
        const list = (label: string, xs: { id: number; title: string; status: string }[]) =>
          xs.length && out(`${label}:\n${xs.map((x) => `  #${x.id} ${x.title} [${x.status}]`).join('\n')}`);
        list('children', d.children); list('deps', d.deps); list('dependents', d.dependents);
        for (const { run, node_runs, gates } of runs) {
          out(`run #${run.id} ${run.status} attempt ${run.attempt}${run.pr_url ? ` ${run.pr_url}` : ''}`);
          for (const n of node_runs) out(`  ${n.node}#${n.iteration} ${n.status}${n.model ? ` ${n.model}` : ''}`);
          for (const g of gates.filter((g) => !g.closed_at)) out(`  gate #${g.id} ${g.kind}: ${g.question}`);
        }
        return 0;
      }
      case 'add': {
        if (pos.length) throw new UsageError('add takes no positional arguments');
        if (typeof v.title !== 'string' || !v.title) throw new UsageError('add requires --title');
        if (v.tier !== undefined && !(TIERS as readonly unknown[]).includes(v.tier)) throw new UsageError(`--tier must be ${TIERS.join('|')}`);
        const deps = typeof v['depends-on'] === 'string' ? v['depends-on'].split(',').map((s) => int(s.trim(), '--depends-on')) : undefined;
        const item = await api.post('/api/items', {
          title: v.title, type: v.type, body: v.body, spec_path: v.spec, tier: v.tier, test_cmd: v['test-cmd'],
          parent_id: v.parent === undefined ? undefined : int(v.parent as string, '--parent'),
          depends_on: deps, status: v.ready ? 'ready' : 'draft',
        });
        out(String(item.id));
        return 0;
      }
      case 'import': {
        const dir = one('prd-dir');
        let items: BatchItem[];
        try { items = buildImportBatch(dir, resolvePaths().root); } catch (e) { err((e as Error).message); return 1; }
        if (v['dry-run']) { printTree(items); return 0; }
        const r: BatchResult = await api.post('/api/items/batch', { items });
        out(`created ${r.created.length}, skipped ${r.skipped.length}`);
        return 0;
      }
      case 'start': return await start(api, v.all === true, pos);
      case 'approve': case 'reject': {
        const id = int(one('gate-id'), 'gate-id');
        await api.post(`/api/gates/${id}/decision`, { decision: cmd, note: v.note });
        out(`gate ${id} ${cmd}d`);
        return 0;
      }
    }
    return 64;
  } catch (e) {
    if (e instanceof UsageError) { err(`factory: ${e.message}\n`); process.stderr.write(USAGE); return 64; }
    if (e instanceof ApiError) { err(`${e.code}: ${e.message}`); return 1; }
    if (e instanceof DaemonUnreachableError) { err(e.message); return 2; }
    throw e;
  }
}

async function status(api: Client, json: boolean, pos: string[]): Promise<number> {
  if (pos.length) throw new UsageError('status takes no positional arguments');
  const items: ItemSummary[] = await api.get('/api/items');
  const gates: Gate[] = await api.get('/api/gates?open=1');
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
  const active = [];
  for (const i of items.filter((i) => i.status === 'active')) {
    const d: ItemDetail = await api.get(`/api/items/${i.id}`);
    const last = d.runs.reduce<ItemDetail['runs'][number] | null>((a, r) => (!a || r.id > a.id ? r : a), null);
    const rd: RunDetail | null = last ? await api.get(`/api/runs/${last.id}`) : null;
    active.push({
      id: i.id, title: i.title, run_id: last?.id ?? null, pr_url: last?.pr_url ?? null,
      node: rd?.node_runs.find((n) => n.status === 'running')?.node ?? null,
    });
  }
  const waiting = items.filter((i) => i.status === 'queued' && i.open_deps > 0).map((i) => ({ id: i.id, title: i.title, open_deps: i.open_deps }));
  if (json) { out(JSON.stringify({ counts, active, gates, waiting })); return 0; }
  out(Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join('  ') || 'no items');
  if (active.length) out('active:');
  for (const a of active) out(`  #${a.id} ${a.title} run ${a.run_id ?? '-'}${a.node ? ` node ${a.node}` : ''}${a.pr_url ? ` ${a.pr_url}` : ''}`);
  const runItem = new Map<number, number>();
  if (gates.length) out('open gates:');
  for (const g of gates) {
    if (!runItem.has(g.run_id)) runItem.set(g.run_id, ((await api.get(`/api/runs/${g.run_id}`)) as RunDetail).run.item_id);
    out(`  gate #${g.id} item #${runItem.get(g.run_id)} ${g.kind}: ${g.question}`);
  }
  if (waiting.length) out('waiting on deps:');
  for (const w of waiting) out(`  #${w.id} ${w.title} (${w.open_deps} open)`);
  return 0;
}

async function start(api: Client, all: boolean, pos: string[]): Promise<number> {
  if (all === pos.length > 0) throw new UsageError('start takes ids or --all, not both');
  const ids = pos.map((p) => int(p, 'id'));
  const items: ItemSummary[] = await api.get('/api/items');
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map<number, ItemSummary[]>();
  for (const i of items) if (i.parent_id !== null) kids.set(i.parent_id, [...(kids.get(i.parent_id) ?? []), i]);
  const leaves = (id: number): ItemSummary[] => {
    const ks = kids.get(id);
    return ks ? ks.flatMap((k) => leaves(k.id)) : [byId.get(id)!];
  };
  const targets = new Set<ItemSummary>();
  if (all) for (const i of items) { if (!kids.has(i.id) && i.status === 'ready') targets.add(i); }
  for (const id of ids) {
    const it = byId.get(id);
    if (!it) throw new ApiError(404, 'not_found', `item ${id} not found`);
    if (kids.has(id)) leaves(id).filter((l) => l.status === 'ready').forEach((l) => targets.add(l));
    else if (it.status !== 'ready') throw new ApiError(409, 'conflict', `item ${id} is ${it.status}`);
    else targets.add(it);
  }
  for (const t of targets) await api.patch(`/api/items/${t.id}`, { status: 'queued', from: 'ready' });
  out(`queued ${targets.size}`);
  return 0;
}

function printTree(items: BatchItem[]): void {
  const depth = new Map<string, number>();
  for (const it of items) {
    const d = it.parent_ref === undefined ? 0 : (depth.get(it.parent_ref) ?? 0) + 1;
    depth.set(it.ref, d);
    const deps = it.depends_on_refs?.length ? ` ← deps: ${it.depends_on_refs.join(', ')}` : '';
    out(`${'  '.repeat(d)}${it.type ?? 'task'} ${it.title} [${it.status ?? 'draft'}] (${it.source_ref ?? it.ref})${deps}`);
  }
}

function daemon(port: number | undefined): Promise<number> {
  const entry = fileURLToPath(new URL('../daemon/main.ts', import.meta.url));
  const child = spawn(process.execPath, [entry, ...(port !== undefined ? ['--port', String(port)] : [])], { stdio: 'inherit' });
  const fwd = (sig: NodeJS.Signals) => () => child.kill(sig);
  const onInt = fwd('SIGINT'), onTerm = fwd('SIGTERM');
  process.on('SIGINT', onInt).on('SIGTERM', onTerm);
  return new Promise((resolve) => child.on('exit', (code, sig) => {
    process.off('SIGINT', onInt).off('SIGTERM', onTerm);
    resolve(code ?? (sig ? 1 : 0));
  }));
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
