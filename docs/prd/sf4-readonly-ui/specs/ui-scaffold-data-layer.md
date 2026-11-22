# UI scaffold, design system, and data layer

## Objective

Create `factory/ui/`, a private devDependencies-only package with Vite 8, React 19, Tailwind v4, shadcn/ui (`base-nova`), and TanStack Router file-based routing. It contains:

- the root layout with a shadcn sidebar (*Work items*, *Gates*);
- `src/lib/api.ts`, typed GET wrappers whose types come from `factory/src/shared/types.ts`;
- `src/lib/events.ts`, which shares one `EventSource` and exposes `useResource` and `useActivity`;
- `StatusBadge` and the format helpers;
- one route shell per route.

It also adds the `build:ui` script, the shadcn MCP registration in the repo-root `.mcp.json`, and the dev seed server `factory/test/ui-seed.ts` that every UI task uses for its browser check.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5`. The toolchain setup is fully specified. The only subtle part is the SSE hook semantics, and they are given below.

## Context

sf4 is the read-only v0 UI that the daemon serves from `factory/ui/dist` (sf0 static serving with SPA fallback). This task lays the foundation that the two view tasks build on in parallel, and sf7 later adds review features on the same base. When it is done, every route renders its page heading inside the sidebar layout, and the data layer is ready for the views.

### Parent PRD

- **PRD**: sf4-readonly-ui
- **PRD Path**: `docs/prd/sf4-readonly-ui/PRD.md`. Architecture → Package and toolchain, Routing, Data layer, and Look are normative. `research.yaml` holds the verified shadcn, MCP, and TanStack facts.

### Related Tasks

- **Depends on**: all of sf0, through these pieces:
  - `factory/src/shared/types.ts`: `WorkItem`, `ItemSummary`, `ItemDetail`, `Run` (with `pr_url`), `RunDetail`, `NodeRun`, `Gate`, `Activity`, `EventType`, `BatchItem`, and the status unions;
  - `factory/src/daemon/http.ts`: `createApiServer({ store, bus, uiDir })`, `/events` with `event: activity` frames that carry no `id:` line;
  - `store.ts`, `bus.ts`, and `db.ts`, which the seed server uses;
  - `factory/package.json`.
- **Blocks**: "Work-item tree and item detail views" and "Run detail and gates views". Those two run in parallel and depend only on the exports listed in Code Examples. The items task owns `src/routes/index.tsx` and `src/routes/items.$id.tsx`; the runs task owns `src/routes/runs.$id.tsx` and `src/routes/gates.tsx`.

## Acceptance Criteria

- [ ] `factory/ui/package.json`:
  - `"private": true`, `"type": "module"`, scripts `dev: vite`, `build: vite build`, `preview: vite preview`, and `typecheck: tsc --noEmit -p tsconfig.json`.
  - **No `dependencies` key.** Everything goes in `devDependencies`: `vite@^8`, `@vitejs/plugin-react`, `typescript`, `@types/react`, `@types/react-dom`, `@types/node`, `react@^19`, `react-dom@^19`, `tailwindcss@^4`, `@tailwindcss/vite`, `@tanstack/react-router`, `@tanstack/router-plugin`, plus whatever shadcn installs (expected: `@base-ui/react`, `class-variance-authority`, `lucide-react`, `cn`, `tw-animate-css`, `shadcn`). shadcn writes into `dependencies`, so move those entries to `devDependencies` and re-run `npm install`.
- [ ] `factory/ui/package-lock.json` is committed, and `npm --prefix factory/ui ci` succeeds from a clean checkout.
- [ ] `factory/package.json` gains `"build:ui": "npm --prefix ui ci && npm --prefix ui run build"`. The daemon package's `dependencies` stay empty.
- [ ] `vite.config.ts` lists plugins in exactly this order: `tanstackRouter({ target: 'react', autoCodeSplitting: true })`, `react()`, `tailwindcss()`. It sets alias `@` → `<ui>/src` and dev `server.proxy` for `/api` and `/events` → `http://127.0.0.1:7317`. There is no `base` option, so assets stay at `/`.
- [ ] `tsconfig.json` (one file; the app and `vite.config.ts` together) has:
  - `noEmit`, `strict`, `target: ES2022`, `lib: ["ES2023","DOM","DOM.Iterable"]`, `module: ESNext`, `moduleResolution: bundler`, `jsx: react-jsx`;
  - `verbatimModuleSyntax`, `allowImportingTsExtensions`, `types: ["vite/client","node"]`;
  - `paths: {"@/*": ["./src/*"]}`, `include: ["src", "vite.config.ts"]`.
