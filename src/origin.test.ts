/**
 * Event-chain tracking tests.
 *
 * Concurrent isolation and implicit inheritance are acceptance criteria that
 * regress silently — a leak between chains produces no error, just wrong
 * correlation data. These tests pin them down.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { createKRulesContainer } from './container'
import {
  getOriginId,
  withOriginId,
  enterOriginScope,
  exitOriginScope,
} from './origin'
import { SubjectPropertyChanged } from './events'
import type { EventContext } from './handlers/types'

describe('origin id', () => {
  let container: ReturnType<typeof createKRulesContainer>
  let on: ReturnType<ReturnType<typeof createKRulesContainer>['handlers']>['on']
  let emit: ReturnType<
    ReturnType<typeof createKRulesContainer>['handlers']
  >['emit']

  beforeEach(() => {
    container = createKRulesContainer()
    const handlers = container.handlers()
    on = handlers.on
    emit = handlers.emit
  })

  test('is auto-generated when emitting outside any chain', async () => {
    const seen: string[] = []
    on('evt.root').run(async (ctx) => {
      seen.push(ctx.originId)
    })

    const subject = container.subject('test:origin')
    await emit('evt.root', subject)
    await emit('evt.root', subject)

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBeTruthy()
    expect(seen[1]).toBeTruthy()
    // Independent root chains get independent ids
    expect(seen[0]).not.toBe(seen[1])
  })

  test('uses the explicit id provided by the entry-point caller', async () => {
    let seen: string | undefined
    on('evt.explicit').run(async (ctx) => {
      seen = ctx.originId
    })

    const subject = container.subject('test:origin')
    await withOriginId('REQ-123', async () => {
      await emit('evt.explicit', subject)
    })

    expect(seen).toBe('REQ-123')
  })

  test('inherits across nested ctx.emit()', async () => {
    const seen: string[] = []

    on('evt.first').run(async (ctx) => {
      seen.push(ctx.originId)
      await ctx.emit('evt.second', ctx.subject)
    })
    on('evt.second').run(async (ctx) => {
      seen.push(ctx.originId)
      await ctx.emit('evt.third', ctx.subject)
    })
    on('evt.third').run(async (ctx) => {
      seen.push(ctx.originId)
    })

    const subject = container.subject('test:origin')
    await withOriginId('CHAIN-A', async () => {
      await emit('evt.first', subject)
    })

    expect(seen).toEqual(['CHAIN-A', 'CHAIN-A', 'CHAIN-A'])
  })

  test('inherits through implicit events from Subject.set()', async () => {
    const seen: string[] = []

    on('evt.trigger').run(async (ctx) => {
      await ctx.subject.set('temperature', 90)
    })
    on(SubjectPropertyChanged).run(async (ctx) => {
      seen.push(ctx.originId)
    })

    const subject = container.subject('test:origin-implicit')
    await withOriginId('CHAIN-B', async () => {
      await emit('evt.trigger', subject)
    })

    expect(seen).toEqual(['CHAIN-B'])
  })

  test('inherits through implicit events from a batch commit', async () => {
    const seen: string[] = []
    on(SubjectPropertyChanged).run(async (ctx) => {
      seen.push(ctx.originId)
    })

    const subject = container.subject('test:origin-batch')
    await withOriginId('CHAIN-C', async () => {
      await subject.batch().set('a', 1).set('b', 2).commit()
    })

    expect(seen).toEqual(['CHAIN-C', 'CHAIN-C'])
  })

  test('keeps concurrent chains isolated', async () => {
    const seen = new Map<string, string[]>()

    on('evt.concurrent').run(async (ctx: EventContext) => {
      const payload = ctx.payload as { chain: string }
      // Yield so the two chains genuinely interleave
      await Bun.sleep(1)
      await ctx.subject.set(`prop-${payload.chain}`, payload.chain)
    })
    on(SubjectPropertyChanged).run(async (ctx) => {
      const list = seen.get(ctx.propertyName!) ?? []
      list.push(ctx.originId)
      seen.set(ctx.propertyName!, list)
    })

    const subject = container.subject('test:origin-concurrent')

    await Promise.all([
      withOriginId('CHAIN-1', async () => {
        await emit('evt.concurrent', subject, { chain: '1' })
      }),
      withOriginId('CHAIN-2', async () => {
        await emit('evt.concurrent', subject, { chain: '2' })
      }),
    ])

    expect(seen.get('prop-1')).toEqual(['CHAIN-1'])
    expect(seen.get('prop-2')).toEqual(['CHAIN-2'])
  })

  test('does not leak outside the scope', async () => {
    expect(getOriginId()).toBeUndefined()

    await withOriginId('SCOPED', async () => {
      expect(getOriginId()).toBe('SCOPED')
    })

    expect(getOriginId()).toBeUndefined()
  })

  test('restores the outer chain after a nested scope', async () => {
    await withOriginId('OUTER', async () => {
      await withOriginId('INNER', async () => {
        expect(getOriginId()).toBe('INNER')
      })
      expect(getOriginId()).toBe('OUTER')
    })
  })

  test('passes the resolved id to the scope callback', async () => {
    const generated = await withOriginId(undefined, async (originId) => originId)
    expect(generated).toBeTruthy()
    expect(await withOriginId('GIVEN', async (id) => id)).toBe('GIVEN')
  })

  test('binds and detaches the chain via the low-level scope pair', async () => {
    // Run inside a wrapper so enterWith() cannot bleed into other tests
    await withOriginId('WRAPPER', async () => {
      const bound = enterOriginScope('MANUAL')
      expect(bound).toBe('MANUAL')
      expect(getOriginId()).toBe('MANUAL')

      const seen: string[] = []
      on('evt.manual').run(async (ctx) => {
        seen.push(ctx.originId)
      })
      await emit('evt.manual', container.subject('test:origin-manual'))
      expect(seen).toEqual(['MANUAL'])

      exitOriginScope()
      expect(getOriginId()).toBeUndefined()
    })

    expect(getOriginId()).toBeUndefined()
  })

  test('generates an id when the low-level scope is opened without one', async () => {
    await withOriginId('WRAPPER', async () => {
      const bound = enterOriginScope()
      expect(bound).toBeTruthy()
      expect(getOriginId()).toBe(bound)
      exitOriginScope()
    })
  })

  test('does not add any origin-id surface to Subject', () => {
    const subject = container.subject('test:origin-surface') as unknown as Record<
      string,
      unknown
    >
    expect(subject.originId).toBeUndefined()
    expect(subject.origin_id).toBeUndefined()
    expect(subject.getOriginId).toBeUndefined()
  })
})
