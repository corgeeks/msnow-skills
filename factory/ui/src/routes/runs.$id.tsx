import { createFileRoute, Link } from '@tanstack/react-router';
import { StatusBadge } from '@/components/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ActivityPanel } from '@/components/runs/activity-panel';
import { GateCard } from '@/components/runs/gate-card';
import { NodeTimeline } from '@/components/runs/node-timeline';
import { api, ApiError } from '@/lib/api';
import { useResource } from '@/lib/events';
import { formatCost, formatDuration, formatTime } from '@/lib/format';

export const Route = createFileRoute('/runs/$id')({ component: Page });

function Page() {
  const id = Number(Route.useParams().id);
  if (!Number.isInteger(id) || id <= 0) return <NotFound />;
  return <RunView key={id} id={id} />;
}

function NotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Run not found</h1>
      <Link to="/" className="underline">Back to items</Link>
    </div>
  );
}

function RunView({ id }: { id: number }) {
  const { data, error } = useResource(api.run(id), { refetchOn: ['run.updated', 'node.updated', 'gate.opened', 'gate.closed'] });
  const item = useResource(data ? api.item(data.run.item_id) : null, { refetchOn: ['item.updated'] }).data;
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  if (!data) return error ? <p className="text-destructive">{error.message}</p> : <Skeleton className="h-40 w-full" />;
  const { run, node_runs, gates } = data;
  const pr = run.pr_url ? <a href={run.pr_url} target="_blank" rel="noreferrer" className="underline">PR #{run.pr_number}</a>
    : run.pr_number ? `PR #${run.pr_number}` : '—';
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle><h1 className="text-2xl font-semibold">Run #{run.id} · attempt {run.attempt}</h1></CardTitle>
          <Link to="/items/$id" params={{ id: String(run.item_id) }} className="underline">#{run.item_id} {item?.item.title ?? ''}</Link>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
            <dt className="text-muted-foreground">Status</dt><dd><StatusBadge status={run.status} /></dd>
            <dt className="text-muted-foreground">Template</dt><dd>{run.template}</dd>
            <dt className="text-muted-foreground">Branch</dt><dd>{run.branch ? <code>{run.branch}</code> : '—'}</dd>
            <dt className="text-muted-foreground">Cost</dt><dd>{formatCost(run.cost_usd)}</dd>
            <dt className="text-muted-foreground">PR</dt><dd>{pr}</dd>
            <dt className="text-muted-foreground">Duration</dt><dd>{formatDuration(run.started_at, run.ended_at)}</dd>
            <dt className="text-muted-foreground">Started</dt><dd>{formatTime(run.started_at)}</dd>
            <dt className="text-muted-foreground">Ended</dt><dd>{formatTime(run.ended_at)}</dd>
          </dl>
        </CardContent>
      </Card>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Nodes</h2>
        <NodeTimeline nodes={node_runs} />
      </section>
      {gates.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Gates</h2>
          {gates.map((g) => <GateCard key={g.id} gate={g} />)}
        </section>
      )}
      <ActivityPanel runId={id} />
    </div>
  );
}