- [ ] `components.json` is committed with `style: "base-nova"`, `rsc: false`, `tsx: true`, `tailwind.config: ""`, `tailwind.css: "src/index.css"`, `cssVariables: true`, and the default `@/…` aliases.
- [ ] shadcn components exist under `src/components/ui/`: `badge`, `card`, `table`, `tabs`, `separator`, `scroll-area`, `skeleton`, `tooltip`, `sidebar`, and `input`. `sidebar` pulls in `button`, `sheet`, and `use-mobile`. The view tasks do **not** run `shadcn add` or `npm install`, so this list is final for v0.
- [ ] Repo-root `.mcp.json` contains `mcpServers.shadcn = {"command":"npx","args":["shadcn@latest","mcp"],"cwd":"factory/ui"}`. The `factory/ui/.mcp.json` written by `mcp init` is removed (moved, not copied).
- [ ] `src/routes/__root.tsx` renders `SidebarProvider` → `AppSidebar` + `SidebarInset` (a header with `SidebarTrigger`, then `<main>` with `<Outlet/>`). It also defines a `notFoundComponent`.
- [ ] `src/components/app-sidebar.tsx` has two links, *Work items* (`/`) and *Gates* (`/gates`), rendered through `SidebarMenuButton` with a TanStack `Link`. *Work items* is active on `/`, `/items/*`, and `/runs/*`; *Gates* is active on `/gates`.
- [ ] Route shells exist: `index.tsx`, `items.$id.tsx`, `runs.$id.tsx`, and `gates.tsx`. Each one is `createFileRoute(<path>)({ component })` and renders only an `<h1>` page title; the view tasks replace those components. `src/routeTree.gen.ts` is generated by the build and committed.
- [ ] Theme: an inline script in `index.html` toggles the `dark` class on `<html>` from `matchMedia('(prefers-color-scheme: dark)')`, both at load and on `change`.
- [ ] `src/lib/api.ts`, `src/lib/events.ts`, `src/lib/format.ts`, and `src/components/status-badge.tsx` export exactly the signatures in Code Examples.
- [ ] The UI never mutates anything. `rg -n "method\s*:" factory/ui/src` matches nothing, and `fetchJson` is the only `fetch` call in `src/` (excluding `src/components/ui`).
- [ ] `factory/test/ui-seed.ts` behaves as described in Testing Requirements.
- [ ] `npm run build:ui --prefix factory` produces `factory/ui/dist/index.html`, and `npm --prefix factory/ui run typecheck` passes.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/ui/package.json`, `package-lock.json` | Create | Package and lockfile |
| `factory/ui/vite.config.ts`, `tsconfig.json`, `components.json`, `index.html` | Create | Toolchain |
| `factory/ui/src/main.tsx`, `src/index.css` | Create | Router bootstrap; Tailwind and shadcn CSS (generated by init) |
| `factory/ui/src/routes/{__root,index,items.$id,runs.$id,gates}.tsx` | Create | Layout and route shells |
| `factory/ui/src/routeTree.gen.ts` | Create | Generated by the router plugin, committed |
| `factory/ui/src/components/ui/**`, `src/hooks/use-mobile.ts`, `src/lib/utils.ts` | Create | Generated by shadcn |
| `factory/ui/src/components/app-sidebar.tsx`, `status-badge.tsx` | Create | Sidebar and status badge |
| `factory/ui/src/lib/{api,events,format}.ts` | Create | Data layer and formatting |
| `factory/package.json` | Edit | `build:ui` script |
| `.mcp.json` | Create | shadcn MCP for agent sessions at the repo root |
| `factory/test/ui-seed.ts` | Create | Dev seed server for browser checks |

### Technical Constraints

- Setup order, all run from `factory/ui`:
  1. Write `package.json` and run `npm i -D` with the packages above.
  2. Write `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/index.css` (`@import "tailwindcss";`), and `__root.tsx`.
  3. `npx shadcn@latest init`: accept the defaults (`base-nova`, `neutral`), then check `components.json`.
  4. `npx shadcn@latest add badge card table tabs separator scroll-area skeleton tooltip sidebar input`.
  5. `npx shadcn@latest mcp init --client claude`, then move the entry to the root `.mcp.json` and add `cwd`.
  6. Move `dependencies` to `devDependencies`, then `npm install`.
  7. Write the lib, components, and routes, then `npm run build`.
- `base-nova` components are built on Base UI. Compose them with the `render` prop (for example `<SidebarMenuButton render={<Link to="/gates" />} isActive={…}>`), not `asChild`. Check the generated `sidebar.tsx` for the exact props.
- Use `import.meta.dirname` in `vite.config.ts` (not `__dirname`).
- **Shared types**: `api.ts` imports them with `import type { … } from '../../../src/shared/types.ts'` (that is `factory/src/shared/types.ts`) and re-exports them with `export type`, so views import every domain type from `@/lib/api`. Never import a value from `types.ts` (including `ITEM_STATUSES`). The PRD allows `import type` only, so `status-badge.tsx` defines the UI's status lists, typed exhaustively with `Record<…>`.
- **Response shapes** are pinned by the sf0 HTTP table. Lists are bare arrays, nested collections are full objects, and `ItemSummary`, `ItemDetail`, and `RunDetail` come from `types.ts`. Do not redefine them in the UI, and do not add or change daemon endpoints.
- **One `EventSource`**, created lazily on first use, for the whole app. Reconnecting relies on the browser's retry (the daemon sends `retry: 3000`), and `Last-Event-ID` is sent automatically. Known v0 ceiling: under `vite dev`, the proxy answers 5xx when the daemon is down, which closes the stream for good until a reload. The production path served by the daemon is unaffected.
- **Refetch-on-reopen**: every `useResource` also refetches on the source's `open` event. This covers a daemon restart, and it covers the gap between the first fetch and the first `open`.
- `factory/.gitignore` already ignores `node_modules/` and `ui/dist/`. If the build leaves other untracked tool output, add it to `factory/ui/.gitignore`.

### Relevant Code References

- `docs/prd/sf4-readonly-ui/research.yaml`: `components.json` shape, base-nova dependencies, MCP clients, and the omp `.mcp.json` fallback with `cwd`
- `docs/prd/sf0-factory-core/specs/http-api-sse.md`: route table, SSE frame format, activity frames, and static serving
- `docs/prd/sf0-factory-core/specs/scaffold-config-types.md`: the `types.ts` contract
- `factory/src/daemon/{db,bus,store,http}.ts`: used by the seed server (read `store.ts` for the exact `createRun`, `createNodeRun`, `openGate`, and `decideGate` arguments)

### Code Examples

```ts
// src/lib/api.ts — GET only
import type { WorkItem, ItemSummary, ItemDetail, Run, RunDetail, NodeRun, Gate, Activity, EventType, ItemStatus, RunStatus, NodeStatus } from '../../../src/shared/types.ts';
export type { WorkItem, ItemSummary, ItemDetail, Run, RunDetail, NodeRun, Gate, Activity, EventType, ItemStatus, RunStatus, NodeStatus };
// ItemSummary = WorkItem & { open_deps }; ItemDetail = { item, deps, dependents, children, runs }; RunDetail = { run, node_runs, gates }
export type Path<T> = string & { readonly __response: T }; // phantom: ties a URL to its response type
const path = <T>(p: string) => p as Path<T>;
export const api = {
  items: () => path<ItemSummary[]>('/api/items'),
  item: (id: number) => path<ItemDetail>(`/api/items/${id}`),
  runs: () => path<Run[]>('/api/runs'),
  run: (id: number) => path<RunDetail>(`/api/runs/${id}`),
  gates: () => path<Gate[]>('/api/gates'), // open first, then closed by closed_at desc (server limit 100)
};
export class ApiError extends Error { status: number; code: string; /* assigned in constructor; no parameter properties */ }
export async function fetchJson<T>(url: Path<T>, signal?: AbortSignal): Promise<T>; // throws ApiError using {error:{code,message}}
```

```ts
// src/lib/events.ts
let source: EventSource | undefined;
const events = () => (source ??= new EventSource('/events'));
export const ACTIVITY_LIMIT = 200;

