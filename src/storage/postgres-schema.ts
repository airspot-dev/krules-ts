/**
 * Schema customization for PostgreSQL-backed storage.
 *
 * Extends the base subjects table with:
 * - Generated columns (DB-computed) sourced from the subject name or a JSONB property
 * - Computed columns (app-computed) sourced from a JavaScript closure
 * - Property indexes (expression indexes on JSONB keys, no column promotion)
 * - Composite indexes mixing real columns and JSONB properties
 *
 * Driver-agnostic: callers wrap their SQL client in `SqlExecutor`.
 *
 * Why two flavours of columns:
 * - `generated` is computed by Postgres on write. Cannot drift, but the source
 *   expression must be valid SQL (we generate it from a structured config).
 * - `computed` is computed by the application on every write. Necessary for
 *   logic SQL cannot express well (multi-property derivations, complex parsing).
 *   Risk: drifts if the table is written outside KRules.
 *
 * Idempotency: the function is purely additive. It creates objects that do
 * not yet exist and leaves existing ones untouched. To change a definition
 * (different generated expression, different index columns, different type),
 * drop the column or index manually first and re-run.
 */

// ============================================
// Types
// ============================================

/**
 * Postgres types we support for customization columns and JSONB casts.
 *
 * Notable absence: timestamp / timestamptz. Both `text → timestamp` and
 * `text → timestamptz` casts are STABLE (not IMMUTABLE) in Postgres because
 * they depend on session `DateStyle` / `timezone` settings. PostgreSQL rejects
 * them from `GENERATED ... STORED` columns and expression indexes, which makes
 * them unsupportable here. Recommended alternatives:
 *
 *   - Store unix epoch as `bigint` (milliseconds) or `numeric` — both index
 *     fine and sort correctly.
 *   - Store ISO 8601 as `text` — lexicographic ordering is correct and you can
 *     parse to a timestamp on read.
 */
export type ColumnType =
  | 'text'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'boolean'
  | 'text[]'

/**
 * How to extract a value from the subject name.
 * Exactly one of `splitPart`, `regex`, `tags` must be set.
 */
export type NameExtractor =
  | { splitPart: { separator: string; segment: number }; regex?: never; tags?: never }
  | { regex: string; group?: number; splitPart?: never; tags?: never }
  | { tags: { separator: string }; splitPart?: never; regex?: never }

/** Source for a GENERATED column: from the subject name, or from a JSONB property. */
export type GeneratedSource =
  | { name: NameExtractor; property?: never }
  | { property: string; name?: never }

/** State passed to a `computed` column closure. */
export interface ComputedState {
  name: string
  properties: Record<string, unknown>
}

export interface GeneratedColumnDefinition {
  generated: GeneratedSource
  computed?: never
  /** Postgres type of the column. Must be `text[]` iff source is `name.tags`. */
  type: ColumnType
  /** Create a btree index on the column. */
  index?: boolean
}

export interface ComputedColumnDefinition {
  generated?: never
  /**
   * Synchronous closure run on every write. Receives the full subject state
   * (name + properties after the change is applied) and returns the column value.
   * Must be deterministic and tolerate partial / undefined properties.
   */
  computed: (state: ComputedState) => unknown
  type: ColumnType
  index?: boolean
}

export type ColumnDefinition = GeneratedColumnDefinition | ComputedColumnDefinition

/** Optional WHERE clause for partial indexes (column = literal). */
export interface IndexFilter {
  column: string
  equals: string | number | boolean
}

export interface PropertyIndexDefinition {
  /** JSONB key to index. */
  property: string
  /** Cast type for the expression index (drives query planner usage). */
  type: ColumnType
  where?: IndexFilter
}

/** Target of a composite index entry: a real/generated column, or a JSONB property. */
export type CompositeIndexTarget =
  | { column: string; property?: never; type?: never }
  | { property: string; type: ColumnType; column?: never }

export interface CompositeIndexDefinition {
  targets: CompositeIndexTarget[]
  where?: IndexFilter
}

export interface SchemaCustomization {
  columns?: Record<string, ColumnDefinition>
  propertyIndexes?: PropertyIndexDefinition[]
  compositeIndexes?: CompositeIndexDefinition[]
}

// ============================================
// Driver abstraction
// ============================================

