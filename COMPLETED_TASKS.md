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

## Atomic batch read-modify-write

**Date:** 2026-07-23
**Branch:** `feature/caveat-su-batch-api`

Make callable read-modify-write inside `batch().commit()` atomic against concurrent writers. Previously the batch resolved callables against an unlocked snapshot (`load()` took no lock; only `store()` locked at commit), so a concurrent writer landing between the read and the commit caused a lost update. The fix moves callable resolution into the storage backend's locked transaction. Immediate-mode `set(prop, callable)` was already atomic; this brings the batch path in line.

**What was done:**
- Changed the `Storage` contract in `src/storage/types.ts`: `StorageChanges` from `{ inserts, updates, deletes }` to `{ sets, deletes }` (a `sets` value may be a callable `(old) => new`), and `store()` from `Promise<void>` to `Promise<StoreResult>` (`{ changed, deleted }` — materialized old/new computed under the lock). Breaking only for code implementing a custom `Storage` backend; consumers of the built-in backends just bump the version.
- Added `src/storage/apply-changes.ts`: shared pure resolver (callable execution, `structuredClone` snapshot of the old value before in-place mutation, change/delete detection) used by every backend for identical semantics.
- Reworked `src/subject/batch.ts`: removed the unlocked `load()`; passes callables through unresolved; emits one `SubjectPropertyChanged`/`SubjectPropertyDeleted` per property from the locked `store()` result, preserving queue order and the muted / unchanged / missing-delete rules (event API unchanged).
- Backends: Postgres (Bun `bun-postgres`, node `postgres`) resolve callables inside the existing `SELECT … FOR UPDATE` transaction; Redis (Bun `bun-redis`, node `redis`) batch `store()` now runs a `WATCH/MULTI/EXEC` optimistic loop with retry (was `MULTI/EXEC` with no `WATCH`); in-memory resolves on its single event loop.
- Updated `README.md` (Batch Operations now documents atomic callable RMW) and synced the `.okf/` bundle (new batch + validation concepts, updated both Redis concepts, refreshed indexes/log; `validate --strict` clean).
- Verified across all five backends with standalone Bun scripts in the monorepo root (`test-batch-shared.ts` + `test-batch-atomic-*.ts`): 11/11 each, including a concurrency guard (Postgres 8×25=200 over pooled `FOR UPDATE` connections; Redis 4×25=100 over independent `WATCH` clients; memory 4×50=200) with zero lost updates.
- Bumped package version `0.5.0` → `0.6.0` and published `krules@0.6.0` to npm.
