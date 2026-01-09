/**
 * KRulesContainer - IoC container for krules.ts
 *
 * Uses Awilix for dependency injection.
 * Provides:
 * - EventBus (singleton)
 * - Storage factory (configurable, supports routing)
 * - Subject factory
 * - Handler utilities (on, middleware, emit)
 *
 * @example
 * // Create container with default InMemoryStorage
 * const container = createKRulesContainer()
 *
 * // Get handler utilities
 * const { on, middleware, emit } = container.handlers()
 *
 * // Create subjects
 * const user = container.subject('user:123')
 *
 * @example
 * // Storage routing - different backends per subject type
 * const container = createKRulesContainer({
 *   storageFactory: (subjectName: string) => {
 *     if (subjectName.startsWith('user:')) {
 *       return redisStorage(subjectName)  // Users on Redis (fast)
 *     }
 *     if (subjectName.startsWith('device:')) {
 *       return postgresStorage(subjectName)  // Devices on PostgreSQL (scalable)
 *     }
 *     return memoryStorage(subjectName)  // Default
 *   }
 * })
 */

import {
  createContainer,
  asClass,
  asFunction,
  asValue,
  InjectionMode,
  type AwilixContainer,
} from 'awilix'

import { EventBus } from './event-bus'
import { Subject } from './subject/subject'
import { createMemoryStorage, type StorageFactory } from './storage'
import { createHandlers } from './handlers/builder'
import type { HandlerBuilder } from './handlers/builder'
import type { MiddlewareFunction, EmitFunction } from './handlers/types'

/**
 * Container cradle interface - defines all registered services
 */
export interface KRulesCradle {
  eventBus: EventBus
  storageFactory: StorageFactory
  subjectFactory: (name: string) => Subject
  handlers: {
    on: (...patterns: string[]) => HandlerBuilder
    middleware: (fn: MiddlewareFunction) => void
    emit: EmitFunction
  }
}

/**
 * Options for creating a KRules container
 */
export interface KRulesContainerOptions {
  /**
   * Custom storage factory.
   * Defaults to InMemoryStorage.
   */
  storageFactory?: StorageFactory
}

/**
 * KRules container wrapper with convenient accessors.
 */
export class KRulesContainer {
  private readonly container: AwilixContainer<KRulesCradle>

  constructor(options: KRulesContainerOptions = {}) {
    this.container = createContainer<KRulesCradle>({
      injectionMode: InjectionMode.PROXY,
    })

    // Register EventBus as singleton
    this.container.register({
      eventBus: asClass(EventBus).singleton(),
    })

    // Register storage factory
    this.container.register({
      storageFactory: asValue(options.storageFactory ?? createMemoryStorage()),
    })

    // Register subject factory (no cache - Subject is a thin wrapper,
    // data lives in storage which handles its own persistence)
    this.container.register({
      subjectFactory: asFunction(({ eventBus, storageFactory }) => {
        return (name: string): Subject => {
          const storage = storageFactory(name)
          return new Subject(name, storage, eventBus)
        }
      }).singleton(),
    })

    // Register handler utilities
    this.container.register({
      handlers: asFunction(({ eventBus }) => {
        return createHandlers(eventBus)
      }).singleton(),
    })
  }

  /**
   * Get a subject by name.
   * Creates a new Subject instance each time (Subject is a thin wrapper).
   * Data persistence is handled by the storage backend.
   *
   * @param name - Subject identifier
   */
  subject(name: string): Subject {
    return this.container.resolve('subjectFactory')(name)
  }

  /**
   * Get handler utilities.
   *
   * @returns Object with on, middleware, and emit
   */
  handlers(): KRulesCradle['handlers'] {
    return this.container.resolve('handlers')
  }

  /**
   * Get the EventBus instance.
   */
  get eventBus(): EventBus {
    return this.container.resolve('eventBus')
  }

  /**
   * Get the storage factory.
   */
  get storageFactory(): StorageFactory {
    return this.container.resolve('storageFactory')
  }

  /**
   * Set a new storage factory.
   *
   * Note: Existing Subject instances will still use their original storage.
   * New calls to container.subject() will use the new factory.
   *
   * @param factory - New storage factory
   *
   * @example
   * container.setStorageFactory(createRedisStorage({ client }))
   * const user = container.subject('user:123') // Uses new storage
   */
  setStorageFactory(factory: StorageFactory): void {
    this.container.register({
      storageFactory: asValue(factory),
    })
  }

  /**
   * Get the underlying Awilix container for advanced use.
   */
  get rawContainer(): AwilixContainer<KRulesCradle> {
    return this.container
  }

  /**
   * Dispose of the container and clean up resources.
   */
  async dispose(): Promise<void> {
    await this.container.dispose()
  }
}

/**
 * Create a new KRules container.
 *
 * @param options - Container options
 * @returns KRulesContainer instance
 *
 * @example
 * // With default InMemoryStorage
 * const container = createKRulesContainer()
 *
 * @example
 * // With Redis storage
 * import { createRedisStorage } from 'krules/storage/redis'
 *
 * const container = createKRulesContainer({
 *   storageFactory: createRedisStorage({ client: redisClient }),
 * })
 */
export function createKRulesContainer(
  options: KRulesContainerOptions = {}
): KRulesContainer {
  return new KRulesContainer(options)
}
