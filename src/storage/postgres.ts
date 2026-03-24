/**
 * PostgresStorage - PostgreSQL-backed storage for krules.ts
 *
 * Stores subject properties in PostgreSQL using JSONB.
 * Auto-creates schema on first use, or attaches to existing tables
 * with configurable column names.
 *
 * Features:
 * - JSONB for flexible property storage
 * - GIN index for property queries
 * - Atomic operations with transactions
 * - Supports callable values (read-modify-write)
 * - Custom column mapping for pre-existing tables
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
 * // Attach to an existing table with custom column names
 * const storageFactory = await createPostgresStorage({
 *   sql,
 *   table: 'adk_sessions',
 *   nameColumn: 'session_id',
 *   propertiesColumn: 'state',
 * })
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
  /** Column name for the subject identifier (default: 'name') */
  nameColumn?: string
  /** Column name for the JSONB properties (default: 'properties') */
  propertiesColumn?: string
}

/** Resolved column configuration from schema inspection */
interface ResolvedColumnConfig {
  hasUpdatedAt: boolean
}

/** Shared initialization state */
const initializedTables = new Map<string, ResolvedColumnConfig>()

/**
 * Ensure the subjects table and required columns exist.
 * - If the table doesn't exist, creates it with all columns (including created_at/updated_at).
 * - If the table exists, checks for nameCol/propsCol and adds them if missing.
 *   created_at/updated_at are NOT added to pre-existing tables.
 */
async function ensureSchema(
  sql: Sql,
  schema: string,
  table: string,
  nameCol: string,
  propsCol: string
): Promise<ResolvedColumnConfig> {
  const fullTable = `"${schema}"."${table}"`

  const cached = initializedTables.get(fullTable)
  if (cached) return cached

  // Check if table exists
  const tableExistsResult = await sql.unsafe<[{ exists: boolean }]>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) as exists`,
    [schema, table]
  )

  const tableExists = tableExistsResult[0]?.exists ?? false

  if (!tableExists) {
    // Create new table with all columns
    await sql.unsafe(`
      CREATE TABLE ${fullTable} (
        "${nameCol}" VARCHAR(512) PRIMARY KEY,
        "${propsCol}" JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_${table}_${propsCol}"
      ON ${fullTable} USING GIN ("${propsCol}")
    `)

    const config: ResolvedColumnConfig = { hasUpdatedAt: true }
    initializedTables.set(fullTable, config)
    return config
  }

  // Table exists - check for required columns
  const columns = await sql.unsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  )
  const existingColumns = new Set(columns.map(c => c.column_name))

  if (!existingColumns.has(nameCol)) {
    await sql.unsafe(`ALTER TABLE ${fullTable} ADD COLUMN "${nameCol}" VARCHAR(512)`)
  }

  if (!existingColumns.has(propsCol)) {
    await sql.unsafe(`ALTER TABLE ${fullTable} ADD COLUMN "${propsCol}" JSONB NOT NULL DEFAULT '{}'::jsonb`)
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_${table}_${propsCol}"
      ON ${fullTable} USING GIN ("${propsCol}")
    `)
  }

  const config: ResolvedColumnConfig = { hasUpdatedAt: existingColumns.has('updated_at') }
  initializedTables.set(fullTable, config)
  return config
}

/**
 * PostgreSQL-backed storage implementation.
 * Uses JSONB for flexible property storage with query capabilities.
 */
export class PostgresStorage implements Storage {
  private readonly sql: Sql
  private readonly fullTable: string
  private readonly nameCol: string
  private readonly propsCol: string
  private readonly hasUpdatedAt: boolean

  constructor(
    public readonly subjectName: string,
    options: PostgresStorageOptions,
    columnConfig: ResolvedColumnConfig
  ) {
    this.sql = options.sql
    const schema = options.schema ?? 'public'
    const table = options.table ?? 'krules_subjects'
    this.fullTable = `"${schema}"."${table}"`
    this.nameCol = options.nameColumn ?? 'name'
    this.propsCol = options.propertiesColumn ?? 'properties'
    this.hasUpdatedAt = columnConfig.hasUpdatedAt
  }

