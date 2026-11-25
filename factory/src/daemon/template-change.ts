import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, gitSigningOffEnv } from './git.ts';
import { asFinding, buildExecutorPrompt, buildReviewerPrompt, parseVerdict, type Finding, type Verdict } from './prompts.ts';
import { computeRetro, testText } from './retro.ts';
import { ConflictError, type NodeRunPatch, type Store } from './store.ts';
import type { Bus } from './bus.ts';
import type { Forge } from './forge.ts';
import type { runSession } from './omp.ts';
import type * as Worktrees from './worktrees.ts';
import type { Config, Gate, ItemStatus, NodeRun, Run, RunStatus, WorkItem } from '../shared/types.ts';

export interface ChangeContext {
  runId: number; stopped: () => boolean;
  store: Store; bus: Bus; config: Config; paths: { root: string; sessionsDir: string };
  runSession: typeof runSession;
  worktrees: Pick<typeof Worktrees, 'commitAll' | 'commitsAhead' | 'headSha' | 'isClean' | 'resetHard' | 'removeWorktree'>;
  forge: Forge; committer: { flush(reason?: string): Promise<void> };
}

export const INTERRUPTED = 'interrupted by daemon restart';
export const REVERTED = 'reviewer modified the worktree (reverted)';
export const RESTART_HINT = 'daemon code changed on main — restart the daemon to pick it up';
const TEST_TIMEOUT_MS = 10 * 60_000;

/** itemCost: spend across all of the item's runs; costApprovals: approved cost gates across them (each raises the item's cap by one `caps.itemCostUsd`). */
export interface StepInput { run: Run; nodeRuns: NodeRun[]; gates: Gate[]; retro: boolean; config: Config; itemCost: number; costApprovals: number }
export type Step =
  | { kind: 'build'; iteration: number; row?: NodeRun; resume?: boolean }
  | { kind: 'pr'; iteration: number; row?: NodeRun; override?: { sha: string; gate: Gate } } // override: failure gate overridden at this tested SHA
  | { kind: 'test' | 'review' | 'merge' | 'open_merge_gate'; iteration: number; row?: NodeRun }
  | { kind: 'open_failure_gate'; node: 'build' | 'test' | 'review'; count: number }
  | { kind: 'open_cost_gate'; node: 'build' | 'review'; spent: number; cap: number }
  | { kind: 'revive'; row: NodeRun } // interrupted merge_gate row: back to running, then re-derive
  | { kind: 'wait' | 'finalize' | 'merge_reject' | 'failure_reject' | 'retro' | 'done' };

type Out = { pre_sha?: string; head_sha?: string; verdict?: string; findings?: (string | Finding)[]; touches_factory?: boolean };
const parse = (s: string | null | undefined): Out => { try { return JSON.parse(s ?? '') ?? {}; } catch { return {}; } };
const findingsOf = (s: string | null | undefined): Finding[] => (parse(s).findings ?? []).map(asFinding);
// Cost gates are failure gates told apart by this question prefix; they must not raise the build/review attempt budgets.
export const costGatePrefix = (itemId: number) => `Item #${itemId} has spent $`;
export const isCostGate = (g: Gate, itemId: number) => g.kind === 'failure' && g.question.startsWith(costGatePrefix(itemId));
// Spend and cap are compared in whole micro-dollars: float sums (ten $0.01 → 0.0999…) must not miss the cap, fractional-cent caps must survive.
const micros = (usd: number) => Math.round(usd * 1e6);
const spent = (usd: number) => String(micros(usd) / 1e6); // the exact value enforced, e.g. 0.0200000001 → 0.02
// Closed gates' notes in order with their decision; identical text goes to executor and reviewer.
const humanNotes = (gates: Gate[]) => gates.filter((g) => g.decision && g.note)
  .sort((a, b) => a.id - b.id).map((g) => `- (${g.kind} gate, ${g.decision}) ${g.note}`).join('\n');
