---
type: Component
title: Event chain tracking (originId)
description: Ambient identifier of an event chain, propagated implicitly across the whole causal sequence of events via AsyncLocalStorage, with a public getter + scope API that bridges transport boundaries the framework does not own.
resource: krules/origin
tags: [events, event-bus, correlation, tracing, async-context, concurrency]
timestamp: 2026-07-30T00:00:00Z
---

# Overview

An **origin id** identifies an *event chain*: the whole causal sequence of events
triggered, directly or indirectly, by a single originating request. It belongs to
the chain, not to any `Subject`, and it propagates **implicitly** — callers never
thread it through `emit()`, `set()` or `delete()`.

Every `EventContext` carries it as `ctx.originId` (typed, always populated).

```typescript
import { withOriginId, getOriginId } from "krules";

await withOriginId(request.headers.get("x-request-id"), async () => {
  await emit("order.received", order, body);
});

on("subject-property-changed").run(async (ctx) => {
  ctx.originId; // same id, three handlers deep, nothing threaded
});
```

Introduced in **0.7.0**. Additive and backward compatible: no existing signature
changed.

# Propagation model

Built on `AsyncLocalStorage` (`node:async_hooks`, native in Bun) — the
runtime-native equivalent of Python's `contextvars.ContextVar`. The value is
inherited across `await` boundaries within the same async flow and stays isolated
between flows running concurrently. No external dependency.

`EventBus.emit()` is the only place that reads the context:

- **Chain already active** → the event joins it and inherits the id unchanged.
- **No chain active** → the event opens a **fresh root chain** with a generated
  id (`crypto.randomUUID()`), wrapping the entire dispatch. Everything emitted
  during that dispatch inherits it.

Because `Subject.set()`, `Subject.delete()`, `Subject.flush()`,
`BatchBuilder.commit()` and nested `ctx.emit()` all funnel through
`EventBus.emit()`, implicit events inherit with **no code of their own** —
`subject.ts` and `batch.ts` were not touched by the feature.

`Subject` has **no API surface** related to origin id (no constructor parameter,
no method, no field): the id is ambient, not state. It is also independent of
`extra`, which keeps its per-call user-metadata semantics.

# Public API (`krules/origin`, re-exported from `krules`)

| Function | Purpose |
|----------|---------|
| `getOriginId(): string \| undefined` | Read the current chain's id. `undefined` outside any chain — not an error, just "no chain opened yet in this flow". |
| `withOriginId(value, fn)` | Run `fn` inside a chain. `value` explicit, or `undefined`/empty to auto-generate. The callback **receives the resolved id**. Restores the previous value on settle. |
| `generateOriginId()` | Mint a fresh id. |
| `enterOriginScope(value?)` / `exitOriginScope()` | Low-level pair (`enterWith`) for entry points that cannot wrap their work in a callback. Can leak the scope — prefer `withOriginId()`. |

# Crossing transport boundaries

`AsyncLocalStorage` follows the async flow of **one process**. It cannot follow a
message through a broker, a scheduler, or an HTTP hop. On those boundaries the id
travels **as data** and must be re-seeded on the way in. This is a deliberate
limit, not a gap: the getter + scope pair is precisely the bridge.

```typescript
// Outbound: read the chain, carry it in the message
await broker.publish("orders", { ...payload, originId: getOriginId() });

// Inbound: re-seed before dispatching locally — the chain continues seamlessly
await withOriginId(message.originId, async () => {
  await emit("order.received", subject, message.payload);
});
```

This package ships **no CloudEvents layer**, so unlike the Python framework there
is no publisher/dispatcher/subscriber wiring `originid` automatically. Carrying
the id across the wire is the application's job, via the API above.

# Cross-framework alignment

The same concept exists in Python KRules as `origin_id`
(`krules_core/origin.py`: `get_origin_id()` / `origin_id_scope()`), and maps to
the `originid` CloudEvent extension attribute on the wire.

Alignment is **conceptual, not literal**: this package uses the TypeScript
camelCase spelling (`originId`, `getOriginId`, `withOriginId`) to stay coherent
with the rest of its public surface (`eventType`, `propertyName`, `oldValue`).
Semantics, propagation guarantees and the wire representation are identical.

# Related

* [Validation: origin id propagation](validation-origin-id-propagation.md) —
  test evidence for implicit inheritance and concurrent isolation.
* [Subject batch API (atomic RMW)](subject-batch-atomic.md) — batch commits emit
  through `EventBus.emit()`, hence inherit the chain.
