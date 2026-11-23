import { createFileRoute } from '@tanstack/react-router';
import { api, type ItemStatus } from '@/lib/api';
import { useResource } from '@/lib/events';
import { ITEM_STATUSES } from '@/components/status-badge';
import { ItemTree } from '@/components/items/item-tree';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

export type ItemsSearch = { type?: string; status?: ItemStatus; q?: string };
const str = (v: unknown) => (typeof v === 'number' ? String(v) : typeof v === 'string' && v.trim() ? v : undefined);

export const Route = createFileRoute('/')({
  validateSearch: (s: Record<string, unknown>): ItemsSearch => ({
    type: str(s.type),
    status: ITEM_STATUSES.includes(s.status as ItemStatus) ? (s.status as ItemStatus) : undefined,
    q: str(s.q),
  }),
  component: Page,
});

const selectCls = 'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

function Page() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data, error } = useResource(api.items(), { refetchOn: ['item.created', 'item.updated'] });
  const set = (key: keyof ItemsSearch, value: string) =>
    navigate({ search: (prev) => ({ ...prev, [key]: value || undefined }), replace: true });
  const types = [...new Set(data?.map((i) => i.type))].sort();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Work items</h1>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Type
          <select className={selectCls} value={search.type ?? ''} onChange={(e) => set('type', e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Status
          <select className={selectCls} value={search.status ?? ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">All statuses</option>
            {ITEM_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Search
          <Input className="w-64" value={search.q ?? ''} placeholder="Title or #id" onChange={(e) => set('q', e.target.value)} />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">Failed to load items: {error.message}</p>
      ) : !data ? (
        <div className="space-y-2">{[0, 1, 2, 3, 4].map((n) => <Skeleton key={n} className="h-8 w-full" />)}</div>
      ) : (
        <ItemTree items={data} />
      )}
    </div>
  );
}