/** SHA a failure gate may be overridden to: set only if the run's latest test node passed and recorded a head_sha. */
export function testedSha(rows: NodeRun[]): string | undefined {
  const t = lastRow(rows, 'test');
  const sha = t?.status === 'completed' ? parse(t.output).head_sha : undefined;
  return typeof sha === 'string' && sha ? sha : undefined;
}
const latest = (gates: Gate[]) => gates.reduce<Gate | undefined>((m, g) => (!m || g.id > m.id ? g : m), undefined);
const lastRow = (rows: NodeRun[], node: string, iteration?: number) =>
  rows.findLast((n) => n.node === node && (iteration === undefined || n.iteration === iteration));
const buildIteration = (rows: NodeRun[]) => Math.max(0, ...rows.filter((n) => n.node === 'build').map((n) => n.iteration));
const now = () => new Date().toISOString();

/** Override context while the latest gate is an overridden failure gate; the tested SHA must still be recorded. */
function overrideOf(rows: NodeRun[], gates: Gate[]): { sha: string; gate: Gate } | undefined {
  const gate = latest(gates);
  if (gate?.kind !== 'failure' || gate.decision !== 'override') return undefined;
  const sha = testedSha(rows);
  if (!sha) throw new Error(`gate ${gate.id} overridden but the latest test did not pass`);
  return { sha, gate };
}

/** Pure: the next step for a run, derived only from persisted rows. A build or review session is replaced by a cost gate once the item's spend reaches its cap. */
export function nextStep(i: StepInput): Step {
  const s = derive(i);
  if (s.kind !== 'build' && s.kind !== 'review') return s;
  const cap = i.config.caps.itemCostUsd * (1 + i.costApprovals);
  return micros(i.itemCost) >= micros(cap) ? { kind: 'open_cost_gate', node: s.kind, spent: i.itemCost, cap } : s;
}

function derive({ run, nodeRuns, gates, retro, config }: StepInput): Step {
  const terminal = run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed';
  // A rejected cost gate ends the run even if recovery left an interrupted node behind: retrying it would only reopen the gate.
  const last = latest(gates);
  if (last && isCostGate(last, run.item_id) && last.decision === 'reject') return terminal ? { kind: retro ? 'done' : 'retro' } : { kind: 'failure_reject' };
  const interrupted = nodeRuns.find((n) => n.status === 'failed' && n.output === INTERRUPTED);
  if (interrupted) {
    const { node, iteration } = interrupted;
    if (node === 'merge_gate') return { kind: 'revive', row: interrupted };
    if (node === 'build') return { kind: 'build', iteration, row: interrupted, resume: true };
    if (node === 'pr') return { kind: 'pr', iteration, row: interrupted, override: overrideOf(nodeRuns, gates) };
    return { kind: node as 'test', iteration, row: interrupted };
  }
  if (terminal) return { kind: retro ? 'done' : 'retro' };
  const gate = latest(gates);
  if (gate && gate.closed_at === null) return { kind: 'wait' };
  if (nodeRuns.some((n) => n.node === 'merge' && n.status === 'completed')) return { kind: 'finalize' };

  const it = buildIteration(nodeRuns);
  const mg = lastRow(nodeRuns, 'merge_gate');
  if (mg) {
    const g = latest(gates.filter((x) => x.node === 'merge_gate'));
    if (!g) return { kind: 'open_merge_gate', iteration: mg.iteration, row: mg.status === 'running' ? mg : undefined };
    return g.decision === 'approve' ? { kind: 'merge', iteration: mg.iteration } : { kind: 'merge_reject' };
  }
  if (lastRow(nodeRuns, 'pr')?.status === 'completed') return { kind: 'open_merge_gate', iteration: it };
  const override = overrideOf(nodeRuns, gates);
  if (override) return { kind: 'pr', iteration: it, override };
  const review = lastRow(nodeRuns, 'review', it);
  const verdict = review?.status === 'completed' ? parse(review.output).verdict : undefined;
  if (verdict === 'approve') return { kind: 'pr', iteration: it };
  if (gate?.kind === 'failure' && gate.decision === 'reject') return { kind: 'failure_reject' };

  if (it === 0) return { kind: 'build', iteration: 1 };
  const build = lastRow(nodeRuns, 'build', it)!;
  const test = lastRow(nodeRuns, 'test', it);
  if (build.status === 'completed' && !test) return { kind: 'test', iteration: it };
  if (test?.status === 'completed' && (!review || review.status === 'failed')) return { kind: 'review', iteration: it };

  const approved = (nodes: string[]) =>
    gates.filter((g) => g.kind === 'failure' && g.decision === 'approve' && nodes.includes(g.node) && !isCostGate(g, run.item_id)).length;
  if (build.status === 'failed' || test?.status === 'failed') {
    const failed = new Set(nodeRuns.filter((n) => (n.node === 'build' || n.node === 'test') && n.status === 'failed')
      .map((n) => n.iteration)).size;
    if (failed >= config.loop.maxBuildAttempts * (1 + approved(['build', 'test']))) {
      return { kind: 'open_failure_gate', node: test?.status === 'failed' ? 'test' : 'build', count: failed };
    }
    return { kind: 'build', iteration: it + 1 };
  }
  if (verdict === 'changes') {
    const changes = nodeRuns.filter((n) => n.node === 'review' && n.status === 'completed' && parse(n.output).verdict === 'changes').length;
    if (changes >= config.loop.maxReviewRounds * (1 + approved(['review']))) return { kind: 'open_failure_gate', node: 'review', count: changes };
    return { kind: 'build', iteration: it + 1 };
  }
  throw new Error(`no next step (build #${it} ${build.status}, test ${test?.status ?? 'none'}, review ${review?.status ?? 'none'})`);
}