  isPersistent(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  /** Returns `, updated_at = NOW()` if the column exists, empty string otherwise */
  private get updatedAtClause(): string {
    return this.hasUpdatedAt ? ', updated_at = NOW()' : ''
  }

  // ============================================
  // Immediate Operations
  // ============================================

  private parseProperties(raw: unknown): Record<string, unknown> {
    if (!raw) return {}
    return raw as Record<string, unknown>
  }

  async get(property: string): Promise<unknown | undefined> {
    const rows = await this.sql.unsafe<[{ properties: unknown }?]>(
      `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1`,
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
        `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]

      // Build new properties object in JavaScript
      const newProperties = { ...oldProperties, [property]: value }

      // Upsert with new properties
      await tx.unsafe(
        `INSERT INTO ${this.fullTable} ("${this.nameCol}", "${this.propsCol}")
         VALUES ($1, $2::text::jsonb)
         ON CONFLICT ("${this.nameCol}") DO UPDATE
         SET "${this.propsCol}" = $2::text::jsonb${this.updatedAtClause}`,
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
        `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const parsedOldValue = oldProperties[property]

      // Snapshot oldValue BEFORE the closure runs, so in-place mutation
      // doesn't make oldValue === newValue (reference comparison)
      const oldValue = parsedOldValue != null && typeof parsedOldValue === 'object'
        ? structuredClone(parsedOldValue)
        : parsedOldValue
      const newValue = fn(parsedOldValue)

      // Build new properties object in JavaScript
      const newProperties = { ...oldProperties, [property]: newValue }

      // Upsert with new properties
      await tx.unsafe(
        `INSERT INTO ${this.fullTable} ("${this.nameCol}", "${this.propsCol}")
         VALUES ($1, $2::text::jsonb)
         ON CONFLICT ("${this.nameCol}") DO UPDATE
         SET "${this.propsCol}" = $2::text::jsonb${this.updatedAtClause}`,
        [this.subjectName, JSON.stringify(newProperties)]
      )

      return { newValue, oldValue }
    })
  }

  async delete(property: string): Promise<DeleteResult> {
    return this.sql.begin(async (tx) => {
      // Get current properties
      const oldRows = await tx.unsafe<[{ properties: unknown }?]>(
        `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]

      // Build new properties without the deleted property
      const { [property]: _, ...newProperties } = oldProperties

      // Update with new properties
      await tx.unsafe(
        `UPDATE ${this.fullTable} SET "${this.propsCol}" = $1::text::jsonb${this.updatedAtClause} WHERE "${this.nameCol}" = $2`,
        [JSON.stringify(newProperties), this.subjectName]
      )

      return { oldValue }
    })
  }

  async has(property: string): Promise<boolean> {
    const rows = await this.sql.unsafe<[{ exists: boolean }?]>(
      `SELECT "${this.propsCol}" ? $1 as exists FROM ${this.fullTable} WHERE "${this.nameCol}" = $2`,
      [property, this.subjectName]
    )
    return rows[0]?.exists ?? false
  }

  async keys(): Promise<string[]> {
    const rows = await this.sql.unsafe<[{ keys: string[] }?]>(
      `SELECT ARRAY(SELECT jsonb_object_keys("${this.propsCol}")) as keys FROM ${this.fullTable} WHERE "${this.nameCol}" = $1`,
      [this.subjectName]
    )
    return rows[0]?.keys ?? []
  }

  // ============================================
  // Batch Operations
  // ============================================

  async load(): Promise<Record<string, unknown>> {
    const rows = await this.sql.unsafe<[{ properties: unknown }?]>(
      `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1`,
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
        `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1 FOR UPDATE`,
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
        `INSERT INTO ${this.fullTable} ("${this.nameCol}", "${this.propsCol}")
         VALUES ($1, $2::text::jsonb)
         ON CONFLICT ("${this.nameCol}") DO UPDATE
         SET "${this.propsCol}" = $2::text::jsonb${this.updatedAtClause}`,
        [this.subjectName, JSON.stringify(newProperties)]
      )
    })
  }

  // ============================================
  // Cleanup
  // ============================================

  async flush(): Promise<void> {
    await this.sql.unsafe(
      `DELETE FROM ${this.fullTable} WHERE "${this.nameCol}" = $1`,
      [this.subjectName]
    )
  }
}

/**
 * Create a PostgreSQL storage factory.
 * Automatically creates the schema/table on first use,
 * or attaches to an existing table with custom column names.
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
 *
 * @example
 * // Attach to pre-existing table
 * const container = createKRulesContainer({
 *   storageFactory: await createPostgresStorage({
 *     sql,
 *     table: 'adk_sessions',
 *     nameColumn: 'session_id',
 *     propertiesColumn: 'state',
 *   }),
 * })
 */
export async function createPostgresStorage(
  options: PostgresStorageOptions
): Promise<StorageFactory> {
  const schema = options.schema ?? 'public'
  const table = options.table ?? 'krules_subjects'
  const nameCol = options.nameColumn ?? 'name'
  const propsCol = options.propertiesColumn ?? 'properties'

  // Ensure schema exists on factory creation
  const columnConfig = await ensureSchema(options.sql, schema, table, nameCol, propsCol)

  return (subjectName: string) => new PostgresStorage(subjectName, options, columnConfig)
}
