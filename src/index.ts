/**
 * krules.ts - Event-driven reactive framework for TypeScript/Bun
 *
 * @example
 * import { createKRulesContainer } from 'krules'
 * import { SubjectPropertyChanged } from 'krules/events'
 *
 * // Create container
 * const container = createKRulesContainer()
 * const { on, middleware, emit } = container.handlers()
 *
 * // Register handlers with fluent API
 * on('user.created')
 *   .run(async (ctx) => {
 *     const user = ctx.subject
 *     await user.set('status', 'active')
 *   })
 *
 * on(SubjectPropertyChanged)
 *   .when((ctx) => ctx.propertyName === 'temperature')
 *   .when((ctx) => ctx.newValue > 80)
 *   .run(async (ctx) => {
 *     await ctx.emit('alert.temperature', ctx.subject, { temp: ctx.newValue })
 *   })
 *
 * // Register middleware
 * middleware(async (ctx, next) => {
 *   console.log(`Event: ${ctx.eventType}`)
 *   await next()
 * })
 *
 * // Use subjects
 * const user = container.subject('user:123')
 *
 * // Immediate mode (default)
 * await user.set('name', 'John')
 *
 * // Batch mode
 * await user.batch()
 *   .set('age', 30)
 *   .set('email', 'john@example.com')
 *   .commit()
 *
 * // Emit custom events
 * await emit('user.created', user, { source: 'api' })
 */

// Container
export {
  KRulesContainer,
  createKRulesContainer,
  type KRulesCradle,
  type KRulesContainerOptions,
} from './container'

// EventBus
export { EventBus } from './event-bus'

// Subject
export { Subject, type SetOptions, type DeleteOptions } from './subject/subject'
export { BatchBuilder } from './subject/batch'

// Handlers
export { HandlerBuilder, createHandlers } from './handlers/builder'
export type {
  EventContext,
  HandlerFunction,
  FilterFunction,
  MiddlewareFunction,
  EmitFunction,
  EmitOptions,
  ErrorHandler,
  ErrorMode,
} from './handlers/types'

// Storage
export type { Storage, StorageFactory, StorageChanges } from './storage/types'
export { InMemoryStorage, createMemoryStorage } from './storage/memory'

// Events (also available via 'krules/events')
export {
  SubjectPropertyChanged,
  SubjectPropertyDeleted,
  SubjectDeleted,
} from './events'
