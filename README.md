# krules

**krules** is an event-driven, reactive state management framework for TypeScript and Bun. Originally inspired by Python KRules, it provides a unified abstraction for managing stateful entities ("Subjects") with powerful reactive capabilities, independent of the underlying storage.

## Key Features

- **Subject-Centric Architecture**: Interact with entities (`user:123`, `device:sensor-01`) via a clean, unified API.
- **Storage Agnostic**: Seamlessly switch between **Redis**, **PostgreSQL**, or **In-Memory** storage without changing your business logic.
- **Storage Routing**: Dynamically route subjects to different backends based on their names (e.g., `user:*` → Redis, `device:*` → PostgreSQL).
- **Reactive Rules**: Fluent API for defining rules and side effects based on state changes (`on(...).when(...).run(...)`).
- **Custom Events**: Emit and handle domain-specific events, enabling event-driven architectures and handler chaining.
- **Advanced PostgreSQL Support**: Leverages JSONB and generated columns for high-performance querying and flexible indexing.

## Installation

```bash
bun add krules
```

## Quick Start (In-Memory)

```typescript
import { createKRulesContainer, SubjectPropertyChanged } from 'krules'

// 1. Create Container (defaults to MemoryStorage)
const container = createKRulesContainer()
// 2. Get Handler APIs
const { on } = container.handlers()

// 3. Define a Rule
on(SubjectPropertyChanged)
  .when(ctx => ctx.subject.name.startsWith('user:'))
  .when(ctx => ctx.propertyName === 'coins')
  .when(ctx => ctx.newValue > 100)
  .run(async (ctx) => {
    console.log(`User ${ctx.subject.name} is now rich! Coins: ${ctx.newValue}`)
  })

// 4. Interact with a Subject
const user = container.subject('user:mario')

await user.set('coins', 50)  // No alert
await user.set('coins', 150) // Triggers Rule -> "User user:mario is now rich..."
```

## Atomic Operations

Avoid race conditions with callable updates, ensuring data consistency even under high concurrency.

```typescript
// Atomic Read-Modify-Write
// Safe even if multiple requests hit this line simultaneously
await user.set('visits', (current) => (current || 0) + 1)
```

The callback receives the current value and returns the new value. The entire read-modify-write cycle is atomic, protected by optimistic locking (Redis `WATCH/MULTI/EXEC`) or transactions (PostgreSQL `SELECT FOR UPDATE`).

## Subject API

A Subject represents a stateful entity identified by a unique name. All operations are async and go directly to storage.

### Reading & Writing Properties

```typescript
const user = container.subject('user:123')

// Get with optional default value
const name = await user.get<string>('name')
const level = await user.get<number>('level', 1)  // returns 1 if not set

// Set a value (emits SubjectPropertyChanged)
await user.set('name', 'Mario')

// Set with options
await user.set('score', 100, { muted: true })  // no event emitted
await user.set('status', 'active', { extra: { source: 'api' } })  // extra context for handlers

// Delete a property (emits SubjectPropertyDeleted)
await user.delete('temporary_token')
```

### Inspecting State

```typescript
// Check if property exists
if (await user.has('email')) {
  // ...
}

// Get all property names
const props = await user.keys()  // ['name', 'level', 'score']

// Get all properties as object
const snapshot = await user.dict()  // { name: 'Mario', level: 1, score: 100 }
```

### Batch Operations

Apply multiple changes atomically. Events are emitted only after successful commit.

```typescript
await user.batch()
  .set('status', 'active')
  .set('last_login', Date.now())
  .delete('reset_token')
  .commit()
```

### Cleanup

```typescript
// Delete all properties (emits SubjectPropertyDeleted for each, then SubjectDeleted)
await user.flush()

// Silent flush (no events)
await user.flush({ muted: true })
```

## Built-in Events

Subjects automatically emit events when their state changes. Use these to build reactive rules.

### SubjectPropertyChanged

Emitted when a property value changes (via `set()` or `batch().commit()`).

