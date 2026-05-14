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
  /**
   * Whether Bun.SQL should auto-create prepared statements (default: true).
   *
   * Set to `false` when connecting through a transaction-mode connection
   * pooler such as Supabase's Supavisor on port 6543, where prepared
   * statements fail with `prepared statement already exists` because the
   * pooler reassigns backend connections between requests.
   *
   * Ignored when `sql` is provided — configure that client yourself.
   */
  preparedStatements?: boolean
  /**
   * Optional schema customization: generated/computed columns, property
   * indexes, composite indexes. See ./postgres-schema.ts and ./postgres.md.
   */
  customSchema?: SchemaCustomization
}

/** Resolved column configuration from schema inspection */
interface ResolvedColumnConfig {
  hasUpdatedAt: boolean
  computedColumns: ResolvedComputedColumn[]
}

/** Wrap a Bun.SQL client into the driver-agnostic SqlExecutor. */
function makeExecutor(sql: BunSQL): SqlExecutor {
  const client = sql as any
  return {
    query: <T = unknown>(q: string, params?: unknown[]) =>
      client.unsafe(q, params) as Promise<T[]>,
  }
}

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
  propsCol: string,
  customSchema: SchemaCustomization | undefined
): Promise<ResolvedColumnConfig> {
  const fullTable = `"${schema}"."${table}"`

  // No memoization: customization is idempotent and a memoized result would
  // silently discard a different `customSchema` on a subsequent factory call.

  const client = sql as any

  // Check if table exists
  const tableExistsResult = await client.unsafe(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) as exists`,
    [schema, table]
  )

  const tableExistedBefore = tableExistsResult[0]?.exists ?? false

  if (!tableExistedBefore) {
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
  } else {
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
  }

  // Re-inspect after any base-table changes for the final hasUpdatedAt flag.
  const finalColumns = await client.unsafe(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  )
  const finalExisting = new Set(finalColumns.map((c: any) => c.column_name))
  const hasUpdatedAt = !tableExistedBefore || finalExisting.has('updated_at')

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
 * Bun-native PostgreSQL storage implementation.
 * Uses JSONB for flexible property storage with query capabilities.
 */
export class BunPostgresStorage implements Storage {
  private readonly sql: BunSQL
  private readonly fullTable: string
  private readonly nameCol: string
  private readonly propsCol: string
  private readonly hasUpdatedAt: boolean
  private readonly computedColumns: ResolvedComputedColumn[]
  private readonly upsertSql: string
  private readonly updateSql: string

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
    this.computedColumns = columnConfig.computedColumns

    // Pre-build upsert / update SQL — see PostgresStorage for the layout.
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

  private computedValues(properties: Record<string, unknown>): unknown[] {
    return this.computedColumns.map(c =>
      c.compute({ name: this.subjectName, properties })
    )
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
    return this.sql.begin(async (tx: any) => {
      // Lock row for update
      const oldRows = await tx.unsafe(
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

      // Build new properties
      const newProperties = { ...oldProperties, [property]: newValue }

      await tx.unsafe(
        this.upsertSql,
        [this.subjectName, JSON.stringify(newProperties), ...this.computedValues(newProperties)]
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

      await tx.unsafe(
        this.updateSql,
        [JSON.stringify(newProperties), ...this.computedValues(newProperties), this.subjectName]
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
    const clientOptions: { url: string; prepare?: boolean } = { url }
    if (options.preparedStatements === false) {
      clientOptions.prepare = false
    }
    sql = new SQL(clientOptions) as unknown as BunSQL
  }

  // Ensure schema exists
  const columnConfig = await ensureSchema(
    sql, schema, table, nameCol, propsCol, options.customSchema
  )

  return (subjectName: string) => new BunPostgresStorage(subjectName, { ...options, sql }, columnConfig)
}
