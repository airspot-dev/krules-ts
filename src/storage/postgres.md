# PostgreSQL Storage - Advanced Patterns

This document covers advanced PostgreSQL patterns for krules.ts subjects,
including generated columns, indexing strategies, and query optimization.

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
