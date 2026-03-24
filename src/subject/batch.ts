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

    // Load current state to track inserts vs updates
    const current = await this.storage.load()

    // Prepare storage changes
    const storageChanges: StorageChanges = {
      inserts: [],
      updates: [],
      deletes: [],
    }

    // Track events to emit after successful storage
    const events: Array<{
      type: 'changed' | 'deleted'
      property: string
      oldValue: unknown
      newValue?: unknown
      muted?: boolean
      extra?: Record<string, unknown>
    }> = []

    // Process each change
    for (const [property, change] of this.changes) {
      const oldValue = current[property]

      if (change.type === 'delete') {
        if (property in current) {
          storageChanges.deletes.push(property)
          events.push({
            type: 'deleted',
            property,
            oldValue,
            muted: change.muted,
            extra: change.extra,
          })
        }
      } else {
        // Resolve callable values
        const isCallable = typeof change.value === 'function'
        // Snapshot oldValue BEFORE the closure runs, so in-place mutation
        // doesn't make oldValue === newValue (reference comparison)
        const snapshotOldValue = isCallable && oldValue != null && typeof oldValue === 'object'
          ? structuredClone(oldValue)
          : oldValue
        const newValue = isCallable
          ? (change.value as (old: unknown) => unknown)(oldValue)
          : change.value

        // Determine insert vs update
        if (property in current) {
          storageChanges.updates.push([property, newValue])
        } else {
          storageChanges.inserts.push([property, newValue])
        }

        // Track event if value changed
        if (newValue !== snapshotOldValue) {
          events.push({
            type: 'changed',
            property,
            oldValue: snapshotOldValue,
            newValue,
            muted: change.muted,
            extra: change.extra,
          })
        }
      }
    }

    // Persist all changes in single batch
    await this.storage.store(storageChanges)

    // Emit events after successful persistence
    for (const event of events) {
      if (event.muted) {
        continue
      }

      if (event.type === 'changed') {
        await this.eventBus.emit(
          SubjectPropertyChanged,
          this.subject,
          {
            propertyName: event.property,
            oldValue: event.oldValue,
            newValue: event.newValue,
          },
          event.extra,
          {
            propertyName: event.property,
            oldValue: event.oldValue,
            newValue: event.newValue,
          }
        )
      } else {
        await this.eventBus.emit(
          SubjectPropertyDeleted,
          this.subject,
          {
            propertyName: event.property,
            oldValue: event.oldValue,
          },
          event.extra,
          {
            propertyName: event.property,
            oldValue: event.oldValue,
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
