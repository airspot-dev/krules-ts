---
type: Validation
title: Origin id propagation — implicit inheritance and concurrent isolation
description: Test evidence that originId propagates implicitly across nested emits, Subject mutations and batch commits, and that concurrently running chains stay isolated with no leakage.
tags: [events, event-bus, correlation, concurrency, async-context, validation]
timestamp: 2026-07-30T00:00:00Z
---

# Overview

Verification of [Event chain tracking (originId)](event-chain-origin-id.md).
Concurrent isolation and implicit inheritance are acceptance criteria that
**regress silently** — a leak between chains raises no error, it just produces
wrong correlation data. They are therefore pinned by tests rather than left to
inspection.

Suite: `src/origin.test.ts` (Bun test, in-memory storage via
`createKRulesContainer()`).

# Checks (12)

**Chain establishment**

- An event emitted outside any chain opens a root chain with a generated id;
  two independent root emits get **different** ids.
- An entry point wrapping the emit in `withOriginId("REQ-123", …)` produces
  `ctx.originId === "REQ-123"`.
- `withOriginId(undefined, fn)` passes the generated id to the callback;
  `withOriginId("GIVEN", fn)` passes `"GIVEN"`.

**Implicit inheritance**

- Three-deep chain through nested `ctx.emit()` → all three handlers observe the
  same id.
- Handler calling `ctx.subject.set()` → the implicit
  `subject-property-changed` handler observes the chain's id.
- `subject.batch().set(a).set(b).commit()` inside a chain → both emitted
  property events carry the chain's id.

**Concurrent isolation**

- Two chains started with `Promise.all`, each emitting an event whose handler
  awaits `Bun.sleep(1)` (forcing genuine interleaving) before mutating a
  distinct property on the **same shared subject**. The implicit events observe
  `CHAIN-1` and `CHAIN-2` respectively — no cross-contamination.

**Scope hygiene**

- `getOriginId()` is `undefined` before and after `withOriginId()`; no leak.
- A nested scope restores the outer chain on exit.
- `enterOriginScope("MANUAL")` binds and returns the id, an emit inside observes
  it, `exitOriginScope()` detaches (`getOriginId()` back to `undefined`).
- `enterOriginScope()` with no argument generates and binds an id.

**Decoupling from Subject**

- A `Subject` instance exposes no `originId`, `origin_id` or `getOriginId`
  member.

# Results

| Run | Result |
|-----|--------|
| `bun test src/origin.test.ts` | 12/12 pass |
| `bun test` (whole package) | 39/39 pass — no regression in the pre-existing 27 |
| `bun run typecheck` (`tsc --noEmit`) | clean |

# Not covered

Propagation **across process or transport boundaries** is out of scope by
construction — `AsyncLocalStorage` cannot cross them, and this package has no
CloudEvents layer to wire. The manual bridge (`getOriginId()` outbound,
`withOriginId()` inbound) is documented but not exercised here: verifying it
requires an application that owns the transport.
