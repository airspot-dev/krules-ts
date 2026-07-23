---
type: Validation
title: Batch atomic RMW — cross-backend validation
description: Empirical verification that callable read-modify-write inside batch().commit() is atomic against concurrent writers across all storage backends, with correct per-property events.
tags: [subject, batch, storage, atomicity, concurrency, validation]
timestamp: 2026-07-23T00:00:00Z
---

# Overview

Verification of the atomic-batch behaviour of the
[Subject batch API](subject-batch-atomic.md) across all five storage backends,
run against real PostgreSQL and Redis instances on Bun.

# Suite (11 checks per backend)

- **Functional** — callable resolved under lock; a mixed batch (plain set +
  callable + muted set + unchanged set + delete-existing + delete-missing)
  produces the correct final state and exactly the right **per-property** events
  in queue order; muted and unchanged sets emit nothing; a missing delete emits
  nothing; in-place object mutation via a callable preserves the old snapshot
  (old ≠ new).
- **Concurrency (regression guard)** — N writers run parallel batch increments
  on one property; the final counter must equal the total, proving no lost
  updates. A whole-batch retry cannot mask a lost update — a non-atomic
  implementation would still land on the wrong final count. The writers must
  exercise genuine contention against a *shared* backend: pooled connections for
  Postgres, a **single shared client** for Redis (see the guard-gap note below).

# Results

| Backend | Concurrency exercised | Result |
|---------|----------------------|--------|
| `bun-postgres` (Bun native SQL) | 8 pooled connections × 25 = 200 | 11/11 — counter = 200 |
| `postgres` (node, postgres.js) | 8 pooled connections × 25 = 200 | 11/11 — counter = 200 |
| `bun-redis` (Bun native) | 8 writers on 1 shared client × 25 = 200 | 11/11 — counter = 200 |
| `redis` (node, ioredis) | 8 writers on 1 shared client × 25 = 200 | 11/11 — counter = 200 |
| memory | 4 workers × 50 = 200 | 11/11 — counter = 200 |

PostgreSQL concurrency is genuine: the pool hands `sql.begin()` a separate
connection, so parallel commits truly contend on `SELECT … FOR UPDATE`. Redis
runs all writers on **one shared client** — the real usage pattern — so the
compare-and-set (`EVAL`) path faces real cross-writer conflicts on a single
socket.

# Guard gap fixed in 0.6.1

0.6.0's guard ran Redis with **one client per writer**. Independent connections
hid the actual defect: `WATCH/MULTI/EXEC` state is per-connection, so it only
corrupts under a *shared* connection — exactly the documented usage pattern the
per-writer guard never exercised. In production the collapse was total (N
concurrent `+1` → final value 1, not merely a few lost updates). 0.6.1 replaces
`WATCH/MULTI/EXEC` with a server-side compare-and-set (`EVAL`) and the guard now
runs on a **single shared client**, reproducing the failing pattern; it passes
at 200/200 on both Redis backends.

# Method

Standalone Bun scripts in the monorepo root drive a shared assertion suite
(`test-batch-shared.ts`). Postgres via `postgres://localhost/krules_test`, Redis
via `redis://localhost:6379` (both overridable through `PG_URL` / `REDIS_URL`).
Each script exits non-zero on any failed check (CI-friendly).

# Citations

[1] `packages/krules/src/subject/batch.ts` — implementation under test.
[2] `packages/krules/src/storage/apply-changes.ts` — shared resolution logic.
[3] `packages/krules/src/storage/redis-cas.ts` — shared Redis compare-and-set (EVAL) logic.
[4] `test-batch-shared.ts` and `test-batch-atomic-{memory,bun-postgres,postgres,bun-redis,redis}.ts` (monorepo root).
