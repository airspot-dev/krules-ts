/**
 * BunRedisStorage - Redis-backed storage using Bun's native Redis client
 *
 * Uses Bun's built-in RedisClient for maximum performance.
 * No external dependencies required.
 *
 * Note: atomic read-modify-write for callable values uses a server-side
 * compare-and-set Lua script (EVAL) — see {@link file://./redis-cas.ts} for why
 * WATCH/MULTI/EXEC is unsafe on the shared (per-URL cached) connection this
 * backend uses.
 *
 * ## Connection resilience
 *
 * Bun's `RedisClient` reconnects automatically (`autoReconnect`), but only for a
 * finite `maxRetries` budget: once exhausted the client is permanently dead, and
 * because clients are cached per URL (`clientCache`) the dead instance would be
 * reused for the whole process lifetime. In addition, a frozen/unresponsive
 * server (e.g. Cloud Run CPU throttling, a silently dropped NAT mapping) can
 * leave a half-open connection that still reports `connected: true` while every
 * operation hangs forever — a state native reconnection never detects because no
 * close event fires.
 *
 * This storage therefore guarantees eventual recovery regardless of outage
 * length by wrapping every operation in a per-operation timeout and, on a
 * timeout or connection error, evicting the dead client from the cache,
 * rebuilding a fresh one and retrying once. See {@link BunRedisStorageOptions}
 * for the tunable knobs.
 *
 * @example
 * import { createBunRedisStorage } from 'krules/storage/bun-redis'
 *
 * const storageFactory = createBunRedisStorage({
 *   url: 'redis://localhost:6379',
 *   prefix: 'myapp:'
 * })
 *
 * const container = createKRulesContainer({ storageFactory })
 */

import type { Storage, StorageChanges, StoreResult, SetResult, DeleteResult, StorageFactory } from './types'
import {
  CAS_APPLY_SCRIPT,
  buildCasArgs,
  casApplied,
  casBackoffMs,
  prepareStore,
} from './redis-cas'

// Bun's native Redis client type
type BunRedisClient = {
  // String operations
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<number>

  // Raw command execution for all hash operations
  send(command: string, args: (string | number | Buffer)[]): Promise<unknown>

  // Connection
  close(): void
  connect?(): Promise<void>
  readonly connected?: boolean
}

/** Resolved connection options passed to Bun's RedisClient constructor. */
interface ResolvedClientOptions {
  autoReconnect: boolean
  maxRetries: number
  enableOfflineQueue: boolean
  /** Timeout (ms) applied to the proactive connect performed at build time. */
  connectTimeoutMs: number
}

export interface BunRedisStorageOptions {
  /** Redis URL (default: redis://localhost:6379) */
  url?: string
  /** Existing Bun RedisClient instance. When provided, resilience/rebuild is
   *  disabled for it (the caller owns its lifecycle, exactly like the ioredis
   *  backend) — only the per-operation timeout still applies. */
  client?: BunRedisClient
  /** Key prefix for all subjects (e.g., 'myapp:subjects:') */
  prefix?: string

  // ---- Connection resilience (URL-based clients only) --------------------
  /** Whether Bun reconnects automatically. Default: true. */
  autoReconnect?: boolean
  /** Native reconnection budget before Bun gives up. The rebuild layer is the
   *  real guarantee, so a modest value is fine. Default: 20. */
  maxRetries?: number
  /** Whether Bun queues commands while disconnected. Default: false, so an
   *  operation issued during an outage fails fast instead of waiting. */
  enableOfflineQueue?: boolean
  /**
   * Per-operation timeout in milliseconds. Guards against half-open/frozen
   * connections that never error and would otherwise hang forever. On timeout
   * the client is evicted and rebuilt. Default: 3000.
   */
  operationTimeoutMs?: number
  /**
   * Max attempts for an atomic read-modify-write before giving up under
   * sustained contention on the same property. Each retry re-reads, recomputes
   * the callable and re-applies the compare-and-set, with a small jittered
   * backoff. Default: 100.
   */
  atomicMaxRetries?: number
}

