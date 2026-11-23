import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { createBus } from './bus.ts';
import { createStore } from './store.ts';
import { runSession, type SessionOptions } from './omp.ts';
import * as worktrees from './worktrees.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { INTERRUPTED, nextStep, RESTART_HINT, REVERTED, runChange, type ChangeContext, type StepInput } from './template-change.ts';
import { git } from './git.ts';
import { makeRepos } from '../../test/fixtures/git-repos.ts';
import type { Forge } from './forge.ts';
import type { Activity, Gate, NodeRun, Run } from '../shared/types.ts';

// ── nextStep table ──

const config = { ...structuredClone(DEFAULT_CONFIG), defaultTestCmd: 'true' };
const baseRun = { id: 1, item_id: 1, status: 'running' } as Run;
let seq = 0;
const nr = (node: string, iteration: number, status: NodeRun['status'], output: string | null = null): NodeRun =>
  ({ id: ++seq, run_id: 1, node, iteration, status, output, model: null, cost_usd: 0 }) as NodeRun;
const gate = (node: string, kind: string, decision: Gate['decision'] = null, note: string | null = null): Gate =>
  ({ id: ++seq, run_id: 1, node, kind, decision, note, closed_at: decision ? 'x' : null }) as Gate;
const verdict = (v: string) => JSON.stringify({ pre_sha: 'a', verdict: v, findings: v === 'changes' ? [{ severity: 'blocking', text: 'fix' }] : [] });
const step = (nodeRuns: NodeRun[], gates: Gate[] = [], o: Partial<StepInput> = {}) =>
  nextStep({ run: baseRun, nodeRuns, gates, retro: false, config, ...o });
const kind = (s: ReturnType<typeof nextStep>) => ({ ...s, row: undefined });
const ok = (i: number) => [nr('build', i, 'completed'), nr('test', i, 'completed')];
const failedTests = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => [nr('build', from + k, 'completed'), nr('test', from + k, 'failed', 'exit 1')]).flat();

test('nextStep: interrupted rows re-run in place', () => {
  const b = nr('build', 2, 'failed', INTERRUPTED);
  assert.deepEqual(step([...failedTests(1, 1), b]), { kind: 'build', iteration: 2, row: b, resume: true });
  const r = nr('review', 1, 'failed', INTERRUPTED);
  assert.deepEqual(step([...ok(1), r]), { kind: 'review', iteration: 1, row: r });
  const mg = nr('merge_gate', 1, 'failed', INTERRUPTED);
  assert.deepEqual(step([...ok(1), nr('review', 1, 'completed', verdict('approve')), nr('pr', 1, 'completed'), mg]), { kind: 'revive', row: mg });
});

test('nextStep: terminal runs, open gates, merge', () => {
  for (const status of ['completed', 'cancelled', 'failed'] as const) {
    assert.deepEqual(step([], [], { run: { ...baseRun, status } }), { kind: 'retro' });
    assert.deepEqual(step([], [], { run: { ...baseRun, status }, retro: true }), { kind: 'done' });
  }
  const pre = [...ok(1), nr('review', 1, 'completed', verdict('approve')), nr('pr', 1, 'completed')];
  assert.deepEqual(step(ok(1), [gate('test', 'failure')]), { kind: 'wait' });
  assert.deepEqual(kind(step(pre)), { kind: 'open_merge_gate', iteration: 1, row: undefined });
  const mg = nr('merge_gate', 1, 'running');
  assert.deepEqual(step([...pre, mg]), { kind: 'open_merge_gate', iteration: 1, row: mg });
  assert.deepEqual(step([...pre, mg], [gate('merge_gate', 'merge')]), { kind: 'wait' });
  assert.deepEqual(step([...pre, mg], [gate('merge_gate', 'merge', 'approve')]), { kind: 'merge', iteration: 1 });
  assert.deepEqual(step([...pre, mg], [gate('merge_gate', 'merge', 'reject')]), { kind: 'merge_reject' });
  const done = nr('merge_gate', 1, 'completed');
  assert.deepEqual(step([...pre, done], [gate('merge_gate', 'merge', 'approve')]), { kind: 'merge', iteration: 1 });
  assert.deepEqual(step([...pre, done, nr('merge', 1, 'completed')], [gate('merge_gate', 'merge', 'approve')]), { kind: 'finalize' });
});

