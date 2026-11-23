import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime } from '@/lib/format';
import type { GateWithPr } from '@/lib/api';

const DECISION = {
  approve: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
  reject: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  override: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
  open: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
};

export function GateCard({ gate, context }: { gate: GateWithPr; context?: ReactNode }) {
  const label = gate.closed_at === null ? 'open' : gate.decision ?? 'open';
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>Gate #{gate.id}</span>
          <Badge variant="outline" className={`border-transparent ${DECISION[label]}`}>{label}</Badge>
          <span className="text-muted-foreground text-sm font-normal">{gate.kind} · {gate.node}</span>
        </CardTitle>
        {context && <div className="text-muted-foreground text-sm">{context}</div>}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="whitespace-pre-wrap break-words">{gate.question}</p>
        {gate.pr_url && (
          <p className="break-all"><span className="font-medium">Pull request:</span>{' '}
            <a href={gate.pr_url} target="_blank" rel="noreferrer" className="underline">{gate.pr_number === null ? gate.pr_url : `PR #${gate.pr_number}`}</a>
          </p>
        )}
        {gate.recommendation && <p className="whitespace-pre-wrap"><span className="font-medium">Recommendation:</span> {gate.recommendation}</p>}
        <p className="text-muted-foreground">
          Opened {formatTime(gate.opened_at)}
          {gate.closed_at !== null && <> · closed {formatTime(gate.closed_at)}</>}
        </p>
        {gate.closed_at !== null && gate.note && <p><span className="font-medium">Note:</span> {gate.note}</p>}
        {gate.closed_at === null && (
          <div className="flex flex-col gap-1">
            <code className="select-all bg-muted rounded px-2 py-1 font-mono">factory approve {gate.id}</code>
            <code className="select-all bg-muted rounded px-2 py-1 font-mono">factory reject {gate.id}</code>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
