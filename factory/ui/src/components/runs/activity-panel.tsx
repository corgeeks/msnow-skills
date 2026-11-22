import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useActivity } from '@/lib/events';
import { formatTime } from '@/lib/format';

export function ActivityPanel({ runId }: { runId: number }) {
  const lines = useActivity(runId);
  return (
    <Card>
      <CardHeader><CardTitle><h2>Live activity ({lines.length})</h2></CardTitle></CardHeader>
      <CardContent>
        <ScrollArea className="h-80">
          {lines.length === 0 && <p className="text-muted-foreground text-sm">Waiting for activity…</p>}
          <ol aria-live="polite" className="space-y-0.5 text-xs">
            {[...lines].reverse().map((a, i) => (
              <li key={`${a.at}-${lines.length - i}`} className="flex gap-2">
                <span className="text-muted-foreground shrink-0">{formatTime(a.at)}</span>
                <span className="shrink-0 font-medium">{a.node}</span>
                <span className="font-mono break-all">{a.text}</span>
              </li>
            ))}
          </ol>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