test('nextStep: build → test → review → pr', () => {
  assert.deepEqual(step([]), { kind: 'build', iteration: 1 });
  assert.deepEqual(step([nr('build', 1, 'completed')]), { kind: 'test', iteration: 1 });
  assert.deepEqual(step(ok(1)), { kind: 'review', iteration: 1 });
  assert.deepEqual(step([...ok(1), nr('review', 1, 'completed', verdict('approve'))]), { kind: 'pr', iteration: 1 });
  assert.deepEqual(step([...failedTests(1, 1)]), { kind: 'build', iteration: 2 });
});

test('nextStep: persisted legacy review is re-derived (approve + string findings reroutes to rework)', () => {
  const legacy = JSON.stringify({ pre_sha: 'a', verdict: 'approve', findings: ['fix a'] });
  assert.deepEqual(step([...ok(1), nr('review', 1, 'completed', legacy)]), { kind: 'build', iteration: 2 });
  const advisoryOnly = JSON.stringify({ pre_sha: 'a', verdict: 'changes', findings: [{ severity: 'advisory', text: 'nit' }] });
  assert.deepEqual(step([...ok(1), nr('review', 1, 'completed', advisoryOnly)]), { kind: 'pr', iteration: 1 });
  // Legacy `changes` + no findings opened a failure gate; today it re-derives as approve, but a closed rejection still wins.
  const legacyEmpty = nr('review', 1, 'completed', JSON.stringify({ pre_sha: 'a', verdict: 'changes', findings: [] }));
  assert.deepEqual(step([...ok(1), legacyEmpty], [gate('review', 'failure', 'reject')]), { kind: 'failure_reject' });
  assert.deepEqual(step([...ok(1), legacyEmpty], [gate('review', 'failure', 'approve')]), { kind: 'pr', iteration: 1 });
});

test('nextStep: build budget, failure gates, review rounds', () => {
  assert.deepEqual(step(failedTests(1, 3)), { kind: 'open_failure_gate', node: 'test', count: 3 });
  const builds = [1, 2, 3].map((i) => nr('build', i, 'failed', 'timeout'));
  assert.deepEqual(step(builds), { kind: 'open_failure_gate', node: 'build', count: 3 });
  assert.deepEqual(step(failedTests(1, 3), [gate('test', 'failure', 'approve')]), { kind: 'build', iteration: 4 });
  assert.deepEqual(step(failedTests(1, 6), [gate('test', 'failure', 'approve')]), { kind: 'open_failure_gate', node: 'test', count: 6 });
  assert.deepEqual(step(failedTests(1, 3), [gate('test', 'failure', 'reject')]), { kind: 'failure_reject' });

  const r1 = [...ok(1), nr('review', 1, 'completed', verdict('changes'))];
  assert.deepEqual(step(r1), { kind: 'build', iteration: 2 });
  const r2 = [...r1, ...ok(2), nr('review', 2, 'completed', verdict('changes'))];
  assert.deepEqual(step(r2), { kind: 'open_failure_gate', node: 'review', count: 2 });
  assert.deepEqual(step(r2, [gate('review', 'failure', 'approve')]), { kind: 'build', iteration: 3 });

  // Review rework does not consume build attempts: 2 failed tests across 4 iterations still rebuilds.
  const mixed = [...failedTests(1, 1), ...ok(2), nr('review', 2, 'completed', verdict('changes')), ...failedTests(3, 3)];
  assert.deepEqual(step(mixed), { kind: 'build', iteration: 4 });
});

// ── runChange against a real store, worktree and fake-omp ──

const fakeOmp = join(import.meta.dirname, '../../test/fakes/fake-omp.ts');
const approve = '```json\n{"verdict":"approve","findings":[]}\n```';
type Script = (call: { role: 'build' | 'review'; n: number }) => string[];
const defaultScript: Script = ({ role, n }) => role === 'build'
  ? ['FAKE_OMP_SCENARIO=edit', `FAKE_OMP_EDIT=mkdir -p factory && echo ${n} > factory/f${n}.txt`]
  : ['FAKE_OMP_SCENARIO=complete', `FAKE_OMP_TEXT=${approve}`];

