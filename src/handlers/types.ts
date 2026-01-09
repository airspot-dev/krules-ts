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
}

/**
 * Emit function type.
 */
export type EmitFunction = (
  eventType: string,
  subject: Subject,
  payload?: unknown,
  extra?: Record<string, unknown>
) => Promise<void>
