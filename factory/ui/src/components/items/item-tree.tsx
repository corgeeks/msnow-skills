import { getRouteApi, Link } from '@tanstack/react-router';
import type { ItemSummary } from '@/lib/api';
import { StatusBadge } from '@/components/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const route = getRouteApi('/');

type Row = { item: ItemSummary; depth: number; matched: boolean };

// visible ids: matches plus their ancestors
function visibleIds(items: ItemSummary[], match: (i: ItemSummary) => boolean): Set<number> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const keep = new Set<number>();
  for (const i of items) if (match(i)) for (let c: ItemSummary | undefined = i; c && !keep.has(c.id); c = byId.get(c.parent_id ?? -1)) keep.add(c.id);
  return keep;
}

export function treeRows(items: ItemSummary[], match: ((i: ItemSummary) => boolean) | null): Row[] {
  const ids = new Set(items.map((i) => i.id));
  const keep = match ? visibleIds(items, match) : ids;
  const kids = new Map<number | null, ItemSummary[]>();
  for (const i of [...items].sort((a, b) => a.id - b.id)) {
    const p = i.parent_id !== null && ids.has(i.parent_id) ? i.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), i]);
  }
  const rows: Row[] = [];
  const walk = (p: number | null, depth: number) => {
    for (const i of kids.get(p) ?? []) {
      if (!keep.has(i.id)) continue;
      rows.push({ item: i, depth, matched: !match || match(i) });
      walk(i.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function ItemTree({ items }: { items: ItemSummary[] }) {
  const { type, status, q } = route.useSearch();
  const needle = q?.trim().toLowerCase();
  const filtered = Boolean(type || status || needle);
  const match = filtered
    ? (i: ItemSummary) =>
        (!type || i.type === type) &&
        (!status || i.status === status) &&
        (!needle || i.title.toLowerCase().includes(needle) || needle.replace(/^#/, '') === String(i.id))
    : null;
  const rows = treeRows(items, match);
  if (filtered && rows.length === 0)
    return (
      <p className="text-muted-foreground">
        No items match.{' '}
        <Link to="/" search={{}} className="underline">Clear filters</Link>
      </p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {['ID', 'Type', 'Title', 'Status', 'Blocked by'].map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ item: i, depth, matched }) => (
          <TableRow key={i.id} className={cn(!matched && 'text-muted-foreground')}>
            <TableCell>#{i.id}</TableCell>
            <TableCell>{i.type}</TableCell>
            <TableCell style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}>
              <Link to="/items/$id" params={{ id: String(i.id) }} className="hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">{i.title}</Link>
            </TableCell>
            <TableCell><StatusBadge status={i.status} /></TableCell>
            <TableCell>{i.open_deps || '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
