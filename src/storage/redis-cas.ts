/**
 * Compare-and-set (CAS) Lua scripting for atomic read-modify-write on a Redis
 * hash, shared by the ioredis and Bun-native backends so their atomic semantics
 * stay identical (the same role `apply-changes.ts` plays for resolution).
 *
 * ## Why not WATCH/MULTI/EXEC
 *
 * WATCH/MULTI/EXEC keeps its state — watched keys and the queued command list —
 * PER CONNECTION. Both Redis backends use a *shared* connection: ioredis is a
 * single socket by default, and the Bun backend caches one client per URL, so
 * every subject on that URL shares it. Under concurrent writers the WATCH /
 * MULTI / EXEC commands of different transactions (and even plain non-atomic
 * commands) interleave between `await`s on that one connection, so the watch
 * state and the MULTI queue overwrite each other and isolation collapses —
 * observed as N concurrent `+1` updates on one property landing a final value of
 * 1 instead of N.
 *
 * ## The CAS approach
 *
 * `EVAL` runs an entire Lua script atomically server-side as a SINGLE command,
 * so it is immune to that interleaving: safe on a shared connection and safe
 * across processes. The callable is arbitrary JS and cannot run inside Redis, so
 * the value is read and the callable computed client-side; the script then
 * re-checks that every *callable-derived* field still holds the exact string we
 * read (compare-and-set) and applies the writes only if so. A mismatch means a
 * concurrent writer won: the script writes nothing and returns 0, and the caller
 * re-reads, recomputes and retries — transparently; the application never sees a
 * conflict.
 *
 * Only callable-derived fields are CAS-guarded. Concrete sets and deletes do not
 * depend on the previous value (last-write-wins / unconditional), exactly like
 * immediate mode, so guarding them would only cause spurious conflicts without
 * adding correctness. A batch with no callables therefore never conflicts.
 */

import { applyChanges } from './apply-changes'
import type { StorageChanges, StoreResult } from './types'

/** A field whose write is conditional on it still holding `expected`. */
export interface CasCheck {
  field: string
  /** Whether the field existed (had a value) when it was read. */
  present: boolean
  /** The raw stored string read for the field (only meaningful when present). */
  expected: string
}

/** The CAS-guarded write program handed to the Lua script. */
export interface CasProgram {
  /** CAS guards — the writes proceed only if every one still matches. */
  checks: CasCheck[]
  /** Fields to write, as [field, rawValueString]. */
  sets: Array<[string, string]>
  /** Fields to delete. */
  deletes: string[]
}

/**
 * Lua script: verify every CAS check, then (only if all pass) apply the sets and
 * deletes. Returns 1 on success, 0 on a CAS mismatch (nothing written).
 *
 * `redis.call('HGET', ...)` returns Lua boolean `false` for a missing field, so
 * absence is checked with `cur == false`.
 */
export const CAS_APPLY_SCRIPT = `
local i = 1
local nc = tonumber(ARGV[i]); i = i + 1
for _ = 1, nc do
  local f = ARGV[i]; local present = ARGV[i+1]; local expected = ARGV[i+2]; i = i + 3
  local cur = redis.call('HGET', KEYS[1], f)
  if present == '1' then
    if cur == false or cur ~= expected then return 0 end
  else
    if cur ~= false then return 0 end
  end
end
local ns = tonumber(ARGV[i]); i = i + 1
for _ = 1, ns do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]); i = i + 2
end
local nd = tonumber(ARGV[i]); i = i + 1
for _ = 1, nd do
  redis.call('HDEL', KEYS[1], ARGV[i]); i = i + 1
end
return 1
`.trim()

/** Serialize a {@link CasProgram} into the ARGV array the script expects. */
export function buildCasArgs(program: CasProgram): string[] {
  const argv: string[] = []
  argv.push(String(program.checks.length))
  for (const c of program.checks) {
    argv.push(c.field, c.present ? '1' : '0', c.present ? c.expected : '')
  }
  argv.push(String(program.sets.length))
  for (const [field, value] of program.sets) {
    argv.push(field, value)
  }
  argv.push(String(program.deletes.length))
  for (const field of program.deletes) {
    argv.push(field)
  }
  return argv
}

/** True when the EVAL result means the writes were applied (script returned 1). */
export function casApplied(result: unknown): boolean {
  return Number(result) === 1
}

/**
 * Small jittered exponential backoff (ms) to decongest optimistic-CAS retries
 * under contention. `attempt` is 0-based; the base is capped at 32ms.
 */
export function casBackoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt, 32)
  return Math.floor(Math.random() * base)
}

/** Result of {@link prepareStore}: the CAS program plus the event result. */
export interface PreparedStore {
  program: CasProgram
  /** Materialized old/new values for the caller to emit per-property events. */
  result: StoreResult
}

/**
 * Build the CAS program + event result for a batch, given the raw strings read
 * for the referenced fields (`null` = field absent). Shared by both Redis
 * backends so their batch semantics stay identical.
 */
export function prepareStore(
  changes: StorageChanges,
  rawByField: Record<string, string | null>
): PreparedStore {
  const current: Record<string, unknown> = {}
  for (const [field, raw] of Object.entries(rawByField)) {
    if (raw != null) current[field] = JSON.parse(raw)
  }

  const { newProperties, result } = applyChanges(current, changes)

  // CAS-guard only callable-derived fields; concrete sets / deletes are
  // unconditional (last-write-wins), matching immediate mode.
  const checks: CasCheck[] = []
  for (const [property, value] of changes.sets) {
    if (typeof value === 'function') {
      const raw = rawByField[property] ?? null
      checks.push({ field: property, present: raw != null, expected: raw ?? '' })
    }
  }

  const sets: Array<[string, string]> = changes.sets.map(([p]) => [
    p,
    JSON.stringify(newProperties[p]),
  ])

  return {
    program: { checks, sets, deletes: [...changes.deletes] },
    result,
  }
}
