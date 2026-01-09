/**
 * PostgresStorage - PostgreSQL-backed storage for krules.ts
 *
 * Stores subject properties in PostgreSQL using JSONB.
 * Auto-creates schema on first use.
 *
 * Features:
 * - JSONB for flexible property storage
 * - GIN index for property queries
 * - Atomic operations with transactions
 * - Supports callable values (read-modify-write)
 *
 * For advanced patterns (generated columns, indexing, queries),
 * see: postgres.md in this directory.
 *
 * @example
 * import postgres from 'postgres'
 * import { createPostgresStorage } from 'krules/storage/postgres'
 *
 * const sql = postgres('postgres://localhost/krules_test')
 * const storageFactory = await createPostgresStorage({ sql, table: 'subjects' })
 *
 * const container = createKRulesContainer({ storageFactory })
 *
 * @example
 * // Storage routing - PostgreSQL for devices, Redis for users
 * const container = createKRulesContainer({
 *   storageFactory: (subjectName: string) => {
 *     if (subjectName.startsWith('device:')) {
 *       return postgresStorage(subjectName)
 *     }
 *     return redisStorage(subjectName)
 *   }
 * })
 */

import type { Storage, StorageChanges, SetResult, DeleteResult, StorageFactory } from './types'

// postgres.js types - keep optional
type Sql = {
  <T extends readonly unknown[]>(template: TemplateStringsArray, ...args: unknown[]): Promise<T>
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>
  unsafe<T extends readonly unknown[]>(query: string, params?: unknown[]): Promise<T>
  end(): Promise<void>
}

export interface PostgresStorageOptions {
  /** postgres.js client instance */
  sql: Sql
  /** Table name (default: 'krules_subjects') */
  table?: string
  /** Schema name (default: 'public') */
  schema?: string
}

/** Shared initialization state */
const initializedTables = new Set<string>()

/**
 * Ensure the subjects table exists.
 * Called once per table name.
 */
