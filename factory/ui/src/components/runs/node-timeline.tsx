import { Fragment } from 'react';
import { StatusBadge } from '@/components/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCost, formatDuration } from '@/lib/format';
import type { NodeRun } from '@/lib/api';

export function NodeTimeline({ nodes }: { nodes: NodeRun[] }) {
  const rows = [...nodes].sort((a, b) => a.id - b.id);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Node</TableHead><TableHead>Iteration</TableHead><TableHead>Status</TableHead>
          <TableHead>Model</TableHead><TableHead>Cost</TableHead><TableHead>Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">No nodes yet</TableCell></TableRow>}
        {rows.map((n) => (
          <Fragment key={n.id}>
            <TableRow>
              <TableCell className="font-medium">{n.node}</TableCell>
              <TableCell>{n.iteration}</TableCell>
              <TableCell><StatusBadge status={n.status} /></TableCell>
              <TableCell>{n.model ?? '—'}</TableCell>
              <TableCell>{formatCost(n.cost_usd)}</TableCell>
              <TableCell>{formatDuration(n.started_at, n.ended_at)}</TableCell>
            </TableRow>
            {n.output && (
              <TableRow>
                <TableCell colSpan={6} className="whitespace-normal">
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">Output</summary>
                    <pre className="whitespace-pre-wrap font-mono text-xs">{n.output}</pre>
                  </details>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
