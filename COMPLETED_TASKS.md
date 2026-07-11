# Completed Tasks

## disable-prepared-statement-bun-sql

**Date:** 2026-05-14
**Branch:** `feature/disable-prepared-statement-bun-sql`

Add an option to `createBunPostgresStorage` to disable Bun.SQL automatic prepared statements, so the storage can be used through transaction-mode connection poolers (e.g. Supabase Supavisor on port 6543) that fail with `prepared statement already exists`.

**What was done:**
- Added `preparedStatements?: boolean` (default `true`) to `BunPostgresStorageOptions` in `src/storage/bun-postgres.ts`.
- When the factory builds its own Bun.SQL client and `preparedStatements === false`, passes `{ url, prepare: false }` to the `SQL` constructor (Bun 1.3+ native option).
- Option is documented as ignored when a pre-built `sql` client is provided via `options.sql` — the caller is responsible for configuring that client.

## BunRedisStorage automatic reconnection

**Date:** 2026-07-11
**Branch:** `feature/bun-redis-storage-reconnection`

Make `BunRedisStorage` self-heal across Redis/Valkey outages so long-running services no longer fail silently after a connection drops. Empirical investigation corrected the original diagnosis: Bun's native client does reconnect (`autoReconnect` on by default), but only for a finite `maxRetries` budget, after which the module-cached client is permanently dead; additionally a frozen/unresponsive server (Cloud Run CPU throttle, dropped NAT mapping) leaves a half-open connection that still reports `connected: true` while every operation hangs forever — a state native reconnection never detects.

**What was done:**
- Wrapped every operation in a per-operation timeout (`operationTimeoutMs`, default 3000ms) and, on a timeout or connection error, evict the dead client from `clientCache` (only if still current, to avoid rebuild churn), build a fresh one (`await connect()` up front) and retry once.
- Built clients with explicit resilience options (`autoReconnect`, `maxRetries` default 20, `enableOfflineQueue` false) exposed via `BunRedisStorageOptions`.
- Atomic callable values (`WATCH/MULTI/EXEC`) retry only when the failure provably occurred before `EXEC` was dispatched; once `EXEC` is in flight the commit outcome is ambiguous, so the operation fails loudly (no retry, for both timeouts and connection errors) to avoid double-applying the non-idempotent callable. The timeout is a nuisance-failure guard, not a correctness mechanism for this decision.
- Injected clients are treated as caller-owned (never rebuilt), consistent with the ioredis backend.
- Documented the resilience in `README.md`, seeded an `.okf/` knowledge bundle covering both Redis backends (Bun-native and ioredis) plus a validation concept, and added the Bun-native backend to the `krules-typescript` skill (previously undocumented).
- Verified end-to-end against real `redis-server` instances: recovery after kill/restart and long outages, bounded (non-hanging) behaviour under a half-open freeze, and exactly-once atomic semantics (a failed atomic during a freeze is not applied).
- Bumped package version `0.4.0` → `0.5.0`.
