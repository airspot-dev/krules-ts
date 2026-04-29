/**
 * Handler types for krules.ts
 */

import type { Subject } from '../subject/subject'

/**
 * Context passed to event handlers.
 * Contains all information about the event being processed.
 */
export interface EventContext<TPayload = unknown> {
  /** The event type that triggered this handler */
  readonly eventType: string

  /** The subject associated with this event */
  readonly subject: Subject

  /** Event payload data */
  readonly payload: TPayload

  /** Property name (for property change/delete events) */
  readonly propertyName?: string

  /** Previous value (for property change/delete events) */
  readonly oldValue?: unknown

  /** New value (for property change events) */
  readonly newValue?: unknown

  /** Extra context passed with the event */
  readonly extra: Record<string, unknown>

  /**
   * Emit a new event from within a handler.
   * Uses the same EventBus instance.
   */
  emit(
    eventType: string,
    subject: Subject,
    payload?: unknown,
    extra?: Record<string, unknown>
  ): Promise<void>
}

/**
 * Handler function type.
 * Receives EventContext and performs async operations.
 */
export type HandlerFunction<TPayload = unknown> = (
  ctx: EventContext<TPayload>
) => Promise<void>

/**
 * Filter function type.
 * Returns true if the handler should execute, false to skip.
 * Can be sync or async.
 */
export type FilterFunction = (
  ctx: EventContext
) => boolean | Promise<boolean>

/**
 * Middleware function type.
 * Wraps handler execution for cross-cutting concerns.
 *
 * @example
 * middleware(async (ctx, next) => {
 *   console.log('Before handler')
 *   await next()
 *   console.log('After handler')
 * })
 */
export type MiddlewareFunction = (
  ctx: EventContext,
  next: () => Promise<void>
) => Promise<void>

/**
 * Error handler called when a handler throws during dispatch.
 *
 * Per-handler error handlers (registered via `on(...).onError(...)`) take
 * precedence over the global handler. If neither is set, errors fall back
 * to `console.error`.
 *
 * Errors thrown by the error handler itself are logged via `console.error`
 * and swallowed, so a buggy error handler can't break dispatch.
 */
export type ErrorHandler = (
  error: unknown,
  ctx: EventContext,
  handlerName: string
) => void | Promise<void>

/**
 * Controls what happens when a handler throws during emit().
 *
 * - `continue` (default): log/notify and proceed with remaining handlers.
 *   `emit()` resolves normally.
 * - `fail-fast`: invoke error handler, then re-throw the first error.
 *   Remaining handlers do NOT run.
 * - `aggregate`: run all handlers, collect errors, throw an `AggregateError`
 *   at the end if any failed.
 */
export type ErrorMode = 'continue' | 'fail-fast' | 'aggregate'

/**
 * Registered handler with metadata.
 * Used internally by EventBus.
 */
export interface RegisteredHandler {
  /** Unique handler name (for unregistration) */
  name: string

  /** The handler function to execute */
  fn: HandlerFunction

  /** Event patterns to match (supports glob: *, ?) */
  patterns: string[]

  /** Filter conditions (all must pass) */
  filters: FilterFunction[]

  /** Per-handler error callback (overrides the bus-global onError). */
  onError?: ErrorHandler
}

/**
 * Per-emit options exposed to user code.
 */
export interface EmitOptions {
  /** Override the bus default error mode for this emit. */
  errorMode?: ErrorMode
}

/**
 * Emit function type.
 */
export type EmitFunction = (
  eventType: string,
  subject: Subject,
  payload?: unknown,
  extra?: Record<string, unknown>,
  options?: EmitOptions
) => Promise<void>
