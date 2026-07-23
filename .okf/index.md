---
okf_version: "0.1"
---

# krules (TypeScript/Bun) — Knowledge Bundle

Knowledge-as-code bundle for the `krules` framework package. Coverage grows
per task; it currently documents the Redis storage backends, the connection
resilience work, and the atomic batch read-modify-write behaviour.

# Concepts

* [Subject batch API (atomic RMW)](concepts/subject-batch-atomic.md) - batch() and the Storage.store() contract that resolves callables under the backend lock.
* [Storage: BunRedisStorage (Bun native)](concepts/storage-bun-redis.md) - Bun-native Redis backend with self-healing connection resilience.
* [Storage: RedisStorage (ioredis)](concepts/storage-redis-ioredis.md) - ioredis-backed Redis storage using a caller-injected client.
* [Validation: BunRedisStorage reconnection](concepts/validation-bun-redis-reconnection.md) - Empirical validation of recovery across outage and freeze scenarios.
* [Validation: Batch atomic RMW](concepts/validation-batch-atomic-rmw.md) - Cross-backend verification that batch callable RMW is atomic with no lost updates.
