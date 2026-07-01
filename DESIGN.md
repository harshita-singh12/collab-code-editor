# DESIGN.md — Real-Time Collaborative Code Editor

This document is written **before** any implementation code, as a record of the
architectural decisions and the reasoning behind them. It covers the three
required design questions, then expands into the full system design so the
rest of the codebase can be read as "implementation of this plan."

---

## 1. How Yjs's CRDT model handles concurrent inserts/deletes

Yjs implements a family of CRDTs; the type we use for the editor buffer is
`Y.Text`, based on the **YATA** (Yjs's variant of a sequence CRDT, closely
related to RGA — Replicated Growable Array). The high-level model:

- **Every character (or run of characters) inserted is an *item*** with a
  globally unique, immutable ID: `(clientID, clock)`, where `clientID` is a
  random ID generated per editing session and `clock` is a per-client
  monotonically increasing counter (Lamport-style, but per-item, not a single
  scalar per replica). This is Yjs's built-in causality tracking — there is
  no hand-rolled vector clock anywhere in this project; we exclusively use
  `Y.Doc`, `Y.Text`, `Y.encodeStateAsUpdate`, `Y.applyUpdate`, and
  `y-protocols/awareness`.
- **Insertion position is encoded relative to neighboring items**, not as a
  numeric index. Every item stores a reference to the item that was
  immediately to its left (`origin`) and right (`rightOrigin`) *at the time
  of insertion*. This is the key trick that makes concurrent inserts
  commute: two users typing at "the same index" never actually conflict on
  an index, because the index was never the source of truth — the
  neighboring item identity was.
- **Conflict resolution for concurrent inserts at the same origin** is
  resolved by a deterministic tie-break: items competing for the same
  left-origin are ordered by comparing `clientID` (YATA's integration
  algorithm walks the list of "conflicting" items and inserts based on a
  well-defined total order over origins + clientID). Because every replica
  applies the *same* deterministic rule, all replicas converge to the
  *same* final ordering regardless of the order updates arrive in
  (commutativity + associativity + idempotency = a CRDT by definition).
- **Deletes are tombstones, not removals.** Deleting a character marks the
  item as deleted (a boolean flag) rather than physically removing it from
  the internal doubly-linked list. This is essential for convergence:
  if client A deletes character X while client B concurrently inserts a new
  character with `origin = X`, B's insert still has a well-defined anchor
  to integrate against even though X is "gone" from the user's point of
  view. Concurrent delete+delete of the same item is naturally idempotent
  (second delete is a no-op). Concurrent insert+delete never race because
  inserts and deletes are separate, order-independent operations over
  immutable item IDs.
- **Updates are the unit of network transfer.** `Y.encodeStateAsUpdate(doc)`
  serializes a set of items (or the full doc); `Y.applyUpdate(doc, update)`
  merges them in. Updates are commutative, associative, and idempotent —
  applying the same update twice, or applying updates out of order, always
  converges to the same document state. This is what lets our server relay
  raw update bytes without understanding their contents, and what lets
  offline clients replay a backlog of updates in any order on reconnect.

**Why this is the right choice given our stack** (this directly answers the
"use Yjs's built-in causality tracking" constraint): hand-rolling a vector
clock would only give us "did A happen before B," which is necessary but
nowhere near sufficient for text — we'd still have to invent an
insert-position resolution algorithm (i.e., re-implement YATA/RGA badly and
without the years of edge-case hardening Yjs has). Yjs also gives us, for
free, on top of the same causality machinery: `Y.UndoManager` (origin-scoped
undo/redo), `y-protocols/awareness` (ephemeral presence CRDT), and
`y-indexeddb` / update-based persistence (see §2). Using it end-to-end means
one causality model powers editing, undo, offline queuing, and persistence,
instead of four bespoke ones.

---

## 2. Persisting snapshots without replaying the full operation history

