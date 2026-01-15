/**
 * BunPostgresStorage - PostgreSQL-backed storage using Bun's native SQL client
 *
 * Uses Bun's built-in SQL client for maximum performance.
 * No external dependencies required.
 *
 * Features:
 * - Zero dependencies (uses Bun.SQL)
 * - 50% faster than traditional Node.js clients
 * - Auto-prepared statements
 * - Connection pooling built-in
 * - JSONB for flexible property storage
 *
 * For advanced patterns (generated columns, indexing, queries),
 * see: postgres.md in this directory.
 *
 * @example
 * import { createBunPostgresStorage } from 'krules/storage/bun-postgres'
 *
 * const storageFactory = await createBunPostgresStorage({
 *   url: 'postgres://localhost/mydb',
 *   table: 'subjects'
 * })
 *
 * const container = createKRulesContainer({ storageFactory })
 */

import type { Storage, StorageChanges, SetResult, DeleteResult, StorageFactory } from './types'

// Bun's native SQL client type
type BunSQL = {
  <T extends object[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
  begin<T>(fn: (tx: BunSQL) => Promise<T>): Promise<T>
  (obj: object): unknown  // For sql(object) syntax
  (str: string): unknown  // For sql("tablename") syntax
  end(): Promise<void>
}

export interface BunPostgresStorageOptions {
  /** PostgreSQL URL (e.g., 'postgres://user:pass@localhost:5432/mydb') */
  url?: string
  /** Existing Bun SQL client instance */
  sql?: BunSQL
  /** Table name (default: 'krules_subjects') */
  table?: string
  /** Schema name (default: 'public') */
  schema?: string
}

/** Track initialized tables to avoid repeated schema creation */
const initializedTables = new Set<string>()

/**
 * Ensure the subjects table exists.
 * Called once per table name.
 */
async function ensureSchema(sql: BunSQL, schema: string, table: string): Promise<void> {
  const fullTable = `"${schema}"."${table}"`
  const cacheKey = `${schema}.${table}`

  if (initializedTables.has(cacheKey)) {
    return
  }

  // Use unsafe for DDL with dynamic table names
  const client = sql as any

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${fullTable} (
      name VARCHAR(512) PRIMARY KEY,
      properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS "idx_${table}_properties"
    ON ${fullTable} USING GIN (properties)
  `)

  initializedTables.add(cacheKey)
}

/**
 * Bun-native PostgreSQL storage implementation.
 * Uses JSONB for flexible property storage with query capabilities.
 */
export class BunPostgresStorage implements Storage {
  private readonly sql: BunSQL
  private readonly fullTable: string

  constructor(
    public readonly subjectName: string,
    options: BunPostgresStorageOptions & { sql: BunSQL }
  ) {
    this.sql = options.sql
    const schema = options.schema ?? 'public'
    const table = options.table ?? 'krules_subjects'
    this.fullTable = `"${schema}"."${table}"`
  }

  private parseProperties(raw: unknown): Record<string, unknown> {
    if (!raw) return {}
    return raw as Record<string, unknown>
  }

  // Helper to execute raw SQL with table name
  private async query<T>(queryFn: (sql: BunSQL, table: string, name: string) => Promise<T>): Promise<T> {
    return queryFn(this.sql, this.fullTable, this.subjectName)
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
    // Use unsafe for dynamic table name (safe: table name comes from our config)
    const rows = await (this.sql as any).unsafe(
      `SELECT properties FROM ${this.fullTable} WHERE name = $1`,
      [this.subjectName]
    )

    if (!rows || rows.length === 0) {
      return undefined
    }

    const properties = this.parseProperties(rows[0]?.properties)
    return properties[property]
  }

  async set(property: string, value: unknown): Promise<SetResult> {
    if (typeof value === 'function') {
      return this.setAtomic(property, value as (old: unknown) => unknown)
    }

    return this.sql.begin(async (tx: any) => {
      // Get current properties
      const oldRows = await tx.unsafe(
        `SELECT properties FROM ${this.fullTable} WHERE name = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]

      // Build new properties
      const newProperties = { ...oldProperties, [property]: value }

      // Upsert
      await tx.unsafe(
        `INSERT INTO ${this.fullTable} (name, properties)
         VALUES ($1, $2::text::jsonb)
         ON CONFLICT (name) DO UPDATE
         SET properties = $2::text::jsonb, updated_at = NOW()`,
        [this.subjectName, JSON.stringify(newProperties)]
      )

      return { newValue: value, oldValue }
    })
  }

  private async setAtomic(
    property: string,
    fn: (old: unknown) => unknown
  ): Promise<SetResult> {
    return this.sql.begin(async (tx: any) => {
      // Lock row for update
      const oldRows = await tx.unsafe(
        `SELECT properties FROM ${this.fullTable} WHERE name = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]
      const newValue = fn(oldValue)

      // Build new properties
      const newProperties = { ...oldProperties, [property]: newValue }

      // Upsert
      await tx.unsafe(
        `INSERT INTO ${this.fullTable} (name, properties)
         VALUES ($1, $2::text::jsonb)
         ON CONFLICT (name) DO UPDATE
         SET properties = $2::text::jsonb, updated_at = NOW()`,
        [this.subjectName, JSON.stringify(newProperties)]
      )

      return { newValue, oldValue }
    })
  }

  async delete(property: string): Promise<DeleteResult> {
    return this.sql.begin(async (tx: any) => {
      // Get current properties
      const oldRows = await tx.unsafe(
        `SELECT properties FROM ${this.fullTable} WHERE name = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]

      // Build new properties without the deleted property
      const { [property]: _, ...newProperties } = oldProperties

      // Update
      await tx.unsafe(
        `UPDATE ${this.fullTable} SET properties = $1::text::jsonb, updated_at = NOW() WHERE name = $2`,
        [JSON.stringify(newProperties), this.subjectName]
      )

      return { oldValue }
    })
  }

  async has(property: string): Promise<boolean> {
    const rows = await (this.sql as any).unsafe(
      `SELECT properties ? $1 as exists FROM ${this.fullTable} WHERE name = $2`,
      [property, this.subjectName]
    )
    return rows[0]?.exists ?? false
  }

  async keys(): Promise<string[]> {
    const rows = await (this.sql as any).unsafe(
      `SELECT ARRAY(SELECT jsonb_object_keys(properties)) as keys FROM ${this.fullTable} WHERE name = $1`,
      [this.subjectName]
    )
    return rows[0]?.keys ?? []
  }

  // ============================================
  // Batch Operations
  // ============================================

  async load(): Promise<Record<string, unknown>> {
    const rows = await (this.sql as any).unsafe(
      `SELECT properties FROM ${this.fullTable} WHERE name = $1`,
      [this.subjectName]
    )
    return this.parseProperties(rows[0]?.properties)
  }

  async store(changes: StorageChanges): Promise<void> {
    if (changes.inserts.length === 0 && changes.updates.length === 0 && changes.deletes.length === 0) {
      return
    }

    await this.sql.begin(async (tx: any) => {
      // Get current properties
      const oldRows = await tx.unsafe(
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

      // Upsert
      await tx.unsafe(
        `INSERT INTO ${this.fullTable} (name, properties)
         VALUES ($1, $2::text::jsonb)
         ON CONFLICT (name) DO UPDATE
         SET properties = $2::text::jsonb, updated_at = NOW()`,
        [this.subjectName, JSON.stringify(newProperties)]
      )
    })
  }

  // ============================================
  // Cleanup
  // ============================================

  async flush(): Promise<void> {
    await (this.sql as any).unsafe(
      `DELETE FROM ${this.fullTable} WHERE name = $1`,
      [this.subjectName]
    )
  }
}

