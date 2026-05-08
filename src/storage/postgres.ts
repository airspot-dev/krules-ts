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
import {
  applySchemaCustomization,
  type ResolvedComputedColumn,
  type SchemaCustomization,
  type SqlExecutor,
} from './postgres-schema'

export type {
  ColumnDefinition,
  ColumnType,
  CompositeIndexDefinition,
  CompositeIndexTarget,
  ComputedColumnDefinition,
  ComputedState,
  GeneratedColumnDefinition,
  GeneratedSource,
  IndexFilter,
  NameExtractor,
  PropertyIndexDefinition,
  SchemaCustomization,
} from './postgres-schema'

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
  /**
   * Optional schema customization: generated/computed columns, property indexes,
   * composite indexes. See ./postgres-schema.ts for full type details, and
   * ./postgres.md for usage and trade-offs (notably the Supabase Realtime
   * motivation for promoting JSONB properties to real columns).
   */
  customSchema?: SchemaCustomization
}

/** Resolved column configuration from schema inspection */
interface ResolvedColumnConfig {
  hasUpdatedAt: boolean
  computedColumns: ResolvedComputedColumn[]
}

/** Wrap a postgres.js client into the driver-agnostic SqlExecutor. */
function makeExecutor(sql: Sql): SqlExecutor {
  return {
    query: <T = unknown>(q: string, params?: unknown[]) =>
      sql.unsafe<T[]>(q, params) as unknown as Promise<T[]>,
  }
}

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
  propsCol: string,
  customSchema: SchemaCustomization | undefined
): Promise<ResolvedColumnConfig> {
  const fullTable = `"${schema}"."${table}"`

  // No memoization: the customization step is idempotent (IF NOT EXISTS,
  // checks against information_schema), and a memoized result would silently
  // discard a different `customSchema` passed on a subsequent factory call.

  // Check if table exists
  const tableExistsResult = await sql.unsafe<[{ exists: boolean }]>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) as exists`,
    [schema, table]
  )

  const tableExistedBefore = tableExistsResult[0]?.exists ?? false

  if (!tableExistedBefore) {
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
  } else {
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
  }

  // Re-inspect after any base-table changes to get the final hasUpdatedAt flag.
  const finalColumns = await sql.unsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  )
  const finalExisting = new Set(finalColumns.map(c => c.column_name))
  const hasUpdatedAt = !tableExistedBefore || finalExisting.has('updated_at')

  // Apply optional schema customization (generated/computed columns, indexes).
  let computedColumns: ResolvedComputedColumn[] = []
  if (customSchema) {
    computedColumns = await applySchemaCustomization({
      exec: makeExecutor(sql),
      schema,
      table,
      nameCol,
      propsCol,
      customization: customSchema,
      isNewTable: !tableExistedBefore,
    })
  }

  return { hasUpdatedAt, computedColumns }
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
  private readonly computedColumns: ResolvedComputedColumn[]
  /** Pre-built upsert SQL — depends only on factory-level config, not subject. */
  private readonly upsertSql: string
  /** Pre-built update SQL (for delete operations). */
  private readonly updateSql: string

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
    this.computedColumns = columnConfig.computedColumns

    // Build upsert and update SQL once. Param layout:
    //   $1: subject name
    //   $2: properties (json text → jsonb)
    //   $3..$(2+N): computed column values (in order)
    const cols = [`"${this.nameCol}"`, `"${this.propsCol}"`]
    const params = ['$1', '$2::text::jsonb']
    const updates = [`"${this.propsCol}" = $2::text::jsonb`]
    this.computedColumns.forEach((c, i) => {
      const p = `$${i + 3}`
      cols.push(`"${c.name}"`)
      params.push(p)
      updates.push(`"${c.name}" = ${p}`)
    })
    if (this.hasUpdatedAt) updates.push('updated_at = NOW()')

    this.upsertSql =
      `INSERT INTO ${this.fullTable} (${cols.join(', ')}) ` +
      `VALUES (${params.join(', ')}) ` +
      `ON CONFLICT ("${this.nameCol}") DO UPDATE SET ${updates.join(', ')}`

    // For UPDATE-only (delete path), param layout:
    //   $1: properties
    //   $2..$(1+N): computed values
    //   $(2+N): subject name (WHERE)
    const updateOnly = [`"${this.propsCol}" = $1::text::jsonb`]
    this.computedColumns.forEach((c, i) => {
      updateOnly.push(`"${c.name}" = $${i + 2}`)
    })
    if (this.hasUpdatedAt) updateOnly.push('updated_at = NOW()')
    const wherePos = this.computedColumns.length + 2
    this.updateSql =
      `UPDATE ${this.fullTable} SET ${updateOnly.join(', ')} ` +
      `WHERE "${this.nameCol}" = $${wherePos}`
  }

  isPersistent(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  /** Compute values for all computed columns from a snapshot of properties. */
  private computedValues(properties: Record<string, unknown>): unknown[] {
    return this.computedColumns.map(c =>
      c.compute({ name: this.subjectName, properties })
    )
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

      await tx.unsafe(
        this.upsertSql,
        [this.subjectName, JSON.stringify(newProperties), ...this.computedValues(newProperties)]
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

      await tx.unsafe(
        this.upsertSql,
        [this.subjectName, JSON.stringify(newProperties), ...this.computedValues(newProperties)]
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

      await tx.unsafe(
        this.updateSql,
        [JSON.stringify(newProperties), ...this.computedValues(newProperties), this.subjectName]
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

      await tx.unsafe(
        this.upsertSql,
        [this.subjectName, JSON.stringify(newProperties), ...this.computedValues(newProperties)]
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
  const columnConfig = await ensureSchema(
    options.sql, schema, table, nameCol, propsCol, options.customSchema
  )

  return (subjectName: string) => new PostgresStorage(subjectName, options, columnConfig)
}
