---
type: Component
title: RedisStorage (ioredis backend)
description: ioredis-backed Redis storage for KRules subjects, driven by a caller-injected client that the caller owns.
resource: krules/storage/redis
tags: [storage, redis, ioredis]
timestamp: 2026-07-11T09:30:00Z
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

Callable values use ioredis pipelines/`multi()` with `WATCH/MULTI/EXEC` optimistic
locking, retrying on `WATCH` conflicts — the same semantics as the Bun-native
backend, expressed with the ioredis API.

# Citations

[1] `packages/krules/src/storage/redis.ts`
