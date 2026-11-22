import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/items/$id')({ component: Page });

function Page() {
  return <h1 className="text-2xl font-semibold">Work item</h1>;
}
