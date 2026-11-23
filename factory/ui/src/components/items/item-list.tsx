import { Link } from '@tanstack/react-router';
import type { WorkItem } from '@/lib/api';
import { StatusBadge } from '@/components/status-badge';

export function ItemList({ title, items }: { title: string; items: WorkItem[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {items.length === 0 ? (
        <p className="text-muted-foreground">None</p>
      ) : (
        <ul className="space-y-1">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-2">
              <span className="text-muted-foreground">#{i.id}</span>
              <Link to="/items/$id" params={{ id: String(i.id) }} className="hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">{i.title}</Link>
              <StatusBadge status={i.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
