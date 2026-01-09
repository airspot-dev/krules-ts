/**
 * HandlerBuilder - Fluent API for handler registration
 *
 * Provides the on().when().run() pattern for registering event handlers.
 *
 * @example
 * on('user.login')
 *   .when((ctx) => ctx.payload.ip !== undefined)
 *   .run(async (ctx) => {
 *     console.log(`User logged in from ${ctx.payload.ip}`)
 *   })
 *
 * @example
 * on(SubjectPropertyChanged)
 *   .when((ctx) => ctx.propertyName === 'temperature')
 *   .when((ctx) => ctx.newValue > 80)
 *   .run(async (ctx) => {
 *     await ctx.emit('alert.temperature', ctx.subject, { temp: ctx.newValue })
 *   })
 */

import type { EventBus } from '../event-bus'
import type {
  HandlerFunction,
  FilterFunction,
  MiddlewareFunction,
  EmitFunction,
} from './types'
import type { Subject } from '../subject/subject'

/**
 * Builder for registering handlers with filters.
 */
export class HandlerBuilder {
  private filters: FilterFunction[] = []
  private handlerName?: string

  constructor(
    private readonly eventBus: EventBus,
    private readonly patterns: string[]
  ) {}

  /**
   * Add a filter condition (chainable).
   * All filters must pass for handler to execute (AND logic).
   * Supports both sync and async filter functions.
   *
   * @param filter - Function that returns true to allow execution
   */
  when(filter: FilterFunction): this {
    this.filters.push(filter)
    return this
  }

  /**
   * Set a name for this handler (useful for unregistration).
   *
   * @param name - Unique handler name
   */
  named(name: string): this {
    this.handlerName = name
    return this
  }

  /**
   * Register the handler function.
   * This finalizes the handler registration.
   *
   * @param fn - Async handler function
   * @returns Handler name (for unregistration)
   */
  run(fn: HandlerFunction): string {
    return this.eventBus.register(fn, this.patterns, this.filters, this.handlerName)
  }
}

/**
 * Create handler utilities bound to an EventBus.
 *
 * @param eventBus - The EventBus instance to bind to
 * @returns Object with on, middleware, and emit functions
 *
 * @example
 * const { on, middleware, emit } = createHandlers(eventBus)
 *
 * on('user.created').run(async (ctx) => { ... })
 *
 * middleware(async (ctx, next) => {
 *   console.log('Before')
 *   await next()
 *   console.log('After')
 * })
 *
 * await emit('user.created', subject, { name: 'John' })
 */
export function createHandlers(eventBus: EventBus): {
  on: (...patterns: string[]) => HandlerBuilder
  middleware: (fn: MiddlewareFunction) => void
  emit: EmitFunction
} {
  return {
    /**
     * Start building a handler for event pattern(s).
     *
     * @param patterns - Event patterns to match (supports *, ?)
     * @returns HandlerBuilder for fluent configuration
     *
     * @example
     * // Single pattern
     * on('user.created').run(async (ctx) => { ... })
     *
     * // Glob pattern
     * on('device.alert.*').run(async (ctx) => { ... })
     *
     * // Multiple patterns (OR logic)
     * on('user.login', 'user.logout').run(async (ctx) => { ... })
     */
    on: (...patterns: string[]): HandlerBuilder => {
      return new HandlerBuilder(eventBus, patterns)
    },

    /**
     * Register middleware that runs for ALL events.
     *
     * @param fn - Middleware function
     *
     * @example
     * middleware(async (ctx, next) => {
     *   const start = performance.now()
     *   await next()
     *   console.log(`Took ${performance.now() - start}ms`)
     * })
     */
    middleware: (fn: MiddlewareFunction): void => {
      eventBus.addMiddleware(fn)
    },

    /**
     * Emit an event.
     *
     * @param eventType - Event type string
     * @param subject - Subject associated with this event
     * @param payload - Optional event payload
     * @param extra - Optional extra context
     *
     * @example
     * await emit('user.created', user, { email: 'john@example.com' })
     */
    emit: async (
      eventType: string,
      subject: Subject,
      payload?: unknown,
      extra?: Record<string, unknown>
    ): Promise<void> => {
      await eventBus.emit(eventType, subject, payload, extra)
    },
  }
}
