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
  ErrorHandler,
  EmitOptions,
} from './types'
import type { Subject } from '../subject/subject'

/**
 * Builder for registering handlers with filters.
 */
export class HandlerBuilder {
  private filters: FilterFunction[] = []
  private handlerName?: string
  private errorHandler?: ErrorHandler

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
   * Attach a per-handler error callback. Invoked when this handler throws,
   * before the dispatcher applies the active errorMode. Overrides the
   * bus-global onError for this handler only.
   *
   * @param fn - Error callback receiving (error, ctx, handlerName)
   *
   * @example
   * on('payment.process')
   *   .onError(async (err, ctx) => {
   *     await ctx.emit('payment.failed', ctx.subject, { reason: String(err) })
   *   })
   *   .run(async (ctx) => { ... })
   */
  onError(fn: ErrorHandler): this {
    this.errorHandler = fn
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
    return this.eventBus.register(
      fn,
      this.patterns,
      this.filters,
      this.handlerName,
      this.errorHandler
    )
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
  onError: (fn: ErrorHandler) => void
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
     * Register middleware that runs once per emitted event.
     *
     * Middleware runs before handler dispatch, regardless of whether
     * any handler matches the event or passes its filters. This makes
     * it suitable for cross-cutting concerns like logging, metrics,
     * tracing, and audit that must observe every event.
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
     * Register a global error callback invoked when any handler throws.
     *
     * Per-handler `onError` callbacks take precedence. If neither is set,
     * errors are logged via `console.error`.
     *
     * @param fn - Error callback receiving (error, ctx, handlerName)
     *
     * @example
     * onError((err, ctx, handlerName) => {
     *   logger.error({ err, eventType: ctx.eventType, handlerName })
     * })
     */
    onError: (fn: ErrorHandler): void => {
      eventBus.onError(fn)
    },

    /**
     * Emit an event.
     *
     * @param eventType - Event type string
     * @param subject - Subject associated with this event
     * @param payload - Optional event payload
     * @param extra - Optional extra context
     * @param options - Optional per-emit options (e.g. errorMode override)
     *
     * @example
     * await emit('user.created', user, { email: 'john@example.com' })
     *
     * @example
     * // Stop on first handler error and propagate it to the caller.
     * await emit('payment.process', user, { amount: 100 }, undefined, {
     *   errorMode: 'fail-fast',
     * })
     */
    emit: async (
      eventType: string,
      subject: Subject,
      payload?: unknown,
      extra?: Record<string, unknown>,
      options?: EmitOptions
    ): Promise<void> => {
      await eventBus.emit(eventType, subject, payload, extra, options)
    },
  }
}
