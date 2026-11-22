import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/runs/$id')({ component: Page });

function Page() {
  return <h1 className="text-2xl font-semibold">Run</h1>;
}
