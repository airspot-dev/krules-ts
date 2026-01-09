/**
 * BunRedisStorage - Redis-backed storage using Bun's native Redis client
 *
 * Uses Bun's built-in RedisClient for maximum performance.
 * No external dependencies required.
 *
 * Note: Atomic operations (callable values) use raw WATCH/MULTI/EXEC
 * commands since Bun's Redis client doesn't have native transaction support.
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

import type { Storage, StorageChanges, SetResult, DeleteResult, StorageFactory } from './types'

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
}

export interface BunRedisStorageOptions {
  /** Redis URL (default: redis://localhost:6379) */
  url?: string
  /** Existing Bun RedisClient instance */
  client?: BunRedisClient
  /** Key prefix for all subjects (e.g., 'myapp:subjects:') */
  prefix?: string
}

// Shared client per URL to avoid connection overhead
const clientCache = new Map<string, BunRedisClient>()

async function getClient(url: string): Promise<BunRedisClient> {
  if (clientCache.has(url)) {
    return clientCache.get(url)!
  }

  // Dynamic import to avoid errors if not running in Bun
  const { RedisClient } = await import('bun')
  const client = new RedisClient(url) as unknown as BunRedisClient
  clientCache.set(url, client)
  return client
}

/**
 * Bun-native Redis storage implementation.
 * Uses Redis hashes for efficient property storage.
 */
export class BunRedisStorage implements Storage {
  private client: BunRedisClient | null = null
  private readonly clientPromise: Promise<BunRedisClient>
  private readonly prefix: string
  private readonly hashKey: string

  constructor(
    public readonly subjectName: string,
    options: BunRedisStorageOptions
  ) {
    this.prefix = options.prefix ?? 'krules:'
    this.hashKey = `${this.prefix}${subjectName}`

    if (options.client) {
      this.client = options.client
      this.clientPromise = Promise.resolve(options.client)
    } else {
      const url = options.url ?? 'redis://localhost:6379'
      this.clientPromise = getClient(url)
    }
  }

  private async getClient(): Promise<BunRedisClient> {
    if (this.client) return this.client
    this.client = await this.clientPromise
    return this.client
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
    const client = await this.getClient()
    const value = await client.send('HGET', [this.hashKey, property]) as string | null
    if (value === null) {
      return undefined
    }
    return JSON.parse(value)
  }

  async set(property: string, value: unknown): Promise<SetResult> {
    const client = await this.getClient()

    // Handle callable values with atomic WATCH/MULTI/EXEC
    if (typeof value === 'function') {
      return this.setAtomic(property, value as (old: unknown) => unknown)
    }

    // Get old value first
    const oldValueRaw = await client.send('HGET', [this.hashKey, property]) as string | null
    const oldValue = oldValueRaw ? JSON.parse(oldValueRaw) : undefined

    // Set new value
    await client.send('HSET', [this.hashKey, property, JSON.stringify(value)])

    return { newValue: value, oldValue }
  }

  /**
   * Atomic set with optimistic locking for callable values.
   * Uses raw WATCH/MULTI/EXEC commands.
   */
  private async setAtomic(
    property: string,
    fn: (old: unknown) => unknown
  ): Promise<SetResult> {
    const client = await this.getClient()
    const maxRetries = 10
    let retries = 0

    while (retries < maxRetries) {
      // Watch the hash key for changes
      await client.send('WATCH', [this.hashKey])

      try {
        // Get current value
        const oldValueRaw = await client.send('HGET', [this.hashKey, property]) as string | null
        const oldValue = oldValueRaw ? JSON.parse(oldValueRaw) : undefined

        // Compute new value
        const newValue = fn(oldValue)

        // Start transaction
        await client.send('MULTI', [])

        // Queue the HSET command
        await client.send('HSET', [this.hashKey, property, JSON.stringify(newValue)])

        // Execute transaction
        const result = await client.send('EXEC', [])

        // If result is null, another client modified the key
        if (result === null) {
          retries++
          continue
        }

        return { newValue, oldValue }
      } catch (error) {
        // Unwatch and rethrow
        await client.send('DISCARD', []).catch(() => {})
        throw error
      }
    }

    throw new Error(`Redis atomic set failed after ${maxRetries} retries`)
  }

  async delete(property: string): Promise<DeleteResult> {
    const client = await this.getClient()

    // Get old value first
    const oldValueRaw = await client.send('HGET', [this.hashKey, property]) as string | null
    const oldValue = oldValueRaw ? JSON.parse(oldValueRaw) : undefined

    // Delete
    await client.send('HDEL', [this.hashKey, property])

    return { oldValue }
  }

  async has(property: string): Promise<boolean> {
    const client = await this.getClient()
    const exists = await client.send('HEXISTS', [this.hashKey, property])
    return exists === 1
  }

  async keys(): Promise<string[]> {
    const client = await this.getClient()
    const keys = await client.send('HKEYS', [this.hashKey])
    return (keys as string[]) ?? []
  }

  // ============================================
  // Batch Operations
  // ============================================

  async load(): Promise<Record<string, unknown>> {
    const client = await this.getClient()
    const raw = await client.send('HGETALL', [this.hashKey]) as Record<string, string> | null

    const result: Record<string, unknown> = {}

    // Bun's HGETALL returns an object { field: value, ... }
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        result[key] = JSON.parse(value)
      }
    }

    return result
  }

  async store(changes: StorageChanges): Promise<void> {
    const client = await this.getClient()

    // Start transaction for atomicity
    await client.send('MULTI', [])

    try {
      // Collect all sets
      const toSet: string[] = []

      for (const [property, value] of changes.inserts) {
        toSet.push(property, JSON.stringify(value))
      }

      for (const [property, value] of changes.updates) {
        toSet.push(property, JSON.stringify(value))
      }

      // Apply sets in batch
      if (toSet.length > 0) {
        await client.send('HSET', [this.hashKey, ...toSet])
      }

      // Apply deletes
      if (changes.deletes.length > 0) {
        await client.send('HDEL', [this.hashKey, ...changes.deletes])
      }

      // Execute transaction
      await client.send('EXEC', [])
    } catch (error) {
      await client.send('DISCARD', []).catch(() => {})
      throw error
    }
  }

  // ============================================
  // Cleanup
  // ============================================

  async flush(): Promise<void> {
    const client = await this.getClient()
    await client.del(this.hashKey)
  }
}

/**
 * Create a Bun-native Redis storage factory.
 *
 * @param options - Redis URL and prefix configuration
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
