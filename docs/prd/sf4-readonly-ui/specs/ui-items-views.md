# Work-item tree and item detail views

## Objective

Replace the scaffold's shells for `/` and `/items/$id` with the real read-only views:

- **`/`**: the work-item tree, nested by `parent_id`, with hand-validated `type`, `status`, and `q` search params.
- **`/items/$id`**: item detail with header, plain-text body, deps, dependents, children, and the runs table.

Both views update live over SSE through `useResource`, without a reload.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5`. This is view code on a fixed data layer. The only logic is the tree filter and the search validation, and both are specified below.

## Context

The v0 UI is how you browse what the factory is tracking. Imports from `factory import` (sf3) produce deep trees (umbrella → PRD → group → task), so the tree must keep context when filtered: a matching item is shown together with its ancestors.

### Parent PRD

- **PRD**: sf4-readonly-ui
- **PRD Path**: `docs/prd/sf4-readonly-ui/PRD.md`. The Routing table rows for `/` and `/items/$id`, plus Look and Constraints, are normative.

### Related Tasks

- **Depends on**: "UI scaffold, design system, and data layer". This task relies on these exact exports:
  - `@/lib/api`: `api.items(): Path<ItemSummary[]>` (`ItemSummary` = `WorkItem` plus `open_deps: number`), `api.item(id: number): Path<ItemDetail>` (`ItemDetail` = `{ item: WorkItem; deps: WorkItem[]; dependents: WorkItem[]; children: WorkItem[]; runs: Run[] }`), `ApiError` (with `.status`), and the re-exported `WorkItem`, `ItemSummary`, `ItemDetail`, `Run`, and `ItemStatus`. All of these come from sf0 `types.ts`;
  - `@/lib/events`: `useResource<T>(url: Path<T> | null, { refetchOn: EventType[] }): { data?: T; error?: Error }`;
  - `@/lib/format`: `formatCost`, `formatTime`;
  - `@/components/status-badge`: `StatusBadge`, `ITEM_STATUSES`;
  - the shadcn components in `@/components/ui/*`;
  - the seed server `factory/test/ui-seed.ts`.
- **Parallel sibling**: "Run detail and gates views". It owns `src/routes/runs.$id.tsx`, `src/routes/gates.tsx`, and `src/components/runs/**`. It links to `/items/$id` with `params={{ id: String(itemId) }}`, so keep that route path and its param name `id`. Run rows here link to `/runs/$id` the same way.
- **Cross-slice**: sf0 `GET /api/items` and `GET /api/items/:id`. sf3 imports produce the data shapes seen in practice: types `umbrella`, `prd`, `group`, and `task`.

## Acceptance Criteria

**`/` (`src/routes/index.tsx`)**
- [ ] `validateSearch` is a hand-written function (no zod) that returns `ItemsSearch = { type?: string; status?: ItemStatus; q?: string }`.
  - TanStack's default parser JSON-parses values, so `?q=42` arrives as the number `42`. Coerce numbers to strings for `q` and `type`.
  - Drop empty strings, and drop any `status` not in `ITEM_STATUSES`.
  - Every key is optional, so `<Link to="/">` in the sidebar still typechecks without `search`.
- [ ] Data comes from `useResource(api.items(), { refetchOn: ['item.created', 'item.updated'] })`. Filtering happens on the client.
- [ ] The tree:
  - Roots are items with `parent_id === null`, or whose parent is not in the list.
  - Children are ordered by `id` ascending.
  - Depth is shown by indenting the title cell.
- [ ] Filter semantics:
  - An item **matches** when every given filter holds: `type` is equal; `status` is equal; `q` (trimmed, case-insensitive) is a substring of the title, or equals the id with an optional leading `#`.
  - The view renders each matching item plus all of its ancestors. Ancestors that don't match use `text-muted-foreground`.
  - With no filters, everything renders.
  - With filters and zero matches, it says "No items match" and offers a link that clears the filters.
- [ ] The tree is rendered in a semantic shadcn `Table` with `<th scope="col">` headers. Columns are `ID` (`#id`), `Type`, `Title` (a `Link` to `/items/$id`), `Status` (`StatusBadge`), and `Blocked by`.
- [ ] **Blocked by** is `open_deps` from the list response (the count of dependencies not yet `done`). It renders `—` when the count is 0, and needs no per-row fetch.
- [ ] Filter controls sit above the table, each with a visible `<label>`:
  - a native `<select>` for type (options are the distinct `type`s in the data, sorted, plus "All types");
  - a native `<select>` for status (`ITEM_STATUSES`, plus "All statuses");
  - the shadcn `Input` for `q`.
  - Each change calls `navigate({ search: (prev) => ({ ...prev, <key>: value || undefined }), replace: true })`, so the URL is the only filter state.
- [ ] While loading, the view shows `Skeleton` rows. On error, it shows an inline message with `error.message`.

**`/items/$id` (`src/routes/items.$id.tsx`)**
- [ ] `id` is parsed with `Number`. A value that is not a positive integer renders "Item not found" without fetching. A fetch that fails with `ApiError` status 404 renders the same message, with a link back to `/`.
- [ ] Data comes from `const { data } = useResource(api.item(id), { refetchOn: ['item.created', 'item.updated', 'run.created', 'run.updated'] })`. The fields are read from `data.item`, and the lists from `data.deps`, `data.dependents`, `data.children`, and `data.runs`.
- [ ] The header shows `#id`, `type`, `title` (`<h1>`), `StatusBadge`, a parent link (when `item.parent_id` is set), and a definition list of `tier`, `priority`, `spec_path`, `test_cmd`, `source_ref`, `created_at`, and `updated_at`. Null values show as `—`.
- [ ] The body renders as plain text inside `<pre className="whitespace-pre-wrap">` (no markdown, no `dangerouslySetInnerHTML`). An empty body shows "No description".
- [ ] There are three lists, *Depends on*, *Dependents*, and *Children*. Each row is `#id` + a title link + `StatusBadge`, and each empty list says "None".
- [ ] The runs table (semantic `Table`) has columns `Attempt` (a link to `/runs/$id`), `Status`, `Template`, `Branch`, `PR`, `Cost` (`formatCost`), `Started`, and `Ended` (`formatTime`), sorted by attempt descending. `PR` shows `#n` as an `<a href={pr_url} target="_blank" rel="noreferrer">` when `pr_url` is set, `#n` as text when only `pr_number` is set, and `—` otherwise.
- [ ] `npm --prefix factory/ui run typecheck` and `npm run build:ui --prefix factory` pass. `src/routeTree.gen.ts` is unchanged, because no route file is added or renamed.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/ui/src/routes/index.tsx` | Edit | Replace the shell: `validateSearch`, filters, tree table |
| `factory/ui/src/routes/items.$id.tsx` | Edit | Replace the shell: item detail |
| `factory/ui/src/components/items/item-tree.tsx` | Create | Tree build and filter, table rows |
| `factory/ui/src/components/items/item-list.tsx` | Create | The `#id` + link + badge list used by deps, dependents, and children |

### Technical Constraints

- **Read-only.** Use only `useResource` (GET). There is no `fetch`, no `method:`, and no mutation UI.
- Do not run `shadcn add` or `npm install`, and do not touch `package.json` or the lockfile. The scaffold's component set is final. If you need something it lacks, use native elements with Tailwind classes.
- Keep components out of `src/routes/`, so the router plugin doesn't regenerate `routeTree.gen.ts`. Don't edit the scaffold's `src/lib/**`, `status-badge.tsx`, or `app-sidebar.tsx`. If the sidebar's `<Link to="/">` stops typechecking because of `validateSearch`, fix it with `search={{}}` in `app-sidebar.tsx` and nothing more.
- Import domain types from `@/lib/api` only, never from `factory/src` directly.
- Inside the code-split route component, use `Route.useSearch()`, `Route.useParams()`, and `Route.useNavigate()` from the same file. Use `getRouteApi('/')` inside `src/components/items/*`.

### Relevant Code References

- `factory/ui/src/lib/api.ts`, `src/lib/events.ts`, `src/components/status-badge.tsx`: the data layer contract
- `docs/prd/sf0-factory-core/PRD.md`: the HTTP API table (`GET /api/items` → `ItemSummary[]`; `GET /api/items/:id` → `ItemDetail`)
- `docs/prd/sf3-cli-and-import/PRD.md`: Mapping (the item types and statuses an import produces)
- https://tanstack.com/router/latest/docs/guide/search-params

### Code Examples

```ts
export type ItemsSearch = { type?: string; status?: ItemStatus; q?: string };
const str = (v: unknown) => (typeof v === 'number' ? String(v) : typeof v === 'string' && v.trim() ? v : undefined);
export const Route = createFileRoute('/')({
  validateSearch: (s: Record<string, unknown>): ItemsSearch => ({
    type: str(s.type),
    status: ITEM_STATUSES.includes(s.status as ItemStatus) ? (s.status as ItemStatus) : undefined,
    q: str(s.q),
  }),
  component: ItemsPage,
});

// visible ids: matches plus their ancestors
function visibleIds(items: ItemSummary[], match: (i: ItemSummary) => boolean): Set<number> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const keep = new Set<number>();
  for (const i of items) if (match(i)) for (let c: ItemSummary | undefined = i; c && !keep.has(c.id); c = byId.get(c.parent_id ?? -1)) keep.add(c.id);
  return keep;
}
```

## Testing Requirements

The UI has no unit-test framework (PRD constraint). Verify with the build, the typecheck, and a real browser (the omp `browser` tool or Chrome).

Setup:
```bash
npm run build:ui --prefix factory && npm --prefix factory/ui run typecheck
node factory/test/ui-seed.ts --port 7317   # prints seeded ids as JSON; open http://127.0.0.1:7317/
```

- [ ] `/` shows the Demo PRD → Views → t1–t5 nesting and the root bug b1. Each row has `#id`, the type, a title link, and a status badge. t3 shows Blocked by `1` (t2 is active); t1 shows `—`.
- [ ] `/?status=blocked` shows t4 with Demo PRD and Views muted as ancestors. `/?type=bug` shows only b1. `/?q=%23<t2id>` and `/?q=items` both find t2. `/?q=42` does not throw. `/?status=bogus` shows the full tree. Changing a control updates the URL in place, without adding a history entry.
- [ ] Live updates without a reload:
  - `curl -s -X POST http://127.0.0.1:7317/api/items -H 'content-type: application/json' -d '{"title":"Live item","type":"bug","parent_id":<grp>}'` makes the item appear under Views.
  - `curl -s -X PATCH http://127.0.0.1:7317/api/items/<t2> -H 'content-type: application/json' -d '{"from":"active","status":"done"}'` turns t2's badge to done, and t3's Blocked by becomes `—`.
- [ ] `/items/<t2>` shows the header fields, deps (t1), dependents (t3), and the runs table with R2 linking to `/runs/<R2>`. R2's PR `#12` links to its `pr_url` in a new tab, and its cost shows as `$…`. `/items/<b1>` keeps the body's indentation and blank lines. `/items/<grp>` lists t1–t5 as children. `/items/999999` and `/items/abc` show "Item not found".
- [ ] Hard-refreshing `/items/<t2>` and `/?status=active&q=view` renders the same view, and the filters are restored from the URL.
- [ ] Refetch-on-reopen: with `/` open, add an item with curl, then stop the seed (Ctrl-C) and restart it. The fresh DB has no "Live item", and it disappears within about 5 s without a reload.
- [ ] Keyboard: Tab reaches each filter control and each title link with a visible focus ring.

## Out of Scope

- `/runs/$id`, `/gates`, and the live activity panel: "Run detail and gates views"
- `src/lib/**`, the layout, the sidebar, the status colors, and new shadcn components: "UI scaffold, design system, and data layer"
- Editing, creating, or starting items, expand/collapse state, a DAG view, and markdown rendering (sf7)
- Daemon changes, including anything about how `open_deps` is computed (sf0)
