/**
 * RedisStorage - Redis-backed storage for krules.ts
 *
 * Stores subject properties in Redis hashes.
 * Atomic read-modify-write for callable values uses a server-side
 * compare-and-set Lua script (EVAL) — see {@link file://./redis-cas.ts} for why
 * WATCH/MULTI/EXEC is unsafe on the shared connection this backend uses.
 *
 * @example
 * import Redis from 'ioredis'
 * import { createRedisStorage } from 'krules/storage/redis'
 *
 * const client = new Redis('redis://localhost:6379')
 * const storageFactory = createRedisStorage({ client, prefix: 'myapp:' })
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

// ioredis types - imported dynamically to keep it optional
type RedisClient = {
  hget(key: string, field: string): Promise<string | null>
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>
  hset(key: string, field: string, value: string): Promise<number>
  hset(key: string, map: Record<string, string>): Promise<number>
  hdel(key: string, ...fields: string[]): Promise<number>
  hexists(key: string, field: string): Promise<number>
  hkeys(key: string): Promise<string[]>
  hgetall(key: string): Promise<Record<string, string>>
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  del(key: string): Promise<number>
  multi(): RedisMulti
  duplicate(): RedisClient
  quit(): Promise<'OK'>
}

type RedisMulti = {
  hget(key: string, field: string): RedisMulti
  hset(key: string, field: string, value: string): RedisMulti
  hset(key: string, map: Record<string, string>): RedisMulti
  hdel(key: string, ...fields: string[]): RedisMulti
  exec(): Promise<Array<[Error | null, unknown]> | null>
}

export interface RedisStorageOptions {
  /** Redis client instance (ioredis) */
  client: RedisClient
  /** Key prefix for all subjects (e.g., 'myapp:subjects:') */
  prefix?: string
  /**
   * Max attempts for an atomic read-modify-write before giving up under
   * sustained contention on the same property. Each retry re-reads, recomputes
   * the callable and re-applies the compare-and-set, with a small jittered
   * backoff. Default: 100.
   */
  atomicMaxRetries?: number
}

/**
 * Redis-backed storage implementation.
 * Uses Redis hashes for efficient property storage.
 */
export class RedisStorage implements Storage {
  private readonly client: RedisClient
  private readonly prefix: string
  private readonly hashKey: string
  private readonly atomicMaxRetries: number

  constructor(
    public readonly subjectName: string,
    options: RedisStorageOptions
  ) {
    this.client = options.client
    this.prefix = options.prefix ?? 'krules:'
    this.hashKey = `${this.prefix}${subjectName}`
    this.atomicMaxRetries = options.atomicMaxRetries ?? 100
  }

  /**
   * Redis storage is persistent across restarts.
   */
  isPersistent(): boolean {
    return true
  }

  /**
   * Redis storage is concurrency-safe: atomic read-modify-write uses a
   * server-side compare-and-set (EVAL), which is correct even on the single
   * shared connection this backend uses and across processes.
   */
  isConcurrencySafe(): boolean {
    return true
  }

  /** Run the shared CAS Lua script on this subject's hash. */
  private evalCas(args: string[]): Promise<unknown> {
    return this.client.eval(CAS_APPLY_SCRIPT, 1, this.hashKey, ...args)
  }

  // ============================================
  // Immediate Operations
  // ============================================

  async get(property: string): Promise<unknown | undefined> {
    const value = await this.client.hget(this.hashKey, property)
    if (value === null) {
      return undefined
    }
    return JSON.parse(value)
  }

  async set(property: string, value: unknown): Promise<SetResult> {
    // Handle callable values with atomic WATCH/MULTI/EXEC
    if (typeof value === 'function') {
      return this.setAtomic(property, value as (old: unknown) => unknown)
    }

    // Simple set: get old value and set new value in pipeline
    const pipeline = this.client.multi()
    pipeline.hget(this.hashKey, property)
    pipeline.hset(this.hashKey, property, JSON.stringify(value))

    const results = await pipeline.exec()
    if (!results) {
      throw new Error('Redis transaction failed')
    }

    const oldValueRaw = results[0][1] as string | null
    const oldValue = oldValueRaw ? JSON.parse(oldValueRaw) : undefined

    return { newValue: value, oldValue }
  }