async function ensureSchema(sql: Sql, schema: string, table: string): Promise<void> {
  const fullTable = `"${schema}"."${table}"`

  if (initializedTables.has(fullTable)) {
    return
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${fullTable} (
      name VARCHAR(512) PRIMARY KEY,
      properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // Create GIN index for JSONB queries
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS "idx_${table}_properties"
    ON ${fullTable} USING GIN (properties)
  `)

  initializedTables.add(fullTable)
}

/**
 * PostgreSQL-backed storage implementation.
 * Uses JSONB for flexible property storage with query capabilities.
 */
export class PostgresStorage implements Storage {
  private readonly sql: Sql
  private readonly fullTable: string

  constructor(
    public readonly subjectName: string,
    options: PostgresStorageOptions
  ) {
    this.sql = options.sql
    const schema = options.schema ?? 'public'
    const table = options.table ?? 'krules_subjects'
    this.fullTable = `"${schema}"."${table}"`
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

  private parseProperties(raw: unknown): Record<string, unknown> {
    if (!raw) return {}
    if (typeof raw === 'string') return JSON.parse(raw)
    return raw as Record<string, unknown>
  }

  async get(property: string): Promise<unknown | undefined> {
    const rows = await this.sql.unsafe<[{ properties: unknown }?]>(
      `SELECT properties FROM ${this.fullTable} WHERE name = $1`,
      [this.subjectName]
    )

    if (rows.length === 0) {
      return undefined
    }

    const properties = this.parseProperties(rows[0]?.properties)
    return properties[property]
  }

  async set(property: string, value: unknown): Promise<SetResult> {
    // Handle callable values with transaction
    if (typeof value === 'function') {
      return this.setAtomic(property, value as (old: unknown) => unknown)
    }

    return this.sql.begin(async (tx) => {
      // Get current properties
      const oldRows = await tx.unsafe<[{ properties: unknown }?]>(
        `SELECT properties FROM ${this.fullTable} WHERE name = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]

      // Build new properties object in JavaScript
      const newProperties = { ...oldProperties, [property]: value }

      // Upsert with new properties
      await tx.unsafe(
        `INSERT INTO ${this.fullTable} (name, properties)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (name) DO UPDATE
         SET properties = $2::jsonb,
             updated_at = NOW()`,
        [this.subjectName, JSON.stringify(newProperties)]
      )

      return { newValue: value, oldValue }
    })
  }

  private async setAtomic(
    property: string,
    fn: (old: unknown) => unknown
  ): Promise<SetResult> {
    return this.sql.begin(async (tx) => {
      // Lock row for update
      const oldRows = await tx.unsafe<[{ properties: unknown }?]>(
        `SELECT properties FROM ${this.fullTable} WHERE name = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]
      const newValue = fn(oldValue)

      // Build new properties object in JavaScript
      const newProperties = { ...oldProperties, [property]: newValue }

      // Upsert with new properties
      await tx.unsafe(
        `INSERT INTO ${this.fullTable} (name, properties)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (name) DO UPDATE
         SET properties = $2::jsonb,
             updated_at = NOW()`,
        [this.subjectName, JSON.stringify(newProperties)]
      )

      return { newValue, oldValue }
    })
  }

  async delete(property: string): Promise<DeleteResult> {
    return this.sql.begin(async (tx) => {
      // Get current properties
      const oldRows = await tx.unsafe<[{ properties: unknown }?]>(
        `SELECT properties FROM ${this.fullTable} WHERE name = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]

      // Build new properties without the deleted property
      const { [property]: _, ...newProperties } = oldProperties

      // Update with new properties
      await tx.unsafe(
        `UPDATE ${this.fullTable} SET properties = $1::jsonb, updated_at = NOW() WHERE name = $2`,
        [JSON.stringify(newProperties), this.subjectName]
      )

      return { oldValue }
    })
  }

  async has(property: string): Promise<boolean> {
    const rows = await this.sql.unsafe<[{ exists: boolean }?]>(
      `SELECT properties ? $1 as exists FROM ${this.fullTable} WHERE name = $2`,
      [property, this.subjectName]
    )
    return rows[0]?.exists ?? false
  }

  async keys(): Promise<string[]> {
    const rows = await this.sql.unsafe<[{ keys: string[] }?]>(
      `SELECT ARRAY(SELECT jsonb_object_keys(properties)) as keys FROM ${this.fullTable} WHERE name = $1`,
      [this.subjectName]
    )
    return rows[0]?.keys ?? []
  }

  // ============================================
  // Batch Operations
  // ============================================

  async load(): Promise<Record<string, unknown>> {
    const rows = await this.sql.unsafe<[{ properties: unknown }?]>(
      `SELECT properties FROM ${this.fullTable} WHERE name = $1`,
      [this.subjectName]
    )
    return this.parseProperties(rows[0]?.properties)
  }

  async store(changes: StorageChanges): Promise<void> {
    if (changes.inserts.length === 0 && changes.updates.length === 0 && changes.deletes.length === 0) {
      return
    }

    await this.sql.begin(async (tx) => {
      // Get current properties
      const oldRows = await tx.unsafe<[{ properties: unknown }?]>(
        `SELECT properties FROM ${this.fullTable} WHERE name = $1 FOR UPDATE`,
        [this.subjectName]
      )

      let newProperties = { ...this.parseProperties(oldRows[0]?.properties) }

      // Apply inserts and updates
      for (const [property, value] of changes.inserts) {
        newProperties[property] = value
      }

      for (const [property, value] of changes.updates) {
        newProperties[property] = value
      }

      // Apply deletes
      for (const property of changes.deletes) {
        delete newProperties[property]
      }

      // Upsert with new properties
      await tx.unsafe(
        `INSERT INTO ${this.fullTable} (name, properties)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (name) DO UPDATE
         SET properties = $2::jsonb,
             updated_at = NOW()`,
        [this.subjectName, JSON.stringify(newProperties)]
      )
    })
  }

  // ============================================
  // Cleanup
  // ============================================

  async flush(): Promise<void> {
    await this.sql.unsafe(
      `DELETE FROM ${this.fullTable} WHERE name = $1`,
      [this.subjectName]
    )
  }
}

/**
 * Create a PostgreSQL storage factory.
 * Automatically creates the schema/table on first use.
 *
 * @param options - PostgreSQL client and table configuration
 * @returns Storage factory function
 *
 * @example
 * import postgres from 'postgres'
 * import { createKRulesContainer } from 'krules'
 * import { createPostgresStorage } from 'krules/storage/postgres'
 *
 * const sql = postgres('postgres://localhost/mydb')
 *
 * const container = createKRulesContainer({
 *   storageFactory: await createPostgresStorage({ sql }),
 * })
 *
 * const user = container.subject('user:123')
 * await user.set('name', 'John')
 */
export async function createPostgresStorage(
  options: PostgresStorageOptions
): Promise<StorageFactory> {
  const schema = options.schema ?? 'public'
  const table = options.table ?? 'krules_subjects'

  // Ensure schema exists on factory creation
  await ensureSchema(options.sql, schema, table)

  return (subjectName: string) => new PostgresStorage(subjectName, options)
}
