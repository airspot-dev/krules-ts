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
 * - Custom column mapping for pre-existing tables
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
 *
 * @example
 * // Attach to an existing table with custom column names
 * const storageFactory = await createBunPostgresStorage({
 *   url: 'postgres://localhost/mydb',
 *   table: 'adk_sessions',
 *   nameColumn: 'session_id',
 *   propertiesColumn: 'state',
 * })
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
  /** Column name for the subject identifier (default: 'name') */
  nameColumn?: string
  /** Column name for the JSONB properties (default: 'properties') */
  propertiesColumn?: string
}

/** Resolved column configuration from schema inspection */
interface ResolvedColumnConfig {
  hasUpdatedAt: boolean
}

/** Track initialized tables to avoid repeated schema creation */
const initializedTables = new Map<string, ResolvedColumnConfig>()

/**
 * Ensure the subjects table and required columns exist.
 * - If the table doesn't exist, creates it with all columns (including created_at/updated_at).
 * - If the table exists, checks for nameCol/propsCol and adds them if missing.
 *   created_at/updated_at are NOT added to pre-existing tables.
 */
async function ensureSchema(
  sql: BunSQL,
  schema: string,
  table: string,
  nameCol: string,
  propsCol: string
): Promise<ResolvedColumnConfig> {
  const fullTable = `"${schema}"."${table}"`
  const cacheKey = `${schema}.${table}`

  const cached = initializedTables.get(cacheKey)
  if (cached) return cached

  const client = sql as any

  // Check if table exists
  const tableExistsResult = await client.unsafe(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) as exists`,
    [schema, table]
  )

  const tableExists = tableExistsResult[0]?.exists ?? false

  if (!tableExists) {
    // Create new table with all columns
    await client.unsafe(`
      CREATE TABLE ${fullTable} (
        "${nameCol}" VARCHAR(512) PRIMARY KEY,
        "${propsCol}" JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await client.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_${table}_${propsCol}"
      ON ${fullTable} USING GIN ("${propsCol}")
    `)

    const config: ResolvedColumnConfig = { hasUpdatedAt: true }
    initializedTables.set(cacheKey, config)
    return config
  }

  // Table exists - check for required columns
  const columns = await client.unsafe(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  )
  const existingColumns = new Set(columns.map((c: any) => c.column_name))

  if (!existingColumns.has(nameCol)) {
    await client.unsafe(`ALTER TABLE ${fullTable} ADD COLUMN "${nameCol}" VARCHAR(512)`)
  }

  if (!existingColumns.has(propsCol)) {
    await client.unsafe(`ALTER TABLE ${fullTable} ADD COLUMN "${propsCol}" JSONB NOT NULL DEFAULT '{}'::jsonb`)
    await client.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_${table}_${propsCol}"
      ON ${fullTable} USING GIN ("${propsCol}")
    `)
  }

  const config: ResolvedColumnConfig = { hasUpdatedAt: existingColumns.has('updated_at') }
  initializedTables.set(cacheKey, config)
  return config
}

/**
 * Bun-native PostgreSQL storage implementation.
 * Uses JSONB for flexible property storage with query capabilities.
 */
export class BunPostgresStorage implements Storage {
  private readonly sql: BunSQL
  private readonly fullTable: string
  private readonly nameCol: string
  private readonly propsCol: string
  private readonly hasUpdatedAt: boolean

  constructor(
    public readonly subjectName: string,
    options: BunPostgresStorageOptions & { sql: BunSQL },
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

  private parseProperties(raw: unknown): Record<string, unknown> {
    if (!raw) return {}
    return raw as Record<string, unknown>
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

  async get(property: string): Promise<unknown | undefined> {
    const rows = await (this.sql as any).unsafe(
      `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1`,
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
        `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]

      // Build new properties
      const newProperties = { ...oldProperties, [property]: value }

      // Upsert
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
    return this.sql.begin(async (tx: any) => {
      // Lock row for update
      const oldRows = await tx.unsafe(
        `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]
      const newValue = fn(oldValue)

      // Build new properties
      const newProperties = { ...oldProperties, [property]: newValue }

      // Upsert
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
    return this.sql.begin(async (tx: any) => {
      // Get current properties
      const oldRows = await tx.unsafe(
        `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1 FOR UPDATE`,
        [this.subjectName]
      )

      const oldProperties = this.parseProperties(oldRows[0]?.properties)
      const oldValue = oldProperties[property]

      // Build new properties without the deleted property
      const { [property]: _, ...newProperties } = oldProperties

      // Update
      await tx.unsafe(
        `UPDATE ${this.fullTable} SET "${this.propsCol}" = $1::text::jsonb${this.updatedAtClause} WHERE "${this.nameCol}" = $2`,
        [JSON.stringify(newProperties), this.subjectName]
      )

      return { oldValue }
    })
  }

  async has(property: string): Promise<boolean> {
    const rows = await (this.sql as any).unsafe(
      `SELECT "${this.propsCol}" ? $1 as exists FROM ${this.fullTable} WHERE "${this.nameCol}" = $2`,
      [property, this.subjectName]
    )
    return rows[0]?.exists ?? false
  }

  async keys(): Promise<string[]> {
    const rows = await (this.sql as any).unsafe(
      `SELECT ARRAY(SELECT jsonb_object_keys("${this.propsCol}")) as keys FROM ${this.fullTable} WHERE "${this.nameCol}" = $1`,
      [this.subjectName]
    )
    return rows[0]?.keys ?? []
  }

  // ============================================
  // Batch Operations
  // ============================================

  async load(): Promise<Record<string, unknown>> {
    const rows = await (this.sql as any).unsafe(
      `SELECT "${this.propsCol}" as properties FROM ${this.fullTable} WHERE "${this.nameCol}" = $1`,
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

      // Upsert
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
    await (this.sql as any).unsafe(
      `DELETE FROM ${this.fullTable} WHERE "${this.nameCol}" = $1`,
      [this.subjectName]
    )
  }
}

/**
 * Create a Bun-native PostgreSQL storage factory.
 * Automatically creates the schema/table on first use,
 * or attaches to an existing table with custom column names.
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
 *
 * @example
 * // Attach to pre-existing table
 * const container = createKRulesContainer({
 *   storageFactory: await createBunPostgresStorage({
 *     url: 'postgres://localhost/mydb',
 *     table: 'adk_sessions',
 *     nameColumn: 'session_id',
 *     propertiesColumn: 'state',
 *   }),
 * })
 */
export async function createBunPostgresStorage(
  options: BunPostgresStorageOptions = {}
): Promise<StorageFactory> {
  const schema = options.schema ?? 'public'
  const table = options.table ?? 'krules_subjects'
  const nameCol = options.nameColumn ?? 'name'
  const propsCol = options.propertiesColumn ?? 'properties'

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
  const columnConfig = await ensureSchema(sql, schema, table, nameCol, propsCol)

  return (subjectName: string) => new BunPostgresStorage(subjectName, { ...options, sql }, columnConfig)
}