/** Minimal SQL executor — both postgres.js and Bun.SQL expose `unsafe(sql, params)`. */
export interface SqlExecutor {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface ApplySchemaParams {
  exec: SqlExecutor
  schema: string
  table: string
  nameCol: string
  propsCol: string
  customization: SchemaCustomization
  /** True if the table was just created in this run (no rows can exist). */
  isNewTable: boolean
}

/** Resolved computed columns to be maintained by the storage write path. */
export interface ResolvedComputedColumn {
  name: string
  type: ColumnType
  compute: (state: ComputedState) => unknown
}

// ============================================
// Validation helpers
// ============================================

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

function validateIdentifier(name: string, role: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Invalid ${role} '${name}': must match ${IDENTIFIER_RE} ` +
      `(lowercase letters, digits and underscores; cannot start with a digit). ` +
      `This restriction is intentional to keep the API safe from SQL identifier injection.`
    )
  }
}

const PG_TYPE: Record<ColumnType, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  numeric: 'NUMERIC',
  boolean: 'BOOLEAN',
  'text[]': 'TEXT[]',
}

function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function literalForFilter(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid numeric literal in index filter: ${value}`)
    }
    return String(value)
  }
  if (typeof value === 'string') return quoteSqlString(value)
  throw new Error(`Unsupported literal type in index filter: ${typeof value}`)
}

// ============================================
// Expression builders
// ============================================

function nameExtractorExpr(extractor: NameExtractor, nameCol: string): string {
  const col = `"${nameCol}"`
  if (extractor.splitPart) {
    const { separator, segment } = extractor.splitPart
    if (!Number.isInteger(segment) || segment < 1) {
      throw new Error(
        `splitPart.segment must be a positive integer (1-indexed, matching Postgres split_part), got ${segment}`
      )
    }
    return `split_part(${col}, ${quoteSqlString(separator)}, ${segment})`
  }
  if (extractor.regex !== undefined) {
    const group = extractor.group ?? 1
    if (!Number.isInteger(group) || group < 1) {
      throw new Error(`regex.group must be a positive integer (1-indexed), got ${group}`)
    }
    return `(regexp_match(${col}, ${quoteSqlString(extractor.regex)}))[${group}]`
  }
  if (extractor.tags) {
    return `string_to_array(${col}, ${quoteSqlString(extractor.tags.separator)})`
  }
  throw new Error(`Invalid NameExtractor: must set exactly one of splitPart, regex, tags`)
}

function propertyAccessExpr(property: string, propsCol: string, type: ColumnType): string {
  if (type === 'text[]') {
    throw new Error(
      `Property source cannot produce 'text[]'. Use 'name.tags' for tag arrays, ` +
      `or store the array as a JSONB property and index it directly.`
    )
  }
  const access = `("${propsCol}"->>${quoteSqlString(property)})`
  if (type === 'text') return access
  return `(${access})::${PG_TYPE[type]}`
}

function generatedExpr(
  source: GeneratedSource,
  nameCol: string,
  propsCol: string,
  type: ColumnType
): string {
  if (source.name) {
    if (source.name.tags) {
      if (type !== 'text[]') {
        throw new Error(`'name.tags' source requires type 'text[]', got '${type}'`)
      }
      return nameExtractorExpr(source.name, nameCol)
    }
    if (type === 'text[]') {
      throw new Error(`type 'text[]' is only valid with 'name.tags' source`)
    }
    const expr = nameExtractorExpr(source.name, nameCol)
    return type === 'text' ? expr : `(${expr})::${PG_TYPE[type]}`
  }
  if (source.property !== undefined) {
    return propertyAccessExpr(source.property, propsCol, type)
  }
  throw new Error(`Invalid GeneratedSource: must set exactly one of 'name' or 'property'`)
}

function whereSql(filter: IndexFilter): string {
  validateIdentifier(filter.column, 'index filter column')
  return `WHERE "${filter.column}" = ${literalForFilter(filter.equals)}`
}

// ============================================
// Public API
// ============================================

/**
 * Apply schema customization to an existing krules-managed table.
 *
 * - Validates and creates generated/computed columns and their indexes.
 * - Creates property indexes on JSONB keys.
 * - Creates composite indexes.
 * - Returns the resolved computed columns so the storage write path can
 *   maintain them on every write.
 *
 * Idempotent (additive only). Existing objects are left untouched even if
 * their definition has drifted from the config — drop manually to change.
 */
