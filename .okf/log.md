# Update Log

## 2026-07-30
* **Feature (0.7.0)**: event-chain tracking. Every event now carries `ctx.originId`, the identifier of the causal chain it belongs to, propagated implicitly via `AsyncLocalStorage` — nested `ctx.emit()`, `Subject.set/delete/flush` and batch commits all inherit it with no manual threading. New leaf module `krules/origin` (`getOriginId`, `withOriginId`, `generateOriginId`, `enterOriginScope`/`exitOriginScope`), also exposed as the `krules/origin` subpath. Port of the Python `origin_id` mechanism, aligned conceptually but using TypeScript camelCase.
  * **Creation**: [Event chain tracking (originId)](concepts/event-chain-origin-id.md) — propagation model, public API, the transport-boundary bridge (no CloudEvents layer in this package), and the cross-framework naming rationale.
  * **Creation**: [Validation: origin id propagation](concepts/validation-origin-id-propagation.md) — 12 checks covering implicit inheritance, concurrent isolation, scope hygiene and the absence of any origin-id surface on `Subject`.

## 2026-07-23
* **Fix (0.6.1)**: Redis atomic read-modify-write moved from `WATCH/MULTI/EXEC` to a server-side compare-and-set Lua script (`EVAL`). The `WATCH/MULTI/EXEC` state is per-connection, and both Redis backends use a *shared* connection, so concurrent writers on one socket interleaved and isolation collapsed (N concurrent `+1` → final value 1). New shared logic in `krules/storage/redis-cas`.
  * **Update**: [RedisStorage (ioredis)](concepts/storage-redis-ioredis.md) and [BunRedisStorage (Bun native)](concepts/storage-bun-redis.md) — Atomicity/Retry-safety rewritten for the CAS (`EVAL`) mechanism; added `atomicMaxRetries` (default 100) with jittered-backoff retry.
  * **Update**: [Subject batch API (atomic RMW)](concepts/subject-batch-atomic.md) — per-backend locking table now lists CAS (`EVAL`) for Redis, with the shared-connection rationale.
  * **Update**: [Validation: Batch atomic RMW](concepts/validation-batch-atomic-rmw.md) — concurrency guard rerun on a **single shared Redis client** (8 × 25 = 200 on both backends); added the guard-gap note explaining why the 0.6.0 per-writer-client guard missed the defect.
* **Creation**: [Subject batch API (atomic RMW)](concepts/subject-batch-atomic.md) — documents the 0.6.0 fix making batch callable read-modify-write atomic under the backend lock, and the changed `Storage` contract (`StorageChanges = {sets, deletes}`, `store() → StoreResult`).
* **Creation**: [Validation: Batch atomic RMW](concepts/validation-batch-atomic-rmw.md) — cross-backend verification (memory, bun/node Postgres, bun/node Redis) that concurrent batch RMW has no lost updates, with correct per-property events.
* **Update**: [BunRedisStorage (Bun native)](concepts/storage-bun-redis.md) — batch `store()` carrying callables now runs the `WATCH/MULTI/EXEC` non-idempotent path (moved out of the freely-retried idempotent set); timestamp refreshed.
* **Update**: [RedisStorage (ioredis)](concepts/storage-redis-ioredis.md) — Atomicity section notes batch `store()` now resolves callables under `WATCH/MULTI/EXEC`; timestamp refreshed.

## 2026-07-11
* **Creation**: seeded the OKF bundle for the `krules` package with the Redis storage backends and the connection-resilience work.
* **Creation**: [BunRedisStorage (Bun native)](concepts/storage-bun-redis.md) — Bun-native Redis backend with per-operation timeout + rebuild-on-failure resilience.
* **Creation**: [RedisStorage (ioredis)](concepts/storage-redis-ioredis.md) — ioredis backend with caller-owned client (documented alongside the Bun backend for completeness).
* **Creation**: [Validation: BunRedisStorage reconnection](concepts/validation-bun-redis-reconnection.md) — empirical recovery validation across outage and half-open freeze scenarios.
