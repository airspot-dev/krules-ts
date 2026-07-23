---
type: Component
title: RedisStorage (ioredis backend)
description: ioredis-backed Redis storage for KRules subjects, driven by a caller-injected client that the caller owns.
resource: krules/storage/redis
tags: [storage, redis, ioredis]
timestamp: 2026-07-23T00:00:00Z
---

# Overview

`RedisStorage` persists Subject properties in Redis hashes using an **injected
ioredis client**. It is one of two Redis backends; the other is the Bun-native
[BunRedisStorage](storage-bun-redis.md). Prefer this backend on Node-compatible
deployments, or when you already manage an ioredis client (pub/sub, cluster,
sentinel) and want KRules to reuse it.

Exposed via `krules/storage/redis` (ioredis is an optional peer, imported
dynamically to keep it out of the default dependency graph):

```typescript
import { createRedisStorage } from "krules/storage/redis";
import Redis from "ioredis";

const storageFactory = createRedisStorage({
  client: new Redis(process.env.REDIS_URL),
  prefix: "myapp:",
});
```

# Connection ownership & resilience

The client is **caller-owned**: `RedisStorage` never creates, pools, closes or
rebuilds it. Reconnection is therefore delegated entirely to ioredis, which
**retries indefinitely by default** (`retryStrategy`) — so the permanent-death
and half-open hazards that motivated the Bun-native rebuild layer do not arise
here. If you need different reconnection behaviour, configure it on the ioredis
client you pass in.

This ownership difference is exactly why the resilience layer lives only in
[BunRedisStorage](storage-bun-redis.md): you must not rebuild a client you did
not create, and ioredis already provides the guarantee natively.

# Atomicity

Callable values are applied with a **server-side compare-and-set** Lua script
(`EVAL`): the value is read (`HGET`/`HMGET`), the callable is computed in JS, then
a single `EVAL` re-checks that each callable-derived field still holds the exact
string that was read and writes only if so — otherwise it returns a conflict and
the storage layer re-reads, recomputes and retries (with a small jittered
backoff, bounded by `atomicMaxRetries`, default 100). The retry is internal; the
application never sees a conflict. This covers both immediate
`set(prop, old => ...)` and **batch `store()` carrying callables** (see
[Subject batch API](subject-batch-atomic.md)). Non-callable `set` uses a plain
`multi()` pipeline (no `WATCH`, no mid-transaction `await`), which is safe.

**Why not `WATCH/MULTI/EXEC` (0.6.1 fix).** 0.6.0 used `WATCH/MULTI/EXEC`, but
that state is **per-connection** and this backend runs on the single injected
ioredis client shared by every subject. Concurrent atomic operations on that one
socket interleaved their `WATCH`/`MULTI`/`EXEC` (and plain) commands between
`await`s, corrupting the watch state and the queued command list, so isolation
collapsed under concurrency (N concurrent `+1` → final value 1). `EVAL` is a
single command executed atomically server-side, so it is immune to that
interleaving — correct on a shared connection and across processes. The CAS logic
is shared with the Bun-native backend in `krules/storage/redis-cas`.

# Citations

[1] `packages/krules/src/storage/redis.ts`
[2] `packages/krules/src/storage/redis-cas.ts` — shared compare-and-set (EVAL) logic