export function useResource<T>(url: Path<T> | null, { refetchOn }: { refetchOn: EventType[] }): { data?: T; error?: Error } {
  const [state, setState] = useState<{ url?: string; data?: T; error?: Error }>({});
  const [tick, setTick] = useState(0);
  const types = refetchOn.join(' ');
  useEffect(() => {
    const es = events(), bump = () => setTick((t) => t + 1), names = [...types.split(' '), 'open'];
    names.forEach((n) => es.addEventListener(n, bump));
    return () => names.forEach((n) => es.removeEventListener(n, bump));
  }, [types]);
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    fetchJson(url, ac.signal).then(
      (data) => setState({ url, data }),
      (error: Error) => { if (!ac.signal.aborted) setState((s) => ({ url, data: s.url === url ? s.data : undefined, error })); });
    return () => ac.abort(); // a newer event supersedes an in-flight fetch
  }, [url, tick]);
  return state.url === url ? { data: state.data, error: state.error } : {}; // no stale data across URLs
}

export function useActivity(runId: number): Activity[]; // only this run's `activity` frames since mount, oldest→newest, capped to the last ACTIVITY_LIMIT
```

```ts
// src/lib/format.ts
export function formatCost(usd: number): string;                                   // "$0.42"
export function formatTime(iso: string | null): string;                            // toLocaleString(), "—" when null
export function formatDuration(start: string | null, end: string | null): string;  // "—" without start; open end = now; "1h 02m" | "3m 05s" | "12s"
// src/components/status-badge.tsx
export const ITEM_STATUSES: ItemStatus[]; // Object.keys of a Record<ItemStatus, true>, in schema order
export function StatusBadge(props: { status: ItemStatus | RunStatus | NodeStatus }): JSX.Element;
// one Tailwind class set per status in a Record<ItemStatus | RunStatus | NodeStatus, string>, readable in light and dark:
// draft slate, ready sky, queued violet, active/running blue, paused amber, blocked/failed red, done/completed emerald, cancelled zinc, skipped stone, pending slate
```

## Testing Requirements

There is no unit-test framework in the UI (PRD constraint). Verify with the build, the typecheck, and a real browser.

- [ ] `npm run build:ui --prefix factory` succeeds and creates `factory/ui/dist/index.html` with assets under `/assets/`. `npm --prefix factory/ui run typecheck` passes. `git status` shows `routeTree.gen.ts` and `package-lock.json` as tracked, and nothing under `dist/`.
- [ ] `factory/test/ui-seed.ts` (run as `node factory/test/ui-seed.ts [--port 7317] [--activity-ms 250]` from the repo root; argv parsed with `node:util` `parseArgs`):
  1. Opens a fresh DB in `fs.mkdtempSync`.
  2. Creates the bus and store, then `createApiServer({ store, bus, uiDir: <repo>/factory/ui/dist })`, and listens on `127.0.0.1:<port>`.
  3. Creates the items **through the API** with one `POST /api/items/batch` whose body is `{items: BatchItem[]}`, with `status` set per item. It reads the `BatchResult.ids` map. The items are:
     - `prd` "Demo PRD" (active);
     - `group` "Views" under it (active);
     - tasks under the group: t1 "Scaffold" (done), t2 "Items view" (active, deps t1), t3 "Runs view" (queued, deps t2), t4 "Flaky test" (blocked, deps t1), t5 "Docs" (active, deps t1);
     - a root `bug` b1 (draft) whose body contains indented lines and blank lines.
  4. Creates runs, node runs, and gates **through the store**, because sf0 has no HTTP endpoints for them:
     - R1 on t1: completed, PR 11 (`pr_url` `https://github.com/corgeeks/msnow-skills/pull/11`), nodes build/test/review/pr all completed, merge gate closed with `approve` and note "lgtm";
     - R2 on t2: running, branch `factory/<t2>-1`, PR 12 with a matching `pr_url`, nodes build#1 completed (`anthropic/claude-sonnet-5-5`, $0.30), test#1 failed, build#2 running;
     - R3 on t4: paused, build#1–#3 failed, open `failure` gate with a question and a recommendation;
     - R4 on t5: running, PR 14 with a matching `pr_url`, nodes through `pr` completed, open `merge` gate.
  5. Prints one JSON line with every id, keyed `prd, grp, t1…t5, b1, R1…R4, g1, g3, g4` (gate `gN` belongs to run `RN`; g3 is opened before g4). It then publishes activity every `--activity-ms`: `{run_id: R2, node: 'build', text: 'read src/file-<n>.ts'}`, and every 5th line goes to R4 instead.
  6. On SIGINT it closes the server and DB, removes the temp dir, and exits 0.
