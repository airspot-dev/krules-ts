/**
 * Shared batch-change resolution logic used by every Storage backend.
 *
 * Given a locked snapshot of the current state, resolves callable values
 * (read-modify-write), applies sets/deletes, and reports the materialized
 * old/new values so the caller can emit per-property change events.
 *
 * Keeping this in one place guarantees identical semantics — callable
 * resolution, in-place-mutation snapshotting, change/delete detection — across
 * the memory, Postgres, and Redis backends (both the Bun-native and standard
 * driver variants).
 */

import type { StorageChanges, StoreResult } from './types'

export interface ApplyResult {
  /** Full property map after applying all sets/deletes. */
  newProperties: Record<string, unknown>
  /** Materialized old/new values for the caller to emit events. */
  result: StoreResult
}

/**
 * Resolve `changes` against `current` (a locked snapshot).
 *
 * `current` only needs to contain the properties referenced by `changes`
 * (sets + deletes); backends that read a partial snapshot can pass just those.
 */
export function applyChanges(
  current: Record<string, unknown>,
  changes: StorageChanges
): ApplyResult {
  const newProperties: Record<string, unknown> = { ...current }
  const result: StoreResult = { changed: [], deleted: [] }

  for (const [property, value] of changes.sets) {
    const rawOld = current[property]
    const isCallable = typeof value === 'function'

    // Snapshot oldValue BEFORE the callable runs, so in-place mutation of an
    // object doesn't make oldValue === newValue under reference comparison.
    const oldValue =
      isCallable && rawOld != null && typeof rawOld === 'object'
        ? structuredClone(rawOld)
        : rawOld

    const newValue = isCallable
      ? (value as (old: unknown) => unknown)(rawOld)
      : value

    newProperties[property] = newValue

    if (newValue !== oldValue) {
      result.changed.push({ property, oldValue, newValue })
    }
  }

  for (const property of changes.deletes) {
    if (property in newProperties) {
      const oldValue = current[property]
      delete newProperties[property]
      result.deleted.push({ property, oldValue })
    }
  }

  return { newProperties, result }
}
