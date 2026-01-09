/**
 * Subject - Reactive entity with properties in krules.ts
 *
 * Subjects are the core state holders in krules.
 * Each subject has:
 * - A unique name (identifier)
 * - Properties (key-value pairs)
 * - Automatic event emission on property changes
 *
 * Default mode: IMMEDIATE
 * - All operations go directly to storage
 * - Each set/delete emits events immediately
 * - Safe for concurrent access
 *
 * Batch mode: via .batch()
 * - Operations accumulate in memory
 * - Persisted together with .commit()
 * - Events emitted after successful commit
 */

import type { Storage } from '../storage/types'
import type { EventBus } from '../event-bus'
import { BatchBuilder } from './batch'
import {
  SubjectPropertyChanged,
  SubjectPropertyDeleted,
  SubjectDeleted,
} from '../events'

export interface SetOptions {
  /** If true, don't emit property change event */
  muted?: boolean
  /** Extra context to pass to event handlers */
  extra?: Record<string, unknown>
}

export interface DeleteOptions {
  /** If true, don't emit property delete event */
  muted?: boolean
  /** Extra context to pass to event handlers */
  extra?: Record<string, unknown>
}

export class Subject {
  constructor(
    public readonly name: string,
    private readonly storage: Storage,
    private readonly eventBus: EventBus
  ) {}

  // ============================================
  // Immediate Operations (default mode)
  // ============================================

  /**
   * Get a property value.
   *
   * @param property - Property name
   * @param defaultValue - Value to return if property doesn't exist
   */
  async get<T = unknown>(property: string, defaultValue?: T): Promise<T> {
    const value = await this.storage.get(property)
    return (value !== undefined ? value : defaultValue) as T
  }

  /**
   * Set a property value immediately.
   * Emits SubjectPropertyChanged event unless muted.
   *
   * Supports callable values for atomic read-modify-write:
   * @example
   * await subject.set('counter', (old = 0) => old + 1)
   *
   * @param property - Property name
   * @param value - Value or callable (oldValue) => newValue
   * @param options - Optional settings (muted, extra)
   */
  async set<T = unknown>(
    property: string,
    value: T | ((old: T | undefined) => T),
    options?: SetOptions
  ): Promise<void> {
    const { newValue, oldValue } = await this.storage.set(property, value)

    // Emit event unless muted or value unchanged
    if (!options?.muted && newValue !== oldValue) {
      await this.eventBus.emit(
        SubjectPropertyChanged,
        this,
        { propertyName: property, oldValue, newValue },
        options?.extra,
        { propertyName: property, oldValue, newValue }
      )
    }
  }

  /**
   * Delete a property immediately.
   * Emits SubjectPropertyDeleted event unless muted.
   *
   * @param property - Property name
   * @param options - Optional settings (muted, extra)
   */
  async delete(property: string, options?: DeleteOptions): Promise<void> {
    const { oldValue } = await this.storage.delete(property)

    // Only emit if property existed
    if (!options?.muted && oldValue !== undefined) {
      await this.eventBus.emit(
        SubjectPropertyDeleted,
        this,
        { propertyName: property, oldValue },
        options?.extra,
        { propertyName: property, oldValue }
      )
    }
  }

  /**
   * Check if a property exists.
   */
  async has(property: string): Promise<boolean> {
    return this.storage.has(property)
  }

  /**
   * Get all property names.
   */
  async keys(): Promise<string[]> {
    return this.storage.keys()
  }

  /**
   * Get all properties as a dictionary.
   */
  async dict(): Promise<Record<string, unknown>> {
    return this.storage.load()
  }

  // ============================================
  // Batch Mode
  // ============================================

  /**
   * Start a batch operation.
   * Returns a BatchBuilder for fluent batch operations.
   *
   * @example
   * await subject.batch()
   *   .set('name', 'John')
   *   .set('age', 30)
   *   .set('status', 'active')
   *   .commit()
   */
  batch(): BatchBuilder {
    return new BatchBuilder(this, this.storage, this.eventBus)
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Delete all properties for this subject.
   * Emits SubjectPropertyDeleted for each property,
   * then SubjectDeleted with a snapshot.
   *
   * @param options - Optional settings (muted)
   */
  async flush(options?: { muted?: boolean }): Promise<void> {
    // Get snapshot before deletion
    const properties = await this.storage.load()

    // Flush storage
    await this.storage.flush()

    if (!options?.muted) {
      // Emit property deleted for each property
      for (const [propertyName, oldValue] of Object.entries(properties)) {
        await this.eventBus.emit(
          SubjectPropertyDeleted,
          this,
          { propertyName, oldValue },
          undefined,
          { propertyName, oldValue }
        )
      }

      // Emit subject deleted with snapshot
      await this.eventBus.emit(SubjectDeleted, this, { properties })
    }
  }
}