- [ ] Browser check: run `npm run build:ui --prefix factory`, then `node factory/test/ui-seed.ts`, then open `http://127.0.0.1:7317/`.
  - The sidebar shows both links, and the active state follows navigation.
  - Hard-refreshing `/gates` and `/items/1` renders the layout, not a 404.
  - `/nope/x` shows the not-found component.
  - Dark mode follows the OS setting (toggle emulation in devtools).
  - The Network panel shows exactly one `/events` request.
- [ ] Dev path: with the seed running, `npm --prefix factory/ui run dev` serves at `:5173`, and `/api/health` plus `/events` work through the proxy.
- [ ] MCP: an omp session started at the repo root lists the `shadcn` server tools, and `get_project_registries` returns `@shadcn`, which proves `cwd: factory/ui` took effect.

## Out of Scope

- The real page content of `/`, `/items/$id`, `/runs/$id`, and `/gates`, plus filters and tables: "Work-item tree and item detail views" and "Run detail and gates views"
- Any mutation, approve/reject button, diff, DAG view, or inbox (sf7)
- Daemon changes: new endpoints, response envelopes, or SSE behaviour (sf0)
- A UI test framework, zod or another validation library, a data-fetching library, or a theme toggle
- The CLI (sf3), including gate decisions made through `factory approve`