/** `sh -c cmd` in cwd; stdout+stderr interleaved; process group killed at the timeout. */
export function runTest(cmd: string, cwd: string): Promise<{ code: number | string; tail: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | string; tail: string }>();
  const child = spawn('sh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...gitSigningOffEnv() } });
  let out = '';
  let timedOut = false;
  const add = (c: string) => { out += c; if (out.length > 1 << 20) out = out.slice(-(1 << 19)); };
  for (const s of [child.stdout, child.stderr]) { s.setEncoding('utf8'); s.on('data', add); }
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }, TEST_TIMEOUT_MS);
  child.on('error', (e) => add(`${e.message}\n`));
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    resolve({ code: timedOut ? 'timeout' : code ?? signal ?? 'unknown', tail: out.replace(/\n$/, '').split('\n').slice(-200).join('\n') });
  });
  return promise;
}

/** `advisory` spans every review round, so advisories from rounds that triggered rework still reach the human. */
const reviewMarkdown = (model: string | null, v: Out, advisories: Finding[]) => {
  const list = (fs: Finding[]) => fs.map((f) => `- ${f.text}`);
  const blocking = list((v.findings ?? []).map(asFinding).filter((f) => f.severity === 'blocking'));
  const advisory = list(advisories);
  return [`## Review`, '', `Reviewer: ${model}`, `Verdict: **${v.verdict}**`,
    ...(blocking.length ? ['', ...blocking] : []),
    ...(advisory.length ? ['', '### Advisory (not blocking)', '', ...advisory] : [])].join('\n');
};

/** PR body/comment section for a failure gate overridden by the human: the note, every finding of the latest review, and advisories from earlier rounds. */
const overrideMarkdown = (g: Gate, review: NodeRun | undefined, earlier: Finding[]) => {
  const findings = [...findingsOf(review?.output).map((f) => `- [${f.severity}] ${f.text}`),
    ...earlier.map((f) => `- [advisory, earlier round] ${f.text}`)];
  return ['## Overridden by the human', '', `Failure gate #${g.id} (${g.node}) was overridden; the tested commit went straight to this PR.`, '',
    `Note: ${g.note ?? '(none)'}`, '',
    `### Latest review${review ? ` (${review.model}, verdict **${parse(review.output).verdict}**)` : ''}`, '',
    ...(findings.length ? findings : ['- no findings'])].join('\n');
};

const STOP = Symbol('stopped');

/** Message for a thrown value; String() itself can throw (e.g. `Object.create(null)`). */
function errorMessage(e: unknown): string {
  try { return String(e instanceof Error ? e.message : e); } catch { return 'unknown error'; }
}