/**
 * Create a Bun-native PostgreSQL storage factory.
 * Automatically creates the schema/table on first use.
 *
 * @param options - PostgreSQL URL and table configuration
 * @returns Storage factory function
 *
 * @example
 * import { createKRulesContainer } from 'krules'
 * import { createBunPostgresStorage } from 'krules/storage/bun-postgres'
 *
 * const container = createKRulesContainer({
 *   storageFactory: await createBunPostgresStorage({
 *     url: 'postgres://localhost/mydb',
 *     table: 'subjects',
 *   }),
 * })
 *
 * const user = container.subject('user:123')
 * await user.set('name', 'John')
 */
export async function createBunPostgresStorage(
  options: BunPostgresStorageOptions = {}
): Promise<StorageFactory> {
  const schema = options.schema ?? 'public'
  const table = options.table ?? 'krules_subjects'

  let sql: BunSQL

  if (options.sql) {
    sql = options.sql
  } else {
    // Dynamic import to avoid errors if not running in Bun
    const { SQL } = await import('bun')
    const url = options.url ?? process.env.DATABASE_URL ?? 'postgres://localhost/postgres'
    sql = new SQL(url) as unknown as BunSQL
  }

  // Ensure schema exists
  await ensureSchema(sql, schema, table)

  return (subjectName: string) => new BunPostgresStorage(subjectName, { ...options, sql })
}