// Shared client per URL to avoid connection overhead. Stores the in-flight
// promise so concurrent first-callers share a single connection.
const clientCache = new Map<string, Promise<BunRedisClient>>()

/** Error thrown when an operation exceeds {@link BunRedisStorageOptions.operationTimeoutMs}. */
export class RedisOperationTimeoutError extends Error {
  constructor(ms: number) {
    super(`BunRedisStorage: Redis operation timed out after ${ms}ms`)
    this.name = 'RedisOperationTimeoutError'
  }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof RedisOperationTimeoutError
}

/** Heuristic: does this error mean the connection is dead and worth rebuilding? */
function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /Max reconnection attempts reached|Connection (has failed|is closed|closed|refused|reset)|offline queue|ECONNREFUSED|ECONNRESET|EPIPE|not connected|socket (closed|error)|reset by peer/i.test(
    msg,
  )
}

/**
 * Race a promise against a timeout. The underlying operation cannot be
 * cancelled (Bun's promises are not abortable), so on timeout we stop waiting
 * and let the dangling promise settle harmlessly; the caller rebuilds the
 * client so subsequent operations use a fresh connection.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RedisOperationTimeoutError(ms)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function createClient(url: string, opts: ResolvedClientOptions): Promise<BunRedisClient> {
  // Dynamic import to avoid errors if not running in Bun
  const { RedisClient } = await import('bun')
  const client = new RedisClient(url, {
    autoReconnect: opts.autoReconnect,
    maxRetries: opts.maxRetries,
    enableOfflineQueue: opts.enableOfflineQueue,
  }) as unknown as BunRedisClient

  // Proactively establish the connection before first use. Required when
  // enableOfflineQueue is false, otherwise the first operation could race the
  // lazy connect and fail. Time-boxed so a frozen server can't hang a rebuild.
  if (typeof client.connect === 'function') {
    await withTimeout(client.connect(), opts.connectTimeoutMs)
  }
  return client
}

function getClient(url: string, opts: ResolvedClientOptions): Promise<BunRedisClient> {
  let promise = clientCache.get(url)
  if (!promise) {
    // If the connection fails, drop the cached (rejected) promise so the next
    // call retries a fresh build rather than replaying the failure.
    promise = createClient(url, opts).catch((err) => {
      if (clientCache.get(url) === promise) clientCache.delete(url)
      throw err
    })
    clientCache.set(url, promise)
  }
  return promise
}

/**
 * Evict a client from the cache, but only if it is still the current one.
 * This prevents concurrent failing operations from tearing down a client that
 * another operation has already rebuilt (avoids rebuild churn under load).
 */
async function evictIfCurrent(url: string, failed: BunRedisClient): Promise<void> {
  const promise = clientCache.get(url)
  if (!promise) return
  try {
    const current = await promise
    if (current === failed) {
      clientCache.delete(url)
      try { current.close() } catch { /* already closed */ }
    }
  } catch {
    // Cached promise rejected: it is already being cleaned up by getClient.
    clientCache.delete(url)
  }
}

/**
 * Bun-native Redis storage implementation.
 * Uses Redis hashes for efficient property storage.
 */
export class BunRedisStorage implements Storage {
  private readonly prefix: string
  private readonly hashKey: string

  /** URL for cache-managed clients, or null when a client was injected. */
  private readonly url: string | null
  /** Injected client (caller-owned, not rebuilt), or null for URL-based. */
  private readonly injectedClient: BunRedisClient | null
  private readonly clientOptions: ResolvedClientOptions
  private readonly operationTimeoutMs: number
  private readonly atomicMaxRetries: number