export async function applySchemaCustomization(
  p: ApplySchemaParams
): Promise<ResolvedComputedColumn[]> {
  const { exec, schema, table, nameCol, propsCol, customization, isNewTable } = p
  const fullTable = `"${schema}"."${table}"`

  validateIdentifier(nameCol, 'name column')
  validateIdentifier(propsCol, 'properties column')

  const reserved = new Set([nameCol, propsCol, 'created_at', 'updated_at'])
  const computed: ResolvedComputedColumn[] = []

  // Inspect existing columns once
  const existingColsRows = await exec.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  )
  const existingCols = new Set(existingColsRows.map(r => r.column_name))

  // Cache "table has rows" check (only computed if needed)
  let cachedHasRows: boolean | undefined = isNewTable ? false : undefined
  const tableHasRows = async (): Promise<boolean> => {
    if (cachedHasRows !== undefined) return cachedHasRows
    const rows = await exec.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${fullTable} LIMIT 1) as exists`
    )
    cachedHasRows = rows[0]?.exists ?? false
    return cachedHasRows
  }

  // ---- Columns ----
  if (customization.columns) {
    for (const [colName, def] of Object.entries(customization.columns)) {
      validateIdentifier(colName, 'column name')
      if (reserved.has(colName)) {
        throw new Error(`Column '${colName}' is reserved (base table column)`)
      }

      const exists = existingCols.has(colName)

      if (def.generated) {
        const expr = generatedExpr(def.generated, nameCol, propsCol, def.type)
        if (!exists) {
          await exec.query(
            `ALTER TABLE ${fullTable} ADD COLUMN "${colName}" ${PG_TYPE[def.type]} ` +
            `GENERATED ALWAYS AS (${expr}) STORED`
          )
        }
      } else if (def.computed) {
        if (!exists) {
          if (await tableHasRows()) {
            throw new Error(
              `Cannot add computed column '${colName}': table "${schema}"."${table}" has existing rows. ` +
              `Computed columns are populated by the application on write — adding one to a populated ` +
              `table would leave existing rows with NULL. Either backfill the column manually first, or ` +
              `use a 'generated' column instead.`
            )
          }
          await exec.query(
            `ALTER TABLE ${fullTable} ADD COLUMN "${colName}" ${PG_TYPE[def.type]}`
          )
        }
        computed.push({ name: colName, type: def.type, compute: def.computed })
      } else {
        throw new Error(`Column '${colName}' must declare exactly one of 'generated' or 'computed'`)
      }

      if (def.index) {
        const indexName = `idx_${table}_${colName}`
        await exec.query(
          `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${fullTable} ("${colName}")`
        )
      }
    }
  }

  // ---- Property indexes ----
  if (customization.propertyIndexes) {
    for (const def of customization.propertyIndexes) {
      validateIdentifier(def.property, 'property name')
      const expr = propertyAccessExpr(def.property, propsCol, def.type)
      const indexName = `idx_${table}_prop_${def.property}`
      const where = def.where ? ` ${whereSql(def.where)}` : ''
      await exec.query(
        `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${fullTable} ((${expr}))${where}`
      )
    }
  }

  // ---- Composite indexes ----
  if (customization.compositeIndexes) {
    for (const def of customization.compositeIndexes) {
      if (def.targets.length === 0) {
        throw new Error(`Composite index must have at least one target`)
      }
      const exprs: string[] = []
      const nameParts: string[] = []
      for (const target of def.targets) {
        if (target.column !== undefined) {
          validateIdentifier(target.column, 'composite index column')
          exprs.push(`"${target.column}"`)
          nameParts.push(target.column)
        } else if (target.property !== undefined) {
          validateIdentifier(target.property, 'composite index property')
          exprs.push(`(${propertyAccessExpr(target.property, propsCol, target.type)})`)
          nameParts.push(`prop_${target.property}`)
        } else {
          throw new Error(`Composite index target must set exactly one of 'column' or 'property'`)
        }
      }
      const indexName = `idx_${table}_c_${nameParts.join('_')}`
      const where = def.where ? ` ${whereSql(def.where)}` : ''
      await exec.query(
        `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${fullTable} (${exprs.join(', ')})${where}`
      )
    }
  }

  return computed
}