```typescript
on(SubjectPropertyChanged)
  .run(async (ctx) => {
    ctx.subject        // The subject that changed
    ctx.propertyName   // Name of the property (string)
    ctx.oldValue       // Previous value (undefined if new)
    ctx.newValue       // New value
    ctx.extra          // Extra context passed via set(..., { extra })
  })
```

### SubjectPropertyDeleted

Emitted when a property is deleted (via `delete()` or `batch().commit()`).

```typescript
on(SubjectPropertyDeleted)
  .run(async (ctx) => {
    ctx.subject        // The subject that changed
    ctx.propertyName   // Name of the deleted property
    ctx.oldValue       // Value before deletion
  })
```

### SubjectDeleted

Emitted when a subject is flushed (via `flush()`), after all `SubjectPropertyDeleted` events.

```typescript
on(SubjectDeleted)
  .run(async (ctx) => {
    ctx.subject        // The subject that was deleted
    ctx.payload        // { properties: Record<string, unknown> } - snapshot before deletion
  })
```

## Advanced Configuration

### Storage Routing (Redis + PostgreSQL)

The real power of `krules` comes from mixing storage backends transparently.

```typescript
import { createKRulesContainer } from 'krules'
import { createRedisStorage } from 'krules/storage/redis'
import { createPostgresStorage } from 'krules/storage/postgres'
import Redis from 'ioredis'
import postgres from 'postgres'

// Setup Clients
const redisClient = new Redis()
const sqlClient = postgres('postgres://localhost/mydb')

// Create Factories
const redisFactory = createRedisStorage({ client: redisClient })
const pgFactory = await createPostgresStorage({ sql: sqlClient, table: 'subjects' })

// Configure Routing
const container = createKRulesContainer({
  storageFactory: (subjectName) => {
    // Hot data in Redis
    if (subjectName.startsWith('session:')) return redisFactory(subjectName)
    // Persistent data in Postgres
    if (subjectName.startsWith('user:')) return pgFactory(subjectName)
    // Default to Redis
    return redisFactory(subjectName)
  }
})
```

### Atomic State Transitions & Triggers

`krules` excels at handling state changes safely. You can define rules that inspect both the **old** and **new** values to detect specific transitions.

```typescript
// Trigger only when temperature increases by more than 10 degrees
on(SubjectPropertyChanged)
  .when(ctx => ctx.propertyName === 'temperature')
  .when(ctx => (ctx.newValue as number) - (ctx.oldValue as number) > 10)
  .run(async (ctx) => {
    console.log(`Rapid temperature rise detected! ${ctx.oldValue} -> ${ctx.newValue}`)
  })
```

### Custom Events

Beyond built-in events (`SubjectPropertyChanged`, `SubjectPropertyDeleted`, `SubjectDeleted`), you can emit and handle custom events for your domain logic.

```typescript
const { on, emit } = container.handlers()

// Define a handler for a custom event
on('user.level-up')
  .run(async (ctx) => {
    const user = ctx.subject
    const { oldLevel, newLevel } = ctx.payload as { oldLevel: number; newLevel: number }
    console.log(`${user.name} leveled up: ${oldLevel} -> ${newLevel}`)
    await user.set('badge', `level-${newLevel}`)
  })

// Emit custom events from anywhere
const player = container.subject('user:player1')
await emit('user.level-up', player, { oldLevel: 5, newLevel: 6 })

// Chain events: emit from within a handler
on(SubjectPropertyChanged)
  .when(ctx => ctx.propertyName === 'xp')
  .run(async (ctx) => {
    const xp = ctx.newValue as number
    const oldLevel = await ctx.subject.get<number>('level', 1)
    const newLevel = Math.floor(xp / 100) + 1

    if (newLevel > oldLevel) {
      await ctx.subject.set('level', newLevel)
      await ctx.emit('user.level-up', ctx.subject, { oldLevel, newLevel })
    }
  })
```

### Event Patterns

The `on()` function supports glob patterns for flexible event matching.

