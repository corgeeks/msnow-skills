import { Link, Outlet, createRootRoute } from '@tanstack/react-router';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';

export const Route = createRootRoute({ component: RootLayout, notFoundComponent: NotFound });

function RootLayout() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-12 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4" />
            <span className="text-sm text-muted-foreground">Software factory</span>
          </header>
          <main className="flex-1 p-6"><Outlet /></main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function NotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-muted-foreground">Nothing lives at this address. <Link to="/" className="underline">Back to work items</Link></p>
    </div>
  );
}
