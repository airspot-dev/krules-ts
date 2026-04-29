/**
 * Error handling tests for EventBus dispatch.
 *
 * Covers:
 * - Per-handler onError vs global onError vs console.error fallback
 * - errorMode: 'continue' (default), 'fail-fast', 'aggregate'
 * - onError hook errors do not break dispatch
 */

import { describe, test, expect, beforeEach, spyOn } from 'bun:test'
import { EventBus } from './event-bus'
import { createHandlers } from './handlers/builder'
import { createKRulesContainer } from './container'
import type { Subject } from './subject/subject'

describe('EventBus error handling', () => {
  let bus: EventBus
  let subject: Subject
  let on: ReturnType<typeof createHandlers>['on']
  let onError: ReturnType<typeof createHandlers>['onError']
  let emit: ReturnType<typeof createHandlers>['emit']

  beforeEach(() => {
    const container = createKRulesContainer()
    bus = container.eventBus
    const handlers = container.handlers()
    on = handlers.on
    onError = handlers.onError
    emit = handlers.emit
    subject = container.subject('test:errors')
  })

  describe('default behavior (no error handler registered)', () => {
    test('continues to next handler after one throws', async () => {
      const calls: string[] = []
      const stderr = spyOn(console, 'error').mockImplementation(() => {})

      on('evt.fail').run(async () => {
        calls.push('first')
        throw new Error('boom')
      })
      on('evt.fail').run(async () => {
        calls.push('second')
      })

      await emit('evt.fail', subject)

      expect(calls).toEqual(['first', 'second'])
      expect(stderr).toHaveBeenCalled()
      stderr.mockRestore()
    })

    test('emit() resolves successfully when handler throws', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})

      on('evt.fail').run(async () => {
        throw new Error('boom')
      })

      await expect(emit('evt.fail', subject)).resolves.toBeUndefined()
      stderr.mockRestore()
    })
  })

  describe('global onError', () => {
    test('is invoked instead of console.error when set', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})
      const seen: Array<{ err: unknown; eventType: string; name: string }> = []

      onError((err, ctx, name) => {
        seen.push({ err, eventType: ctx.eventType, name })
      })

      on('evt.fail').named('handler-a').run(async () => {
        throw new Error('boom')
      })

      await emit('evt.fail', subject)

      expect(seen).toHaveLength(1)
      expect(seen[0]!.eventType).toBe('evt.fail')
      expect(seen[0]!.name).toBe('handler-a')
      expect((seen[0]!.err as Error).message).toBe('boom')
      expect(stderr).not.toHaveBeenCalled()
      stderr.mockRestore()
    })

    test('supports async error handlers', async () => {
      let resolved = false

      onError(async (_err, _ctx, _name) => {
        await new Promise((r) => setTimeout(r, 5))
        resolved = true
      })

      on('evt.fail').run(async () => {
        throw new Error('boom')
      })

      await emit('evt.fail', subject)

      expect(resolved).toBe(true)
    })

    test('clearErrorHandler restores console.error fallback', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})
      let hookCalls = 0

      onError(() => {
        hookCalls++
      })
      bus.clearErrorHandler()

      on('evt.fail').run(async () => {
        throw new Error('boom')
      })

      await emit('evt.fail', subject)

      expect(hookCalls).toBe(0)
      expect(stderr).toHaveBeenCalled()
      stderr.mockRestore()
    })

    test('a throwing onError hook does not break dispatch', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})
      const calls: string[] = []

      onError(() => {
        throw new Error('hook exploded')
      })

      on('evt.fail').run(async () => {
        calls.push('first')
        throw new Error('boom')
      })
      on('evt.fail').run(async () => {
        calls.push('second')
      })

      await emit('evt.fail', subject)

      expect(calls).toEqual(['first', 'second'])
      expect(stderr).toHaveBeenCalled()
      stderr.mockRestore()
    })
  })

  describe('per-handler onError', () => {
    test('takes precedence over global onError', async () => {
      let global = 0
      let perHandler = 0

      onError(() => {
        global++
      })

      on('evt.fail')
        .onError(() => {
          perHandler++
        })
        .run(async () => {
          throw new Error('boom')
        })

      await emit('evt.fail', subject)

      expect(perHandler).toBe(1)
      expect(global).toBe(0)
    })

    test('applies only to the handler it is attached to', async () => {
      let perHandler = 0
      let global = 0

      onError(() => {
        global++
      })

      on('evt.fail')
        .onError(() => {
          perHandler++
        })
        .run(async () => {
          throw new Error('first')
        })

      on('evt.fail').run(async () => {
        throw new Error('second')
      })

      await emit('evt.fail', subject)

      expect(perHandler).toBe(1)
      expect(global).toBe(1)
    })

    test('receives error, ctx, and handler name', async () => {
      let captured: { err: unknown; eventType: string; name: string } | null = null

      on('evt.fail')
        .named('payment-processor')
        .onError((err, ctx, name) => {
          captured = { err, eventType: ctx.eventType, name }
        })
        .run(async () => {
          throw new Error('charge failed')
        })

      await emit('evt.fail', subject)

      expect(captured).not.toBeNull()
      expect(captured!.eventType).toBe('evt.fail')
      expect(captured!.name).toBe('payment-processor')
      expect((captured!.err as Error).message).toBe('charge failed')
    })
  })

  describe("errorMode: 'continue' (default)", () => {
    test('runs all handlers and resolves even when several throw', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})
      const calls: string[] = []

      on('evt.multi').run(async () => {
        calls.push('a')
        throw new Error('a-fail')
      })
      on('evt.multi').run(async () => {
        calls.push('b')
        throw new Error('b-fail')
      })
      on('evt.multi').run(async () => {
        calls.push('c')
      })

      await expect(emit('evt.multi', subject)).resolves.toBeUndefined()
      expect(calls).toEqual(['a', 'b', 'c'])
      stderr.mockRestore()
    })
  })

  describe("errorMode: 'fail-fast'", () => {
    test('throws first error and stops remaining handlers', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})
      const calls: string[] = []

      on('evt.ff').run(async () => {
        calls.push('a')
      })
      on('evt.ff').run(async () => {
        calls.push('b')
        throw new Error('b-fail')
      })
      on('evt.ff').run(async () => {
        calls.push('c')
      })

      await expect(
        emit('evt.ff', subject, undefined, undefined, { errorMode: 'fail-fast' })
      ).rejects.toThrow('b-fail')

      expect(calls).toEqual(['a', 'b'])
      stderr.mockRestore()
    })

    test('still invokes onError before re-throwing', async () => {
      let hookCalls = 0
      onError(() => {
        hookCalls++
      })

      on('evt.ff').run(async () => {
        throw new Error('boom')
      })

      await expect(
        emit('evt.ff', subject, undefined, undefined, { errorMode: 'fail-fast' })
      ).rejects.toThrow('boom')

      expect(hookCalls).toBe(1)
    })

    test('resolves normally when no handler throws', async () => {
      on('evt.ok').run(async () => {})
      await expect(
        emit('evt.ok', subject, undefined, undefined, { errorMode: 'fail-fast' })
      ).resolves.toBeUndefined()
    })
  })

  describe("errorMode: 'aggregate'", () => {
    test('runs all handlers and throws AggregateError with all errors', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})
      const calls: string[] = []

      on('evt.agg').run(async () => {
        calls.push('a')
        throw new Error('a-fail')
      })
      on('evt.agg').run(async () => {
        calls.push('b')
      })
      on('evt.agg').run(async () => {
        calls.push('c')
        throw new Error('c-fail')
      })

      let caught: unknown
      try {
        await emit('evt.agg', subject, undefined, undefined, {
          errorMode: 'aggregate',
        })
      } catch (e) {
        caught = e
      }

      expect(calls).toEqual(['a', 'b', 'c'])
      expect(caught).toBeInstanceOf(AggregateError)
      const agg = caught as AggregateError
      expect(agg.errors).toHaveLength(2)
      expect((agg.errors[0] as Error).message).toBe('a-fail')
      expect((agg.errors[1] as Error).message).toBe('c-fail')
      stderr.mockRestore()
    })

    test('resolves normally when no handler throws', async () => {
      on('evt.agg-ok').run(async () => {})
      await expect(
        emit('evt.agg-ok', subject, undefined, undefined, {
          errorMode: 'aggregate',
        })
      ).resolves.toBeUndefined()
    })
  })

  describe('default error mode on bus', () => {
    test('setDefaultErrorMode applies to subsequent emits without override', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})
      bus.setDefaultErrorMode('fail-fast')

      on('evt.df').run(async () => {
        throw new Error('boom')
      })

      await expect(emit('evt.df', subject)).rejects.toThrow('boom')
      stderr.mockRestore()
    })

    test('per-emit errorMode overrides the default', async () => {
      const stderr = spyOn(console, 'error').mockImplementation(() => {})
      bus.setDefaultErrorMode('fail-fast')

      on('evt.df2').run(async () => {
        throw new Error('boom')
      })

      await expect(
        emit('evt.df2', subject, undefined, undefined, { errorMode: 'continue' })
      ).resolves.toBeUndefined()
      stderr.mockRestore()
    })
  })
})
