# Run detail and gates views

## Objective

Replace the scaffold's shells for `/runs/$id` and `/gates` with the real read-only views:

- **`/runs/$id`**: the run header, the node timeline, the run's gates, and a **live activity** panel that holds this run's transient `activity` frames, keeping the last 200.
- **`/gates`**: open gates first, then recently closed ones. Each open gate shows the `factory approve <id>` / `factory reject <id>` command to copy, and there are no buttons.

Both views update live over SSE without a reload.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5`. This is view code on a fixed data layer. Activity collection is already implemented by `useActivity`.

## Context

In v0 the human decides gates through the CLI (sf3 `factory approve|reject`). The UI's job is to show what is waiting, why, and what is happening right now. Activity frames come from the session runner (sf1), which sf5 forwards to `bus.publishActivity`. They are never persisted and never replayed, so the panel shows only lines that arrive while the page is open.

### Parent PRD

- **PRD**: sf4-readonly-ui
- **PRD Path**: `docs/prd/sf4-readonly-ui/PRD.md`. The Routing table rows for `/runs/$id` and `/gates`, plus Look and Constraints, are normative.

### Related Tasks

- **Depends on**: "UI scaffold, design system, and data layer". This task relies on these exact exports:
  - `@/lib/api`: `api.run(id: number): Path<RunDetail>` (`RunDetail` = `{ run: Run; node_runs: NodeRun[]; gates: Gate[] }`), `api.item(id): Path<ItemDetail>` (`{ item, deps, dependents, children, runs }`), `api.items(): Path<ItemSummary[]>`, `api.runs(): Path<Run[]>`, `api.gates(): Path<Gate[]>` (all gates: open first, then closed by `closed_at` desc, server limit 100), `ApiError`, and the re-exported domain types. All of these come from sf0 `types.ts`, and `Run` includes `pr_url`;
  - `@/lib/events`: `useResource<T>(url: Path<T> | null, { refetchOn: EventType[] }): { data?: T; error?: Error }` and `useActivity(runId: number): Activity[]` (only this run's frames since mount, oldest to newest, capped at `ACTIVITY_LIMIT = 200`);
  - `@/lib/format`: `formatCost`, `formatTime`, `formatDuration`;
  - `@/components/status-badge`: `StatusBadge`;
  - the shadcn components (`card`, `table`, `badge`, `scroll-area`, `skeleton`, `separator`);
  - the seed server `factory/test/ui-seed.ts`.
- **Parallel sibling**: "Work-item tree and item detail views". It owns `src/routes/index.tsx`, `src/routes/items.$id.tsx`, and `src/components/items/**`. Its runs table links to `/runs/$id` with `params={{ id: String(runId) }}`, so keep that path and its param name `id`. Item links from here use `/items/$id` the same way.
- **Cross-slice**:
  - sf0 `GET /api/runs/:id`, `GET /api/runs`, `GET /api/gates`, and the SSE `event: activity` frames (no `id:`);
  - sf3 `factory approve|reject <gate-id>`, whose command text this view shows;
  - sf1 and sf5 produce the activity lines (`` `${toolName} ${summary}` ``, ≤160 chars).

## Acceptance Criteria

**`/runs/$id` (`src/routes/runs.$id.tsx`)**
- [ ] `id` is parsed with `Number`. A value that is not a positive integer, or an `ApiError` with status 404, renders "Run not found" with a link to `/`.
- [ ] Data comes from `const { data } = useResource(api.run(id), { refetchOn: ['run.updated', 'node.updated', 'gate.opened', 'gate.closed'] })`, read as `data.run`, `data.node_runs`, and `data.gates`. The item title comes from `useResource(data ? api.item(data.run.item_id) : null, { refetchOn: ['item.updated'] })` as `.item.title`.
- [ ] The header (a shadcn `Card`) shows:
  - `Run #id · attempt N` as the `<h1>`;
  - a link to the item (`#item_id title`);
  - `StatusBadge(run.status)`, `template`, `branch` (in `<code>`), and the cost (`formatCost`);
  - the PR as `<a href={run.pr_url} target="_blank" rel="noreferrer">PR #n</a>` when `pr_url` is set, `PR #n` as text when only `pr_number` is set, and `—` otherwise;
  - started, ended, and duration (`formatDuration`).
- [ ] The node timeline is a semantic `Table` with columns `Node`, `Iteration`, `Status` (`StatusBadge`), `Model`, `Cost`, and `Duration`, sorted by `node_run.id` ascending (creation order). When a node has a non-empty `output`, it is shown in a native `<details>` under the row as `<pre className="whitespace-pre-wrap">`. With no node runs, the table says "No nodes yet".
- [ ] The run's gates use the same `GateCard` as `/gates`. Every field is shown:
  - `kind`, `node`, `question`, and `recommendation` (when set);
  - `opened_at`, plus `closed_at`, the decision badge, and `note` when closed;
  - for an open gate, the copy commands.
- [ ] The **Live activity** panel is a `Card` with a `ScrollArea` (fixed height, about 20 rem). It holds `useActivity(id)` rendered **newest first**, one line each: `formatTime(at)`, `node`, then `text` in monospace.
  - An empty panel says "Waiting for activity…".
  - The heading shows the count, for example "Live activity (200)", which never exceeds 200.
  - The list is an `<ol aria-live="polite">`, so screen readers announce new lines.
- [ ] Lines for other runs never appear. `useActivity` filters by `run_id`. Don't add a second `EventSource` or filter again in the view.

**`/gates` (`src/routes/gates.tsx`)**
- [ ] Data comes from `useResource(api.gates(), { refetchOn: ['gate.opened', 'gate.closed'] })`. For context it also uses `api.runs()` (`refetchOn: ['run.created']`) and `api.items()` (`refetchOn: ['item.created', 'item.updated']`) to label each gate with its item `#id title` (a link to `/items/$id`) and its run (a link to `/runs/$id`).
- [ ] There are two sections, each with an `<h2>`:
  - **Open** (`closed_at === null`), oldest `opened_at` first. When there are none it says "No open gates".
  - **Recently closed**: the closed gates in server order (`closed_at` desc), limited to the first 20.
- [ ] `GateCard` (in `src/components/runs/gate-card.tsx`) shows, for an open gate, `factory approve <id>` and `factory reject <id>`. Each is a `<code className="select-all">` block, so one click selects it. There are no `<button>`s and no clipboard code.
- [ ] Decision badges: `approve` is emerald and `reject` is red, using the shadcn `Badge` with classes. An open gate gets an amber "open" badge.
- [ ] `npm --prefix factory/ui run typecheck` and `npm run build:ui --prefix factory` pass. `src/routeTree.gen.ts` is unchanged.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/ui/src/routes/runs.$id.tsx` | Edit | Replace the shell: run detail page |
| `factory/ui/src/routes/gates.tsx` | Edit | Replace the shell: gates page |
| `factory/ui/src/components/runs/gate-card.tsx` | Create | Gate display shared by both routes |
| `factory/ui/src/components/runs/node-timeline.tsx` | Create | Node table |
| `factory/ui/src/components/runs/activity-panel.tsx` | Create | Live activity panel |

### Technical Constraints

- **Read-only.** Use only `useResource` and `useActivity`. There is no `fetch`, no `method:`, no approve/reject buttons, and no clipboard API.
- Do not run `shadcn add` or `npm install`, and do not touch `package.json` or the lockfile. Do not edit `src/lib/**`, `status-badge.tsx`, `app-sidebar.tsx`, or the items routes.
- Keep components in `src/components/runs/`, not `src/routes/`, so `routeTree.gen.ts` stays unchanged.
- Link the PR only through `run.pr_url`. Never build a GitHub URL from `pr_number` or a hard-coded `github.com/<owner>/<repo>`.
- `formatDuration` with a null `ended_at` measures up to "now" at render time. Don't add a ticking timer; the next `node.updated` or `run.updated` refetch re-renders.
- Import domain types from `@/lib/api` only.

### Relevant Code References

- `factory/ui/src/lib/events.ts`: `useResource` and `useActivity` semantics (activity is per mount and capped at 200)
- `docs/prd/sf0-factory-core/specs/http-api-sse.md`: the activity frame format (`event: activity`, no `id:`)
- `docs/prd/sf0-factory-core/PRD.md`: the `gates` and `node_runs` columns; gate `kind` is free text (v0 uses `merge` and `failure`)
- `docs/prd/sf1-session-runner/PRD.md`: Activity (the line format)
- `docs/prd/sf3-cli-and-import/PRD.md`: the `factory approve|reject <gate-id> [--note N]` syntax

### Code Examples

```tsx
// gates page partition
const open = gates.filter((g) => g.closed_at === null).sort((a, b) => a.opened_at.localeCompare(b.opened_at));
const closed = gates.filter((g) => g.closed_at !== null).slice(0, 20); // server already orders closed by closed_at desc

// activity panel: newest first
const lines = useActivity(runId);
<ol aria-live="polite">{[...lines].reverse().map((a, i) => <li key={`${a.at}-${lines.length - i}`}>…</li>)}</ol>
```

## Testing Requirements

The UI has no unit-test framework (PRD constraint). Verify with the build, the typecheck, and a real browser (the omp `browser` tool or Chrome).

Setup:
```bash
npm run build:ui --prefix factory && npm --prefix factory/ui run typecheck
node factory/test/ui-seed.ts --port 7317 --activity-ms 100   # prints R1–R4 and gate ids; open http://127.0.0.1:7317/
```

- [ ] `/runs/<R2>`:
  - The header shows attempt 1, running, the branch, the cost, and a link to t2 "Items view". `PR #12` is an anchor whose `href` is R2's `pr_url` and which opens in a new tab.
  - The timeline lists build#1 completed (sonnet, $0.30), test#1 failed, and build#2 running, in that order.
  - The activity panel fills with `read src/file-<n>.ts` lines, newest on top. None of the every-5th lines published for R4 appear.
  - After about 25 s at 100 ms, the count holds at 200.
- [ ] `/runs/<R4>` shows only the R4 lines. `/runs/<R3>` shows the open failure gate with its question, its recommendation, and both `factory approve|reject <id>` commands. `/runs/<R1>` shows the closed merge gate with an `approve` badge and the note "lgtm". `/runs/999999` and `/runs/x` show "Run not found".
- [ ] `/gates` shows **Open**: the R3 failure gate, then the R4 merge gate (oldest first), each with its item and run links. **Recently closed** shows the R1 gate.
- [ ] Live gate decision without a reload, with `/gates` and `/runs/<R4>` open in two tabs:
  - Run `node factory/src/cli/main.ts approve <g4> --note ok --port 7317` if sf3 has landed. Otherwise run the same endpoint with curl: `curl -s -X POST http://127.0.0.1:7317/api/gates/<g4>/decision -H 'content-type: application/json' -d '{"decision":"approve","note":"ok"}'`.
  - The gate moves to Recently closed with an `approve` badge, and the R4 page shows it closed with the note "ok".
- [ ] Hard-refreshing `/runs/<R2>` and `/gates` renders correctly. The activity panel starts empty and then fills (no replay is expected).
- [ ] Refetch-on-reopen: stop the seed with Ctrl-C and restart it. Within about 5 s, `/gates` shows the reseeded state again (g4 open), and activity resumes without a reload.
- [ ] No mutation affordances: the gates page has no `<button>` other than the sidebar trigger, and `rg -n "method\s*:|clipboard" factory/ui/src` matches nothing.

## Out of Scope

- `/` and `/items/$id`: "Work-item tree and item detail views"
- `src/lib/**`, the layout, the sidebar, the status colors, and new shadcn components: "UI scaffold, design system, and data layer"
- Approve/reject buttons, a copy-to-clipboard button, diffs, the DAG view, and the inbox (sf7)
- Persisting or replaying activity, and new daemon endpoints (sf0, sf1)
