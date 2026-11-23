import { createFileRoute, Link } from '@tanstack/react-router';
import { GateCard } from '@/components/runs/gate-card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type Gate } from '@/lib/api';
import { useResource } from '@/lib/events';

export const Route = createFileRoute('/gates')({ component: Page });

function Page() {
  const { data: gates, error } = useResource(api.gates(), { refetchOn: ['gate.opened', 'gate.closed', 'run.updated'] }); // run.updated: a run gaining its PR changes gate links
  const { data: runs } = useResource(api.runs(), { refetchOn: ['run.created'] });
  const { data: items } = useResource(api.items(), { refetchOn: ['item.created', 'item.updated'] });
  if (!gates) return error ? <p className="text-destructive">{error.message}</p> : <Skeleton className="h-40 w-full" />;
  const open = gates.filter((g) => g.closed_at === null).sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  const closed = gates.filter((g) => g.closed_at !== null).slice(0, 20); // server orders closed by closed_at desc

  const context = (g: Gate) => {
    const run = runs?.find((r) => r.id === g.run_id);
    const item = run && items?.find((i) => i.id === run.item_id);
    return (
      <>
        {run && <><Link to="/items/$id" params={{ id: String(run.item_id) }} className="underline">#{run.item_id} {item?.title ?? ''}</Link> · </>}
        <Link to="/runs/$id" params={{ id: String(g.run_id) }} className="underline">Run #{g.run_id}</Link>
      </>
    );
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Gates</h1>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Open</h2>
        {open.length === 0 && <p className="text-muted-foreground text-sm">No open gates</p>}
        {open.map((g) => <GateCard key={g.id} gate={g} context={context(g)} />)}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recently closed</h2>
        {closed.map((g) => <GateCard key={g.id} gate={g} context={context(g)} />)}
      </section>
    </div>
  );
}
