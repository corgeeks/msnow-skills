# L1 · sf4 — Read-only UI

> Child of umbrella **software-factory** (`../software-factory/PRD.md`). It builds on the **sf0** contracts (`../sf0-factory-core/PRD.md`): the HTTP API, `/events` SSE with `event: activity` frames, and static serving of `factory/ui/dist`.

## Objective

A read-only web UI served by the daemon. It shows:
- the work-item tree, nested by parent and filterable by type and status;
- item detail;
- run detail, with node rows, cost, gates, and a **live activity** feed;
- the list of open gates.

It updates live over SSE. It is a shadcn/ui + Tailwind v4 + TanStack Router (file-based) React app built by Vite into static files.

**Done when:**
- `npm run build:ui --prefix factory` produces `factory/ui/dist`.
- `npm --prefix factory/ui run typecheck` passes.
- With a daemon running and seeded with items, runs, and gates, every route renders real data. A new item, or a gate decision made through the CLI, appears without a reload, and deep links work after a hard refresh. This is verified in a real browser.

## Motivation

You asked for enterprise-tracker-style organization and review. v0 lays the foundation (layout, routing, data and SSE plumbing, a design system) in read-only form. sf7 then adds the review UI and inbox (diffs, the DAG view, approve and reject) on the same foundation without rework.

## Implementation Details

### Architecture

#### Package and toolchain (`factory/ui/`, its own private package)

- **devDependencies only**, because the output is static:
  - `vite@^8`, `@vitejs/plugin-react`, `typescript`, `@types/react`, `@types/react-dom`, `@types/node`;
  - `react@^19`, `react-dom@^19`;
  - `tailwindcss@^4`, `@tailwindcss/vite`;
  - `@tanstack/react-router`, `@tanstack/router-plugin`;
  - whatever `shadcn init` and `shadcn add` install (expected: `@base-ui/react`, `class-variance-authority`, `lucide-react`, `cn`, `tw-animate-css`, `shadcn`).
- **Package manager**: npm. `factory/ui/package-lock.json` is committed.
- **`factory/package.json`** gains `"build:ui": "npm --prefix ui ci && npm --prefix ui run build"`. The daemon package itself stays dependency-free.
- **`vite.config.ts`**: plugins are `tanstackRouter({ target: 'react', autoCodeSplitting: true })` **before** `react()`, then `tailwindcss()`. Alias `@` → `./src`. The dev server proxies `/api` and `/events` to `http://127.0.0.1:7317`.
- **shadcn**:
  - `npx shadcn@latest init` is run inside `factory/ui`, using the default style (`base-nova`), `rsc: false`, and `tailwind.config: ""`. `components.json` is committed.
  - Components are added with `npx shadcn@latest add …` as needed (expected: `badge`, `card`, `table`, `tabs`, `separator`, `scroll-area`, `skeleton`, `tooltip`, `sidebar`).
  - **shadcn MCP**: register it once for agents via `npx shadcn@latest mcp init --client claude`, run from `factory/ui`. That writes `.mcp.json` there, and omp reads root and project `.mcp.json` as a fallback. Move or copy the entry to the repo-root `.mcp.json` so sessions started at the repo root see it. Server: `npx shadcn@latest mcp` (stdio; the working directory must be `factory/ui`, so set `"cwd": "factory/ui"`).
- **Routing**: TanStack Router file-based routes in `src/routes/`. The generated `src/routeTree.gen.ts` is committed. History is the default browser history; the Navigation API is not used directly. The routes are:

| Route | View |
|---|---|
| `/` | Work-item tree. Items nest by `parent_id`. Search params `type`, `status`, and `q` are validated with `validateSearch`, which is hand-written (no zod dependency). Each row shows `#id`, type, title, a status badge, and the blocked-by count. |
| `/items/$id` | Item header, body (rendered as plain text, preserving whitespace), deps and dependents, children, and the runs table |
| `/runs/$id` | Run header (attempt, status, branch, a PR link built from `run.pr_url`, cost); a node timeline (node, iteration, status, model, cost, duration); gates with question, recommendation, and decision; a **live activity** panel showing transient `activity` frames for this run, keeping the last 200 in memory |
| `/gates` | Open gates first, then recently closed ones. v0 shows the `factory approve <id>` / `factory reject <id>` command to copy; there are no buttons. |

- **Data layer** (no extra library):
  - `src/lib/api.ts` holds typed `fetch` wrappers for the sf0 endpoints. Types come from `factory/src/shared/types.ts` (from `factory/ui/src/lib/` that is `../../../src/shared/types.ts`) via `import type`, so the shared contract has one source. Lists arrive as bare arrays. The tree's blocked-by count is `ItemSummary.open_deps`.
  - `src/lib/events.ts` holds one shared `EventSource('/events')`. Each `useResource(url, { refetchOn: EventType[] })` hook refetches its resource when a matching persisted event arrives. `useActivity(runId)` collects `activity` frames.
  - Reconnects use the browser's automatic retry. After the connection reopens, the UI refetches the visible resources, which covers anything missed during a daemon restart.
- **Look**: a shadcn sidebar layout with *Work items* and *Gates* in the sidebar. Status badges use one color per `ItemStatus` and `RunStatus`. Light and dark follow the OS (`prefers-color-scheme`). Accessibility basics apply: semantic tables, labelled controls, and focus styles from shadcn.

### Constraints

- **Read-only.** No `POST`, `PATCH`, or other mutation from the UI in v0.
- Import shared types with `import type` only. The UI bundle never imports daemon runtime code.
- `factory/ui/tsconfig.json` is separate from the daemon's: DOM lib, `jsx: react-jsx`, `moduleResolution: bundler`, and the `@/*` path alias. `typecheck` runs `tsc -b --noEmit` or the equivalent.
- `dist/` is gitignored, and the daemon serves it. Asset URLs stay at base `/`.
- The UI has no unit-test framework in v0. Verification is the build, the typecheck, and the browser check in Acceptance.

### Relevant Guides

- `research.yaml` (this PRD): shadcn on Vite with Tailwind v4, the shadcn MCP plus omp MCP config, and TanStack Router plus the Navigation API
- https://ui.shadcn.com/docs/installation/vite
- https://ui.shadcn.com/docs/mcp
- https://tanstack.com/router/latest/docs/installation/with-vite
- https://vite.dev/guide/build
- sf0 PRD: HTTP API and SSE frame format

### Relevant Files

- `factory/ui/**` - (Create) the app: `package.json`, `vite.config.ts`, `tsconfig*.json`, `components.json`, `index.html`, `src/{main.tsx,index.css,routeTree.gen.ts}`, `src/routes/**`, `src/components/**`, `src/lib/{api,events,utils}.ts`
- `factory/package.json` - (Edit) the `build:ui` script
- `.mcp.json` - (Create) shadcn MCP registration for agent sessions
- `factory/src/shared/types.ts` - (Review) shared types

## Discussion

### UI foundation

_Untitled UI, plain CSS, or another kit? Which router?_

shadcn/ui, which provides its own MCP when installed. TanStack Router rather than react-router. You noted the Location API is standardized. Research found that the newer **Navigation API** reached Baseline "newly available" in early 2026, and that TanStack Router uses the History API, not the Navigation API.

### UI package layout

_The shadcn CLI and Vite expect the UI app to have its own `package.json`, but we chose a single `package.json`. Which layout?_

`factory/ui` is its own small private package with devDependencies only, built by `npm run build:ui` from `factory/`. No npm workspaces.

### Smaller defaults

_TanStack file-based routes, the shadcn default style, npm, and no direct use of the Navigation API?_

Accepted.
