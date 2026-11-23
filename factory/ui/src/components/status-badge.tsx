import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ItemStatus, NodeStatus, RunStatus } from '@/lib/api';

const ITEM: Record<ItemStatus, true> = { draft: true, ready: true, queued: true, active: true, blocked: true, done: true, cancelled: true };
export const ITEM_STATUSES = Object.keys(ITEM) as ItemStatus[];

const COLORS: Record<ItemStatus | RunStatus | NodeStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  pending: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  ready: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
  queued: 'bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200',
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  blocked: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
  cancelled: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  skipped: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
};

export function StatusBadge({ status }: { status: ItemStatus | RunStatus | NodeStatus }) {
  return <Badge variant="outline" className={cn('border-transparent', COLORS[status])}>{status}</Badge>;
}