/** Drives one `change` run until it is terminal or waiting on an open gate. Re-entrant: state lives in the store. */
export async function runChange(ctx: ChangeContext): Promise<void> {
  const { store, bus, config, paths, forge, worktrees: wt, runId } = ctx;
  let cur: NodeRun | undefined; // node run to mark failed if a step throws
  let step: Step | undefined;
  const halt = () => { if (ctx.stopped()) throw STOP; };
  const run = () => store.getRun(runId);
  const item = () => store.getItem(run().item_id);

  const setItem = (from: ItemStatus, to: ItemStatus) => { const i = item(); if (i.status !== to) store.transitionItem(i.id, from, to); };
  const setRun = (from: RunStatus, to: RunStatus) => {
    if (run().status !== to) store.transitionRun(runId, from, to);
    if (to !== 'paused' && to !== 'running' && !run().ended_at) store.updateRun(runId, { ended_at: now() });
  };
  const resume = () => { setItem('blocked', 'active'); setRun('paused', 'running'); }; // only called where item is active/blocked
  const close = (row: NodeRun, status: 'completed' | 'failed', p: NodeRunPatch = {}) => {
    store.updateNodeRun(row.id, { ...p, ended_at: now() });
    store.transitionNodeRun(row.id, 'running', status);
  };
  const begin = (node: string, iteration: number, row?: NodeRun, model?: string): NodeRun =>
    (cur = row ? store.transitionNodeRun(row.id, 'failed', 'running')
      : store.transitionNodeRun(store.createNodeRun({ run_id: runId, node, iteration, model }).id, 'pending', 'running'));
  const end = (status: 'completed' | 'failed', p: NodeRunPatch = {}) => { close(cur!, status, p); cur = undefined; };
  /** One store transaction; `cur` is restored on rollback so the failing node stays identifiable. */
  const atomic = <T>(fn: () => T): T => {
    const saved = cur;
    try { return store.atomic(fn); } catch (e) { cur = saved; throw e; }
  };
  // Retro is part of terminalization: callers run it in the same transaction that makes the run terminal.
  const reviewFindings = (rows: NodeRun[]) => rows.filter((n) => n.node === 'review').flatMap((n) => findingsOf(n.output).map((f) => `[${f.severity}] ${f.text}`));
  const writeRetro = () => {
    const rows = store.listNodeRuns(runId);
    const findings = reviewFindings(rows);
    const touches = parse(lastRow(rows, 'merge')?.output).touches_factory === true;
    begin('retro', Math.max(1, buildIteration(rows)));
    const retro = computeRetro(run(), rows, findings);
    if (touches) {
      retro.notes = RESTART_HINT;
      console.log(RESTART_HINT);
    }
    store.recordRetro(retro);
    end('completed');
  };
  const addCost = () => store.updateRun(runId, { cost_usd: store.listNodeRuns(runId).reduce((s, n) => s + n.cost_usd, 0) });

  const session = async (node: 'build' | 'review', prompt: string, model: string, cwd: string) => {
    const o = await ctx.runSession(prompt, {
      cwd, model, sessionDir: paths.sessionsDir,
      timeoutMs: config.caps.sessionMinutes * 60_000, maxCostUsd: config.caps.sessionCostUsd,
      onActivity: (text) => bus.publishActivity({ run_id: runId, node, text, at: now() }),
    });
    // Persisted before any fallible post-session work: reported spend must survive a later throw or stop.
    store.updateNodeRun(cur!.id, { cost_usd: cur!.cost_usd + o.costUsd, session_file: o.sessionFile });
    addCost();
    halt();
    return o;
  };
  const common = (i: WorkItem, cwd: string) => ({
    item_id: i.id, title: i.title, body: i.body,
    spec: i.spec_path ? readFileSync(join(cwd, i.spec_path), 'utf8') : '',
    spec_path: i.spec_path ?? '', test_cmd: i.test_cmd ?? config.defaultTestCmd,
  });

  async function exec(s: Step, r: Run, rows: NodeRun[], gates: Gate[]): Promise<void> {
    const w = r.worktree!;
    const it = buildIteration(rows);
    switch (s.kind) {
      case 'build': {
        resume();
        const i = item();
        const model = config.roles.executor[i.tier ?? 'standard'];
        begin('build', s.iteration, s.row, model);
        const prev = (node: string) => rows.findLast((n) => n.iteration === s.iteration - 1 && n.node === node);
        const failure = [prev('build'), prev('test')].find((n) => n?.status === 'failed');
        const failureOutput = failure?.node === 'test' ? testText(failure.output) : failure?.output ?? '';
        const findings = findingsOf(prev('review')?.output).filter((f) => f.severity === 'blocking');
        const prompt = buildExecutorPrompt({
          ...common(i, w),
          prd_path: i.spec_path ? join(dirname(dirname(i.spec_path)), 'PRD.md') : '',
          iteration: s.iteration,
          human_notes: humanNotes(gates),
          failure_output: failureOutput,
          review_findings: findings.map((f) => `- ${f.text}`).join('\n'),
          resume: s.resume === true,
        });
        const o = await session('build', prompt, model, w);
        wt.commitAll(w, `factory: #${i.id} ${i.title}`);
        const ok = o.status === 'completed' && wt.commitsAhead(w, 'origin/main') > 0;
        // On success the head is recorded so an interrupted review can recover its pre-review SHA.
        const output = ok ? JSON.stringify({ head_sha: wt.headSha(w) })
          : o.status === 'completed' ? 'no commits ahead of origin/main'
          : o.status === 'error' || o.status === 'crashed' ? `${o.status}: ${o.error}` : o.status;
        end(ok ? 'completed' : 'failed', { output });
        return;
      }
      case 'test': {
        const i = item();
        begin('test', s.iteration, s.row);
        const head_sha = wt.headSha(w); // sampled before the command: the SHA the result is about
        const t = await runTest(i.test_cmd ?? config.defaultTestCmd, w);
        halt();
        end(t.code === 0 ? 'completed' : 'failed', { output: JSON.stringify({ exit: t.code, head_sha, tail: t.tail }) });
        return;
      }
      case 'review': {
        resume(); // a cost gate may have left the item blocked and the run paused before this review
        const i = item();
        const build = lastRow(rows, 'build', s.iteration)!;
        const family = (build.model ?? '').split('/')[0];
        const model = config.roles.reviewer[family];
        begin('review', s.iteration, s.row, model); // recorded before the lookup can throw
        if (!model) throw new Error(`no reviewer mapped for model family '${family}'`);
        // The engine overwrites an interrupted row's output, so a re-run falls back to the build's recorded head.
        const pre = s.row ? parse(s.row.output).pre_sha ?? parse(build.output).head_sha ?? wt.headSha(w) : wt.headSha(w);
        store.updateNodeRun(cur!.id, { output: JSON.stringify({ pre_sha: pre }) });
        let reverted = false;
        const contain = () => {
          if (wt.isClean(w) && wt.headSha(w) === pre) return;
          git(w, ['reset', '--hard', pre]);
          wt.resetHard(w);
          reverted = true;
        };
        if (s.row) contain();
        const prompt = buildReviewerPrompt({
          ...common(i, w), diff: git(w, ['diff', 'origin/main...HEAD']), test_output: testText(lastRow(rows, 'test', s.iteration)?.output ?? null), human_notes: humanNotes(gates),
        });
        const o = await session('review', prompt, model, w);
        const v: Verdict = o.status === 'completed' ? parseVerdict(o.finalText) : { verdict: 'changes', findings: [{ severity: 'blocking', text: `reviewer session ${o.status}` }] };
        contain();
        if (reverted) v.findings.push({ severity: 'advisory', text: REVERTED });
        end('completed', { output: JSON.stringify({ pre_sha: pre, ...v }) });
        return;
      }
      case 'pr': {
        const i = item();
        const ov = s.override;
        if (ov) resume(); // the failure gate left the item blocked and the run paused
        begin('pr', s.iteration, s.row);
        const cmd = i.test_cmd ?? config.defaultTestCmd;
        const tail = testText(lastRow(rows, 'test', ov ? undefined : s.iteration)?.output ?? null).split('\n').slice(1).slice(-20).join('\n');
        const review = lastRow(rows, 'review', ov ? undefined : s.iteration);
        const md = ov ? overrideMarkdown(ov.gate, review,
          rows.filter((n) => n.node === 'review' && n.status === 'completed' && n.id !== review?.id).flatMap((n) => findingsOf(n.output)).filter((f) => f.severity === 'advisory'))
          : reviewMarkdown(review!.model, parse(review!.output),
            rows.filter((n) => n.node === 'review' && n.status === 'completed').flatMap((n) => findingsOf(n.output)).filter((f) => f.severity === 'advisory'));
        await forge.pushBranch(w, r.branch!, ov?.sha);
        halt();
        let n = r.pr_number;
        if (n === null) {
          const body = [i.body, ...(i.spec_path ? [`Spec: ${i.spec_path}`] : []), `## Tests\n\n\`${cmd}\`: exit 0\n\n\`\`\`\n${tail}\n\`\`\``, md].join('\n\n');
          const pr = await forge.openPr({ branch: r.branch!, title: `#${i.id} ${i.title}`, body });
          n = pr.number;
          // Written before the stop check: losing the number would open a duplicate PR on re-run.
          store.updateRun(runId, { pr_number: pr.number, pr_url: pr.url, head_sha: ov?.sha ?? wt.headSha(w) });
          halt();
        }
        if (ov) {
          const oid = (await forge.prState(n)).headRefOid;
          halt();
          if (oid !== ov.sha) throw new Error(`PR #${n} head ${oid} is not the tested SHA ${ov.sha}`);
        }
        await forge.commentPr(n, md);
        halt();
        end('completed', { output: run().pr_url });
        return;
      }
      case 'open_merge_gate': {
        const i = item();
        cur = s.row ?? begin('merge_gate', s.iteration);
        atomic(() => {
          store.openGate({
            run_id: runId, node: 'merge_gate', kind: 'merge',
            question: `Merge PR #${r.pr_number} (${r.pr_url}) for #${i.id} ${i.title}?`,
            recommendation: gates.some((g) => g.decision === 'override')
              ? 'judge the PR — failure gate overridden by the human; unresolved review findings are listed on it'
              : `approve — tests pass, ${lastRow(rows, 'review')?.model} approved`,
          });
          setRun('running', 'paused');
        });
        cur = undefined; // stays running until the gate is decided
        return;
      }
      case 'open_cost_gate': {
        const i = item();
        // An interrupted/failed review row has no verdict; the last completed one holds the findings.
        const latestReview = rows.findLast((n) => n.node === 'review' && n.status === 'completed');
        const findings = reviewFindings(rows.filter((n) => n === latestReview));
        atomic(() => {
          setItem('active', 'blocked');
          store.openGate({
            run_id: runId, node: s.node, kind: 'failure',
            question: `${costGatePrefix(i.id)}${spent(s.spent)} (cap $${spent(s.cap)}). Continue?`,
            recommendation: findings.length ? findings.join('\n') : `no review findings — inspect worktree ${w}`,
          });
          setRun('running', 'paused');
        });
        return;
      }
      case 'open_failure_gate': {
        const i = item();
        atomic(() => {
          setItem('active', 'blocked');
          store.openGate({
            run_id: runId, node: s.node, kind: 'failure',
            question: `#${i.id} ${i.title}: ${s.node} failed ${s.count} times. Retry?`,
            recommendation: `reject — inspect worktree ${w}`,
          });
          setRun('running', 'paused');
        });
        return;
      }
      case 'wait': {
        if (latest(gates)!.kind === 'failure') setItem('active', 'blocked');
        setRun('running', 'paused');
        return;
      }
      case 'revive':
        store.transitionNodeRun(s.row.id, 'failed', 'running');
        return;
      case 'merge': {
        resume();
        const mg = lastRow(rows, 'merge_gate');
        if (mg?.status === 'running') close(mg, 'completed');
        const n = r.pr_number!;
        begin('merge', s.iteration, s.row);
        const touches = existsSync(w) && git(w, ['diff', '--name-only', 'origin/main...HEAD']).split('\n').some((l) => l.startsWith('factory/'));
        if ((await forge.prState(n)).state !== 'MERGED') {
          halt();
          await forge.mergePr(n, r.head_sha!);
        }
        halt();
        await forge.syncMain();
        halt();
        end('completed', { output: JSON.stringify({ touches_factory: touches }) });
        return; // finalize is derived next; it cleans up after everything that can fail the run has committed
      }
      case 'finalize': {
        const i = item();
        atomic(() => {
          setItem('active', 'done');
          setRun('running', 'completed');
          writeRetro();
        });
        await ctx.committer.flush(`merged #${i.id}`);
        // Destructive cleanup last, each step only if not stopped: the run is already terminal.
        halt();
        await forge.deleteRemoteBranch(r.branch!);
        halt();
        if (existsSync(w)) wt.removeWorktree(paths.root, w, { deleteBranch: r.branch });
        return;
      }
      case 'merge_reject': {
        const g = latest(gates.filter((x) => x.node === 'merge_gate'))!;
        const n = r.pr_number!;
        const mg = lastRow(rows, 'merge_gate');
        if (mg?.status === 'running') cur = mg; // an unexpected error below fails this node too
        if ((await forge.prState(n)).state === 'OPEN') {
          halt();
          await forge.closePr(n, g.note ?? undefined);
        }
        halt();
        atomic(() => {
          if (mg?.status === 'running') end('failed');
          setRun('paused', 'cancelled');
          setItem('active', 'ready');
          writeRetro(); // terminalization includes the retro: a stop during cleanup must not lose it
        });
        // Destructive cleanup after the outcome is committed, each step only if not stopped.
        halt();
        await forge.deleteRemoteBranch(r.branch!);
        halt();
        if (existsSync(w)) wt.removeWorktree(paths.root, w, { deleteBranch: r.branch });
        return;
      }
      case 'failure_reject':
        setItem('blocked', 'cancelled');
        setRun('paused', 'failed');
        return;
      case 'retro':
        atomic(writeRetro);
        return;
      case 'done':
        return;
    }
  }

  try {
    for (;;) {
      halt();
      const r = run();
      const rows = store.listNodeRuns(runId);
      const gates = store.listRunGates(runId);
      const itemRuns = store.listRuns({ item_id: r.item_id });
      step = nextStep({
        run: r, nodeRuns: rows, gates, retro: store.getRetro(runId) !== undefined, config,
        // Node costs are the source of truth; run.cost_usd is a derived total that may lag.
        itemCost: itemRuns.flatMap((x) => store.listNodeRuns(x.id)).reduce((sum, n) => sum + n.cost_usd, 0),
        costApprovals: itemRuns.flatMap((x) => store.listRunGates(x.id)).filter((g) => g.decision === 'approve' && isCostGate(g, r.item_id)).length,
      });
      if (step.kind === 'done') return;
      await exec(step, r, rows, gates);
      if (step.kind === 'wait' || step.kind === 'open_merge_gate' || step.kind === 'open_failure_gate' || step.kind === 'open_cost_gate') return;
    }
  } catch (e) {
    if (e === STOP || ctx.stopped()) return; // restart recovery handles a stop
    const message = errorMessage(e);
    let conflict = false;
    try { conflict = e instanceof ConflictError; } catch { /* exotic throwable: not a conflict */ }
    if (conflict) {
      console.error(`factory: run ${runId} ${step?.kind}: ${message}`);
      return;
    }
    console.error(`factory: run ${runId} ${step?.kind} failed: ${message}`);
    // Fail fast: recovery is a new attempt (`factory start`), never an in-place retry.
    try {
      store.atomic(() => {
        const node = cur?.node ?? step?.kind ?? 'unknown';
        if (cur) close(cur, 'failed', { output: JSON.stringify({ error: message }) });
        const from = run().status;
        const live = from === 'running' || from === 'paused';
        if (!live && store.getRetro(runId)) return; // terminal and retro recorded: nothing to fail
        const rows = store.listNodeRuns(runId);
        const retro = computeRetro(run(), rows, reviewFindings(rows));
        retro.notes = `node ${node} errored: ${message}`;
        store.recordRetro(retro);
        if (!live) return; // e.g. cleanup after a committed outcome: the retro still records the error
        const i = item();
        if (i.status === 'active') store.transitionItem(i.id, 'active', 'ready');
        setRun(from, 'failed'); // last: the dispatch slot is counted by 'running'
      });
    } catch (e2) {
      console.error(`factory: run ${runId}: could not fail run: ${errorMessage(e2)}`);
    }
  }
}
