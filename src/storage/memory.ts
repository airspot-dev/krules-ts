/**
 * InMemoryStorage - Default storage backend for krules.ts
 *
 * Stores subject properties in memory using a global Map.
 * Subjects are singletons within the same process.
 *
 * Use cases:
 * - Development and prototyping
 * - Unit testing
 * - CLI scripts and one-shot processes
 * - In-memory caching layer
 *
 * Limitations:
 * - Data is lost when process terminates
 * - Not shared between worker threads (isolated memory)
 */

import type { Storage, StorageChanges, SetResult, DeleteResult, StorageFactory } from './types'

/**
 * Global storage for all subjects.
 * Each subject has its own Map of properties.
 */
const globalStore = new Map<string, Map<string, unknown>>()

export class InMemoryStorage implements Storage {
  constructor(public readonly subjectName: string) {}

  /**
   * InMemoryStorage does not persist across process restarts.
   */
  isPersistent(): boolean {
    return false
  }

  /**
   * Safe for concurrent async operations within the same event loop.
   * Not safe across worker threads (they have isolated memory).
   */
  isConcurrencySafe(): boolean {
    return true
  }

  /**
   * Get or create the property store for this subject.
   */
  private getStore(): Map<string, unknown> {
    let store = globalStore.get(this.subjectName)
    if (!store) {
      store = new Map()
      globalStore.set(this.subjectName, store)
    }
    return store
  }

  // ============================================
  // Immediate Operations
  // ============================================

  async get(property: string): Promise<unknown | undefined> {
    return this.getStore().get(property)
  }

  async set(property: string, value: unknown): Promise<SetResult> {
    const store = this.getStore()
    const rawOldValue = store.get(property)

    // Snapshot oldValue BEFORE the closure runs, so in-place mutation
    // doesn't make oldValue === newValue (reference comparison)
    const isCallable = typeof value === 'function'
    const oldValue = isCallable && rawOldValue != null && typeof rawOldValue === 'object'
      ? structuredClone(rawOldValue)
      : rawOldValue

    const newValue = isCallable
      ? (value as (old: unknown) => unknown)(rawOldValue)
      : value

    store.set(property, newValue)

    return { newValue, oldValue }
  }

  async delete(property: string): Promise<DeleteResult> {
    const store = this.getStore()
    const oldValue = store.get(property)
    store.delete(property)
    return { oldValue }
  }

  async has(property: string): Promise<boolean> {
    return this.getStore().has(property)
  }

  async keys(): Promise<string[]> {
    return Array.from(this.getStore().keys())
  }

  // ============================================
  // Batch Operations
  // ============================================

  async load(): Promise<Record<string, unknown>> {
    const store = this.getStore()
    const result: Record<string, unknown> = {}
    for (const [key, value] of store) {
      result[key] = value
    }
    return result
  }

  async store(changes: StorageChanges): Promise<void> {
    const store = this.getStore()

    // Apply inserts
    for (const [property, value] of changes.inserts) {
      store.set(property, value)
    }

    // Apply updates
    for (const [property, value] of changes.updates) {
      store.set(property, value)
    }

    // Apply deletes
    for (const property of changes.deletes) {
      store.delete(property)
    }
  }

  // ============================================
  // Cleanup
  // ============================================

  async flush(): Promise<void> {
    globalStore.delete(this.subjectName)
  }
}

/**
 * Create an InMemoryStorage factory.
 *
 * @example
 * const storageFactory = createMemoryStorage()
 * const storage = storageFactory('user:123')
 */
export function createMemoryStorage(): StorageFactory {
  return (subjectName: string) => new InMemoryStorage(subjectName)
}

/**
 * Clear all in-memory storage.
 * Useful for testing to reset state between tests.
 */
export function clearAllMemoryStorage(): void {
  globalStore.clear()
}

/**
 * Get the number of subjects currently in memory.
 * Useful for debugging and testing.
 */
export function getMemoryStorageStats(): { subjectCount: number; totalProperties: number } {
  let totalProperties = 0
  for (const store of globalStore.values()) {
    totalProperties += store.size
  }
  return {
    subjectCount: globalStore.size,
    totalProperties,
  }
}
