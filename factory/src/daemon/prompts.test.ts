import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutorPrompt, buildReviewerPrompt, parseVerdict, render, NO_VERDICT_FINDING, type ExecutorVars } from './prompts.ts';

const exec: ExecutorVars = {
  item_id: 7, title: 'Do thing', body: 'item body', spec: 'SPEC TEXT', spec_path: 'docs/prd/x/specs/a.md',
  prd_path: 'docs/prd/x/PRD.md', test_cmd: 'npm test', iteration: 1, failure_output: '', review_findings: '',
  human_notes: '', resume: false,
};

test('executor: no conditional sections when empty', () => {
  const out = buildExecutorPrompt(exec);
  assert.ok(!out.includes('{{'));
  assert.ok(!out.includes('## Resume') && !out.includes('## Rework'));
  assert.ok(out.includes('SPEC TEXT') && out.includes('docs/prd/x/PRD.md') && out.includes('npm test'));
  assert.ok(out.includes('do not update task status or write logs'));
  for (const s of ['status_script', 'log.md', 'update-task-status', 'Output Format']) assert.ok(!out.includes(s), s);
});

test('executor: architecture doc sync rule', () => {
  const out = buildExecutorPrompt(exec);
  assert.ok(out.includes('If your change alters behavior, interfaces, data model, or decisions described in docs/factory/architecture.md, update the relevant section in the same change.'));
  assert.ok(out.includes('Add a new decision-log entry (D-NN) when you make a design decision.'));
});

test('executor: resume and failure sections', () => {
  const out = buildExecutorPrompt({ ...exec, resume: true, failure_output: 'BOOM 42', review_findings: '- fix x', human_notes: '- (failure gate, approve) try y' });
  assert.ok(out.includes('A previous session was interrupted'));
  assert.ok(out.includes('BOOM 42') && out.includes('- fix x') && out.includes('try y'));
  assert.ok(!out.includes('{{'));
});

test('values inserted literally', () => {
  assert.ok(buildExecutorPrompt({ ...exec, body: 'see {{title}}' }).includes('see {{title}}'));
});

test('unknown var throws', () => {
  assert.throws(() => render('{{nope}}', {}), /nope/);
  assert.throws(() => render('{{#nope}}x{{/nope}}', {}), /nope/);
});

test('reviewer render', () => {
  const out = buildReviewerPrompt({ item_id: 1, title: 't', body: 'b', spec: 's', spec_path: 'p', test_cmd: 'npm test', diff: '+added line', test_output: 'ok', human_notes: '' });
  assert.ok(out.includes('+added line'));
  assert.ok(out.includes('Do not modify, create, or delete any files, and do not commit. Changes you make will be reverted and reported.'));
  assert.ok(out.includes('{ "verdict": "approve" | "changes", "findings": [{ "severity": "blocking" | "advisory", "text": "..." }] }'));
  assert.ok(out.includes('a correctness, security, data-loss, or spec-violation problem in this change'));
  assert.ok(out.includes('Flag changes that make docs/factory/architecture.md inaccurate.'));
  assert.ok(!/\{\{\w/.test(out));
});

const bad = { verdict: 'changes', findings: [NO_VERDICT_FINDING] };
const block = (s: string, lang = 'json') => '```' + lang + '\n' + s + '\n```';

const blocking = (text: string) => ({ severity: 'blocking', text });
const advisory = (text: string) => ({ severity: 'advisory', text });

test('parseVerdict', () => {
  assert.deepEqual(parseVerdict('ok\n' + block('{"verdict":"approve","findings":[]}')), { verdict: 'approve', findings: [] });
  assert.deepEqual(parseVerdict(block('{"verdict":"changes","findings":["a"]}') + '\n' + block('{"verdict":"approve"}') + '\nthanks!'), { verdict: 'approve', findings: [] });
  assert.deepEqual(parseVerdict('no block'), bad);
  assert.deepEqual(parseVerdict(block('{not json')), bad);
  assert.deepEqual(parseVerdict(block('{"verdict":"lgtm","findings":[]}')), bad);
  assert.deepEqual(parseVerdict(block('{"verdict":"changes"}')), bad);
  assert.deepEqual(parseVerdict(block('{"verdict":"approve","findings":[{"severity":"advisory","text":"nit"}]}', 'JSON  ')), { verdict: 'approve', findings: [advisory('nit')] });
  assert.deepEqual(parseVerdict(block('{"verdict":"approve","findings":[]}') + '\n' + block('const x = 1;', 'ts')), { verdict: 'approve', findings: [] });
});

test('parseVerdict severities', () => {
  const changes = (findings: unknown[]) => parseVerdict(block(JSON.stringify({ verdict: 'changes', findings })));
  assert.deepEqual(changes([blocking('a'), advisory('b')]), { verdict: 'changes', findings: [blocking('a'), advisory('b')] });
  // advisory-only `changes` is an approval
  assert.deepEqual(changes([advisory('b')]), { verdict: 'approve', findings: [advisory('b')] });
  // legacy plain strings count as blocking
  assert.deepEqual(changes(['a']), { verdict: 'changes', findings: [blocking('a')] });
  assert.deepEqual(changes(['a', advisory('b')]), { verdict: 'changes', findings: [blocking('a'), advisory('b')] });
  // a blocking finding overrides an `approve` verdict
  const approves = (findings: unknown[]) => parseVerdict(block(JSON.stringify({ verdict: 'approve', findings })));
  assert.deepEqual(approves([blocking('a')]), { verdict: 'changes', findings: [blocking('a')] });
  assert.deepEqual(approves(['a']), { verdict: 'changes', findings: [blocking('a')] });
  // unknown severity or missing text is unparseable
  assert.deepEqual(changes([{ severity: 'nit', text: 'a' }]), bad);
  assert.deepEqual(changes([{ severity: 'blocking' }]), bad);
});