Naively, a collaborative doc server could store every incoming update
row-by-row in Postgres and, on load, `applyUpdate` each one in sequence.
That is $O(\text{total edits ever made})$ per document open, which is
unacceptable for a long-lived document (get to a few hundred thousand
keystrokes and every page load recomputes the whole history).

Instead:

1. **Each active document is a single in-memory `Y.Doc` on the server**
   (per room), which is the authoritative live replica. Incoming client
   updates are applied to it once and re-broadcast; the server never stores
   the individual update log durably.
2. **Persistence writes the *merged current state*, not the update log.**
   Because Yjs updates are associative, `Y.encodeStateAsUpdate(doc)` at any
   point in time already represents "the single update that would take an
   empty doc straight to the current state" — deletions are already
   collapsed into tombstone flags, and (because the live doc runs with
   `gc: true`, Yjs's default) content that is provably no longer needed for
   causality is proactively discarded from that encoding. Loading a
   document is therefore always **one `applyUpdate` call**, regardless of
   how many thousands of edits produced that state — O(current document
   size), not O(history length).
3. **Debounced writes.** The server does not fsync to Postgres on every
   keystroke. A per-room debounce timer (default 3s of inactivity, hard cap
   of 30s under continuous typing) triggers
   `UPDATE documents SET state = $1, updated_at = now() WHERE id = $2`
   with the latest `encodeStateAsUpdate` blob (`bytea`). A `pg_notify` is
   not needed since we're single-writer-per-room already. This bounds
   Postgres write volume to roughly one row write per few seconds per
   *active* room, not one per keystroke.
4. **Version history is a deliberately separate table**
   (`document_snapshots`), populated much more sparsely (every N minutes of
   edit activity, or on explicit "save version," capped by a retention
   policy — see §"Tombstone compaction" in the advanced features below).
   Each row is again a full merged-state blob plus a plain-text extraction
   used for diffing — not a delta chain — so restoring or diffing any
   historical version is also O(document size), never O(history).
5. **Crash recovery**: if the process restarts, the next time a client
   joins a room the server does exactly one `SELECT state FROM documents
   WHERE id = $1`, `applyUpdate`s it into a fresh `Y.Doc`, and is caught up
   — no replay loop.

This design trades a small amount of durability window (up to ~3-30s of
edits could be lost on a hard crash before the debounce fires) for O(1)
persistence cost per edit and O(size) load cost. That's the right trade for
a text editor (compare: Google Docs / Notion also batch-persist, they do not
fsync per keystroke either).

---

## 3. Presence (cursors, who's editing) synced separately from content

Presence is handled by **`y-protocols/awareness`**, which is architecturally
distinct from `Y.Doc` content on purpose:

- **Ephemeral, not CRDT-merged.** Awareness state is last-writer-wins *per
  client ID*, with no history and no tombstones. Each client publishes a
  single JSON-like blob: `{ user: { name, color }, cursor: { anchor, head },
  selection } `. When a new value arrives for a given client, it fully
  replaces the old one — there is nothing to "merge" the way concurrent text
  inserts are merged.
- **Not persisted.** Presence is never written to Postgres. It lives only in
  server memory (and gets rebuilt from scratch as clients (re)connect) and
  in each browser's memory. This keeps the durable document state
  (Y.Doc content) free of churn from cursor movement, which would otherwise
  dominate the update volume (cursor moves far more often than text
  changes).
- **Own wire channel.** On the same Socket.io connection we multiplex two
  distinct event names: `doc-sync` (Yjs sync protocol: state-vector
  exchange + update application, mutates `Y.Doc`) and `doc-awareness`
  (awareness protocol: mutates only the local `Awareness` instance, never
  touches `Y.Doc`). This mirrors exactly how `y-websocket` splits sync vs.
  awareness messages, just carried over Socket.io instead of raw `ws`.
- **Liveness via timeout, not disconnect events.** `awareness` assigns each
  active client a random 32-bit client ID and expects periodic
  keep-alives; if a client's awareness state isn't refreshed within a
  timeout window (default 30s in the library, we keep default), it's
  pruned automatically — so a browser tab that closes uncleanly (no clean
  Socket.io `disconnect`) still has its cursor/name disappear for everyone
  else within a bounded time, without any custom heartbeat code.
- **Cross-instance fan-out** uses the same Redis pub/sub mechanism as
  document updates (see §"Scaling" below), on a separate channel per room,
  so presence is consistent across horizontally scaled server instances
  without ever touching Postgres.

---

## Full system architecture

```
┌────────────────────┐        WebSocket (socket.io)        ┌──────────────────────┐
│   Browser client    │ ───────────────────────────────────▶│   Node server (N)     │
│  React + Monaco     │◀─────────────────────────────────── │  Express + Socket.io  │
│  Y.Doc (source of   │   doc-sync / doc-awareness events    │  Y.Doc per room       │
│  local truth,       │                                      │  (authoritative)      │
│  y-indexeddb cache)  │        REST (HTTP, JWT bearer)       │  REST API             │
└─────────┬────────────┘ ───────────────────────────────────▶└─────┬──────────┬──────┘
          │                                                        │          │
          │                                                        │          │
          ▼                                                        ▼          ▼
   IndexedDB (offline                                        Postgres     Redis
   durability of local                                    (documents,    (pub/sub
   edits + awareness                                        users,       fan-out
   cache)                                                  permissions,  across N
                                                             snapshots)   server
                                                                          instances)
```

### Packages (npm workspaces monorepo)

- `packages/shared` — TypeScript types shared by client & server: wire
  message shapes, role enum, REST DTOs. Zero runtime dependencies beyond
  TypeScript, so both sides compile against the same contract.
- `packages/server` — Express REST API + Socket.io relay + Postgres access
  (`pg`) + Redis pub/sub (`ioredis`) + Yjs room manager.
- `packages/client` — Vite + React + Monaco + Yjs + our custom
  `SocketIOProvider`.
- `packages/ot-demo` — standalone, not wired into the app: a small
  from-scratch Operational Transformation engine for plain-text
  insert/delete, with its own tests and a comparison write-up against the
  CRDT approach used everywhere else in this repo.

### Transport protocol (custom Yjs ⇄ Socket.io provider)

We deliberately do **not** pull in `y-websocket` (it assumes a raw `ws`
socket) or the third-party `y-socket.io` package (small, sparsely
maintained, and the assignment specifically asks for a Socket.io relay we
understand end to end). Instead `packages/client/src/yjs/SocketIOProvider.ts`
and `packages/server/src/rooms/roomManager.ts` implement the same handshake
`y-websocket` uses, built directly on Yjs's own published wire-protocol
encoders (`y-protocols/sync`, `y-protocols/awareness`) — i.e., we reuse
Yjs's protocol code, we only supply the transport glue:

1. Client joins room: `socket.emit('join-room', { docId, token })`.
2. Server authenticates (JWT) and authorizes (role lookup), loads/creates the
   room's `Y.Doc` (from Postgres if not already hot in memory), and replies
   with a `sync-step-1` message (its state vector).
3. Client responds with `sync-step-2` (the updates the server is missing)
   and its own `sync-step-1`; server replies with the updates the client is
   missing. This is the standard two-way Yjs sync handshake — after it
   completes both sides hold identical state.
4. Subsequent edits are single `update` messages, applied and immediately
   re-broadcast (server never buffers/batches network fan-out — it does
   batch *persistence*, per §2).
5. Awareness updates flow on a parallel `doc-awareness` event, independent
   of the above.

### Scaling: Redis pub/sub + sticky sessions

Each server instance keeps its own in-memory `Y.Doc` replica per *locally
active* room (i.e., a room with at least one client connected to that
instance). When instance A applies an update from one of its local clients,
it (a) rebroadcasts to its own locally-connected sockets in that room, and
(b) `PUBLISH`es the raw update bytes to Redis channel `room:<id>:sync`.
Every instance `SUBSCRIBE`s to the rooms it has hot; on message, it applies
the update to its local replica (idempotent — safe even if it somehow
already had it) and rebroadcasts to its local sockets, skipping the origin
socket. This is plain `ioredis` publish/subscribe, chosen deliberately over
the off-the-shelf `@socket.io/redis-adapter` package: the adapter only
solves *client-facing* Socket.io room fan-out across instances, but each
instance would still need a way to keep its own authoritative `Y.Doc`
replica (used for persistence and for late-joining clients) up to date —
that requires our own pub/sub loop regardless, so using both mechanisms
together would be two overlapping broadcast systems and a likely source of
bugs. One explicit pub/sub loop, fully owned by our code, is simpler to
reason about and is what the assignment specifically asks for.

Because Socket.io's handshake (and its long-polling fallback transport)
requires all packets for one logical connection to land on the same
process, running N instances behind a load balancer requires **sticky
sessions** (e.g., nginx `ip_hash` / `hash $remote_addr`, or a cookie-based
affinity in a real L7 LB / AWS ALB with `stickiness` enabled). This repo's
`docker-compose.yml` runs a single server instance (sticky sessions are
moot with N=1), but `deploy/nginx-sticky.conf.example` documents the
config for horizontal scaling, and the room manager code has no
process-local assumptions that would break under it.

### Tombstone compaction / GC

Two independent mechanisms:

1. **Live editing doc**: `Y.Doc` is constructed with the Yjs default
   `gc: true`. Yjs already garbage-collects tombstoned (deleted) content
   from the in-memory structure once it can prove no future remote update
   could still reference it as an origin — this is automatic and requires
   no code from us, which is precisely why we don't hand-roll it.
2. **Snapshot table retention**: `document_snapshots` rows accumulate over
   a document's lifetime (they're what powers version history + diffing,
   and they intentionally *do* keep independent full states rather than a
   diff chain). A scheduled job (`server/src/jobs/compactSnapshots.ts`,
   invoked on a timer and exposed as a script for a cron/k8s CronJob in
   production) prunes snapshot rows using a "keep more recent, thin out
   older" retention policy (keep all from the last 24h, keep hourly for the
   last week, keep daily beyond that, always keep rows explicitly labeled
   by a user as a named checkpoint). This bounds Postgres storage growth
   for long-lived documents without ever affecting the live editing
   session.

