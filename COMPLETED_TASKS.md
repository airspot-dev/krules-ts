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

## Redis atomic RMW: compare-and-set instead of WATCH/MULTI/EXEC

**Date:** 2026-07-23
**Branch:** `feature/caveat-su-batch-api`

Fix a regression in the 0.6.0 Redis path found during production rollout: atomic read-modify-write collapsed under concurrency on a shared connection. The 0.6.0 code ran `WATCH/MULTI/EXEC` on the single shared client (ioredis is one socket; the Bun backend caches one client per URL). That state is per-connection, so concurrent operations on one socket interleaved between `await`s and isolation broke completely — N concurrent `+1` updates on one property landed a final value of 1, not N. Postgres (pooled `SELECT … FOR UPDATE`) was unaffected. The 0.6.0 concurrency guard missed it because it used one client *per writer*; independent connections never exercise the shared-connection failure.

**What was done:**
- Added `src/storage/redis-cas.ts`: a shared server-side compare-and-set Lua script (`EVAL`) plus helpers, the Redis analogue of `apply-changes.ts`. `EVAL` runs the whole script atomically server-side as a single command, so it is correct on a shared connection and across processes. The callable is computed client-side; the script CAS-guards only callable-derived fields (concrete sets/deletes stay unconditional, matching immediate mode) and returns a conflict on mismatch.
- Rewrote the atomic paths in `src/storage/redis.ts` (ioredis) and `src/storage/bun-redis.ts` (Bun native) — both immediate `setAtomic` and batch `store()` — to read, compute, then apply via `EVAL`/CAS with an internal retry loop (jittered backoff, bounded by the new `atomicMaxRetries` option, default 100). The application never sees a conflict. Bun-native keeps its timeout/rebuild resilience and the "don't retry after dispatch" guard (now keyed on `EVAL` dispatch); a CAS conflict is always safe to retry.
- Reworked the concurrency guard to run on a **single shared client** (the real usage pattern that exposed the bug) — 8 writers × 25 = 200 on one property, for both Redis backends.
- Updated `README.md` (three Redis atomicity references now describe the `EVAL` CAS) and synced the `.okf/` bundle (both Redis concepts, the batch concept's locking table, and the validation concept with a guard-gap note; `validate --strict` clean).
- Verified locally against real Redis and Postgres: 11/11 on all five backends, including the shared-client Redis guard now closing at 200/200 (the exact scenario that produced 1 before the fix). Fix confirmed in the reported production case.
- Bumped package version `0.6.0` → `0.6.1` and published `krules@0.6.1` to npm.

## Event chain tracking via originId

**Date:** 2026-07-30
**Branch:** `feature/introduce-origin-id-for-transparent-event-chain-tracking`

Give every event an `originId` identifying the event *chain* it belongs to — the whole causal sequence triggered, directly or indirectly, by a single originating request — so an implicit `subject-property-changed` fired three handlers deep can be correlated with the request that caused it. The id propagates implicitly: callers never thread it through `emit()`, `set()` or `delete()`. Port of the mechanism already present in the Python framework, aligned in semantics but spelled in TypeScript camelCase.

**What was done:**
- Added `src/origin.ts`, a leaf module built on `AsyncLocalStorage` (`node:async_hooks`, native in Bun — the runtime equivalent of Python's `contextvars.ContextVar`), with no external dependency. Public API: `getOriginId()`, `withOriginId(value, fn)` (explicit id or auto-generated; the callback receives the resolved id), `generateOriginId()`, and the low-level `enterOriginScope()` / `exitOriginScope()` pair for entry points that cannot wrap their work in a callback.
- Added `originId: string` to `EventContext` (typed, always populated) and reworked `EventBus.emit()`: it inherits an already-active chain, or opens a fresh root chain wrapping the whole dispatch when none is active. Body extracted into a private `dispatchEvent(originId, …)`.
- Implicit events inherit with no code of their own — `Subject.set/delete/flush`, `BatchBuilder.commit()` and nested `ctx.emit()` all funnel through `EventBus.emit()`, so `subject.ts` and `batch.ts` were left untouched. `Subject` gains no origin-id surface: the id is ambient, not state, and is independent of `extra`.
- Exposed the API from the package barrel and as a new `krules/origin` subpath export.
- Documented in `README.md` (new "Event Chain Tracking" section: propagation guarantee, explicit vs auto-generated id, concurrent isolation, and the manual bridge across transport boundaries the framework does not own) plus `ctx.originId` in the built-in-events reference.
- Added `src/origin.test.ts` (12 checks): implicit inheritance across nested emits / `Subject.set()` / batch commits, isolation between two interleaved concurrent chains on a shared subject, scope hygiene (no leak, nested restore, low-level pair), and the absence of any origin-id member on `Subject`. Whole suite green at 39/39 with `tsc --noEmit` clean.
- Synced the `.okf/` bundle: new component and validation concepts, refreshed indexes and log; `validate --strict` clean.
- Bumped package version `0.6.1` → `0.7.0` (additive, backward compatible).

Known limit, documented rather than papered over: `AsyncLocalStorage` follows the async flow of one process, so propagation is automatic only there. Across brokers, schedulers or HTTP hops the id must be carried as data and re-seeded with `withOriginId()` — this package ships no CloudEvents layer to wire it automatically, unlike the Python framework.

## The krules-typescript skill mounted as a production submodule

**Date:** 2026-08-03

This repository produces the `krules-typescript` skill, which until now lived in an
unrelated monorepo with nothing connecting the two. It is now mounted at
`.claude/skills/krules-typescript` from `krules-typescript-skill`, and a new `CLAUDE.md`
carries the rule that keeps the two in step.

**Why it was needed.** The skill had drifted two releases behind: it still described Redis
atomicity as `WATCH/MULTI/EXEC`, the mechanism replaced in 0.6.1 precisely because its
per-connection state silently lost concurrent writes on a shared connection, and it did not
mention `originId` at all. Both were fixed from this repository's own knowledge bundle
before the link was made.

**The signal is checkable rather than discretionary.** The skill declares a package version
that must match `package.json`, and `.okf/log.md` records behavioural changes entry by
entry. A release that moves the version without touching the skill is a verifiable
mismatch.

**`CLAUDE.md` is written for a public repository from the start:** project identity,
layout, the pointer to the knowledge bundle, and the co-evolution rule. No internal
workspace configuration, no local paths, no references to private aggregators.