function setup(t: TestContext, o: { script?: Script; test_cmd?: string | null } = {}) {
  const repos = makeRepos();
  const db = openDb(join(repos.dir, 'f.db'));
  const bus = createBus();
  const store = createStore(db, bus);
  t.after(() => { db.close(); rmSync(repos.dir, { recursive: true, force: true }); });
  const item = store.createItem({ title: 'thing', body: 'do the thing', status: 'active', test_cmd: o.test_cmd ?? null });
  const wt = worktrees.createWorktree(repos.root, { itemId: item.id, attempt: 1, base: 'origin/main' });
  const run = store.createRun({ item_id: item.id, template: 'change', attempt: 1 });
  store.updateRun(run.id, { branch: wt.branch, worktree: wt.path });
  store.transitionRun(run.id, 'pending', 'running');

  const calls: unknown[][] = [];
  let prState = 'OPEN';
  const rec = (name: string, ret?: () => unknown) => async (...a: unknown[]) => { calls.push([name, ...a]); return ret?.(); };
  const forge = {
    pushBranch: rec('pushBranch'),
    openPr: rec('openPr', () => ({ number: 7, url: 'https://example.test/pull/7' })),
    commentPr: rec('commentPr'),
    prState: async () => ({ state: prState }),
    mergePr: rec('mergePr', () => { prState = 'MERGED'; }),
    closePr: rec('closePr', () => { prState = 'CLOSED'; }),
    syncMain: rec('syncMain'),
    deleteRemoteBranch: rec('deleteRemoteBranch'),
  } as unknown as Forge;
  const flushes: (string | undefined)[] = [];
  const prompts: { role: string; n: number; prompt: string }[] = [];
  const counts = { build: 0, review: 0 };
  const f = {
    ...repos, store, bus, item, wt, runId: run.id, calls, flushes, prompts, stop: false,
    ctx: undefined as unknown as ChangeContext,
    rows: () => store.listNodeRuns(run.id),
    row: (node: string, iteration: number) => store.listNodeRuns(run.id).findLast((n) => n.node === node && n.iteration === iteration),
    decide: (decision: 'approve' | 'reject', note?: string) => store.decideGate(store.listGates({ run_id: run.id, open: true })[0].id, decision, note),
  };
  f.ctx = {
    runId: run.id, stopped: () => f.stop, store, bus, config, paths: { root: repos.root, sessionsDir: join(repos.dir, 'sessions') },
    worktrees, forge, committer: { flush: async (reason) => { flushes.push(reason); } },
    runSession: (prompt: string, opts: SessionOptions) => {
      const role = opts.model === config.roles.executor.standard ? 'build' : 'review';
      const n = ++counts[role];
      prompts.push({ role, n, prompt });
      const vars = (o.script ?? defaultScript)({ role, n });
      return runSession(prompt, { ...opts, command: ['env', ...vars, process.execPath, fakeOmp], graceMs: { ready: 2000, exit: 500, abort: 500 } });
    },
  };
  return f;
}

