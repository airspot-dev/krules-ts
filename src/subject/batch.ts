/**
 * BatchBuilder - Fluent API for batch subject operations
 *
 * Accumulates changes in memory and persists them together
 * with a single commit() call.
 *
 * Use cases:
 * - Multiple property updates that should be atomic
 * - Performance optimization (single storage write)
 * - Transactional semantics (all or nothing)
 *
 * @example
 * await subject.batch()
 *   .set('name', 'John')
 *   .set('age', 30)
 *   .delete('temp')
 *   .commit()
 */

import type { Storage, StorageChanges } from '../storage/types'
import type { EventBus } from '../event-bus'
import type { Subject } from './subject'
import {
  SubjectPropertyChanged,
  SubjectPropertyDeleted,
} from '../events'

interface BatchChange {
  type: 'set' | 'delete'
  value?: unknown
  muted?: boolean
  extra?: Record<string, unknown>
}

export class BatchBuilder {
  private changes = new Map<string, BatchChange>()

  constructor(
    private readonly subject: Subject,
    private readonly storage: Storage,
    private readonly eventBus: EventBus
  ) {}

  /**
   * Queue a property set operation.
   *
   * @param property - Property name
   * @param value - Value or callable (oldValue) => newValue
   * @param options - Optional settings (muted, extra)
   */
  set<T = unknown>(
    property: string,
    value: T | ((old: T | undefined) => T),
    options?: { muted?: boolean; extra?: Record<string, unknown> }
  ): this {
    this.changes.set(property, {
      type: 'set',
      value,
      muted: options?.muted,
      extra: options?.extra,
    })
    return this
  }

  /**
   * Queue a property delete operation.
   *
   * @param property - Property name
   * @param options - Optional settings (muted, extra)
   */
  delete(
    property: string,
    options?: { muted?: boolean; extra?: Record<string, unknown> }
  ): this {
    this.changes.set(property, {
      type: 'delete',
      muted: options?.muted,
      extra: options?.extra,
    })
    return this
  }

  /**
   * Commit all queued changes to storage.
   * Emits events for each change after successful persistence.
   */
  async commit(): Promise<void> {
    if (this.changes.size === 0) {
      return
    }

    // Build storage changes. Callables are passed through UNRESOLVED — the
    // backend resolves them under the lock, making batch read-modify-write
    // atomic against concurrent writers. Insert-vs-update and existence are
    // decided by the backend under the lock too.
    const storageChanges: StorageChanges = {
      sets: [],
      deletes: [],
    }

    for (const [property, change] of this.changes) {
      if (change.type === 'delete') {
        storageChanges.deletes.push(property)
      } else {
        storageChanges.sets.push([property, change.value])
      }
    }

    // Persist atomically. The backend returns the materialized old/new values
    // computed under the lock, so we emit accurate per-property events.
    const { changed, deleted } = await this.storage.store(storageChanges)

    const changedByProperty = new Map(changed.map((c) => [c.property, c]))
    const deletedByProperty = new Map(deleted.map((d) => [d.property, d]))

    // Emit one event per property, after successful persistence, preserving the
    // original queue order and the "only if changed / only if existed" rule.
    for (const [property, change] of this.changes) {
      if (change.muted) {
        continue
      }

      if (change.type === 'delete') {
        const d = deletedByProperty.get(property)
        if (!d) {
          continue
        }
        await this.eventBus.emit(
          SubjectPropertyDeleted,
          this.subject,
          {
            propertyName: property,
            oldValue: d.oldValue,
          },
          change.extra,
          {
            propertyName: property,
            oldValue: d.oldValue,
          }
        )
      } else {
        const c = changedByProperty.get(property)
        if (!c) {
          continue
        }
        await this.eventBus.emit(
          SubjectPropertyChanged,
          this.subject,
          {
            propertyName: property,
            oldValue: c.oldValue,
            newValue: c.newValue,
          },
          change.extra,
          {
            propertyName: property,
            oldValue: c.oldValue,
            newValue: c.newValue,
          }
        )
      }
    }

    // Clear changes after commit
    this.changes.clear()
  }

  /**
   * Get the number of pending changes.
   */
  get pendingCount(): number {
    return this.changes.size
  }

  /**
   * Check if there are pending changes.
   */
  get hasPending(): boolean {
    return this.changes.size > 0
  }

  /**
   * Clear all pending changes without committing.
   */
  clear(): this {
    this.changes.clear()
    return this
  }
}
