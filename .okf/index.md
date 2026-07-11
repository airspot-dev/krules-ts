---
okf_version: "0.1"
---

# krules (TypeScript/Bun) — Knowledge Bundle

Knowledge-as-code bundle for the `krules` framework package. Coverage grows
per task; this seed documents the Redis storage backends and the connection
resilience work.

# Concepts

* [Storage: BunRedisStorage (Bun native)](concepts/storage-bun-redis.md) - Bun-native Redis backend with self-healing connection resilience.
* [Storage: RedisStorage (ioredis)](concepts/storage-redis-ioredis.md) - ioredis-backed Redis storage using a caller-injected client.
* [Validation: BunRedisStorage reconnection](concepts/validation-bun-redis-reconnection.md) - Empirical validation of recovery across outage and freeze scenarios.