```typescript
// Exact match
on('user.created').run(...)

// Wildcard: * matches any sequence of characters
on('user.*').run(...)           // matches user.created, user.deleted, user.updated
on('*.error').run(...)          // matches api.error, db.error, auth.error

// Single character: ? matches exactly one character
on('device.?').run(...)         // matches device.1, device.A, but not device.10

// Multiple patterns (OR logic)
on('user.login', 'user.logout').run(...)  // matches either event
```

### Handler Lifecycle

Handlers can be named for later removal.

```typescript
const { on } = container.handlers()

// Register a named handler
const handlerName = on(SubjectPropertyChanged)
  .named('temperature-alert')
  .when(ctx => ctx.propertyName === 'temperature')
  .run(async (ctx) => {
    console.log('Temperature changed!')
  })

// run() returns the handler name (auto-generated if not specified)
console.log(handlerName)  // 'temperature-alert'

// Unregister by name
container.eventBus.unregister('temperature-alert')

// Unregister all handlers
container.eventBus.unregisterAll()
```

### High Performance with Bun Native Drivers

`krules` includes specialized storage adapters that leverage **Bun's native clients** for Redis and PostgreSQL, bypassing Node.js compatibility layers for maximum throughput.

```typescript
import { createBunRedisStorage } from 'krules/storage/bun-redis'
// Uses Bun's built-in RedisClient (zero dependencies)
const bunRedisFactory = createBunRedisStorage({ url: 'redis://localhost:6379' })
```

### PostgreSQL Advanced Patterns

PostgreSQL is ideal for subjects with unbounded growth. The base schema uses JSONB for flexible property storage:

```sql
CREATE TABLE subjects (
  name VARCHAR(512) PRIMARY KEY,
  properties JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subjects_properties ON subjects USING GIN (properties);
```

#### Generated Columns for Subject Type

With naming conventions like `user:123` or `device:sensor:456`, extract the type automatically:

```sql
-- Extract first segment as subject type
ALTER TABLE subjects ADD COLUMN subject_type TEXT
  GENERATED ALWAYS AS (split_part(name, ':', 1)) STORED;

-- Index for fast type-based queries
CREATE INDEX idx_subjects_type ON subjects (subject_type);

-- Query all devices
SELECT * FROM subjects WHERE subject_type = 'device';
```

For hierarchical names like `device:sensor:temp:001`:

```sql
-- Extract subtype (second segment)
ALTER TABLE subjects ADD COLUMN subject_subtype TEXT
  GENERATED ALWAYS AS (split_part(name, ':', 2)) STORED;

-- All segments as searchable array
ALTER TABLE subjects ADD COLUMN name_tags TEXT[]
  GENERATED ALWAYS AS (string_to_array(name, ':')) STORED;

CREATE INDEX idx_subjects_name_tags ON subjects USING GIN (name_tags);

-- Find subjects with 'sensor' anywhere in the name
SELECT * FROM subjects WHERE name_tags @> ARRAY['sensor'];
```

#### Indexing JSONB Properties

Create indexes on frequently queried properties:

```sql
-- Index specific property
CREATE INDEX idx_subjects_status ON subjects ((properties->>'status'));

-- Index numeric property for range queries
CREATE INDEX idx_subjects_coins ON subjects (((properties->>'coins')::int));

-- Composite index: type + property
CREATE INDEX idx_subjects_type_status ON subjects (
  subject_type,
  (properties->>'status')
);

-- Partial index (smaller, faster)
CREATE INDEX idx_active_users ON subjects (name)
WHERE subject_type = 'user' AND properties->>'status' = 'active';
```

#### Query Examples

```sql
-- Active premium users
SELECT name, properties
FROM subjects
WHERE subject_type = 'user'
  AND properties->>'status' = 'active'
  AND (properties->>'premium')::boolean = true;

-- Count by type
SELECT subject_type, COUNT(*) FROM subjects GROUP BY subject_type;

-- Users without email
SELECT name FROM subjects
WHERE subject_type = 'user' AND NOT (properties ? 'email');

-- Nested JSONB query
SELECT * FROM subjects
WHERE properties @> '{"settings": {"notifications": true}}';
```

### Consistency

Subjects always read fresh data from storage. There is no internal caching layer, ensuring consistency across multiple processes or containers.
