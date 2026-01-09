/**
 * Storage interface for krules.ts
 *
 * Storage backends must implement this interface to provide
 * persistence for Subject properties.
 */

/**
 * Changes to be persisted in a batch operation
 */
export interface StorageChanges {
  /** New properties to insert */
  inserts: Array<[property: string, value: unknown]>
  /** Existing properties to update */
  updates: Array<[property: string, value: unknown]>
  /** Properties to delete */
  deletes: string[]
}

/**
 * Result of a set operation
 */
export interface SetResult {
  /** The new value after the set operation */
  newValue: unknown
  /** The previous value (undefined if property didn't exist) */
  oldValue: unknown | undefined
}

/**
 * Result of a delete operation
 */
export interface DeleteResult {
  /** The value that was deleted (undefined if property didn't exist) */
  oldValue: unknown | undefined
}

/**
 * Storage interface for Subject property persistence.
 *
 * Implementations must handle:
 * - Immediate operations (get, set, delete)
 * - Batch operations (load, store)
 * - Callable values for atomic read-modify-write
 */
export interface Storage {
  /** The subject name this storage instance is bound to */
  readonly subjectName: string

  /**
   * Whether this storage persists data across process restarts.
   * - InMemoryStorage: false
   * - RedisStorage: true
   * - PostgresStorage: true
   */
  isPersistent(): boolean

  /**
   * Whether this storage is safe for concurrent access from multiple processes.
   * - InMemoryStorage: true (single event loop)
   * - RedisStorage: true (WATCH/MULTI/EXEC)
   * - PostgresStorage: true (transactions)
   */
  isConcurrencySafe(): boolean

  // ============================================
  // Immediate Operations
  // ============================================

  /**
   * Get a property value immediately from storage.
   */
  get(property: string): Promise<unknown | undefined>

  /**
   * Set a property value immediately to storage.
   * Supports callable values for atomic read-modify-write operations.
   *
   * @param property - Property name
   * @param value - Value or callable (oldValue) => newValue
   */
  set(property: string, value: unknown): Promise<SetResult>

  /**
   * Delete a property immediately from storage.
   */
  delete(property: string): Promise<DeleteResult>

  /**
   * Check if a property exists in storage.
   */
  has(property: string): Promise<boolean>

  /**
   * Get all property names from storage.
   */
  keys(): Promise<string[]>

  // ============================================
  // Batch Operations
  // ============================================

  /**
   * Load all properties from storage.
   * Used by batch mode to get current state before applying changes.
   */
  load(): Promise<Record<string, unknown>>

  /**
   * Persist multiple changes in a single batch operation.
   * Used by batch mode to commit all accumulated changes.
   */
  store(changes: StorageChanges): Promise<void>

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Delete all properties for this subject.
   */
  flush(): Promise<void>
}

/**
 * Factory function to create Storage instances for subjects.
 */
export type StorageFactory = (subjectName: string) => Storage