  constructor(
    public readonly subjectName: string,
    options: BunRedisStorageOptions
  ) {
    this.prefix = options.prefix ?? 'krules:'
    this.hashKey = `${this.prefix}${subjectName}`
    this.operationTimeoutMs = options.operationTimeoutMs ?? 3000
    this.atomicMaxRetries = options.atomicMaxRetries ?? 100

    this.clientOptions = {
      autoReconnect: options.autoReconnect ?? true,
      maxRetries: options.maxRetries ?? 20,
      enableOfflineQueue: options.enableOfflineQueue ?? false,
      connectTimeoutMs: this.operationTimeoutMs,
    }

    if (options.client) {
      this.injectedClient = options.client
      this.url = null
    } else {
      this.injectedClient = null
      this.url = options.url ?? 'redis://localhost:6379'
    }
  }

  /** Resolve the client to use for the next operation. */
  private currentClient(): Promise<BunRedisClient> {
    if (this.injectedClient) return Promise.resolve(this.injectedClient)
    return getClient(this.url!, this.clientOptions)
  }

  /**
   * Run an idempotent operation with a per-operation timeout. On a timeout or
   * connection error against a cache-managed client, evict the dead client,
   * rebuild a fresh one and retry exactly once. Injected clients are never
   * rebuilt (the caller owns them) — only the timeout applies.
   */
  private async run<T>(fn: (client: BunRedisClient) => Promise<T>): Promise<T> {
    const canRebuild = this.injectedClient === null
    const maxAttempts = canRebuild ? 2 : 1
    let lastErr: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = await this.currentClient()
      try {
        return await withTimeout(fn(client), this.operationTimeoutMs)
      } catch (err) {
        lastErr = err
        const recoverable = isTimeoutError(err) || isConnectionError(err)
        if (!canRebuild || !recoverable || attempt === maxAttempts - 1) throw err
        // Dead or hung client: drop it so the retry builds a fresh connection.
        await evictIfCurrent(this.url!, client)
      }
    }
    throw lastErr
  }

  isPersistent(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  // ============================================
  // Immediate Operations
  // ============================================

  async get(property: string): Promise<unknown | undefined> {
    return this.run(async (client) => {
      const value = await client.send('HGET', [this.hashKey, property]) as string | null
      if (value === null) {
        return undefined
      }
      return JSON.parse(value)
    })
  }

  async set(property: string, value: unknown): Promise<SetResult> {
    // Handle callable values with atomic compare-and-set
    if (typeof value === 'function') {
      return this.setAtomic(property, value as (old: unknown) => unknown)
    }

    // Simple set is idempotent (last write wins), so it is safe to retry.
    return this.run(async (client) => {
      const oldValueRaw = await client.send('HGET', [this.hashKey, property]) as string | null
      const oldValue = oldValueRaw ? JSON.parse(oldValueRaw) : undefined

      await client.send('HSET', [this.hashKey, property, JSON.stringify(value)])

      return { newValue: value, oldValue }
    })
  }

  /**
   * Atomic set with optimistic compare-and-set for callable values.
   *
   * Resilience note: callable values are non-idempotent by design (their whole
   * purpose is a race-free read-modify-write of an existing value), so an
   * automatic retry must never risk re-applying `fn`. A failure is safe to retry
   * ONLY when it provably happened *before* the EVAL was dispatched — nothing
   * could have committed. Once EVAL is in flight the commit outcome is ambiguous
   * (a lost ack looks identical whether the server committed or died first),
   * regardless of whether the failure surfaces as a connection error or a
   * timeout, so we fail loudly instead of retrying. The client is still healed
   * for subsequent operations. A per-operation timeout is a nuisance-failure
   * guard, never a correctness mechanism for this decision.
   *
   * A CAS *conflict* (EVAL returned 0 — nothing written) is different: it
   * provably committed nothing, so it is safe to re-read, recompute and retry.
   */
  private async setAtomic(
    property: string,
    fn: (old: unknown) => unknown
  ): Promise<SetResult> {
    let rebuiltBeforeEval = false

    for (let attempt = 0; attempt < this.atomicMaxRetries; attempt++) {
      const client = await this.currentClient()
      // Flag flips to true the instant EVAL is dispatched; after that a failure
      // has an ambiguous commit outcome and must not be retried.
      const state = { evalDispatched: false }
      try {
        const outcome = await withTimeout(
          this.atomicAttempt(client, property, fn, state),
          this.operationTimeoutMs,
        )
        if (outcome === 'conflict') {
          const delay = casBackoffMs(attempt)
          if (delay > 0) await new Promise((r) => setTimeout(r, delay))
          continue
        }
        return outcome
      } catch (err) {
        // Heal the (possibly dead) client so future operations recover — this
        // does not re-apply anything.
        if (this.injectedClient === null) await evictIfCurrent(this.url!, client)

        const recoverable = isTimeoutError(err) || isConnectionError(err)
        const provablyNotCommitted = !state.evalDispatched

        // Transparent retry ONLY when the failure provably occurred before EVAL
        // (covers the stale/dead cached-client case safely). Otherwise fail loud.
        if (this.injectedClient === null && recoverable && provablyNotCommitted && !rebuiltBeforeEval) {
          rebuiltBeforeEval = true
          continue
        }
        throw err
      }
    }

    throw new Error(`Redis atomic set failed after ${this.atomicMaxRetries} retries`)
  }

  /**
   * A single compare-and-set attempt. Reads the value, computes the callable,
   * then applies it via EVAL only if the field still holds what we read. Returns
   * 'conflict' if a concurrent writer won. Sets `state.evalDispatched`
   * immediately before sending EVAL so the caller can tell a
   * provably-not-committed failure from an ambiguous one.
   */
  private async atomicAttempt(
    client: BunRedisClient,
    property: string,
    fn: (old: unknown) => unknown,
    state: { evalDispatched: boolean }
  ): Promise<SetResult | 'conflict'> {
    // Read the raw stored string; it doubles as the CAS "expected" value.
    const raw = (await client.send('HGET', [this.hashKey, property])) as string | null
    const parsedOldValue = raw != null ? JSON.parse(raw) : undefined

    // Snapshot oldValue BEFORE the closure runs, so in-place mutation
    // doesn't make oldValue === newValue (reference comparison)
    const oldValue = parsedOldValue != null && typeof parsedOldValue === 'object'
      ? structuredClone(parsedOldValue)
      : parsedOldValue

    const newValue = fn(parsedOldValue)

    const args = buildCasArgs({
      checks: [{ field: property, present: raw != null, expected: raw ?? '' }],
      sets: [[property, JSON.stringify(newValue)]],
      deletes: [],
    })

    // From here the commit outcome is ambiguous on failure: mark it before the
    // EVAL round-trip so the caller never retries a possibly-committed op.
    state.evalDispatched = true
    const result = await client.send('EVAL', [CAS_APPLY_SCRIPT, 1, this.hashKey, ...args])

    return casApplied(result) ? { newValue, oldValue } : 'conflict'
  }

  async delete(property: string): Promise<DeleteResult> {
    return this.run(async (client) => {
      const oldValueRaw = await client.send('HGET', [this.hashKey, property]) as string | null
      const oldValue = oldValueRaw ? JSON.parse(oldValueRaw) : undefined

      await client.send('HDEL', [this.hashKey, property])

      return { oldValue }
    })
  }

  async has(property: string): Promise<boolean> {
    return this.run(async (client) => {
      const exists = await client.send('HEXISTS', [this.hashKey, property])
      return exists === 1
    })
  }

  async keys(): Promise<string[]> {
    return this.run(async (client) => {
      const keys = await client.send('HKEYS', [this.hashKey])
      return (keys as string[]) ?? []
    })
  }

  // ============================================
  // Batch Operations
  // ============================================

  async load(): Promise<Record<string, unknown>> {
    return this.run(async (client) => {
      const raw = await client.send('HGETALL', [this.hashKey]) as Record<string, string> | null

      const result: Record<string, unknown> = {}

      // Bun's HGETALL returns an object { field: value, ... }
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
          result[key] = JSON.parse(value)
        }
      }

      return result
    })
  }

  async store(changes: StorageChanges): Promise<StoreResult> {
    if (changes.sets.length === 0 && changes.deletes.length === 0) {
      return { changed: [], deleted: [] }
    }

    // Read the referenced fields, compute callables, then apply through a
    // server-side compare-and-set. Same resilience model as setAtomic: on a
    // connection failure, retry only when it provably occurred before EVAL; a
    // CAS conflict (nothing written) is always safe to re-read and retry.
    const referenced = [
      ...new Set([...changes.sets.map(([p]) => p), ...changes.deletes]),
    ]
    let rebuiltBeforeEval = false

    for (let attempt = 0; attempt < this.atomicMaxRetries; attempt++) {
      const client = await this.currentClient()
      const state = { evalDispatched: false }
      try {
        const outcome = await withTimeout(
          this.storeAttempt(client, changes, referenced, state),
          this.operationTimeoutMs,
        )
        if (outcome === 'conflict') {
          const delay = casBackoffMs(attempt)
          if (delay > 0) await new Promise((r) => setTimeout(r, delay))
          continue
        }
        return outcome
      } catch (err) {
        if (this.injectedClient === null) await evictIfCurrent(this.url!, client)

        const recoverable = isTimeoutError(err) || isConnectionError(err)
        const provablyNotCommitted = !state.evalDispatched

        if (this.injectedClient === null && recoverable && provablyNotCommitted && !rebuiltBeforeEval) {
          rebuiltBeforeEval = true
          continue
        }
        throw err
      }
    }

    throw new Error(`Redis batch store failed after ${this.atomicMaxRetries} retries`)
  }

  /**
   * A single compare-and-set attempt for a batch store. Reads the referenced
   * fields, resolves callables, then applies HSET/HDEL via EVAL only if every
   * callable-derived field still holds what we read. Returns 'conflict' if a
   * concurrent writer won. Sets `state.evalDispatched` immediately before
   * sending EVAL so the caller can tell a provably-not-committed failure from an
   * ambiguous one.
   */
  private async storeAttempt(
    client: BunRedisClient,
    changes: StorageChanges,
    referenced: string[],
    state: { evalDispatched: boolean }
  ): Promise<StoreResult | 'conflict'> {
    const rawByField: Record<string, string | null> = {}
    if (referenced.length > 0) {
      const raw = (await client.send('HMGET', [this.hashKey, ...referenced])) as (string | null)[]
      referenced.forEach((property, i) => {
        rawByField[property] = raw[i] ?? null
      })
    }

    const { program, result } = prepareStore(changes, rawByField)

    // From here the commit outcome is ambiguous on failure: mark it before the
    // EVAL round-trip so the caller never retries a possibly-committed op.
    state.evalDispatched = true
    const execResult = await client.send('EVAL', [
      CAS_APPLY_SCRIPT,
      1,
      this.hashKey,
      ...buildCasArgs(program),
    ])

    return casApplied(execResult) ? result : 'conflict'
  }

  // ============================================
  // Cleanup
  // ============================================

  async flush(): Promise<void> {
    await this.run(async (client) => {
      await client.del(this.hashKey)
    })
  }
}

/**
 * Create a Bun-native Redis storage factory.
 *
 * @param options - Redis URL, prefix and connection-resilience configuration
 * @returns Storage factory function
 *
 * @example
 * import { createKRulesContainer } from 'krules'
 * import { createBunRedisStorage } from 'krules/storage/bun-redis'
 *
 * const container = createKRulesContainer({
 *   storageFactory: createBunRedisStorage({
 *     url: 'redis://localhost:6379',
 *     prefix: 'myapp:subjects:',
 *     // resilience knobs (defaults shown):
 *     // maxRetries: 20,
 *     // enableOfflineQueue: false,
 *     // operationTimeoutMs: 3000,
 *   }),
 * })
 *
 * // Now all subjects persist to Redis using Bun's native client
 * const user = container.subject('user:123')
 * await user.set('name', 'John')
 */
export function createBunRedisStorage(
  options: BunRedisStorageOptions = {}
): StorageFactory {
  return (subjectName: string) => new BunRedisStorage(subjectName, options)
}
