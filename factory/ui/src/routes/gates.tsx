import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/gates')({ component: Page });

function Page() {
  return <h1 className="text-2xl font-semibold">Gates</h1>;
}
