# Update Log

## 2026-07-11
* **Creation**: seeded the OKF bundle for the `krules` package with the Redis storage backends and the connection-resilience work.
* **Creation**: [BunRedisStorage (Bun native)](concepts/storage-bun-redis.md) — Bun-native Redis backend with per-operation timeout + rebuild-on-failure resilience.
* **Creation**: [RedisStorage (ioredis)](concepts/storage-redis-ioredis.md) — ioredis backend with caller-owned client (documented alongside the Bun backend for completeness).
* **Creation**: [Validation: BunRedisStorage reconnection](concepts/validation-bun-redis-reconnection.md) — empirical recovery validation across outage and half-open freeze scenarios.
