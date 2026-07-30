# Concepts

# Events

* [Event chain tracking (originId)](event-chain-origin-id.md) - ambient chain identifier propagated implicitly via AsyncLocalStorage, with getter + scope as the bridge across transport boundaries.

# Subject

* [Subject batch API (atomic RMW)](subject-batch-atomic.md) - batch() + the Storage.store() contract that resolves callables under the backend lock.

# Storage backends

* [BunRedisStorage (Bun native)](storage-bun-redis.md) - Bun-native Redis backend with self-healing connection resilience.
* [RedisStorage (ioredis)](storage-redis-ioredis.md) - ioredis-backed Redis storage using a caller-injected client.

# Validations

* [BunRedisStorage reconnection](validation-bun-redis-reconnection.md) - Empirical recovery validation across outage and half-open freeze scenarios.
* [Batch atomic RMW](validation-batch-atomic-rmw.md) - Cross-backend verification that batch callable RMW is atomic with no lost updates.
* [Origin id propagation](validation-origin-id-propagation.md) - Implicit inheritance across nested emits, Subject mutations and batch commits; isolation between concurrent chains.
