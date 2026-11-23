import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BatchItem, ItemStatus, Tier } from '../shared/types.ts';

interface Entry {
  name: string; description?: string; spec?: string; status?: string;
  subtasks?: Entry[];
}

const STATUS: Record<string, ItemStatus> = {
  draft: 'draft', defined: 'ready', 'in-progress': 'ready', completed: 'done',
};

/** Flatten a YAML PRD directory into an ordered batch for POST /api/items/batch. */
export function buildImportBatch(prdDir: string, root: string): BatchItem[] {
  const items: BatchItem[] = [];
  walkPrd(path.resolve(prdDir), path.resolve(root), undefined, items);
  return items;
}

function readYaml(file: string, root: string): Entry[] {
  const lib = path.join(root, 'skills/prd/scripts/lib/yq-compat.sh');
  let json: string;
  try {
    json = execFileSync('bash',
      ['-c', 'source "$1" && require_yaml_tools && yaml_to_json "$2"', '_', lib, file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(e.stderr?.trim() || e.message);
  }
  const doc: unknown = json.trim() ? JSON.parse(json) : null;
  return Array.isArray(doc) ? doc as Entry[] : [];
}

function prdItem(dir: string, root: string): Omit<BatchItem, 'ref' | 'type' | 'status'> {
  const file = path.join(dir, 'PRD.md');
  if (!existsSync(file)) throw new Error(`PRD.md not found: ${file}`);
  const md = readFileSync(file, 'utf8');
  const title = /^# (.+)$/m.exec(md)?.[1]?.trim() ?? path.basename(dir);
  const body = /^## Objective[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(md)?.[1]?.trim() ?? '';
  return { title, body, spec_path: path.relative(root, file), tier: null, source_ref: `prd:${path.basename(dir)}` };
}

function parseTier(specFile: string): Tier | null {
  const lines = readFileSync(specFile, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.trim() === '## Suggested Model');
  if (i < 0) return null;
  const first = lines.slice(i + 1).find((l) => l.trim() !== '');
  const m = first && /^(heavy|standard|light)\b/i.exec(first.trim());
  return m ? m[1].toLowerCase() as Tier : null;
}

/** Emit the PRD at `dir` (and everything below it); return its dispatchable leaf refs. */
function walkPrd(dir: string, root: string, parentRef: string | undefined, items: BatchItem[]): string[] {
  const base = prdItem(dir, root);
  const ref = base.source_ref!;
  const tasksFile = path.join(dir, 'tasks.yaml');
  if (!existsSync(tasksFile)) {
    // Stub child PRD: a single draft leaf the factory plans later.
    items.push({ ...base, ref, parent_ref: parentRef, type: 'prd', status: 'draft' });
    return [ref];
  }
  const entries = readYaml(tasksFile, root);
  const isChildPrd = (e: Entry) => (e.spec ?? '').endsWith('PRD.md');
  const umbrella = entries.some((e) => (e.subtasks ?? [e]).some(isChildPrd));
  const prd: BatchItem = { ...base, ref, type: umbrella ? 'umbrella' : 'prd', status: 'ready' };
  if (parentRef) prd.parent_ref = parentRef;
  items.push(prd);
  const byRef = new Map<string, BatchItem>();

  const leaf = (e: Entry, parent: string): string[] => {
    if (isChildPrd(e)) {
      const before = items.length;
      const refs = walkPrd(path.resolve(dir, path.dirname(e.spec!)), root, parent, items);
      for (const it of items.slice(before)) byRef.set(it.ref, it);
      return refs;
    }
    const sref = `prd:${path.basename(dir)}#${e.name}`;
    let specPath: string | null = null;
    let tier: Tier | null = null;
    if (e.spec) {
      const file = path.resolve(dir, e.spec);
      if (!existsSync(file)) throw new Error(`spec not found: ${file}`);
      specPath = path.relative(root, file);
      tier = parseTier(file);
    }
    const it: BatchItem = {
      ref: sref, parent_ref: parent, type: 'task', title: e.name, body: e.description ?? '',
      spec_path: specPath, tier, status: STATUS[e.status ?? 'draft'] ?? 'draft', source_ref: sref,
    };
    items.push(it);
    byRef.set(sref, it);
    return [sref];
  };

  let prev: string[] = [];
  const all: string[] = [];
  for (const e of entries) {
    let cur: string[];
    if (e.subtasks) {
      const gref = `prd:${path.basename(dir)}#${e.name}`;
      items.push({ ref: gref, parent_ref: ref, type: 'group', title: e.name, body: e.description ?? '',
        spec_path: null, tier: null, status: 'ready', source_ref: gref });
      cur = e.subtasks.flatMap((s) => leaf(s, gref));
    } else {
      cur = leaf(e, ref);
    }
    // Sequential levels: every leaf of entry k depends on every leaf of entry k-1.
    for (const r of cur) {
      const it = byRef.get(r)!;
      it.depends_on_refs = [...new Set([...(it.depends_on_refs ?? []), ...prev])];
    }
    prev = cur;
    all.push(...cur);
  }
  return all;
}
