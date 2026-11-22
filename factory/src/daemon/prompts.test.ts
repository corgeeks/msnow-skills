import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutorPrompt, buildReviewerPrompt, parseVerdict, render, NO_VERDICT_FINDING, type ExecutorVars } from './prompts.ts';

const exec: ExecutorVars = {
  item_id: 7, title: 'Do thing', body: 'item body', spec: 'SPEC TEXT', spec_path: 'docs/prd/x/specs/a.md',
  prd_path: 'docs/prd/x/PRD.md', test_cmd: 'npm test', iteration: 1, failure_output: '', review_findings: '',
  gate_note: '', resume: false,
};

test('executor: no conditional sections when empty', () => {
  const out = buildExecutorPrompt(exec);
  assert.ok(!out.includes('{{'));
  assert.ok(!out.includes('## Resume') && !out.includes('## Rework'));
  assert.ok(out.includes('SPEC TEXT') && out.includes('docs/prd/x/PRD.md') && out.includes('npm test'));
  assert.ok(out.includes('do not update task status or write logs'));
  for (const s of ['status_script', 'log.md', 'update-task-status', 'Output Format']) assert.ok(!out.includes(s), s);
});

test('executor: resume and failure sections', () => {
  const out = buildExecutorPrompt({ ...exec, resume: true, failure_output: 'BOOM 42', review_findings: '- fix x', gate_note: 'try y' });
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
  const out = buildReviewerPrompt({ item_id: 1, title: 't', body: 'b', spec: 's', spec_path: 'p', test_cmd: 'npm test', diff: '+added line', test_output: 'ok' });
  assert.ok(out.includes('+added line'));
  assert.ok(out.includes('Do not modify, create, or delete any files, and do not commit. Changes you make will be reverted and reported.'));
  assert.ok(out.includes('{ "verdict": "approve" | "changes", "findings": ["..."] }'));
  assert.ok(!/\{\{\w/.test(out));
});

const bad = { verdict: 'changes', findings: [NO_VERDICT_FINDING] };
const block = (s: string, lang = 'json') => '```' + lang + '\n' + s + '\n```';

test('parseVerdict', () => {
  assert.deepEqual(parseVerdict('ok\n' + block('{"verdict":"approve","findings":[]}')), { verdict: 'approve', findings: [] });
  assert.deepEqual(parseVerdict(block('{"verdict":"changes","findings":["a"]}') + '\n' + block('{"verdict":"approve"}') + '\nthanks!'), { verdict: 'approve', findings: [] });
  assert.deepEqual(parseVerdict('no block'), bad);
  assert.deepEqual(parseVerdict(block('{not json')), bad);
  assert.deepEqual(parseVerdict(block('{"verdict":"lgtm","findings":[]}')), bad);
  assert.deepEqual(parseVerdict(block('{"verdict":"changes"}')), bad);
  assert.deepEqual(parseVerdict(block('{"verdict":"approve","findings":["nit"]}', 'JSON  ')), { verdict: 'approve', findings: ['nit'] });
  assert.deepEqual(parseVerdict(block('{"verdict":"approve","findings":[]}') + '\n' + block('const x = 1;', 'ts')), { verdict: 'approve', findings: [] });
});
