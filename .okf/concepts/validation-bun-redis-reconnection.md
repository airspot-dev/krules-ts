---
type: Validation
title: BunRedisStorage reconnection — empirical validation
description: Empirical verification that BunRedisStorage recovers from Redis outages, long outages beyond the native retry budget, and half-open/frozen-server connections.
tags: [storage, redis, bun, resilience, validation]
timestamp: 2026-07-11T09:30:00Z
---

# Overview

Verification of the connection-resilience behaviour of
[BunRedisStorage](storage-bun-redis.md) on Bun 1.3.6, run against real
`redis-server` instances driven through kill/restart and SIGSTOP/SIGCONT.

# Findings (behaviour of the raw client, motivating the fix)

| Observation | Result |
|-------------|--------|
| Bun `autoReconnect` default | ON (the original bug report's premise was inaccurate). |
| Default `maxRetries: 10` | Finite budget (~31s, exponential backoff); once exhausted the client is permanently dead. |
| `maxRetries: 0` | Means **zero** retries (never recovers), NOT unbounded. No true "infinite" sentinel exists. |
| Module-level `clientCache` | Pins the dead client for the whole process → matches the "silently fails after a while" symptom. |
| Frozen/unresponsive server (SIGSTOP) | Half-open connection still reports `connected: true`; a raw operation **hangs forever** — native reconnection never fires (no close event). |

# Validated behaviour (with the fix)

Exercised end-to-end through `createBunRedisStorage` (`operationTimeoutMs` 1500ms):

- **Outage (kill + restart):** operations during the outage fail fast (bounded),
  and the first operation after the server returns **recovers** — no manual
  restart, independent of the native retry budget.
- **Half-open freeze (SIGSTOP server):** an operation is **bounded** (times out
  and rebuilds instead of hanging forever), and recovers once the server is
  responsive again (SIGCONT), with data intact.
- **Atomic callable values:** work normally and recover after a restart; on a
  timeout they are not blindly retried (avoids double-apply).

# Method

Self-contained Bun probe scripts spawn/kill/freeze their own `redis-server` on a
dedicated port. The client-freeze case uses `process.kill(pid, 'SIGSTOP')` on
both the server (to create the half-open condition) and, in earlier probes, a
worker process (to emulate Cloud Run CPU throttling). Every operation is wrapped
in a hard timeout so a hang is observable rather than stalling the run.

> Note: the reconnection guarantee rests on the **per-operation timeout**, since
> the half-open failure mode produces a hang, not an error — error detection
> alone would never trigger recovery.

# Citations

[1] `packages/krules/src/storage/bun-redis.ts` — implementation under test.