### Offline editing & reconnection

Because the `Y.Doc` *is* the local queue — every local edit already lives in
the document's own update log in memory and is mirrored to `y-indexeddb` —
there is no separate "outbox" to build. `SocketIOProvider` simply:

- Applies local Monaco edits to the local `Y.Doc` regardless of connection
  state (Yjs doesn't know or care if a network exists).
- On `socket.io` `disconnect`, flips a `synced=false` flag (surfaced in the
  UI as an "offline — editing locally" badge) and stops sending; the user
  keeps typing normally.
- On reconnect, re-runs the exact handshake from step 2 above (fresh
  state-vector exchange) — the server sends what the client missed while
  gone, the client sends its entire offline edit backlog as one delta
  update. Convergence is automatic and requires no conflict-resolution code
  on our part, because that's what "CRDT" means.
- `y-indexeddb` additionally persists across full browser restarts / tab
  closes while offline, so a laptop closed mid-flight and reopened days
  later still merges cleanly.

### Version history & diffing

`document_snapshots(id, document_id, seq, label, state bytea, text_excerpt
text, created_at, size_bytes)`. Diffing two versions is done by decoding
each snapshot's `state` into a scratch `Y.Doc`, reading `Y.Text#toString()`,
and running the `diff` npm package's Myers diff over the two plain strings
— text diffing is a solved, well-tested problem, so we reuse a library
there rather than hand-roll it. The diff is rendered client-side with
Monaco's built-in `DiffEditor` component (again, reusing an existing,
well-tested widget instead of hand-rolling diff rendering).

