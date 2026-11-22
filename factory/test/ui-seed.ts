// Dev seed server for UI browser checks: node factory/test/ui-seed.ts [--port 7317] [--activity-ms 250]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../src/daemon/db.ts';
import { createBus } from '../src/daemon/bus.ts';
import { createStore } from '../src/daemon/store.ts';
import { createApiServer } from '../src/daemon/http.ts';
import type { BatchItem, BatchResult, NodeStatus, RunStatus } from '../src/shared/types.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '7317' }, 'activity-ms': { type: 'string', default: '250' } } });
const port = Number(values.port), activityMs = Number(values['activity-ms']);

const dir = mkdtempSync(join(tmpdir(), 'factory-ui-seed-'));
const db = openDb(join(dir, 'factory.db'));
const bus = createBus();
const store = createStore(db, bus);
const server = createApiServer({ store, bus, uiDir: join(import.meta.dirname, '../ui/dist') });
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${port}`;

const items: BatchItem[] = [
  { ref: 'prd', type: 'prd', title: 'Demo PRD', status: 'active' },
  { ref: 'grp', parent_ref: 'prd', type: 'group', title: 'Views', status: 'active' },
  { ref: 't1', parent_ref: 'grp', type: 'task', title: 'Scaffold', status: 'done' },
  { ref: 't2', parent_ref: 'grp', type: 'task', title: 'Items view', status: 'active', depends_on_refs: ['t1'] },
  { ref: 't3', parent_ref: 'grp', type: 'task', title: 'Runs view', status: 'queued', depends_on_refs: ['t2'] },
  { ref: 't4', parent_ref: 'grp', type: 'task', title: 'Flaky test', status: 'blocked', depends_on_refs: ['t1'] },
  { ref: 't5', parent_ref: 'grp', type: 'task', title: 'Docs', status: 'active', depends_on_refs: ['t1'] },
  { ref: 'b1', type: 'bug', title: 'Sidebar flickers on resize', status: 'draft',
    body: 'Steps:\n\n    1. open the UI\n    2. resize the window\n\nExpected: no flicker.\n\n  Actual: the sidebar redraws twice.' },
];
const res = await fetch(`${base}/api/items/batch`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }),
});
if (!res.ok) throw new Error(`batch failed: ${res.status} ${await res.text()}`);
const { ids } = (await res.json()) as BatchResult;

const now = () => new Date().toISOString();
const pr = (n: number) => ({ pr_number: n, pr_url: `https://github.com/corgeeks/msnow-skills/pull/${n}` });

function run(itemId: number, status: RunStatus, patch: Parameters<typeof store.updateRun>[1] = {}) {
  const r = store.createRun({ item_id: itemId, template: 'task' });
  store.transitionRun(r.id, 'pending', 'running');
  if (status !== 'running') {
    store.transitionRun(r.id, 'running', status);
    if (status !== 'paused') patch = { ...patch, ended_at: now() };
  }
  if (Object.keys(patch).length) store.updateRun(r.id, patch);
  return r.id;
}
function node(runId: number, name: string, status: NodeStatus, iteration = 1, extra: { model?: string; cost_usd?: number } = {}) {
  const n = store.createNodeRun({ run_id: runId, node: name, iteration, model: extra.model ?? null });
  store.transitionNodeRun(n.id, 'pending', 'running');
  if (status !== 'running') {
    store.transitionNodeRun(n.id, 'running', status);
    store.updateNodeRun(n.id, { ended_at: now() });
  }
  if (extra.cost_usd) store.updateNodeRun(n.id, { cost_usd: extra.cost_usd });
}

const R1 = run(ids.t1, 'completed', { ...pr(11), branch: `factory/${ids.t1}-1` });
for (const n of ['build', 'test', 'review', 'pr']) node(R1, n, 'completed');
const g1 = store.openGate({ run_id: R1, node: 'merge', kind: 'merge', question: 'Merge PR #11?' }).id;
store.decideGate(g1, 'approve', 'lgtm');

const R2 = run(ids.t2, 'running', { ...pr(12), branch: `factory/${ids.t2}-1` });
node(R2, 'build', 'completed', 1, { model: 'anthropic/claude-sonnet-5-5', cost_usd: 0.3 });
node(R2, 'test', 'failed', 1);
node(R2, 'build', 'running', 2);

const R3 = run(ids.t4, 'paused', { branch: `factory/${ids.t4}-1` });
for (const i of [1, 2, 3]) node(R3, 'build', 'failed', i);
const g3 = store.openGate({
  run_id: R3, node: 'build', kind: 'failure',
  question: 'Build failed 3 times on the same flaky test. Retry, or stop and fix by hand?',
  recommendation: 'Stop: the test depends on wall-clock time; mock the clock first.',
}).id;

const R4 = run(ids.t5, 'running', { ...pr(14), branch: `factory/${ids.t5}-1` });
for (const n of ['build', 'test', 'review', 'pr']) node(R4, n, 'completed');
const g4 = store.openGate({ run_id: R4, node: 'merge', kind: 'merge', question: 'Merge PR #14?', recommendation: 'Approve: docs only.' }).id;

console.log(JSON.stringify({ ...ids, R1, R2, R3, R4, g1, g3, g4 }));

let n = 0;
const timer = setInterval(() => {
  n++;
  bus.publishActivity({ run_id: n % 5 === 0 ? R4 : R2, node: 'build', text: `read src/file-${n}.ts`, at: now() });
}, activityMs);

process.once('SIGINT', () => {
  clearInterval(timer);
  server.closeAllConnections();
  server.close(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
});
