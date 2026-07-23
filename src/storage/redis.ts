/**
 * RedisStorage - Redis-backed storage for krules.ts
 *
 * Stores subject properties in Redis hashes.
 * Supports atomic operations via WATCH/MULTI/EXEC for callable values.
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
import { applyChanges } from './apply-changes'

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
  del(key: string): Promise<number>
  watch(key: string): Promise<'OK'>
  unwatch(): Promise<'OK'>
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
}

/**
 * Redis-backed storage implementation.
 * Uses Redis hashes for efficient property storage.
 */
export class RedisStorage implements Storage {
  private readonly client: RedisClient
  private readonly prefix: string
  private readonly hashKey: string

  constructor(
    public readonly subjectName: string,
    options: RedisStorageOptions
  ) {
    this.client = options.client
    this.prefix = options.prefix ?? 'krules:'
    this.hashKey = `${this.prefix}${subjectName}`
  }

  /**
   * Redis storage is persistent across restarts.
   */
  isPersistent(): boolean {
    return true
  }

  /**
   * Redis storage is concurrency-safe via WATCH/MULTI/EXEC.
   */
  isConcurrencySafe(): boolean {
    return true
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
   * Atomic set with optimistic locking for callable values.
   * Retries on conflict (WatchError).
   */
  private async setAtomic(
    property: string,
    fn: (old: unknown) => unknown
  ): Promise<SetResult> {
    const maxRetries = 10
    let retries = 0

    while (retries < maxRetries) {
      try {
        // Watch the hash key for changes
        await this.client.watch(this.hashKey)

        // Get current value
        const oldValueRaw = await this.client.hget(this.hashKey, property)
        const parsedOldValue = oldValueRaw ? JSON.parse(oldValueRaw) : undefined

        // Snapshot oldValue BEFORE the closure runs, so in-place mutation
        // doesn't make oldValue === newValue (reference comparison)
        const oldValue = parsedOldValue != null && typeof parsedOldValue === 'object'
          ? structuredClone(parsedOldValue)
          : parsedOldValue

        // Compute new value
        const newValue = fn(parsedOldValue)

        // Execute transaction
        const pipeline = this.client.multi()
        pipeline.hset(this.hashKey, property, JSON.stringify(newValue))

        const results = await pipeline.exec()

        // If results is null, another client modified the key (WatchError)
        if (results === null) {
          retries++
          continue
        }

        return { newValue, oldValue }
      } catch (error) {
        // Unwatch and rethrow
        await this.client.unwatch()
        throw error
      }
    }

    throw new Error(`Redis atomic set failed after ${maxRetries} retries`)
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

    // Callables in a batch make the write non-idempotent, so it must be
    // serialized with WATCH/MULTI/EXEC and retried on conflict (WatchError).
    const maxRetries = 10
    let retries = 0

    while (retries < maxRetries) {
      try {
        await this.client.watch(this.hashKey)

        // Read only the properties referenced by this batch.
        const referenced = [
          ...new Set([...changes.sets.map(([p]) => p), ...changes.deletes]),
        ]
        const current: Record<string, unknown> = {}
        if (referenced.length > 0) {
          const raw = await this.client.hmget(this.hashKey, ...referenced)
          referenced.forEach((property, i) => {
            const value = raw[i]
            if (value != null) current[property] = JSON.parse(value)
          })
        }

        const { newProperties, result } = applyChanges(current, changes)

        const pipeline = this.client.multi()
        const toSet: Record<string, string> = {}
        for (const [property] of changes.sets) {
          toSet[property] = JSON.stringify(newProperties[property])
        }
        if (Object.keys(toSet).length > 0) {
          pipeline.hset(this.hashKey, toSet)
        }
        if (changes.deletes.length > 0) {
          pipeline.hdel(this.hashKey, ...changes.deletes)
        }

        const results = await pipeline.exec()

        // null => another client modified the watched key (WatchError), retry.
        if (results === null) {
          retries++
          continue
        }

        return result
      } catch (error) {
        await this.client.unwatch()
        throw error
      }
    }

    throw new Error(`Redis batch store failed after ${maxRetries} retries`)
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
