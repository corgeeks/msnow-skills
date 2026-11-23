# Implementation Log

## 2026-11-22T23:58:00 - Run detail and gates views

**Status**: Completed

**Summary**: Replaced the `/runs/$id` and `/gates` shells with read-only live views: run header card, node timeline, shared `GateCard` with selectable approve/reject commands, and a Live activity panel (newest first, capped at 200).

**Changes Made**:
- `factory/ui/src/routes/runs.$id.tsx` - Modified: run detail page, "Run not found" for bad id/404
- `factory/ui/src/routes/gates.tsx` - Modified: Open (oldest first) / Recently closed (first 20) with item+run links
- `factory/ui/src/components/runs/{gate-card,node-timeline,activity-panel}.tsx` - Created

**Notes**: Browser-checked on ui-seed (port 7317): R2 header/PR anchor/timeline order, activity filtered (no R4 lines) and holds at 200; R1/R3/R4 gates; not-found for 999999 and x; live approve of g4 updates /gates and /runs/4 in two tabs without reload; seed restart restores g4 open and resumes activity. `routeTree.gen.ts` unchanged; no `method:`/clipboard in ui/src. `npm test` hangs in `src/daemon/lifecycle.test.ts` (not touched by this task); every other test file passes (78/78).

---

## 2026-11-22T23:55:00 - Work-item tree and item detail views

**Status**: Completed

**Summary**: Replaced the `/` and `/items/$id` shells. `/` has hand-written `validateSearch`, URL-only filters (native selects plus `Input`), a tree that keeps ancestors (non-matching ones muted), and live refetch. `/items/$id` has the header, a definition list, a plain-text body, deps/dependents/children lists, a runs table, and "Item not found" handling.

**Changes Made**:
- `factory/ui/src/routes/index.tsx` - Modified: search validation, filters, loading and error states
- `factory/ui/src/routes/items.$id.tsx` - Modified: item detail
- `factory/ui/src/components/items/item-tree.tsx` - Created: tree build, filter, and table
- `factory/ui/src/components/items/item-list.tsx` - Created: `#id` + link + badge list

**Notes**: Browser-checked on ui-seed: nesting and indent; the status, type, `#id`, text, and bogus-status filters; `?q=42` shows "No items match"; select changes use replace (history length unchanged); live item create and t2→done (t3 Blocked by → `—`); detail pages for t2, b1, and grp; 404 and `abc`; the reopen refetch drops "Live item". `routeTree.gen.ts` is unchanged, and `app-sidebar.tsx` needed no change. The shared headless Chromium sometimes stalled `goto` on this host, apparently from the per-host connection limit with SSE tabs open. A fresh tab fixed it, so the cause is the environment, not the app.

---

## 2026-11-22T23:45:00 - UI scaffold, design system, and data layer

**Status**: Completed

**Summary**: Created `factory/ui` (Vite 8, React 19, Tailwind v4, shadcn base-nova, TanStack file routing) with sidebar layout, route shells, typed GET data layer, shared-EventSource hooks, StatusBadge/format helpers, the `build:ui` script, root shadcn MCP entry, and the `factory/test/ui-seed.ts` dev seed server.

**Changes Made**:
- `factory/ui/package.json`, `package-lock.json` - Created: devDependencies-only package
- `factory/ui/vite.config.ts`, `tsconfig.json`, `components.json`, `index.html` - Created: toolchain, theme script
- `factory/ui/src/main.tsx`, `src/index.css`, `src/routeTree.gen.ts` - Created
- `factory/ui/src/routes/{__root,index,items.$id,runs.$id,gates}.tsx` - Created: layout + shells
- `factory/ui/src/components/ui/**`, `src/hooks/use-mobile.ts`, `src/lib/utils.ts` - Created: shadcn generated
- `factory/ui/src/components/{app-sidebar,status-badge}.tsx` - Created
- `factory/ui/src/lib/{api,events,format}.ts` - Created: data layer
- `factory/package.json` - Modified: `build:ui` script
- `.mcp.json` - Created: shadcn MCP with `cwd: factory/ui`
- `factory/test/ui-seed.ts` - Created: seed server

**Notes**: shadcn CLI 4.x has no `base-nova` preset name; `init -t vite -b base -p nova` yields `style: "base-nova"`. Init also added `@fontsource-variable/geist` (moved to devDependencies with the rest). Root layout wraps in `TooltipProvider` (required by sidebar tooltips). Browser-checked on the seed: sidebar active state, hard refresh of /gates and /items/1, not-found, dark mode follows OS. `/events` opens lazily, so shells make no request until views use `useResource`. `npm test` failures were only in sibling-owned `src/cli/main.test.ts` and `src/daemon/forge.test.ts`; MCP session check not run from this agent.

---
