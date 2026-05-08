# PostgreSQL Storage - Advanced Patterns

This document covers PostgreSQL patterns for krules.ts subjects, including the
programmatic schema-customization API (generated/computed columns, property and
composite indexes) and the underlying SQL idioms it produces.

## Why customize the schema?

A KRules subject is fundamentally a JSONB document keyed by name. That gives
maximum flexibility but two practical limitations:

1. **Indexing**: queries that filter on a specific JSONB key need explicit
   expression indexes — the GIN index on the whole document only helps for
   containment queries.
2. **Realtime / external filters**: replication-based realtime systems
   (notably **Supabase Realtime** via `wal2json` / `pgoutput`) can filter
   subscriptions only on **real columns**, not on JSONB sub-keys. To make a
   subject property filterable in a Realtime subscription, that property has
   to be **promoted to a column**.

The `customSchema` option on `createPostgresStorage` / `createBunPostgresStorage`
addresses both concerns programmatically. The original SQL recipes in this
document still work and remain useful as reference for cases the API does not
cover.

## Table Schema

The base schema created by `createPostgresStorage`:

```sql
CREATE TABLE subjects (
  name VARCHAR(512) PRIMARY KEY,
  properties JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subjects_properties ON subjects USING GIN (properties);
```

The column names for the subject identifier and properties are configurable
via `nameColumn` and `propertiesColumn` options (see [Custom Column Mapping](#custom-column-mapping) below).

## Custom Column Mapping

When integrating with pre-existing tables (e.g., ADK sessions, external systems),
you can map KRules subjects to existing columns instead of using the defaults.

### Configuration

```typescript
import postgres from 'postgres'
import { createPostgresStorage } from 'krules/storage/postgres'

const sql = postgres('postgres://localhost/mydb')

// Attach to an existing "adk_sessions" table
const storageFactory = await createPostgresStorage({
  sql,
  table: 'adk_sessions',
  nameColumn: 'session_id',       // maps to "session_id" instead of "name"
  propertiesColumn: 'state',      // maps to "state" instead of "properties"
})
```

### Schema Behavior

On initialization, `createPostgresStorage` inspects the database:

| Scenario | Behavior |
|----------|----------|
| **Table does not exist** | Creates it with all columns: `nameColumn` (PK), `propertiesColumn` (JSONB), `created_at`, `updated_at`, plus a GIN index. |
| **Table exists, columns present** | No schema changes. Detects whether `updated_at` exists for conditional use in queries. |
| **Table exists, columns missing** | Adds the missing `nameColumn` / `propertiesColumn` via `ALTER TABLE`. Does **not** add `created_at` or `updated_at` to pre-existing tables. |

### Example: ADK Sessions Integration

Given an existing table:

```sql
CREATE TABLE adk_sessions (
  session_id VARCHAR(256) PRIMARY KEY,
  user_id VARCHAR(256),
  state JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

KRules attaches transparently:

```typescript
const factory = await createPostgresStorage({
  sql,
  table: 'adk_sessions',
  nameColumn: 'session_id',
  propertiesColumn: 'state',
})

const session = container.subject('sess:abc')
await session.set('step', 'processing')   // writes to "state" JSONB column
await session.get('step')                 // reads from "state" JSONB column
```

- The `user_id` column and any other existing columns are left untouched.
- Since this table has no `updated_at`, the storage will skip `updated_at = NOW()` in queries automatically.

## Programmatic Schema Customization

`createPostgresStorage` accepts a `customSchema` object that declares
additional columns and indexes. The factory applies them at startup,
idempotently and additively.

```typescript
import postgres from 'postgres'
import { createPostgresStorage } from 'krules/storage/postgres'

const sql = postgres('postgres://localhost/mydb')

const factory = await createPostgresStorage({
  sql,
  table: 'subjects',
  customSchema: {
    columns: {
      // GENERATED column from the subject name → first segment of "type:id"
      subject_type: {
        generated: { name: { splitPart: { separator: ':', segment: 1 } } },
        type: 'text',
        index: true,
      },

      // GENERATED column from a JSONB property → promoted for Realtime filters
      status: {
        generated: { property: 'status' },
        type: 'text',
        index: true,
      },

      // Numeric promotion with cast
      coins: {
        generated: { property: 'coins' },
        type: 'integer',
        index: true,
      },

      // COMPUTED column — derived from multiple properties via a JS closure
      available: {
        computed: ({ properties }) => {
          const stock = (properties.stock as number) ?? 0
          const reserved = (properties.reserved as number) ?? 0
          return stock - reserved > 0
        },
        type: 'boolean',
        index: true,
      },
    },

    // Expression indexes on JSONB keys (no column promotion)
    propertyIndexes: [
      { property: 'last_seen', type: 'timestamptz' },
    ],

    // Composite index on a real column + a JSONB property
    compositeIndexes: [
      {
        targets: [
          { column: 'subject_type' },
          { property: 'status', type: 'text' },
        ],
      },
    ],
  },
})
```

### `columns` — promote values to real columns

Each entry produces a real column on the table. Two flavours:

- **`generated`**: a Postgres `GENERATED ALWAYS AS (…) STORED` column.
  Computed by the database on every write, cannot drift, cannot be assigned
  manually. The expression is built from a structured config — never raw SQL.

  Sources:
  - `{ name: { splitPart: { separator, segment } } }` — Postgres
    `split_part(name, separator, segment)`. `segment` is **1-indexed** to
    match Postgres semantics.
  - `{ name: { regex: 'pattern', group?: 1 } }` — Postgres
    `(regexp_match(name, 'pattern'))[group]`. Useful when `splitPart` is too
    coarse. Returns NULL if the pattern doesn't match. `group` is 1-indexed.
  - `{ name: { tags: { separator } } }` — Postgres
    `string_to_array(name, separator)`. **Type must be `text[]`**.
  - `{ property: 'key' }` — Postgres `(properties->>'key')::TYPE`. Used to
    promote a JSONB key to a real column for Realtime / native indexing.

- **`computed`**: a regular column that the application writes on every
  `set` / `delete` / `store`. The closure receives `{ name, properties }`
  with the *new* state and returns the column value. Use this for logic SQL
  cannot express well — multi-property derivations, complex parsing, etc.

  ⚠️ **Drift risk**: if any process writes the JSONB column directly without
  going through KRules (a manual `UPDATE`, a different service on the same
  table, a migration), computed columns will become stale. Prefer `generated`
  whenever the logic can be expressed as a SQL expression.

  ⚠️ **Backfill**: adding a `computed` column to a table that already has
  rows raises an error. Either drop and recreate the data, populate the
  column manually, or use `generated` instead.

Both flavours support `index: true` to create a btree index on the column
named `idx_<table>_<column>`.

### `propertyIndexes` — index JSONB keys without promotion

When a key needs to be queried efficiently from SQL but does not need to be
filterable from Realtime, an expression index on the JSONB key is enough:

```typescript
propertyIndexes: [
  { property: 'last_seen_ms', type: 'bigint' },                                   // unix epoch ms
  { property: 'priority',     type: 'integer', where: { column: 'subject_type', equals: 'task' } },
]
```

Produces:
```sql
CREATE INDEX idx_subjects_prop_last_seen_ms
  ON subjects (((properties->>'last_seen_ms')::BIGINT));

CREATE INDEX idx_subjects_prop_priority
  ON subjects (((properties->>'priority')::INTEGER))
  WHERE "subject_type" = 'task';
```

> **No timestamp type:** Postgres `text → timestamp[tz]` casts are STABLE
> (depend on session settings) so they cannot appear in `GENERATED ... STORED`
> columns or expression indexes. Store timestamps as `bigint` epoch or `text`
> ISO 8601 (which sorts lexicographically).

The optional `where` is a structured filter `{ column, equals }`. The
referenced column must be a real column (a base column or one declared in
`columns`). Raw SQL is intentionally not accepted.

### `compositeIndexes` — multi-target indexes

Each entry combines one or more **structured targets**:

- `{ column: 'name' }` — a real column (base or customized).
- `{ property: 'key', type: 'text' }` — a JSONB key with cast.

```typescript
compositeIndexes: [
  {
    targets: [
      { column: 'subject_type' },
      { property: 'status', type: 'text' },
    ],
    where: { column: 'subject_type', equals: 'device' },
  },
]
```

### Identifier rules

Column and property names accepted by the API must match
`^[a-z_][a-z0-9_]*$` — lowercase ASCII letters, digits, underscores; cannot
start with a digit. This is intentional and prevents SQL identifier
injection. Names outside this set are rejected with a clear error.

### Idempotency

The customization step is **purely additive**:

- Columns and indexes that already exist are left untouched.
- To change a generated expression, the type of a column, or the columns of
  an index, **drop the object manually first** and re-run the factory.

The reasoning: silent migrations on production tables are a footgun. The
factory only ever creates what is missing.

### Reserved column names

`name`, `properties`, `created_at`, `updated_at` (and any custom values for
`nameColumn` / `propertiesColumn`) cannot be redeclared in `columns`.

## Generated Columns for Subject Type

When using naming conventions like `user:123` or `device:sensor:456`,
you can extract the subject type automatically with a generated column.

### Basic Type Extraction

```sql
-- Extract first segment as subject type
ALTER TABLE subjects ADD COLUMN subject_type TEXT
  GENERATED ALWAYS AS (split_part(name, ':', 1)) STORED;

-- Create index for fast type-based queries
CREATE INDEX idx_subjects_type ON subjects (subject_type);

-- Query all users
SELECT * FROM subjects WHERE subject_type = 'user';

-- Query all devices
SELECT * FROM subjects WHERE subject_type = 'device';
```

### Multi-level Type Extraction

For hierarchical naming like `device:sensor:temperature:001`:

```sql
-- Extract subtype (second segment)
ALTER TABLE subjects ADD COLUMN subject_subtype TEXT
  GENERATED ALWAYS AS (split_part(name, ':', 2)) STORED;

CREATE INDEX idx_subjects_subtype ON subjects (subject_subtype);

-- Find all sensors
SELECT * FROM subjects
WHERE subject_type = 'device' AND subject_subtype = 'sensor';
```

### Tags as Array (All Segments)

Extract all name segments as searchable tags:

```sql
-- All segments as array
ALTER TABLE subjects ADD COLUMN name_tags TEXT[]
  GENERATED ALWAYS AS (string_to_array(name, ':')) STORED;

-- GIN index for array containment queries
CREATE INDEX idx_subjects_name_tags ON subjects USING GIN (name_tags);

-- Find subjects with 'sensor' anywhere in the name
SELECT * FROM subjects WHERE name_tags @> ARRAY['sensor'];

-- Find subjects matching multiple tags
SELECT * FROM subjects WHERE name_tags @> ARRAY['device', 'eu'];
```

## Indexing JSONB Properties

### Index Specific Properties

```sql
-- Index for querying by a specific property value
CREATE INDEX idx_subjects_status ON subjects ((properties->>'status'));

-- Query users by status
SELECT * FROM subjects
WHERE subject_type = 'user'
  AND properties->>'status' = 'active';
```

### Index Numeric Properties

```sql
-- Cast to numeric for range queries
CREATE INDEX idx_subjects_coins ON subjects (((properties->>'coins')::int));

-- Find users with more than 1000 coins
SELECT * FROM subjects
WHERE subject_type = 'user'
  AND (properties->>'coins')::int > 1000;
```

### Composite Indexes

```sql
-- Type + property combination for common queries
CREATE INDEX idx_subjects_type_status ON subjects (
  subject_type,
  (properties->>'status')
);

-- Efficient query: active devices
SELECT * FROM subjects
WHERE subject_type = 'device'
  AND properties->>'status' = 'online';
```

## Query Patterns

### Find Subjects by Type with Property Filter

```sql
-- Active premium users
SELECT name, properties
FROM subjects
WHERE subject_type = 'user'
  AND properties->>'status' = 'active'
  AND (properties->>'premium')::boolean = true;

-- Devices in a specific location
SELECT name, properties
FROM subjects
WHERE subject_type = 'device'
  AND properties->>'location' = 'warehouse-1';
```

### Aggregations by Type

```sql
-- Count subjects by type
SELECT subject_type, COUNT(*)
FROM subjects
GROUP BY subject_type;

-- Average coins per user status
SELECT
  properties->>'status' as status,
  AVG((properties->>'coins')::int) as avg_coins
FROM subjects
WHERE subject_type = 'user'
GROUP BY properties->>'status';
```

### Find Subjects with Missing Properties

```sql
-- Users without email
SELECT name FROM subjects
WHERE subject_type = 'user'
  AND NOT (properties ? 'email');

-- Devices without location
SELECT name FROM subjects
WHERE subject_type = 'device'
  AND properties->>'location' IS NULL;
```

### JSONB Contains Queries

```sql
-- Users with specific nested structure
SELECT * FROM subjects
WHERE subject_type = 'user'
  AND properties @> '{"settings": {"notifications": true}}';

-- Devices with specific tags in properties
SELECT * FROM subjects
WHERE subject_type = 'device'
  AND properties->'tags' ? 'critical';
```

### Full-Text Search on Properties

```sql
-- Add full-text index
CREATE INDEX idx_subjects_fts ON subjects
USING GIN (to_tsvector('english', properties::text));

-- Search in all properties
SELECT * FROM subjects
WHERE to_tsvector('english', properties::text) @@ to_tsquery('warehouse');
```

## Performance Tips

### 1. Use Partial Indexes

```sql
-- Index only active users (smaller, faster)
CREATE INDEX idx_active_users ON subjects (name)
WHERE subject_type = 'user'
  AND properties->>'status' = 'active';
```

### 2. Use INCLUDE for Covering Indexes

```sql
-- Include properties to avoid table lookup
CREATE INDEX idx_users_with_props ON subjects (subject_type)
INCLUDE (properties)
WHERE subject_type = 'user';
```

### 3. Monitor Query Performance

```sql
-- Explain analyze your queries
EXPLAIN ANALYZE
SELECT * FROM subjects
WHERE subject_type = 'device'
  AND properties->>'location' = 'warehouse-1';
```

## Example: Complete Setup for User/Device System

```sql
-- 1. Add generated columns
ALTER TABLE subjects
ADD COLUMN subject_type TEXT
  GENERATED ALWAYS AS (split_part(name, ':', 1)) STORED,
ADD COLUMN subject_id TEXT
  GENERATED ALWAYS AS (split_part(name, ':', 2)) STORED;

-- 2. Create indexes
CREATE INDEX idx_type ON subjects (subject_type);
CREATE INDEX idx_type_id ON subjects (subject_type, subject_id);
CREATE INDEX idx_user_status ON subjects ((properties->>'status'))
  WHERE subject_type = 'user';
CREATE INDEX idx_device_location ON subjects ((properties->>'location'))
  WHERE subject_type = 'device';

-- 3. Example queries

-- All premium users
SELECT name, properties->>'email' as email
FROM subjects
WHERE subject_type = 'user'
  AND (properties->>'premium')::boolean = true;

-- Devices by location with last reading
SELECT
  name,
  properties->>'location' as location,
  properties->>'lastReading' as last_reading,
  updated_at
FROM subjects
WHERE subject_type = 'device'
  AND properties->>'location' LIKE 'warehouse-%'
ORDER BY updated_at DESC;

-- User statistics
SELECT
  COALESCE(properties->>'tier', 'free') as tier,
  COUNT(*) as count,
  AVG((properties->>'coins')::int) as avg_coins
FROM subjects
WHERE subject_type = 'user'
GROUP BY properties->>'tier';
```

## Notes

- Generated columns are automatically maintained by PostgreSQL
- They cannot be updated manually (GENERATED ALWAYS)
- STORED columns use disk space but can be indexed
- Consider your query patterns when designing indexes
- Use `EXPLAIN ANALYZE` to verify index usage
