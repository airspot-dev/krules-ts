---
type: Component
title: Subject batch API (atomic read-modify-write)
description: The batch() fluent API and the Storage.store() contract that resolves callable values under the backend lock, making batch read-modify-write atomic against concurrent writers.
resource: krules/subject/batch
tags: [subject, batch, storage, atomicity, concurrency]
timestamp: 2026-07-23T00:00:00Z
---

# Overview

`subject.batch()` accumulates property changes and persists them together on
`.commit()` — a single, all-or-nothing storage write instead of one round-trip
per property. Events are emitted only after the write succeeds.

```typescript
await user.batch()
  .set("status", "active")
  .set("visits", (n) => (n || 0) + 1)   // atomic read-modify-write
  .delete("reset_token")
  .commit();
```

# Atomic callable resolution (the store() contract)

A callable passed to `.set(prop, old => new)` is a read-modify-write. Since 0.6.0
the callable is **resolved by the storage backend inside the same locked
transaction that persists the batch**, so batch RMW is atomic against concurrent
writers — no lost updates.

Before 0.6.0 the batch pre-resolved callables against an **unlocked snapshot**
(`load()` took no lock; only `store()` locked at commit), so a concurrent writer
landing between the read and the commit produced a lost update. The fix moves
callable resolution into `store()`, under the lock.

This is encoded in the `Storage` contract (`krules/storage/types`):

- `StorageChanges` = `{ sets, deletes }`. A value in `sets` may be a concrete
  value **or** a callable `(old) => new`; the backend decides insert-vs-update
  and resolves callables under the lock. (Before 0.6.0 it was
  `{ inserts, updates, deletes }` carrying already-resolved values.)
- `store(changes)` returns `StoreResult` = `{ changed, deleted }` — the
  materialized old/new values computed under the lock, so `commit()` can emit
  accurate **per-property** `SubjectPropertyChanged` / `SubjectPropertyDeleted`
  events. The event API is unchanged.

The shared resolution logic (callable execution, in-place-mutation snapshotting
via `structuredClone`, change/delete detection) lives in
`krules/storage/apply-changes` and is used by every backend so semantics are
identical.

> **Breaking change (0.6.0)** — only for code that implements a custom `Storage`
> backend: `StorageChanges` shape and the `store()` return type changed.
> Consumers using the built-in backends need only bump the version.

# Per-backend locking

| Backend | Batch lock |
|---------|-----------|
| PostgreSQL — Bun ([bun-postgres]) and node (`postgres`) | `SELECT … FOR UPDATE` inside `sql.begin()` |
| Redis — Bun ([BunRedisStorage](storage-bun-redis.md)) and node ([RedisStorage](storage-redis-ioredis.md)) | server-side compare-and-set (`EVAL`/Lua) with retry |
| In-memory | single event loop, no lock needed |

For a single-property atomic RMW without a batch, `set(prop, callable)` in
immediate mode is atomic by the same mechanism.

> **Redis mechanism (0.6.1)** — the Redis backends apply the RMW with a
> server-side compare-and-set Lua script (`EVAL`), **not** `WATCH/MULTI/EXEC`.
> 0.6.0 shipped the `WATCH/MULTI/EXEC` optimistic loop, but that state is
> **per-connection** and both Redis backends use a *shared* connection (ioredis
> is a single socket; the Bun backend caches one client per URL). Under
> concurrent writers on that shared connection the transactions interleaved
> between `await`s and isolation collapsed — N concurrent `+1` updates on one
> property landing a final value of 1. `EVAL` runs the whole script atomically
> server-side as a **single command**, immune to that interleaving: correct on a
> shared connection and across processes. The callable is computed client-side,
> then the script CAS-guards only the callable-derived fields (concrete sets /
> deletes are unconditional) and retries on mismatch. Shared logic lives in
> `krules/storage/redis-cas`. See the two Redis backend concepts for detail.

# Validation

Verified across all five backends — see
[Validation: batch atomic RMW](validation-batch-atomic-rmw.md).

# Citations

[1] `packages/krules/src/subject/batch.ts`
[2] `packages/krules/src/storage/types.ts` — `StorageChanges`, `StoreResult`, `Storage.store()`
[3] `packages/krules/src/storage/apply-changes.ts` — shared resolution logic
[4] `packages/krules/src/storage/redis-cas.ts` — shared Redis compare-and-set (EVAL) logic
[5] `packages/krules/README.md` — "Batch Operations"

[bun-postgres]: krules/storage/bun-postgres
