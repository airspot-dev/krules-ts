---
type: Component
title: BunRedisStorage (Bun native Redis backend)
description: Bun-native Redis storage backend for KRules subjects, with per-operation timeout and rebuild-on-failure connection resilience.
resource: krules/storage/bun-redis
tags: [storage, redis, bun, resilience]
timestamp: 2026-07-23T00:00:00Z
---

# Overview

`BunRedisStorage` persists Subject properties in Redis hashes using Bun's
built-in `RedisClient` (zero external dependencies). It is one of two Redis
backends; the other is the ioredis-based [RedisStorage](storage-redis-ioredis.md).
Choose this one on Bun deployments for lower overhead; choose ioredis when you
already manage an ioredis client or need its ecosystem.

Exposed via `krules/storage/bun-redis`:

```typescript
import { createBunRedisStorage } from "krules/storage/bun-redis";

const storageFactory = createBunRedisStorage({
  url: "redis://localhost:6379",
  prefix: "myapp:subjects:",
});
```

Unlike the ioredis backend (which receives a caller-owned client), this backend
**creates and pools the client internally**, cached per URL in a module-level
`clientCache`. That ownership is what makes the resilience layer below both
possible and necessary.

# Connection resilience

Bun's `RedisClient` reconnects automatically (`autoReconnect`) but only for a
finite `maxRetries` budget (~31s at the default of 10, exponential backoff);
once exhausted the cached client is **permanently dead** and would be reused for
the whole process lifetime. Additionally, a frozen/unresponsive server (Cloud
Run CPU throttling, a silently dropped NAT mapping) can leave a **half-open
connection that still reports `connected: true` while every operation hangs
forever** — native reconnection never detects it because no close event fires.

The backend therefore guarantees eventual recovery regardless of outage length:

- Every operation runs under a **per-operation timeout** (`operationTimeoutMs`).
- On a timeout **or** a connection error, the dead client is evicted from
  `clientCache` (only if it is still the current one — avoids rebuild churn), a
  fresh client is built (`await connect()` up front), and the operation is
  retried once.
- The proactive `connect()` avoids a lazy-connect race when
  `enableOfflineQueue` is `false`.

A per-operation timeout is essential, not optional: the half-open failure mode
is a hang, not an error, so error-detection alone would never trigger recovery.

# Options

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `url` | string | `redis://localhost:6379` | Redis URL (cache-managed client). |
| `client` | BunRedisClient | — | Inject a caller-owned client; never rebuilt (only timeout applies). |
| `prefix` | string | `krules:` | Key prefix for all subjects. |
| `autoReconnect` | boolean | `true` | Bun's native reconnection. |
| `maxRetries` | number | `20` | Native reconnect budget; the rebuild layer is the real guarantee. |
| `enableOfflineQueue` | boolean | `false` | Fail fast during an outage instead of queueing (which can hang). |
| `operationTimeoutMs` | number | `3000` | Guards against half-open/frozen connections that never error. |
| `atomicMaxRetries` | number | `100` | Max compare-and-set attempts for an atomic RMW before failing under sustained same-property contention. |

# Retry safety

- Idempotent operations (`get`, non-callable `set`, `delete`, `has`, `keys`,
  `load`) are retried freely after a rebuild — last write wins.
- Atomic callable values — immediate `set(prop, old => ...)` **and batch
  `store()` carrying callables** (see [Subject batch API](subject-batch-atomic.md))
  — are applied with a **server-side compare-and-set** Lua script (`EVAL`; shared
  with the ioredis backend in `krules/storage/redis-cas`). They are
  non-idempotent by design, so an automatic retry must never risk re-applying the
  callable. The attempt tracks whether `EVAL` was dispatched:
  - Failure **before** `EVAL` (HGET/HMGET error or timeout) → nothing could have
    committed → safe transparent retry once (covers the stale/dead cached-client
    case).
  - Failure **at/after** `EVAL` → commit outcome is ambiguous (a lost ack is
    indistinguishable from a pre-commit death), so **fail loudly** — no retry,
    for both timeouts and connection errors. The client is still healed for
    subsequent operations.
  - `EVAL` returning `0` (CAS mismatch — a concurrent writer won) is a provable
    abort: nothing was written, so the storage layer re-reads, recomputes and
    retries with a jittered backoff, up to `atomicMaxRetries` (default 100).
  A per-operation timeout is a nuisance-failure guard, not a correctness
  mechanism for this decision.
- An injected `client` is treated as caller-owned and is never rebuilt.

**Why compare-and-set, not `WATCH/MULTI/EXEC` (0.6.1 fix).** 0.6.0 used
`WATCH/MULTI/EXEC`, whose state is **per-connection**; because this backend caches
one client per URL, every subject shares it, and concurrent atomic operations on
that shared connection interleaved and corrupted each other (isolation collapsed
under concurrency — N concurrent `+1` → final value 1). `EVAL` runs atomically
server-side as a single command, immune to that interleaving.

# Validation

Recovery across kill/restart, long-outage and half-open freeze scenarios is
verified empirically — see
[Validation: BunRedisStorage reconnection](validation-bun-redis-reconnection.md).

# Citations

[1] `packages/krules/src/storage/bun-redis.ts`
[2] `packages/krules/src/storage/redis-cas.ts` — shared compare-and-set (EVAL) logic
[3] `packages/krules/README.md` — "High Performance with Bun Native Drivers" › "Connection resilience"