Restoring a version does **not** overwrite the live `Y.Doc` wholesale
(that would stomp any concurrent edits happening at that moment and defeats
the whole point of using a CRDT). Instead, the server computes a text diff
between the live doc's current text and the target version's text, and
applies the diff as ordinary `Y.Text` insert/delete operations inside a
single transaction. This is causally just "one more edit" from the CRDT's
point of view — it merges with whatever anyone else is concurrently typing,
exactly like any other edit, and is itself undoable via `Y.UndoManager`.

### Access control model

`documents(id, title, owner_id, link_access, created_at, updated_at, state)`
`document_permissions(document_id, user_id, role)` where `role ∈ {editor,
viewer}` (owner is implied by `documents.owner_id`, never duplicated in this
table). `link_access ∈ {none, viewer, editor}` controls what *any*
authenticated user gets by simply holding the share link, without an
explicit row in `document_permissions` — the common "anyone with the link
can comment/edit" pattern. Explicit rows in `document_permissions` let an
owner grant a specific person a higher (or, by an explicit `blocked`
override — out of scope for v1, documented as a future extension) role than
the link default.

Enforcement is always server-side: REST routes run a `requireRole`
middleware that resolves `effective role = max(explicit permission row,
link_access, owner ⇒ owner)`; the Socket.io room join handler resolves the
same effective role once at join time and stores it on the socket, and
**silently drops** (does not apply/broadcast) any `doc-sync` update message
from a socket whose role is `viewer`. The client also sets Monaco to
`readOnly` for defense-in-depth / better UX (no point letting a viewer type
and then discover it didn't save), but the actual security boundary is the
server drop.

### Authentication (pragmatic scope decision)

Building a full OAuth/password/email-verification identity system is out of
scope for what this project is meant to demonstrate (CRDT collaboration
engineering, not identity providers) and would dilute engineering effort
away from the actually-interesting parts. Instead: `POST /api/auth/session`
takes a display name (+ optional color), creates or reuses a `users` row
keyed by a client-generated persistent ID stored in `localStorage`, and
returns a JWT (`HS256`, secret from `.env`, 30-day expiry) used as a Bearer
token for REST calls and as the Socket.io handshake `auth.token`. This is
enough to give every collaborator a stable identity (name, color, permission
rows) across sessions on one browser without building a credential system.
This simplification is called out explicitly here and in `README.md` rather
than silently shipped.

### Undo/redo

`Y.UndoManager` scoped to the document's `Y.Text`, default configuration
(tracks only local-origin transactions, 500ms capture timeout to group
fast keystrokes into one undo step). Monaco's own undo/redo model stack is
disabled (`model.setEOL` aside, we intercept `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`
via Monaco command overrides) so there is exactly one undo stack, backed by
the CRDT, and it never undoes a remote peer's concurrent edit — which is the
entire point of scoping `UndoManager` to local origins.

---

## Consistency testing strategy (summary; full detail in README.md)

Because convergence is the core correctness property of this whole system,
it's tested at three levels:

1. **Unit**: `packages/server/tests/crdt-merge.test.ts` creates multiple
   in-memory `Y.Doc`s, applies interleaved/out-of-order/duplicate updates
   directly (no network), and asserts all replicas reach identical
   `toString()` output — proves the CRDT merge property in isolation.
2. **Integration**: `packages/server/tests/convergence.e2e.test.ts` spins up
   a real server (Express + Socket.io + an in-memory-only persistence stub)
   and drives two or more real `socket.io-client` connections against it,
   including deliberately: disconnecting one client mid-edit (simulated
   network partition), queuing local edits while it's down, reconnecting,
   and asserting the reconnected client's document converges byte-for-byte
   with the client that stayed connected. Latency is simulated by
   delaying/reordering emitted events with `setTimeout`, including sending
   B's older update *after* a newer one from A to prove the CRDT (not
   arrival order) determines the final merge.
3. **Manual**: documented step-by-step in README.md for running two real
   browser tabs against the docker-composed stack, killing one tab's
   network in devtools, typing in both, restoring the network, and visually
   confirming convergence — for anyone who wants to see it with their own
   eyes rather than trust the automated suite.
