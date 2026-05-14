# Completed Tasks

## disable-prepared-statement-bun-sql

**Date:** 2026-05-14
**Branch:** `feature/disable-prepared-statement-bun-sql`

Add an option to `createBunPostgresStorage` to disable Bun.SQL automatic prepared statements, so the storage can be used through transaction-mode connection poolers (e.g. Supabase Supavisor on port 6543) that fail with `prepared statement already exists`.

**What was done:**
- Added `preparedStatements?: boolean` (default `true`) to `BunPostgresStorageOptions` in `src/storage/bun-postgres.ts`.
- When the factory builds its own Bun.SQL client and `preparedStatements === false`, passes `{ url, prepare: false }` to the `SQL` constructor (Bun 1.3+ native option).
- Option is documented as ignored when a pre-built `sql` client is provided via `options.sql` — the caller is responsible for configuring that client.
