# OT vs. CRDT: a comparison, grounded in this repo

This package is a small, from-scratch Operational Transformation (OT) engine
for plain-text insert/delete, built solely to compare against the Yjs CRDT
approach used everywhere else in this repository (`packages/server`,
`packages/client`). It is **not** wired into the main app.

## What's implemented here

- `src/ops.ts` — the four pairwise transform functions
  (insert/insert, insert/delete, delete/insert, delete/delete), each
  hand-derived and unit-tested against the TP1 convergence property
  (`tests/transform.test.ts`).
- `src/server.ts` — a minimal central sequencer (`OTServer`) in the
  Jupiter/Google Wave tradition: every op is transformed against whatever
  history the submitting client hadn't seen, then applied and assigned a
  position in a single total order.
- `tests/convergence.test.ts` — end-to-end convergence checks, including a
  200-round randomized interleaving of concurrent inserts/deletes from
  simulated clients at varying "lag" behind the server.
- `src/demo.ts` — a narrated walk-through (`npm run demo --workspace=packages/ot-demo`).

## Where this repo actually uses which approach

| | This repo's main app | This package |
|---|---|---|
| Merge strategy | Yjs CRDT (`Y.Text`, YATA algorithm) | hand-rolled OT (Jupiter-style) |
| Causality tracking | Yjs's built-in per-item IDs (`clientID, clock`) | a single server-assigned linear revision number |
| Where merge logic runs | Any replica, in any order (client & server both run identical `Y.applyUpdate`) | **only** the central `OTServer` — clients cannot correctly merge without it |

## The core structural difference

**OT requires a total order and a place to compute it.** `OTServer.receive`
transforms an incoming op against every op accepted since the client's
`baseRevision`. This is only correct if there is exactly one place doing
that transformation, with a consistent view of "everything accepted so
far." That's why classic OT systems (Google Wave, early Google Docs) are
built around a single sequencing server (or a designated leader) per
document — two servers independently transforming the same pair of
concurrent ops without coordinating are not guaranteed to agree on the
result. Contrast: **any** two Yjs replicas — two servers, two browser
tabs, a server and an offline laptop reconnecting a week later — can
`Y.applyUpdate()` each other's updates directly and are mathematically
guaranteed to converge, with no coordinator. That's precisely what let
`packages/server`'s room manager (`src/rooms/roomManager.ts`) treat every
server instance as just another replica connected via Redis pub/sub
(see `DESIGN.md` "Scaling"), instead of needing to elect one instance as
the sequencer for each document.

**Every op-pair-type combination needs its own hand-proven transform
function.** `transformDeleteInsert` in `src/ops.ts` has to explicitly
handle "the concurrently-inserted text landed inside the range I wanted to
delete" by *splitting* the delete into two ops around the surviving
insert — miss that case (or get the boundary condition wrong) and you get
silent data corruption: characters someone just typed get silently eaten
by someone else's delete. This is a real, well-documented historical
source of OT bugs. A sequence CRDT sidesteps the whole category: `Y.Text`
never reasons about numeric offsets at all — every character has a stable
identity and an anchor to its neighbors, so a concurrent insert and delete
simply can't collide the way two numeric ranges can. There is no
insert-inside-delete special case to get right, because there's no
"delete this numeric range" operation to begin with.

**Client-side complexity.** This demo's `OTClient` (`src/server.ts`) is
intentionally minimal — generate one op, submit it, wait for the ack —
specifically because implementing a client that can keep accepting local
keystrokes *while* an op is in flight and reconcile correctly once the ack
and any concurrent remote ops arrive (Google Wave's "GOT" algorithm) is
substantial additional machinery on top of everything in `src/ops.ts`.
Yjs's client story, in contrast, is "apply local edits to your `Y.Doc`
whenever you want, in any order, online or offline" — `packages/client`'s
`SocketIOProvider` (`src/yjs/SocketIOProvider.ts`) has no equivalent
reconciliation code at all; §"Offline editing" in `DESIGN.md` covers why
that's inherent to the CRDT model rather than something we happened not
to need.

**Metadata / storage.** Because Yjs tracks per-character identity, deleted
content becomes a tombstone until it's provably safe to garbage-collect
(handled automatically by `gc: true`, see `DESIGN.md` "Tombstone
compaction"). OT ops carry no such long-lived metadata — once transformed
and applied, an op is just gone — but that's only affordable *because* the
central server's op log is the source of truth; a client that was offline
for a long time can't just "catch up" the way a CRDT replica can (see
below).

**Offline support.** A Yjs replica can accumulate local edits indefinitely
while disconnected and merge them in one shot on reconnect (`Y.applyUpdate`
is commutative/associative/idempotent regardless of how stale the replica
is). An OT client that's been offline for a long time has a `baseRevision`
far behind the server's current revision; `OTServer.receive` still
_works_ (it just transforms against a longer slice of history), but real
production OT systems generally keep sessions short-lived and reconnect
aggressively specifically because the amount of history to transform
against, and the likelihood of subtle transform-function edge cases being
exercised, both grow with staleness.

## Why this repo uses Yjs, not the engine in this package

Given the project's constraints (Socket.io relay, multiple horizontally
scaled server instances via Redis pub/sub, offline editing, no single
elected sequencer), a CRDT is the structurally simpler choice — not because
OT is "wrong," but because OT's central-sequencer requirement fights
directly against the "no central lock, horizontally scalable" goals this
project set out to satisfy. This package exists to make that trade-off
concrete and testable rather than asserted.