  /**
   * Atomic set with optimistic compare-and-set for callable values.
   * Reads the value, computes the callable, then applies it only if the field
   * still holds what we read (server-side CAS). Retries on conflict.
   */
  private async setAtomic(
    property: string,
    fn: (old: unknown) => unknown
  ): Promise<SetResult> {
    for (let attempt = 0; attempt < this.atomicMaxRetries; attempt++) {
      // Read the raw stored string; it doubles as the CAS "expected" value.
      const raw = await this.client.hget(this.hashKey, property)
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

      if (casApplied(await this.evalCas(args))) {
        return { newValue, oldValue }
      }

      // CAS mismatch: a concurrent writer won. Back off and retry.
      const delay = casBackoffMs(attempt)
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    }

    throw new Error(`Redis atomic set failed after ${this.atomicMaxRetries} retries`)
  }

  async delete(property: string): Promise<DeleteResult> {
    // Get old value first
    const oldValueRaw = await this.client.hget(this.hashKey, property)
    const oldValue = oldValueRaw ? JSON.parse(oldValueRaw) : undefined

    // Delete
    await this.client.hdel(this.hashKey, property)

    return { oldValue }
  }

  async has(property: string): Promise<boolean> {
    const exists = await this.client.hexists(this.hashKey, property)
    return exists === 1
  }

  async keys(): Promise<string[]> {
    return this.client.hkeys(this.hashKey)
  }

  // ============================================
  // Batch Operations
  // ============================================

  async load(): Promise<Record<string, unknown>> {
    const raw = await this.client.hgetall(this.hashKey)
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(raw)) {
      result[key] = JSON.parse(value)
    }

    return result
  }

  async store(changes: StorageChanges): Promise<StoreResult> {
    if (changes.sets.length === 0 && changes.deletes.length === 0) {
      return { changed: [], deleted: [] }
    }

    // Read the referenced fields, compute callables, then apply through a
    // server-side compare-and-set. Only callable-derived fields are CAS-guarded,
    // so a batch with no callables applies in one shot (never conflicts).
    const referenced = [
      ...new Set([...changes.sets.map(([p]) => p), ...changes.deletes]),
    ]

    for (let attempt = 0; attempt < this.atomicMaxRetries; attempt++) {
      const rawByField: Record<string, string | null> = {}
      if (referenced.length > 0) {
        const raw = await this.client.hmget(this.hashKey, ...referenced)
        referenced.forEach((property, i) => {
          rawByField[property] = raw[i] ?? null
        })
      }

      const { program, result } = prepareStore(changes, rawByField)

      if (casApplied(await this.evalCas(buildCasArgs(program)))) {
        return result
      }

      // CAS mismatch on a callable field: re-read, recompute and retry.
      const delay = casBackoffMs(attempt)
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    }

    throw new Error(`Redis batch store failed after ${this.atomicMaxRetries} retries`)
  }

  // ============================================
  // Cleanup
  // ============================================

  async flush(): Promise<void> {
    await this.client.del(this.hashKey)
  }
}

/**
 * Create a Redis storage factory.
 *
 * @param options - Redis client and prefix configuration
 * @returns Storage factory function
 *
 * @example
 * import Redis from 'ioredis'
 * import { createKRulesContainer } from 'krules'
 * import { createRedisStorage } from 'krules/storage/redis'
 *
 * const client = new Redis('redis://localhost:6379')
 *
 * const container = createKRulesContainer({
 *   storageFactory: createRedisStorage({
 *     client,
 *     prefix: 'myapp:subjects:',
 *   }),
 * })
 *
 * // Now all subjects persist to Redis
 * const user = container.subject('user:123')
 * await user.set('name', 'John')  // Stored in Redis hash 'myapp:subjects:user:123'
 */
export function createRedisStorage(options: RedisStorageOptions): StorageFactory {
  return (subjectName: string) => new RedisStorage(subjectName, options)
}
