/**
 * EventBus - Event routing and dispatch for krules.ts
 *
 * Handles:
 * - Handler registration with glob patterns
 * - Filter evaluation
 * - Middleware chain execution
 * - Event emission
 */

import type { Subject } from './subject/subject'
import type {
  EventContext,
  HandlerFunction,
  FilterFunction,
  MiddlewareFunction,
  RegisteredHandler,
} from './handlers/types'

/**
 * Internal implementation of EventContext
 */
class EventContextImpl implements EventContext {
  constructor(
    public readonly eventType: string,
    public readonly subject: Subject,
    public readonly payload: unknown,
    public readonly extra: Record<string, unknown>,
    private readonly eventBus: EventBus,
    public readonly propertyName?: string,
    public readonly oldValue?: unknown,
    public readonly newValue?: unknown
  ) {}

  async emit(
    eventType: string,
    subject: Subject,
    payload?: unknown,
    extra?: Record<string, unknown>
  ): Promise<void> {
    await this.eventBus.emit(eventType, subject, payload, extra)
  }
}

/**
 * EventBus routes events to registered handlers.
 *
 * Features:
 * - Glob pattern matching for event types (*, ?)
 * - Filter conditions (AND logic)
 * - Middleware chain for cross-cutting concerns
 * - Async handler execution
 */
export class EventBus {
  private handlers: RegisteredHandler[] = []
  private middlewares: MiddlewareFunction[] = []
  private handlerCounter = 0

  /**
   * Register a handler for event patterns.
   *
   * @param fn - Handler function
   * @param patterns - Event patterns to match (supports *, ?)
   * @param filters - Filter conditions (all must pass)
   * @param name - Optional handler name for unregistration
   */
  register(
    fn: HandlerFunction,
    patterns: string[],
    filters: FilterFunction[] = [],
    name?: string
  ): string {
    const handlerName = name ?? `handler_${++this.handlerCounter}`

    this.handlers.push({
      name: handlerName,
      fn,
      patterns,
      filters,
    })

    return handlerName
  }

  /**
   * Unregister a handler by name.
   */
  unregister(name: string): boolean {
    const index = this.handlers.findIndex((h) => h.name === name)
    if (index !== -1) {
      this.handlers.splice(index, 1)
      return true
    }
    return false
  }

  /**
   * Unregister all handlers.
   */
  unregisterAll(): void {
    this.handlers = []
    this.handlerCounter = 0
  }

  /**
   * Add middleware to the execution chain.
   * Middleware runs once per emitted event, before handler dispatch,
   * regardless of whether any handler matches or passes filters.
   * First registered = outermost (runs first before, last after).
   */
  addMiddleware(fn: MiddlewareFunction): void {
    this.middlewares.push(fn)
  }

  /**
   * Remove all middleware.
   */
  clearMiddleware(): void {
    this.middlewares = []
  }

  /**
   * Emit an event to all matching handlers.
   *
   * @param eventType - The event type string
   * @param subject - The subject associated with this event
   * @param payload - Optional event payload
   * @param extra - Optional extra context
   * @param options - Optional event options (propertyName, oldValue, newValue)
   */
  async emit(
    eventType: string,
    subject: Subject,
    payload?: unknown,
    extra?: Record<string, unknown>,
    options?: {
      propertyName?: string
      oldValue?: unknown
      newValue?: unknown
    }
  ): Promise<void> {
    const ctx = new EventContextImpl(
      eventType,
      subject,
      payload ?? {},
      extra ?? {},
      this,
      options?.propertyName,
      options?.oldValue,
      options?.newValue
    )

    // Dispatch: match handlers, evaluate filters, execute
    const dispatch = async (): Promise<void> => {
      const matchingHandlers = this.handlers.filter((handler) =>
        handler.patterns.some((pattern) => this.matchPattern(pattern, eventType))
      )

      for (const handler of matchingHandlers) {
        try {
          const filtersPassed = await this.evaluateFilters(handler.filters, ctx)
          if (!filtersPassed) {
            continue
          }
          await handler.fn(ctx)
        } catch (error) {
          // Log error but don't stop other handlers
          console.error(
            `Error in handler "${handler.name}" for event "${eventType}":`,
            error
          )
        }
      }
    }

    // Wrap dispatch with middleware chain (runs once per event)
    await this.runMiddlewareChain(ctx, dispatch)
  }

  /**
   * Match an event type against a glob pattern.
   *
   * Supports:
   * - * matches any sequence of characters
   * - ? matches any single character
   *
   * @example
   * matchPattern('user.*', 'user.login') // true
   * matchPattern('device.?', 'device.1') // true
   * matchPattern('*', 'anything') // true
   */
  private matchPattern(pattern: string, eventType: string): boolean {
    // Escape regex special chars except * and ?
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')

    const regex = new RegExp(`^${escaped}$`)
    return regex.test(eventType)
  }

  /**
   * Evaluate all filter conditions.
   * All filters must pass (AND logic).
   */
  private async evaluateFilters(
    filters: FilterFunction[],
    ctx: EventContext
  ): Promise<boolean> {
    for (const filter of filters) {
      try {
        const result = await filter(ctx)
        if (!result) {
          return false
        }
      } catch (error) {
        // Filter error = filter failed
        console.error('Filter error:', error)
        return false
      }
    }
    return true
  }

  /**
   * Wrap a dispatch function with the registered middleware chain.
   * Middleware runs once per event, regardless of handler matching.
   */
  private async runMiddlewareChain(
    ctx: EventContext,
    dispatch: () => Promise<void>
  ): Promise<void> {
    let chain = dispatch

    // Wrap with middleware (reverse order so first added runs first)
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const middleware = this.middlewares[i]!
      const next = chain
      chain = async () => {
        await middleware(ctx, next)
      }
    }

    await chain()
  }

  /**
   * Get the number of registered handlers.
   */
  get handlerCount(): number {
    return this.handlers.length
  }

  /**
   * Get the number of registered middlewares.
   */
  get middlewareCount(): number {
    return this.middlewares.length
  }
}
