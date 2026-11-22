import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: Page });

function Page() {
  return <h1 className="text-2xl font-semibold">Work items</h1>;
}
