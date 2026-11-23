import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { BatchItem } from '../shared/types.ts';
import { buildImportBatch } from './import.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const fx = path.join(root, 'factory/test/fixtures/prd');
const byRef = (items: BatchItem[]) => new Map(items.map((i) => [i.ref, i]));

function assertWellFormed(items: BatchItem[]) {
  const seen = new Set<string>();
  for (const it of items) {
    assert.equal(it.ref, it.source_ref);
    assert.ok(!seen.has(it.ref), `dup ref ${it.ref}`);
    if (it.parent_ref) assert.ok(seen.has(it.parent_ref), `parent before ${it.ref}`);
    for (const d of it.depends_on_refs ?? []) assert.ok(seen.has(d), `dep ${d} before ${it.ref}`);
    assert.equal(new Set(it.depends_on_refs ?? []).size, (it.depends_on_refs ?? []).length);
    if (it.type === 'group' || it.type === 'umbrella' || (it.type === 'prd' && it.status === 'ready')) {
      assert.deepEqual(it.depends_on_refs ?? [], [], `container ${it.ref} has deps`);
    }
    seen.add(it.ref);
  }
}

test('ordinary PRD mapping and deps', () => {
  const items = buildImportBatch(path.join(fx, 'ordinary'), root);
  assertWellFormed(items);
  const m = byRef(items);
  const prd = m.get('prd:ordinary')!;
  assert.deepEqual(
    { type: prd.type, title: prd.title, body: prd.body, status: prd.status, spec_path: prd.spec_path },
    { type: 'prd', title: 'Ordinary', body: 'Ordinary objective.', status: 'ready',
      spec_path: 'factory/test/fixtures/prd/ordinary/PRD.md' });
  const [a, g, b1, b2, c] = ['A', 'B', 'B1', 'B2', 'C'].map((n) => m.get(`prd:ordinary#${n}`)!);
  assert.equal(g.type, 'group');
  assert.equal(g.parent_ref, 'prd:ordinary');
  assert.deepEqual([a.type, a.status, a.tier, a.parent_ref], ['task', 'ready', 'heavy', 'prd:ordinary']);
  assert.equal(a.spec_path, 'factory/test/fixtures/prd/ordinary/specs/a.md');
  assert.equal(a.body, 'first');
  assert.deepEqual([b1.status, b1.tier, b1.parent_ref], ['done', 'light', g.ref]);
  assert.deepEqual([b2.status, b2.tier], ['draft', null]);
  assert.deepEqual([c.status, c.tier], ['ready', 'standard']);
  assert.deepEqual(a.depends_on_refs, []);
  assert.deepEqual(b1.depends_on_refs, [a.ref]);
  assert.deepEqual(b2.depends_on_refs, [a.ref]);
  assert.deepEqual(c.depends_on_refs, [b1.ref, b2.ref]);
});

test('umbrella PRD recursion, stubs, and level edges', () => {
  const items = buildImportBatch(path.join(fx, 'umbrella'), root);
  assertWellFormed(items);
  const m = byRef(items);
  assert.equal(items[0].ref, 'prd:umbrella');
  assert.equal(items[0].type, 'umbrella');
  assert.equal(m.get('prd:child-a')!.parent_ref, 'prd:umbrella');
  assert.equal(m.get('prd:child-a')!.status, 'ready');
  assert.equal(m.get('prd:child-b')!.parent_ref, 'prd:umbrella#L1');
  const stub = m.get('prd:child-stub')!;
  assert.deepEqual([stub.type, stub.status, stub.title, stub.body], ['prd', 'draft', 'Child Stub', 'Child Stub objective.']);
  const aLeaves = ['prd:child-a#A1', 'prd:child-a#A2'];
  assert.deepEqual(m.get('prd:child-a#A2')!.depends_on_refs, ['prd:child-a#A1']);
  assert.deepEqual(m.get('prd:child-b#B1')!.depends_on_refs, aLeaves);
  assert.deepEqual(stub.depends_on_refs, aLeaves);
  assert.deepEqual(m.get('prd:child-late')!.depends_on_refs, ['prd:child-b#B1', 'prd:child-stub']);
  assert.equal(m.get('prd:child-late')!.status, 'draft');
});

test('deterministic', () => {
  assert.deepEqual(buildImportBatch(path.join(fx, 'umbrella'), root), buildImportBatch(path.join(fx, 'umbrella'), root));
});

test('missing PRD.md names the path', () => {
  assert.throws(() => buildImportBatch(path.join(fx, 'nope'), root), /nope\/PRD\.md/);
});

test('missing yq/jq surfaces the require_yaml_tools hint', (t) => {
  let bash: string;
  try { bash = execFileSync('which', ['bash'], { encoding: 'utf8' }).trim(); } catch { return t.skip('no bash'); }
  if (!bash) return t.skip('no bash');
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-nobin-'));
  const oldPath = process.env.PATH;
  try {
    symlinkSync(bash, path.join(dir, 'bash'));
    process.env.PATH = dir;
    assert.throws(() => buildImportBatch(path.join(fx, 'ordinary'), root), /yq/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke: software-factory umbrella', () => {
  const items = buildImportBatch(path.join(root, 'docs/prd/software-factory'), root);
  assertWellFormed(items);
  const m = byRef(items);
  assert.equal(m.get('prd:software-factory')!.type, 'umbrella');
  assert.equal(m.get('prd:software-factory#L1 · Adapters and surfaces')!.type, 'group');
  const sf12 = m.get('prd:sf12-configurable-gates')!;
  assert.deepEqual([sf12.type, sf12.status], ['prd', 'draft']);
});
