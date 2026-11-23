import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../cli/main.ts';
import { killAllSessions } from './omp.ts';
import { testText } from './retro.ts';
import { INTERRUPTED, RESTART_HINT } from './template-change.ts';
import { APPROVE, defaultScript, gitOut, setupFactory, waitFor, type Script } from '../../test/e2e-harness.ts';

type F = Awaited<ReturnType<typeof setupFactory>>;
const runOf = (f: F, itemId: number) => waitFor(() => f.store.listRuns({ item_id: itemId })[0]);
const openGate = (f: F) => waitFor(() => f.store.listGates({ open: true })[0]);
const out = (s: string | null) => JSON.parse(s ?? '{}');
const summary = (f: F, runId: number) => f.nodes(runId).map((n) => `${n.node}#${n.iteration}:${n.status}`);

async function toMergeGate(f: F) {
  const item = f.queueItem();
  const gate = await openGate(f);
  const run = f.store.getRun((await runOf(f, item.id)).id);
  return { item, gate, run };
}

test('e2e', { concurrency: 1 }, async (t) => {
  await t.test('happy path to merged', async (t) => {
    const f = await setupFactory(t);
    const { item, gate, run } = await toMergeGate(f);
    assert.equal(gate.kind, 'merge');
    assert.equal(gate.question, `Merge PR #1 (https://github.com/fake/repo/pull/1) for #${item.id} add feature?`);
    assert.equal(f.store.getRun(run.id).status, 'paused');
    await f.decide(gate.id, 'approve');
    await waitFor(() => f.store.getItem(item.id).status === 'done' && f.store.getRetro(run.id));

    const r = f.store.getRun(run.id);
    assert.equal(r.status, 'completed');
    assert.equal(r.pr_number, 1);
    assert.equal(r.pr_url, 'https://github.com/fake/repo/pull/1');
    assert.ok(r.head_sha && r.ended_at);
    for (const node of ['build', 'test', 'review', 'pr', 'merge_gate', 'merge']) {
      assert.ok(f.nodes(run.id).some((n) => n.node === node && n.iteration === 1 && n.status === 'completed'), `${node}: ${summary(f, run.id)}`);
    }
    f.git(['fetch', '-q', 'origin']);
    assert.match(f.git(['ls-tree', '-r', '--name-only', 'origin/main']), /^factory\/feature-1\.txt$/m);
    assert.equal(existsSync(join(f.root, '.factory', 'worktrees', `${item.id}-1`)), false);
    assert.equal(f.git(['branch', '--list', `factory/${item.id}-1`]), '');
    assert.equal(f.git(['ls-remote', 'origin', `factory/${item.id}-1`]), '');
    const retro = f.store.getRetro(run.id)!;
    assert.equal(retro.rework_count, 0);
    assert.deepEqual(retro.failures, []);
    assert.equal(retro.notes, RESTART_HINT);
    await waitFor(() => /^factory: state/m.test(f.git(['log', '--format=%s', 'origin/main'])) || (f.git(['fetch', '-q', 'origin']), false));
    assert.equal(f.gh().prs['1'].state, 'MERGED');
  });

  await t.test('test failure then retry', async (t) => {
    const f = await setupFactory(t);
    writeFileSync(join(f.T, 'fail-once'), '');
    const { item, gate, run } = await toMergeGate(f);
    const rows = f.nodes(run.id);
    const pick = (node: string, it: number) => rows.find((n) => n.node === node && n.iteration === it)!;
    assert.equal(pick('build', 1).status, 'completed');
    assert.equal(pick('test', 1).status, 'failed');
    assert.match(testText(pick('test', 1).output), /^exit 1/);
    assert.equal(pick('build', 2).status, 'completed');
    assert.equal(pick('test', 2).status, 'completed');
    const b2 = f.prompts.find((p) => p.role === 'build' && p.n === 2)!;
    assert.ok(b2.prompt.includes(testText(pick('test', 1).output)), 'build#2 prompt has test#1 output');
    await f.decide(gate.id, 'approve');
    await waitFor(() => f.store.getItem(item.id).status === 'done' && f.store.getRetro(run.id));
    const retro = f.store.getRetro(run.id)!;
    assert.equal(retro.rework_count, 1);
    assert.deepEqual(retro.failures, ['test #1: exit 1']);
  });

  await t.test('review changes then rework', async (t) => {
    const script: Script = (c) => c.role === 'review' && c.n === 1
      ? { FAKE_OMP_SCENARIO: 'complete', FAKE_OMP_TEXT: '```json\n{"verdict":"changes","findings":[{"severity":"blocking","text":"rename x"}]}\n```' }
      : defaultScript(c);
    const f = await setupFactory(t, { script });
    const { item, gate, run } = await toMergeGate(f);
    const rows = f.nodes(run.id);
    const review = (it: number) => out(rows.find((n) => n.node === 'review' && n.iteration === it)!.output);
    assert.equal(review(1).verdict, 'changes');
    assert.ok(rows.some((n) => n.node === 'build' && n.iteration === 2));
    assert.equal(review(2).verdict, 'approve');
    assert.deepEqual(Object.keys(f.gh().prs), ['1']);
    await f.decide(gate.id, 'approve');
    await waitFor(() => f.store.getItem(item.id).status === 'done' && f.store.getRetro(run.id));
    assert.ok(f.store.getRetro(run.id)!.findings.includes('[blocking] rename x'));
  });

  for (const decision of ['reject', 'approve'] as const) {
    await t.test(`exhausted failure gate (${decision})`, async (t) => {
      const f = await setupFactory(t);
      writeFileSync(join(f.T, 'fail'), '');
      const item = f.queueItem();
      const gate = await openGate(f);
      const run = await runOf(f, item.id);
      assert.equal(gate.kind, 'failure');
      assert.equal(gate.node, 'test');
      assert.deepEqual(summary(f, run.id), [1, 2, 3].flatMap((i) => [`build#${i}:completed`, `test#${i}:failed`]));
      assert.equal(f.store.getItem(item.id).status, 'blocked');
      await waitFor(() => f.store.getRun(run.id).status === 'paused');
      const wt = f.store.getRun(run.id).worktree!;

      if (decision === 'reject') {
        await f.decide(gate.id, 'reject');
        await waitFor(() => f.store.getRetro(run.id));
        assert.equal(f.store.getItem(item.id).status, 'cancelled');
        assert.equal(f.store.getRun(run.id).status, 'failed');
        assert.ok(existsSync(wt));
        assert.deepEqual(f.gh().prs, {});
        assert.equal(f.store.getRetro(run.id)!.failures.length, 3);
        return;
      }
      rmSync(join(f.T, 'fail'));
      await f.decide(gate.id, 'approve', 'try harder');
      const mg = await waitFor(() => f.store.listGates({ open: true }).find((g) => g.kind === 'merge'));
      assert.equal(mg.run_id, run.id);
      assert.equal(f.store.getRun(run.id).worktree, wt);
      assert.ok(f.nodes(run.id).some((n) => n.node === 'build' && n.iteration === 4 && n.status === 'completed'));
      assert.ok(f.prompts.find((p) => p.role === 'build' && p.n === 4)!.prompt.includes('try harder'));
    });
  }

  const changes = (text: string): Script => (c) => c.role === 'review'
    ? { FAKE_OMP_SCENARIO: 'complete', FAKE_OMP_TEXT: '```json\n{"verdict":"changes","findings":[{"severity":"blocking","text":"' + text + '"},{"severity":"advisory","text":"style y"}]}\n```' }
    : defaultScript(c);
  const reviewGate = async (f: F) => {
    const item = f.queueItem();
    const gate = await openGate(f);
    const run = await runOf(f, item.id);
    assert.equal(gate.node, 'review');
    return { item, gate, run };
  };
  const testedHead = (f: F, runId: number) => out(f.nodes(runId).findLast((n) => n.node === 'test')!.output).head_sha;

  await t.test('override of a review-exhausted gate opens the PR and merge gate for the tested SHA', async (t) => {
    const f = await setupFactory(t, { script: changes('rename x') });
    const { item, gate, run } = await reviewGate(f);
    const sha = testedHead(f, run.id);
    assert.equal(f.git(['rev-parse', `refs/heads/factory/${item.id}-1`]), sha);
    assert.equal((await f.rawDecide(gate.id, 'override', 'good enough')).status, 200);
    const mg = await waitFor(() => f.store.listGates({ open: true }).find((g) => g.kind === 'merge'));
    assert.equal(mg.run_id, run.id);
    const r = f.store.getRun(run.id);
    assert.equal(r.head_sha, sha);
    assert.equal(f.store.getItem(item.id).status, 'active');
    assert.equal(f.git(['ls-remote', 'origin', `factory/${item.id}-1`]).split(/\s/)[0], sha);
    const pr = f.gh().prs['1'];
    for (const text of [pr.body, pr.comments[0]]) {
      assert.match(text, /Overridden by the human/);
      assert.match(text, /Note: good enough/);
      assert.match(text, /- \[blocking\] rename x/);
      assert.match(text, /- \[advisory\] style y/);
    }
    assert.ok(!f.nodes(run.id).some((n) => n.node === 'build' && n.iteration === 3));
    await f.decide(mg.id, 'approve');
    await waitFor(() => f.store.getItem(item.id).status === 'done' && f.store.getRetro(run.id));
  });

  await t.test('override is a 400 when the latest test failed', async (t) => {
    const f = await setupFactory(t);
    writeFileSync(join(f.T, 'fail'), '');
    const item = f.queueItem();
    const gate = await openGate(f);
    const res = await f.rawDecide(gate.id, 'override');
    assert.equal(res.status, 400);
    assert.equal(res.json.error!.code, 'bad_request');
    assert.equal(f.store.listGates({ open: true })[0].id, gate.id);
    assert.equal(f.store.getItem(item.id).status, 'blocked');
  });

  await t.test('override is a 400 when the branch moved', async (t) => {
    const f = await setupFactory(t, { script: changes('rename x') });
    const { gate, run } = await reviewGate(f);
    gitOut(f.store.getRun(run.id).worktree!, ['commit', '--allow-empty', '-qm', 'moved']);
    assert.equal((await f.rawDecide(gate.id, 'override')).status, 400);
    assert.equal(f.store.listGates({ open: true })[0].id, gate.id);
  });

  await t.test('override is a 400 on a merge gate, open or closed', async (t) => {
    const f = await setupFactory(t);
    const { gate } = await toMergeGate(f);
    assert.equal((await f.rawDecide(gate.id, 'override')).status, 400);
    await f.decide(gate.id, 'reject');
    assert.equal((await f.rawDecide(gate.id, 'override')).status, 400);
  });

  await t.test('a PR head that is not the tested SHA fails the pr node', async (t) => {
    const f = await setupFactory(t, { script: changes('rename x') });
    const { item, gate, run } = await reviewGate(f);
    const real = f.forge.prState;
    f.forge.prState = async (n) => ({ ...(await real(n)), headRefOid: 'deadbeef' });
    await f.decide(gate.id, 'override');
    await waitFor(() => f.store.getRun(run.id).status === 'failed' && f.store.getRetro(run.id));
    const pr = f.nodes(run.id).find((n) => n.node === 'pr')!;
    assert.equal(pr.status, 'failed');
    assert.match(out(pr.output).error, /not the tested SHA/);
    assert.match(f.store.getRetro(run.id)!.notes, /^node pr errored: /);
    assert.equal(f.store.getItem(item.id).status, 'ready');
    assert.ok(!f.store.listGates({ open: true }).some((g) => g.kind === 'merge'));
  });

  await t.test('merge-gate reject', async (t) => {
    const f = await setupFactory(t);
    const { item, gate, run } = await toMergeGate(f);
    const wt = f.store.getRun(run.id).worktree!;
    await f.decide(gate.id, 'reject', 'wrong approach');
    await waitFor(() => f.store.getRetro(run.id));
    assert.equal(f.gh().prs['1'].state, 'CLOSED');
    assert.equal(f.store.getRun(run.id).status, 'cancelled');
    assert.equal(f.store.getItem(item.id).status, 'ready');
    assert.equal(existsSync(wt), false);
    assert.equal(f.git(['branch', '--list', `factory/${item.id}-1`]), '');
    assert.equal(f.git(['ls-remote', 'origin', `factory/${item.id}-1`]), '');
    f.git(['fetch', '-q', 'origin']);
    assert.doesNotMatch(f.git(['ls-tree', '-r', '--name-only', 'origin/main']), /feature-1\.txt/);
  });

  await t.test('unexpected node error fails the run; factory start makes attempt 2 from origin/main', async (t) => {
    const f = await setupFactory(t);
    const real = f.forge.prState;
    let boom = true;
    f.forge.prState = async (n) => { if (boom) throw new Error('forge down'); return real(n); };
    const { item, gate, run } = await toMergeGate(f);
    const wt1 = f.store.getRun(run.id).worktree!;
    await f.decide(gate.id, 'approve');
    await waitFor(() => f.store.getRun(run.id).status === 'failed' && f.store.getRetro(run.id));
    assert.equal(f.store.getItem(item.id).status, 'ready');
    assert.equal(f.store.getRetro(run.id)!.notes, 'node merge errored: forge down');
    assert.deepEqual(out(f.nodes(run.id).find((n) => n.node === 'merge')!.output), { error: 'forge down' });
    assert.ok(existsSync(wt1));
    assert.notEqual(f.git(['branch', '--list', `factory/${item.id}-1`]), '');

    boom = false;
    assert.equal(await main(['start', String(item.id), '--port', String(f.port)]), 0);
    const run2 = await waitFor(() => f.store.listRuns({ item_id: item.id }).find((r) => r.attempt === 2));
    const wt2 = (await waitFor(() => f.store.getRun(run2.id).worktree))!;
    await openGate(f);
    assert.notEqual(wt2, wt1);
    assert.equal(wt2, join(f.root, '.factory', 'worktrees', `${item.id}-2`));
    assert.equal(f.store.getRun(run2.id).branch, `factory/${item.id}-2`);
    f.git(['fetch', '-q', 'origin']);
    const base = f.git(['rev-parse', 'origin/main']);
    assert.equal(gitOut(wt2, ['rev-list', '--count', `${base}..HEAD`]), '1');
    assert.equal(gitOut(wt2, ['rev-parse', 'HEAD^']), base);
  });

  await t.test('restart mid-run', async (t) => {
    const script: Script = (c) => c.role === 'build' && c.n === 1 ? { FAKE_OMP_SCENARIO: 'hang' } : defaultScript(c);
    const f = await setupFactory(t, { script });
    const item = f.queueItem();
    const run = await runOf(f, item.id);
    const build = await waitFor(() => f.nodes(run.id).find((n) => n.node === 'build' && n.status === 'running'));
    await waitFor(() => f.prompts.length === 1);
    await f.engine.stop();
    killAllSessions();
    await waitFor(() => f.sessionsSettled() === 1);
    assert.equal(f.nodes(run.id).find((n) => n.id === build.id)!.status, 'running');
    const updates: Record<string, unknown>[] = [];
    f.bus.subscribe((e) => { if (e.type === 'node.updated' && e.node === 'build') updates.push(e.data); });

    f.engine = f.newEngine();
    await f.engine.start();
    const gate = await openGate(f);
    assert.equal(gate.kind, 'merge');
    assert.deepEqual(updates[0], { status: 'failed', from: 'running' });
    assert.equal(updates[1].output, INTERRUPTED);
    const builds = f.nodes(run.id).filter((n) => n.node === 'build');
    assert.deepEqual(builds.map((n) => [n.id, n.iteration, n.status]), [[build.id, 1, 'completed']]);
    assert.match(f.prompts.find((p) => p.role === 'build' && p.n === 2)!.prompt, /## Resume/);
    await f.decide(gate.id, 'approve');
    await waitFor(() => f.store.getItem(item.id).status === 'done');
  });
});
