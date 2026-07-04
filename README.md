# Collab Code Editor

A real-time collaborative code editor -- multiple people editing the same
file at once, no central lock, no manual merge conflicts -- built on
[Yjs](https://github.com/yjs/yjs) (CRDT), [Monaco](https://microsoft.github.io/monaco-editor/)
(the VS Code editor component), [Socket.io](https://socket.io/) and a
Node/TypeScript backend with Postgres + Redis.

See **[DESIGN.md](./DESIGN.md)** for the full architecture write-up
(CRDT model, persistence strategy, presence sync, scaling, access control,
version history).

## Features

**Core**
- Real-time collaborative text editing with Monaco syntax highlighting
- Multi-cursor presence: collaborators' names, colors, and live cursor/selection positions
- Document creation, link-based sharing, and owner/editor/viewer access control
- Debounced periodic persistence of live document state to Postgres
- Undo/redo backed by Yjs's `Y.UndoManager` (never undoes a remote peer's edit)

**Advanced**
- Automatic CRDT tombstone GC on the live doc (`gc: true`) + a scheduled
  compaction/retention job for the version-history snapshot table
- Offline editing: keep typing while disconnected (Yjs + `y-indexeddb`),
  auto-merges on reconnect with no explicit outbox/queue needed
- Version history with a diff viewer (Monaco `DiffEditor`) and restore
  (restoring re-applies as ordinary CRDT edits, so it merges with
  concurrent activity instead of clobbering it)
- Horizontal scaling: Redis pub/sub fans out document updates and presence
  across multiple server instances; sticky-session config documented for
  the load balancer
- Bonus: a standalone, from-scratch Operational Transformation engine
  (`packages/ot-demo`) plus a written comparison against the CRDT approach
  used everywhere else in this repo (`packages/ot-demo/COMPARISON.md`)

## Stack

| Layer | Choice |
|---|---|
| Editor | React + [`@monaco-editor/react`](https://github.com/suren-atoyan/monaco-react) |
| CRDT | [Yjs](https://github.com/yjs/yjs) (`Y.Text`, `Y.UndoManager`, `y-protocols/awareness`) + [`y-monaco`](https://github.com/yjs/y-monaco) for the editor binding |
| Transport | Socket.io, with a small custom provider (`packages/client/src/yjs/SocketIOProvider.ts`) built directly on Yjs's own `y-protocols/sync` wire encoders |
| Backend | Node.js + TypeScript, Express (REST) + Socket.io (realtime) |
| Database | PostgreSQL (`pg`) -- documents, users, permissions, version snapshots |
| Pub/sub | Redis (`ioredis`) -- cross-instance fan-out of document updates & presence |
| Offline cache | `y-indexeddb` |
| Build tooling | npm workspaces monorepo, Vite (client), `tsc` (server/shared/ot-demo), Vitest |

### Why Yjs's built-in causality tracking, not hand-rolled vector clocks

The assignment allows/encourages implementing this from scratch except for
the CRDT library itself, and specifically calls out using Yjs's causality
tracking rather than hand-rolling vector clocks. Concretely, in this repo
that means: every place causality/ordering matters --
`packages/server/src/rooms/roomManager.ts` (server-side room state),
`packages/client/src/yjs/SocketIOProvider.ts` (client transport), and the
snapshot/version-history logic in `packages/server/src/db/snapshotsRepo.ts`
-- goes through `Y.Doc` / `Y.encodeStateAsUpdate` / `Y.applyUpdate`, never a
custom clock structure. A hand-rolled vector clock would only answer "did
update A happen-before update B" -- it says nothing about *how to merge*
two concurrent text edits into one consistent sequence, which is the part
that's actually hard to get right (see `DESIGN.md` §1 for how Yjs's YATA
algorithm does it, and `packages/ot-demo/COMPARISON.md` for what the
equivalent hand-rolled logic looks like in a system that isn't a CRDT).
Using Yjs end-to-end also means undo/redo, offline editing, and
persistence all share one causality model instead of needing separate
bespoke ones.

## Repository layout

```
DESIGN.md, README.md               -- documentation (read DESIGN.md first)
docker-compose.yml                 -- postgres + redis + server
packages/
  shared/       -- TypeScript types shared by client & server (roles, DTOs, socket event names)
  server/       -- Express REST API + Socket.io relay + Postgres + Redis
  client/       -- React + Vite + Monaco + Yjs frontend
  ot-demo/      -- standalone OT engine + comparison write-up (not wired into the app)
```

## Running it locally

### Option A -- Docker Compose (Postgres + Redis + server) + `npm run dev` (client)

This is the recommended path and the one actually exercised while building
this project.

```bash
cp .env.example .env          # edit JWT_SECRET etc. if you want; defaults work for local dev
docker compose up -d --build  # postgres, redis, server (server runs its own migrations on boot)
docker compose logs -f server # optional: confirm "[server] listening on :4000"

npm install                   # installs all workspaces, needed for the client dev server
npm run dev:client            # Vite dev server at http://localhost:5173
```

Open `http://localhost:5173` in two browser tabs (or two different
browsers), pick two different display names, and open the same document
(share the link from the "Share" dialog, or just copy the URL) to see live
collaboration.

The frontend intentionally is **not** containerized (per the assignment)
-- it always runs via `npm run dev:client` (Vite dev server) against
whichever backend `VITE_SERVER_URL` points at.

### Option B -- everything via plain npm (no Docker)

You need a local Postgres and Redis reachable (e.g. `brew services start postgresql redis`,
or any disposable containers you start yourself):

```bash
npm install
cp .env.example packages/server/.env   # edit DATABASE_URL / REDIS_URL to match your local services
npm run build --workspace=packages/shared
npm run migrate --workspace=packages/server   # creates tables, safe to re-run
npm run dev:server     # http://localhost:4000, auto-reloads on change
npm run dev:client      # http://localhost:5173, in a second terminal
```

### Building for production / verifying the build

```bash
npm install
npm run typecheck   # tsc --noEmit across every workspace
npm run build        # shared -> server -> ot-demo -> client (vite build)
```

Both of these were run as part of building this project and pass cleanly
(the client's `vite build` prints a chunk-size warning for the bundled
Monaco editor -- expected, not an error).

## Running the tests

```bash
npm run test --workspace=packages/ot-demo    # pure unit tests, no external services needed
npm run test --workspace=packages/server     # needs a real Postgres + Redis, see below
```

The server test suite is intentionally **not** mocked at the DB/network
layer -- it runs real SQL against a real Postgres and drives real
`socket.io-client` connections against a real listening HTTP server,
because the whole point of this project is verifying actual convergence
and persistence behavior, not the behavior of mocks. Point it at any
disposable Postgres/Redis, e.g.:

```bash
docker run -d --name collab-test-pg -e POSTGRES_USER=collab -e POSTGRES_PASSWORD=collab \
  -e POSTGRES_DB=collab -p 5544:5432 postgres:16-alpine
docker run -d --name collab-test-redis -p 6390:6379 redis:7-alpine

cat > packages/server/.env <<EOF
DATABASE_URL=postgres://collab:collab@localhost:5544/collab
REDIS_URL=redis://localhost:6390
JWT_SECRET=test-secret
EOF

npm run test --workspace=packages/server
```

Test files share one real database/Redis instance, so
`packages/server/vitest.config.ts` disables file-level parallelism
(`fileParallelism: false`) -- otherwise concurrent `TRUNCATE`s from
different test files race against each other. This is a real thing that
happened while building this project (see below).

What's covered (`packages/server/tests/`):
- `crdt-merge.test.ts` -- direct `Y.Doc` merge-property tests: concurrent
  same-position inserts, idempotent duplicate updates, out-of-order
  delivery, concurrent insert-inside-a-deleted-range, and a 60-round
  randomized multi-replica convergence check.
- `snapshot-persistence.test.ts` -- round-trips a Yjs state through
  Postgres and confirms load is a single `applyUpdate` regardless of edit
  history length; sequence numbering; diff-lookup (`getSnapshotBefore`);
  the snapshot retention/compaction policy.
- `access-control.test.ts` -- unit tests for `resolveEffectiveRole` (owner
  / explicit grant / link-access precedence) plus REST-level enforcement
  (401/403s) via `supertest` against the real Express app.
- `convergence.e2e.test.ts` -- **the main "prove it converges" suite**, see below.

`packages/ot-demo/tests/` covers the OT engine's transform correctness
(the TP1 diamond property for every op-pair combination, including the
insert-inside-delete split case) and a 200-round randomized convergence
check against the central sequencer.

## How convergence/consistency was verified

Two layers, as required:

**1. Automated, real network round-trips (not mocks).**
`packages/server/tests/convergence.e2e.test.ts` boots a real
`http.Server` + Socket.io server and drives 2-3 real `socket.io-client`
connections against it (via a small test harness,
`packages/server/tests/testYjsClient.ts`, that reimplements the same
sync-protocol handshake as the real browser provider, since the browser
client package can't easily run outside a DOM). It specifically covers:
- two clients editing concurrently and converging to identical text
- **a simulated network partition**: one client's socket is explicitly
  disconnected (`socket.disconnect()`), both clients keep editing --
  the connected one normally, the disconnected one purely locally, proving
  divergence happens as expected -- then the disconnected client
  reconnects and the test asserts both converge to the same text within a
  bounded poll window, and that *both* sides' edits survived the merge
- a third, freshly-joining client reaching the same state as two clients
  that have been mid-conversation
- several edits fired back-to-back from both sides with no synchronization
  point between them, to prove convergence doesn't depend on message
  arrival order

There is also a standalone, narrated version of the same partition
scenario you can run yourself and read the live output of:
```bash
npm run convergence-demo --workspace=packages/server
```
(needs `packages/server/.env` pointed at a reachable Postgres/Redis, same
as the test setup above). Sample output:
```
[demo] alice typed a header, bob received it live -> "// shared header\n"
[demo] --- simulating a network partition: disconnecting bob's socket ---
[demo] alice (online) doc:  "// shared header\nfunction fromAlice() { /* while bob was offline */ }\n"
[demo] bob (offline) doc:   "// shared header\nfunction fromBob() { /* written fully offline, no network */ }\n"
[demo] documents have diverged: true
[demo] --- reconnecting bob ---
[demo] alice final doc: "// shared header\nfunction fromBob() { ... }\nfunction fromAlice() { ... }\n"
[demo] bob final doc:   "// shared header\nfunction fromBob() { ... }\nfunction fromAlice() { ... }\n"
[demo] CONVERGED: true
```

**2. Manual, two real browser tabs.** With the stack running (Option A or
B above), open `http://localhost:5173` in two separate browser tabs
(documented here as manual since headless-browser automation of Monaco +
DevTools network throttling was judged lower value than the automated
Socket.io-level test above, which exercises the identical server-side
merge/broadcast code path). Steps:
1. Sign in with two different display names (one per tab), open the same
   document in both.
2. Type in both tabs simultaneously -- confirm both converge live with no
   visible conflict.
3. In one tab's DevTools, Network tab, set throttling to "Offline" (or
   just kill the server / disconnect wifi). Keep typing in both tabs.
4. Restore the network in the throttled tab. Confirm the "Offline --
   editing locally" badge clears and the two tabs' content converges
   within a second or two, with both tabs' offline edits present.

**A concurrency bug this actually caught:** while writing the automated
partition test above, it consistently failed on the *second* test in the
file (but passed when run alone) -- tracked down to a genuine race in
`RoomManager.getOrLoad`: two clients joining a brand-new room at nearly
the same instant could each see the room as not-yet-created, each `await`
their own `createRoom()` (which awaits a DB call), and the second one to
finish would silently overwrite the first's `Room` object in the map --
orphaning whichever socket had registered against the first one, so that
client would never receive broadcasts. Fixed with an in-flight-creation
promise cache so concurrent joiners on the same doc ID await the *same*
room creation (see the `pendingCreates` map in `roomManager.ts`). This is
a good example of why the automated multi-client test matters: it's the
kind of bug that's very easy to miss by hand-testing two browser tabs one
at a time, but shows up reliably once two clients genuinely race.

## Known deviations / scope decisions

Documented in more detail inline in `DESIGN.md`, summarized here:
- **Auth is intentionally lightweight**: a display name + a
  browser-persisted client ID, no passwords/OAuth. This is a deliberate
  scope decision (see `DESIGN.md` "Authentication") to keep engineering
  effort on the collaboration/CRDT/scaling problem the assignment is
  actually about.
- **Redis fan-out is hand-rolled on top of `ioredis` pub/sub**, not
  `@socket.io/redis-adapter` -- see `DESIGN.md` "Scaling" for why running
  both would be two overlapping broadcast systems.
- **WebRTC peer-to-peer** was explicitly out of scope per the assignment
  and is not implemented.
- The OT module (`packages/ot-demo`) is a from-scratch demo scoped to
  plain-text insert/delete with a minimal central-sequencer server; it
  does not implement a full concurrent-client-side reconciliation
  algorithm (the OT equivalent of Google Wave's "GOT") -- see the module's
  own doc comments and `COMPARISON.md` for why that's out of scope and
  what it would take.
- `npm audit` reports a handful of moderate/high advisories, all in dev
  tooling (`vite`'s bundled `esbuild` dev-server, and `uuid`'s buffer-based
  APIs which this repo never calls -- only `uuid.v4()` is used). Not
  patched via `--force` because the available fixes are breaking major
  version bumps of `vite`/`vitest`/`uuid` that weren't worth the
  regression risk for a local dev-tooling-only exposure.

## Environment variables

See `.env.example` for the full list with comments. Copy it to `.env` for
Docker Compose, and/or `packages/server/.env` for running the server
outside Docker. Never commit a real `.env` -- it's gitignored.
