import { createFileRoute, Link } from '@tanstack/react-router';
import { api, ApiError } from '@/lib/api';
import { useResource } from '@/lib/events';
import { formatCost, formatTime } from '@/lib/format';
import { StatusBadge } from '@/components/status-badge';
import { ItemList } from '@/components/items/item-list';
import { Markdown } from '@/components/markdown';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export const Route = createFileRoute('/items/$id')({ component: Page });

const linkCls = 'hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

function NotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Item not found</h1>
      <Link to="/" search={{}} className="underline">Back to work items</Link>
    </div>
  );
}

function Page() {
  const id = Number(Route.useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const { data, error } = useResource(valid ? api.item(id) : null, {
    refetchOn: ['item.created', 'item.updated', 'run.created', 'run.updated'],
  });
  if (!valid || (error instanceof ApiError && error.status === 404)) return <NotFound />;
  if (error) return <p role="alert" className="text-destructive">Failed to load item: {error.message}</p>;
  if (!data) return <div className="space-y-2">{[0, 1, 2].map((n) => <Skeleton key={n} className="h-8 w-full" />)}</div>;

  const { item } = data;
  const fields: [string, string | number | null][] = [
    ['Tier', item.tier], ['Priority', item.priority], ['Spec', item.spec_path], ['Test command', item.test_cmd],
    ['Source', item.source_ref], ['Created', formatTime(item.created_at)], ['Updated', formatTime(item.updated_at)],
  ];
  const runs = [...data.runs].sort((a, b) => b.attempt - a.attempt);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          #{item.id} · {item.type}
          {item.parent_id !== null && (
            <> · parent <Link to="/items/$id" params={{ id: String(item.parent_id) }} className={linkCls}>#{item.parent_id}</Link></>
          )}
        </p>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{item.title}</h1>
          <StatusBadge status={item.status} />
        </div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all">{v ?? '—'}</dd>
            </div>
          ))}
        </dl>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Description</h2>
        {item.body ? <Markdown text={item.body} /> : <p className="text-muted-foreground">—</p>}
      </section>

      <div className="grid gap-6 md:grid-cols-3">
        <ItemList title="Depends on" items={data.deps} />
        <ItemList title="Dependents" items={data.dependents} />
        <ItemList title="Children" items={data.children} />
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Runs</h2>
        {runs.length === 0 ? <p className="text-muted-foreground">None</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                {['Attempt', 'Status', 'Template', 'Branch', 'PR', 'Cost', 'Started', 'Ended'].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><Link to="/runs/$id" params={{ id: String(r.id) }} className={linkCls}>Attempt {r.attempt}</Link></TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell>{r.template}</TableCell>
                  <TableCell>{r.branch ?? '—'}</TableCell>
                  <TableCell>
                    {r.pr_url ? <a href={r.pr_url} target="_blank" rel="noreferrer" className={linkCls}>#{r.pr_number}</a> : r.pr_number !== null ? `#${r.pr_number}` : '—'}
                  </TableCell>
                  <TableCell>{formatCost(r.cost_usd)}</TableCell>
                  <TableCell>{formatTime(r.started_at)}</TableCell>
                  <TableCell>{formatTime(r.ended_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