test('happy path: merge gate, approve, merge, retro', async (t) => {
  const f = setup(t);
  const seen: Activity[] = [];
  f.bus.subscribeActivity((a) => seen.push(a));
  await runChange(f.ctx);

  const run = f.store.getRun(f.runId);
  assert.equal(run.status, 'paused');
  assert.equal(run.pr_number, 7);
  assert.equal(run.pr_url, 'https://example.test/pull/7');
  assert.equal(run.head_sha, worktrees.headSha(f.wt.path));
  assert.ok(run.cost_usd > 0);
  const [g] = f.store.listGates({ run_id: f.runId, open: true });
  assert.equal(g.kind, 'merge');
  assert.equal(g.question, `Merge PR #7 (https://example.test/pull/7) for #${f.item.id} thing?`);
  assert.equal(g.recommendation, `approve — tests pass, ${config.roles.reviewer.anthropic} approved`);
  assert.ok(seen.some((a) => a.node === 'build' && a.run_id === f.runId && a.text === 'read a.txt'));
  const open = f.calls.find((c) => c[0] === 'openPr')![1] as { title: string; body: string };
  assert.equal(open.title, `#${f.item.id} thing`);
  assert.match(open.body, /do the thing[\s\S]*## Tests[\s\S]*`true`: exit 0[\s\S]*## Review[\s\S]*Verdict: \*\*approve\*\*/);
  assert.equal(f.row('merge_gate', 1)!.status, 'running');

  await runChange(f.ctx); // still open: no-op
  assert.equal(f.calls.filter((c) => c[0] === 'mergePr').length, 0);

  f.decide('approve');
  await runChange(f.ctx);
  assert.deepEqual(f.calls.find((c) => c[0] === 'mergePr'), ['mergePr', 7, run.head_sha]);
  assert.equal(f.store.getItem(f.item.id).status, 'done');
  const done = f.store.getRun(f.runId);
  assert.equal(done.status, 'completed');
  assert.ok(done.ended_at);
  assert.equal(existsSync(f.wt.path), false);
  assert.deepEqual(f.flushes, [`merged #${f.item.id}`]);
  assert.deepEqual(JSON.parse(f.row('merge', 1)!.output!), { touches_factory: true });
  assert.deepEqual(f.rows().map((n) => `${n.node}:${n.status}`),
    ['build:completed', 'test:completed', 'review:completed', 'pr:completed', 'merge_gate:completed', 'merge:completed', 'retro:completed']);
  const retro = f.store.getRetro(f.runId)!;
  assert.equal(retro.notes, RESTART_HINT);
  assert.equal(retro.rework_count, 0);

  const events = f.store.listEvents({ limit: 1000 }).length;
  await runChange(f.ctx); // finished: no-op
  assert.equal(f.store.listEvents({ limit: 1000 }).length, events);
});

test('build without commits fails; exhausted budget opens a failure gate; reject keeps the worktree', async (t) => {
  const f = setup(t, { script: ({ role }) => role === 'build' ? ['FAKE_OMP_SCENARIO=complete'] : [] });
  await runChange(f.ctx);
  assert.equal(f.row('build', 1)!.output, 'no commits ahead of origin/main');
  assert.deepEqual(f.rows().map((n) => `${n.node}${n.iteration}:${n.status}`), ['build1:failed', 'build2:failed', 'build3:failed']);
  const [g] = f.store.listGates({ run_id: f.runId, open: true });
  assert.equal(g.kind, 'failure');
  assert.equal(g.question, `#${f.item.id} thing: build failed 3 times. Retry?`);
  assert.equal(f.store.getItem(f.item.id).status, 'blocked');
  assert.equal(f.store.getRun(f.runId).status, 'paused');

  f.decide('reject');
  await runChange(f.ctx);
  assert.equal(f.store.getItem(f.item.id).status, 'cancelled');
  assert.equal(f.store.getRun(f.runId).status, 'failed');
  assert.ok(existsSync(f.wt.path));
  assert.equal(f.store.getRetro(f.runId)!.failures.length, 3);
});

test('test failure feeds the next build; approved failure gate retries with the note; merge reject', async (t) => {
  const f = setup(t, { test_cmd: 'exit 1' });
  await runChange(f.ctx);
  assert.match(f.row('test', 1)!.output!, /^exit 1/);
  assert.ok(f.prompts.find((p) => p.role === 'build' && p.n === 2)!.prompt.includes(f.row('test', 1)!.output!));
  const [g] = f.store.listGates({ run_id: f.runId, open: true });
  assert.equal(g.node, 'test');

  f.store.updateItem(f.item.id, { test_cmd: 'true' });
  const note = 'Ignore "do the thing": instead do the other thing, and never touch the thing.';
  f.store.updateItem(f.item.id, { body: 'Requirement: do the thing.' });
  f.decide('approve', note);
  await runChange(f.ctx);
  const notes = 'Additional requirements from the human (these override the item body where they conflict)';
  const build4 = f.prompts.find((p) => p.role === 'build' && p.n === 4)!.prompt;
  const review4 = f.prompts.find((p) => p.role === 'review')!.prompt;
  for (const p of [build4, review4]) {
    assert.ok(p.includes('Requirement: do the thing.'));
    assert.ok(p.slice(p.indexOf(notes)).includes(`- (failure gate, approve) ${note}`));
  }
  assert.equal(f.row('test', 4)!.status, 'completed');
  assert.equal(f.store.getItem(f.item.id).status, 'active');
  assert.equal(f.store.listGates({ run_id: f.runId, open: true })[0].kind, 'merge');

  f.decide('reject', 'wrong approach');
  await runChange(f.ctx);
  assert.deepEqual(f.calls.find((c) => c[0] === 'closePr'), ['closePr', 7, 'wrong approach']);
  assert.equal(f.store.getRun(f.runId).status, 'cancelled');
  assert.equal(f.store.getItem(f.item.id).status, 'ready');
  assert.equal(existsSync(f.wt.path), false);
  assert.equal(f.row('merge_gate', 4)!.status, 'failed');
  assert.ok(f.store.getRetro(f.runId));
});

test('legacy persisted review: approving its failure gate resumes the item and run before the PR node', async (t) => {
  const f = setup(t);
  const seed = (node: string, output: string) => {
    const row = f.store.createNodeRun({ run_id: f.runId, node, iteration: 1 });
    f.store.transitionNodeRun(row.id, 'pending', 'running');
    f.store.updateNodeRun(row.id, { output });
    f.store.transitionNodeRun(row.id, 'running', 'completed');
  };
  seed('build', JSON.stringify({ head_sha: worktrees.headSha(f.wt.path) }));
  seed('test', 'exit 0\n');
  seed('review', JSON.stringify({ pre_sha: 'a', verdict: 'changes', findings: [] }));
  f.store.transitionItem(f.item.id, 'active', 'blocked');
  f.store.openGate({ run_id: f.runId, node: 'review', kind: 'failure', question: 'q', recommendation: 'r' });
  f.store.transitionRun(f.runId, 'running', 'paused');
  f.decide('approve');
  await runChange(f.ctx);
  assert.equal(f.store.getItem(f.item.id).status, 'active');
  assert.equal(f.row('pr', 1)!.status, 'completed');
  assert.equal(f.store.listGates({ run_id: f.runId, open: true })[0].kind, 'merge');
});

test('reviewer containment reverts commits and dirt but keeps the verdict', async (t) => {
  const edit = 'echo r > r.txt && git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm rev && echo d > dirty.txt';
  const f = setup(t, { script: (c) => c.role === 'review' ? ['FAKE_OMP_SCENARIO=edit', `FAKE_OMP_EDIT=${edit}`, `FAKE_OMP_TEXT=${approve}`] : defaultScript(c) });
  await runChange(f.ctx);
  const out = JSON.parse(f.row('review', 1)!.output!);
  assert.equal(out.verdict, 'approve');
  assert.deepEqual(out.findings, [{ severity: 'advisory', text: REVERTED }]);
  assert.equal(worktrees.headSha(f.wt.path), out.pre_sha);
  assert.ok(worktrees.isClean(f.wt.path));
  assert.equal(f.store.getRun(f.runId).status, 'paused');
});

test('advisory findings go to the PR, not to rework', async (t) => {
  const text = '```json\n{"verdict":"changes","findings":[{"severity":"advisory","text":"harden x"},{"severity":"advisory","text":"style y"}]}\n```';
  const f = setup(t, { script: (c) => c.role === 'review' ? ['FAKE_OMP_SCENARIO=complete', `FAKE_OMP_TEXT=${text}`] : defaultScript(c) });
  await runChange(f.ctx);
  assert.equal(f.rows().filter((n) => n.node === 'build').length, 1);
  assert.equal(JSON.parse(f.row('review', 1)!.output!).verdict, 'approve');
  const body = (f.calls.find((c) => c[0] === 'openPr')![1] as { body: string }).body;
  assert.ok(body.includes('### Advisory (not blocking)\n\n- harden x\n- style y'));
  assert.ok((f.calls.find((c) => c[0] === 'commentPr')![2] as string).includes('Advisory (not blocking)'));
  f.decide('approve');
  await runChange(f.ctx);
  assert.deepEqual(f.store.getRetro(f.runId)!.findings, ['[advisory] harden x', '[advisory] style y']);
});

test('advisories from a round that triggered rework still reach the PR', async (t) => {
  const r1 = '```json\n{"verdict":"changes","findings":[{"severity":"blocking","text":"fix a"},{"severity":"advisory","text":"harden x"}]}\n```';
  const f = setup(t, { script: (c) => c.role === 'review' && c.n === 1 ? ['FAKE_OMP_SCENARIO=complete', `FAKE_OMP_TEXT=${r1}`] : defaultScript(c) });
  await runChange(f.ctx);
  assert.equal(f.rows().filter((n) => n.node === 'build').length, 2);
  const body = (f.calls.find((c) => c[0] === 'openPr')![1] as { body: string }).body;
  assert.ok(body.includes('### Advisory (not blocking)\n\n- harden x'));
  assert.ok(!body.includes('fix a'));
  assert.ok((f.calls.find((c) => c[0] === 'commentPr')![2] as string).includes('- harden x'));
});

test('a conflict (item cancelled externally) returns without further writes', async (t) => {
  const f = setup(t, { script: () => { throw new Error('no session expected'); } });
  for (let i = 1; i <= 3; i++) {
    const n = f.store.createNodeRun({ run_id: f.runId, node: 'build', iteration: i });
    f.store.transitionNodeRun(n.id, 'pending', 'failed');
  }
  f.store.transitionItem(f.item.id, 'active', 'cancelled');
  const events = f.store.listEvents({ limit: 1000 }).length;
  await runChange(f.ctx);
  assert.equal(f.store.listEvents({ limit: 1000 }).length, events);
  assert.equal(f.store.getRun(f.runId).status, 'running');
});

test('stopped after a session: nothing is written and the node run stays running', async (t) => {
  const f = setup(t);
  const inner = f.ctx.runSession;
  f.ctx.runSession = async (p, o) => { const r = await inner(p, o); f.stop = true; return r; };
  await runChange(f.ctx);
  const [b] = f.rows();
  assert.equal(b.status, 'running');
  assert.equal(worktrees.commitsAhead(f.wt.path, 'origin/main'), 0);
});

const toMerge = async (f: ReturnType<typeof setup>) => {
  await runChange(f.ctx);
  f.decide('approve');
};

for (const [name, thrown, message] of [['Error', new Error('forge down'), 'forge down'], ['null', null, 'null']] as const) {
  test(`unexpected node error (${name}) fails the run, readies the item, records a retro`, async (t) => {
    const f = setup(t);
    await toMerge(f);
    (f.ctx.forge as unknown as { prState: () => never }).prState = () => { throw thrown; };
    await runChange(f.ctx);
    assert.equal(f.row('merge', 1)?.status, 'failed');
    assert.deepEqual(JSON.parse(f.row('merge', 1)!.output!), { error: message });
    assert.equal(f.store.getRun(f.runId).status, 'failed');
    assert.ok(f.store.getRun(f.runId).ended_at);
    assert.equal(f.store.getItem(f.item.id).status, 'ready');
    assert.equal(f.store.getRetro(f.runId)?.notes, `node merge errored: ${message}`);
  });
}

test('unexpected node error leaves a no-longer-active item alone; stopped() does nothing', async (t) => {
  const f = setup(t);
  await toMerge(f);
  (f.ctx.forge as unknown as { prState: () => never }).prState = () => {
    f.store.transitionItem(f.item.id, 'active', 'cancelled');
    throw new Error('x');
  };
  await runChange(f.ctx);
  assert.equal(f.store.getItem(f.item.id).status, 'cancelled');
  assert.equal(f.store.getRun(f.runId).status, 'failed');

  const g = setup(t);
  await toMerge(g);
  (g.ctx.forge as unknown as { prState: () => Promise<never> }).prState = async () => { g.stop = true; throw new Error('x'); };
  await runChange(g.ctx);
  assert.equal(g.store.getRun(g.runId).status, 'running');
  assert.equal(g.row('merge', 1)?.status, 'running');
});

type Patchable = { prState: () => unknown; deleteRemoteBranch: () => unknown };
const forgeOf = (f: ReturnType<typeof setup>) => f.ctx.forge as unknown as Patchable;
const failed = (f: ReturnType<typeof setup>, node: string, message: string) => {
  assert.deepEqual(JSON.parse(f.row(node, 1)!.output!), { error: message });
  assert.equal(f.row(node, 1)!.status, 'failed');
  assert.equal(f.store.getRun(f.runId).status, 'failed');
  assert.equal(f.store.getItem(f.item.id).status, 'ready');
  assert.equal(f.store.getRetro(f.runId)?.notes, `node ${node} errored: ${message}`);
};

test('error after a rejected merge gate fails the paused run and its merge_gate node', async (t) => {
  const f = setup(t);
  await runChange(f.ctx);
  f.decide('reject');
  forgeOf(f).prState = () => { throw new Error('forge down'); };
  await runChange(f.ctx);
  failed(f, 'merge_gate', 'forge down');
  assert.ok(existsSync(f.wt.path));
});

for (const [name, decision, status] of [['merge', 'approve', 'completed'], ['merge reject', 'reject', 'cancelled']] as const) {
  test(`remote branch deletion error (${name}) comes after the outcome commits and keeps the worktree`, async (t) => {
    const f = setup(t);
    await runChange(f.ctx);
    f.decide(decision);
    forgeOf(f).deleteRemoteBranch = () => { throw new Error('push refused'); };
    await runChange(f.ctx);
    assert.equal(f.store.getRun(f.runId).status, status);
    assert.ok(f.store.getRetro(f.runId));
    assert.ok(existsSync(f.wt.path));
    assert.match(git(f.root, ['branch', '--list', f.wt.branch]), /factory\//);
  });
}

test('a failing gate-open write leaves no half-open failure gate', async (t) => {
  const f = setup(t, { test_cmd: 'false' });
  const real = f.store.openGate;
  f.store.openGate = () => { throw new Error('db down'); };
  await runChange(f.ctx);
  f.store.openGate = real;
  assert.equal(f.store.getItem(f.item.id).status, 'ready');
  assert.equal(f.store.getRun(f.runId).status, 'failed');
  assert.equal(f.store.listGates({ run_id: f.runId }).length, 0);
});

test('an unexpected error in the retro write fails the run with a retro', async (t) => {
  const f = setup(t);
  await toMerge(f);
  const real = f.store.recordRetro;
  let once = true;
  f.store.recordRetro = (r) => { if (once) { once = false; throw new Error('retro write'); } return real(r); };
  await runChange(f.ctx);
  assert.equal(f.store.getRun(f.runId).status, 'failed');
  assert.equal(f.store.getItem(f.item.id).status, 'ready');
  assert.match(f.store.getRetro(f.runId)!.notes!, /errored: retro write/);
});

test('an unprintable thrown value still fails the run', async (t) => {
  const f = setup(t);
  await toMerge(f);
  forgeOf(f).prState = () => { throw Object.create(null); };
  await runChange(f.ctx);
  failed(f, 'merge', 'unknown error');
});

test('a resumed run with no reviewer mapping records a failed review node', async (t) => {
  const f = setup(t, { script: ({ role }) => role === 'build' ? defaultScript({ role, n: 1 }) : [] });
  f.ctx.config = { ...config, roles: { ...config.roles, reviewer: {} } };
  await runChange(f.ctx);
  failed(f, 'review', "no reviewer mapped for model family 'anthropic'");
});

test('stop during the state flush starts no destructive cleanup', async (t) => {
  const f = setup(t);
  await runChange(f.ctx);
  f.decide('approve');
  f.ctx.committer.flush = async () => { f.stop = true; };
  await runChange(f.ctx);
  assert.equal(f.store.getRun(f.runId).status, 'completed');
  assert.equal(f.calls.filter((c) => c[0] === 'deleteRemoteBranch').length, 0);
  assert.ok(existsSync(f.wt.path));
});

test('merge reject records its retro with the cancellation; a stop during remote deletion keeps the worktree', async (t) => {
  const f = setup(t);
  await runChange(f.ctx);
  f.decide('reject', 'no');
  f.ctx.forge.deleteRemoteBranch = async () => { f.stop = true; };
  await runChange(f.ctx);
  assert.equal(f.store.getRun(f.runId).status, 'cancelled');
  assert.equal(f.store.getItem(f.item.id).status, 'ready');
  assert.ok(f.store.getRetro(f.runId));
  assert.ok(existsSync(f.wt.path));
});
