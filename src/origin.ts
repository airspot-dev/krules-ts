/**
 * Origin ID - Transparent event-chain tracking for krules.ts
 *
 * An origin id identifies an *event chain*: the whole causal sequence of events
 * triggered, directly or indirectly, by a single originating request. It belongs
 * to the chain, not to any Subject, and it propagates implicitly — callers never
 * thread it through `emit()`, `set()` or `delete()`.
 *
 * Propagation is built on `AsyncLocalStorage` (node:async_hooks, native in Bun),
 * the runtime-native equivalent of Python's `contextvars.ContextVar`: the value is
 * inherited across `await` boundaries within the same async flow and stays isolated
 * between concurrently running flows.
 *
 * The public surface is deliberately small:
 * - `getOriginId()` — read the current chain's id (undefined outside a chain)
 * - `withOriginId(value, fn)` — run `fn` inside a chain, with an explicit id or an
 *   auto-generated one
 * - `generateOriginId()` — mint a fresh id
 * - `enterOriginScope()` / `exitOriginScope()` — low-level pair for entry points that
 *   cannot wrap their work in a callback
 *
 * `getOriginId()` + `withOriginId()` are also the bridge across transport boundaries
 * the framework does not own (message brokers, schedulers, HTTP hops): read the id on
 * the way out, carry it as data, re-seed it on the way in.
 *
 * @example
 * // Entry point with an id taken from an incoming request
 * await withOriginId(req.headers.get('x-request-id'), async () => {
 *   await emit('order.received', order, body)
 * })
 *
 * @example
 * // Entry point letting the framework generate one — the callback receives it
 * await withOriginId(undefined, async (originId) => {
 *   res.headers.set('x-origin-id', originId)
 *   await emit('order.received', order, body)
 * })
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Task-local storage holding the current chain's origin id.
 * Module-level singleton: one chain context per async flow.
 */
const originIdStorage = new AsyncLocalStorage<string | undefined>()

/**
 * Generate a fresh origin id.
 *
 * Used by the framework when an event is emitted outside any active chain,
 * and available to user code that needs to mint an id up front.
 */
export function generateOriginId(): string {
  return crypto.randomUUID()
}

/**
 * Read the origin id of the current event chain.
 *
 * Returns `undefined` when called outside any chain — that is not an error
 * condition, it just means no chain has been opened in this async flow yet.
 *
 * @example
 * // Carry the id across a boundary the framework does not own
 * await broker.publish(topic, { ...payload, originId: getOriginId() })
 */
export function getOriginId(): string | undefined {
  return originIdStorage.getStore()
}

/**
 * Run `fn` inside an event chain.
 *
 * Every event emitted while `fn` is running — explicitly via `emit()` / `ctx.emit()`,
 * or implicitly via `Subject.set()`, `Subject.delete()`, `Subject.flush()` and batch
 * commits — carries the same origin id, with no manual threading.
 *
 * Chains opened concurrently are fully isolated from each other. The previous value,
 * if any, is restored when `fn` settles.
 *
 * @param value - Explicit origin id (e.g. from an incoming header). When `undefined`
 *   or empty, a fresh id is generated.
 * @param fn - The work to run inside the chain. Receives the resolved origin id, so
 *   auto-generated ids are available without a separate `getOriginId()` call. Its
 *   return value is passed through.
 *
 * @example
 * // Re-seed a chain that arrived over a transport boundary
 * await withOriginId(message.originId, async () => {
 *   await emit('payment.settled', account, message.body)
 * })
 */
export function withOriginId<T>(
  value: string | undefined | null,
  fn: (originId: string) => T | Promise<T>
): Promise<T> {
  const originId = value != null && value !== '' ? value : generateOriginId()
  return Promise.resolve(originIdStorage.run(originId, fn, originId))
}

/**
 * Low-level scope entry, for entry points that cannot wrap their work in a callback.
 *
 * Binds `value` (or a freshly generated id) to the current async flow and returns the
 * bound id. The scope stays open until `exitOriginScope()` is called from that same
 * flow — prefer `withOriginId()`, which cannot leak the scope.
 *
 * @param value - Explicit origin id. When `undefined` or empty, a fresh id is generated.
 * @returns The origin id now bound to the current flow.
 */
export function enterOriginScope(value?: string | null): string {
  const originId = value != null && value !== '' ? value : generateOriginId()
  originIdStorage.enterWith(originId)
  return originId
}

/**
 * Low-level scope exit: detach the current async flow from its origin id.
 *
 * Counterpart of `enterOriginScope()`. After this call `getOriginId()` returns
 * `undefined` and the next emitted event opens a fresh chain.
 */
export function exitOriginScope(): void {
  originIdStorage.enterWith(undefined)
}
