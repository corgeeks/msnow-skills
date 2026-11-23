import type { NodeRun, Retro, Run } from '../shared/types.ts';

// Pure summary of a finished run's rows. No clock, no I/O.
export function computeRetro(run: Run, nodeRuns: NodeRun[], findings: string[]): Retro {
  const rows = nodeRuns.filter((n) => n.run_id === run.id)
    .sort((a, b) => a.iteration - b.iteration || a.id - b.id);
  const failures = rows
    .filter((n) => (n.node === 'build' || n.node === 'test') && n.status === 'failed')
    .map((n) => `${n.node} #${n.iteration}: ${(n.output ?? '').split('\n')[0] || 'no output'}`.slice(0, 300));
  const builds = new Set(rows.filter((n) => n.node === 'build').map((n) => n.iteration)).size;
  const cost = rows.reduce((s, n) => s + n.cost_usd, 0);
  const lastNodeEnd = rows.reduce<number | null>((m, n) => {
    const t = n.ended_at ? Date.parse(n.ended_at) : NaN;
    return Number.isNaN(t) ? m : Math.max(m ?? t, t);
  }, null);
  const start = run.started_at ? Date.parse(run.started_at) : NaN;
  const end = run.ended_at ? Date.parse(run.ended_at) : lastNodeEnd;
  const duration = Number.isNaN(start) || end == null || Number.isNaN(end) ? 0 : Math.max(0, Math.round((end - start) / 1000));
  return {
    run_id: run.id,
    failures,
    findings: [...findings],
    rework_count: Math.max(0, builds - 1),
    cost_usd: Math.round(cost * 1e4) / 1e4,
    duration_s: duration,
    notes: '',
  };
}
