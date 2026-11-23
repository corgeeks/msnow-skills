import { Link, useRouterState } from '@tanstack/react-router';
import { Factory, ListTree, ShieldCheck } from 'lucide-react';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar';

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const gates = pathname === '/gates';
  const items = pathname === '/' || pathname.startsWith('/items/') || pathname.startsWith('/runs/');
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1 font-semibold"><Factory className="size-4" />Factory</div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/" />} isActive={items}><ListTree />Work items</SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/gates" />} isActive={gates}><ShieldCheck />Gates</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
