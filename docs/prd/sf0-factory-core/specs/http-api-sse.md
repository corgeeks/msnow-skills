# HTTP API, SSE, and static UI serving

## Objective

Implement `createApiServer({ store, bus, uiDir }): http.Server` in `src/daemon/http.ts`. It covers three things:

- the JSON API from the PRD;
- the `/events` Server-Sent Events stream, which replays from `Last-Event-ID`;
- static serving of the built UI, with SPA fallback.

It uses only `node:http` (no framework).

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5`. This is routing and serialization against a fixed store contract, plus a well-specified SSE protocol.

## Context

The CLI (sf3) and the read-only UI (sf4) talk to the daemon only through this server. In parallel, the lifecycle task's `main.ts` calls `createApiServer(...)` and then `.listen(port, '127.0.0.1')` itself, so this module must not listen.

### Parent PRD

- **PRD**: sf0-factory-core
- **PRD Path**: `docs/prd/sf0-factory-core/PRD.md`. The "HTTP API" table is normative.

### Related Tasks

- **Depends on**: SQLite database and store
- **Blocks**: sf3 CLI, sf4 UI. Runs in parallel with "Daemon lifecycle and entrypoint", which imports `createApiServer` with exactly this signature.

## Acceptance Criteria

- [ ] `export function createApiServer(opts: { store: Store; bus: Bus; uiDir: string }): http.Server` returns a server that is not yet listening.
- [ ] Every route in the PRD's HTTP API table is implemented with the documented query/body fields.
  - Request bodies are JSON, with a 1 MiB limit (413 above that).
  - Responses are `application/json; charset=utf-8`.
- [ ] Errors use the shape `{"error":{"code","message"}}`:

  | Condition | Status | `code` |
  |---|---|---|
  | Validation failure (wrong types, unknown status, missing required field) | 400 | `bad_request` |
  | `NotFoundError` or an unknown `/api/*` route | 404 | `not_found` |
  | `ConflictError` | 409 | `conflict` |
  | `CycleError` | 409 | `cycle` |
  | Anything else | 500 | `internal` (message logged to stderr) |

- [ ] `PATCH /api/items/:id` with `status` requires `from` and calls `store.transitionItem(id, from, status)`. Other fields go through `store.updateItem`.
- [ ] `GET /events`:
  - Responds `200` with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive`, then `flushHeaders()` and writes `retry: 3000`.
  - If a `Last-Event-ID` header (or `?after=` query) is present, it first replays `store.listEvents({after})` in pages until caught up. Only then does it attach to `bus.subscribe`.
  - Events published during the replay are buffered and deduped by `seq`, so none is lost or duplicated.
  - Frame format: `id: <seq>\nevent: <type>\ndata: <json>\n\n`.
  - Transient activity: the stream also subscribes to `bus.subscribeActivity` and writes `event: activity\ndata: <json>\n\n` with **no `id:` line**, so `Last-Event-ID` keeps pointing at the last persisted event. Activity is never replayed.
  - Heartbeat: `: ping\n\n` every 15 s. On `res` close it unsubscribes both subscriptions and clears the timer.
- [ ] Static serving:
  - Any non-`/api` and non-`/events` GET resolves under `uiDir`, with a path-traversal guard (403).
  - An existing file is served with a MIME type from a small extension map. `index.html` gets `Cache-Control: no-cache`; `/assets/*` gets `max-age=31536000, immutable`.
  - A missing path that has an extension returns 404.
  - A missing path without an extension serves `uiDir/index.html`.
  - If `uiDir/index.html` doesn't exist, it returns 200 HTML with the text "UI not built — run `npm run build:ui --prefix factory`".
- [ ] `GET /api/health` returns `{ok: true, pid, schemaVersion}`.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/http.ts` | Create | Server factory |
| `factory/src/daemon/http.test.ts` | Create | Tests over an ephemeral port |

### Technical Constraints

- Use only `node:http`, `node:fs`, `node:path`, and `node:url`. No dependencies.
- Use a tiny internal router: an array of `{method, pattern: RegExp, handler}` entries. Don't add a routing abstraction beyond that.
- Validate inputs by hand against the unions in `src/shared/types.ts` (`ITEM_STATUSES`, `TIERS`).
- The server never binds by itself. Tests call `server.listen(0, '127.0.0.1')`.

### Relevant Code References

- `factory/src/daemon/store.ts`: methods and error classes
- `factory/src/shared/types.ts`: `FactoryEvent` and the unions
- `docs/prd/software-factory/research.yaml`: SSE + static snippet (question about the minimal React UI stack)

### Code Examples

```ts
// SSE frame
res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
```

## Testing Requirements

Each test uses a temp DB and listens on port 0.

- [ ] Create, get, list, and patch items. A patch with the wrong `from` returns 409 `conflict`.
- [ ] A batch with refs returns `BatchResult` with every ref in `created`. Re-posting it returns the same `ids`, with every ref in `skipped`.
- [ ] A dependency that would form a cycle returns 409 `cycle`. An unknown item returns 404.
- [ ] Deciding a gate twice returns 409 on the second call. (Create the gate through the store in the test setup.)
- [ ] SSE: connect, create an item, and receive an `item.created` frame with an `id`. Reconnect with `Last-Event-ID: <n>`: the missed events are replayed in order, with no duplicates.
- [ ] Static serving:
  - `/runs/5` with a fixture `index.html` returns `index.html`.
  - `/assets/missing.js` returns 404.
  - `/../etc/passwd` returns 403 or 404 and never file contents.
  - With no `index.html` present, the response is the "UI not built" note.

## Out of Scope

- Listening, signal handling, and the instance lock (lifecycle task)
- Endpoints for creating runs, node runs, or gates. The engine writes those through the store directly.
- Auth, CORS, and gzip. The daemon is localhost-only.
