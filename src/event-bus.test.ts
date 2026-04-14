/**
 * Middleware behavior tests for EventBus.
 *
 * Middleware runs ONCE per emitted event, before handler dispatch,
 * regardless of whether any handler matches or passes filters.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { EventBus } from './event-bus'
import { createHandlers } from './handlers/builder'
import { createKRulesContainer } from './container'
import type { Subject } from './subject/subject'

describe('EventBus middleware', () => {
  let bus: EventBus
  let subject: Subject
  let on: ReturnType<typeof createHandlers>['on']
  let middleware: ReturnType<typeof createHandlers>['middleware']
  let emit: ReturnType<typeof createHandlers>['emit']

  beforeEach(() => {
    const container = createKRulesContainer()
    bus = container.eventBus
    const handlers = container.handlers()
    on = handlers.on
    middleware = handlers.middleware
    emit = handlers.emit
    subject = container.subject('test:middleware')
  })

  test('runs for events with matching handlers', async () => {
    const calls: string[] = []

    middleware(async (ctx, next) => {
      calls.push(`before:${ctx.eventType}`)
      await next()
      calls.push(`after:${ctx.eventType}`)
    })

    on('evt.match').run(async () => {
      calls.push('handler')
    })

    await emit('evt.match', subject)

    expect(calls).toEqual(['before:evt.match', 'handler', 'after:evt.match'])
  })

  test('runs even when no handler matches the event', async () => {
    const calls: string[] = []

    middleware(async (ctx, next) => {
      calls.push(`before:${ctx.eventType}`)
      await next()
      calls.push(`after:${ctx.eventType}`)
    })

    await emit('evt.orphan', subject)

    expect(calls).toEqual(['before:evt.orphan', 'after:evt.orphan'])
  })

  test('runs even when handlers exist but filters reject the event', async () => {
    const calls: string[] = []

    middleware(async (ctx, next) => {
      calls.push('middleware')
      await next()
    })

    on('evt.filtered')
      .when(() => false)
      .run(async () => {
        calls.push('handler')
      })

    await emit('evt.filtered', subject)

    expect(calls).toEqual(['middleware'])
  })

  test('runs exactly once per event even with multiple matching handlers', async () => {
    let middlewareCount = 0
    let handlerCount = 0

    middleware(async (_ctx, next) => {
      middlewareCount++
      await next()
    })

    on('evt.multi').run(async () => {
      handlerCount++
    })
    on('evt.multi').run(async () => {
      handlerCount++
    })
    on('evt.*').run(async () => {
      handlerCount++
    })

    await emit('evt.multi', subject)

    expect(middlewareCount).toBe(1)
    expect(handlerCount).toBe(3)
  })

  test('multiple middlewares run in registration order (onion model)', async () => {
    const calls: string[] = []

    middleware(async (_ctx, next) => {
      calls.push('m1:before')
      await next()
      calls.push('m1:after')
    })

    middleware(async (_ctx, next) => {
      calls.push('m2:before')
      await next()
      calls.push('m2:after')
    })

    on('evt.order').run(async () => {
      calls.push('handler')
    })

    await emit('evt.order', subject)

    expect(calls).toEqual([
      'm1:before',
      'm2:before',
      'handler',
      'm2:after',
      'm1:after',
    ])
  })

  test('middleware can short-circuit dispatch by not calling next()', async () => {
    let handlerCalled = false

    middleware(async (_ctx, _next) => {
      // intentionally skip next()
    })

    on('evt.blocked').run(async () => {
      handlerCalled = true
    })

    await emit('evt.blocked', subject)

    expect(handlerCalled).toBe(false)
  })

  test('middleware errors propagate to emit() caller', async () => {
    middleware(async () => {
      throw new Error('boom')
    })

    on('evt.err').run(async () => {})

    await expect(emit('evt.err', subject)).rejects.toThrow('boom')
  })

  test('handler errors do not break middleware chain', async () => {
    const calls: string[] = []

    middleware(async (_ctx, next) => {
      calls.push('before')
      await next()
      calls.push('after')
    })

    on('evt.handler-err').run(async () => {
      throw new Error('handler failed')
    })

    await emit('evt.handler-err', subject)

    expect(calls).toEqual(['before', 'after'])
  })

  test('middleware receives the same context as handlers', async () => {
    let middlewareCtx: unknown
    let handlerCtx: unknown

    middleware(async (ctx, next) => {
      middlewareCtx = ctx
      await next()
    })

    on('evt.ctx').run(async (ctx) => {
      handlerCtx = ctx
    })

    await emit('evt.ctx', subject, { foo: 'bar' }, { source: 'test' })

    expect(middlewareCtx).toBe(handlerCtx)
  })

  test('clearMiddleware removes all middlewares', async () => {
    let count = 0
    middleware(async (_ctx, next) => {
      count++
      await next()
    })

    bus.clearMiddleware()

    await emit('evt.any', subject)

    expect(count).toBe(0)
    expect(bus.middlewareCount).toBe(0)
  })
})
