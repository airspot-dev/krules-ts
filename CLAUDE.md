# krules (TypeScript/Bun)

Event-driven reactive framework. Subjects hold schema-less properties and emit events when
those properties change; handlers react through an event bus with glob pattern matching.

Current version: **0.7.0**.

## Layout

- `src/` — the package source, published to npm as `krules`
- `src/subject/`, `src/storage/`, `src/events/`, `src/handlers/` — the subsystems
- `src/origin.ts` — event-chain tracking, exposed as the `krules/origin` subpath
- `.okf/` — knowledge bundle: one concept per non-obvious subsystem, with dedicated
  validation concepts recording what was actually verified and how

The `.okf/log.md` is the project's own account of what changed and why. Read it before
assuming how something works, and extend it when closing work that changed a documented
concept.

## Companion skill

This repository produces the `krules-typescript` skill, mounted as a submodule at
`.claude/skills/krules-typescript` and distributed from `krules-typescript-skill`.

The skill is this package **seen by someone building on it**: container setup, handler
registration, property management, batch and atomic writes, storage backends, event-chain
tracking. It exists so that a consumer does not have to read this source to use the
library correctly.

### Keep it in step

A change here that alters what the skill states must be reflected in the skill **within
the same piece of work**, not deferred. What makes it wrong:

- the public `Subject` API — signatures, batch vs immediate semantics, callable values
- property-event semantics — when events are emitted, what they carry
- **`originId`** — the `krules/origin` primitives, propagation, what crosses a boundary
- **storage contracts** — the `Storage` interface, `StorageChanges`, `StoreResult`, and
  above all the per-backend atomicity guarantees
- storage backend behaviour — locking, retry, reconnection
- container composition and the public export map in `package.json`

### The signal is checkable

The skill declares a **Package Version** in its `SKILL.md`. It must match the `version` in
`package.json`. A release that moves the version without touching the skill is a
verifiable mismatch, not a matter of opinion.

The same check applies to `.okf/log.md`: an entry recording a behavioural change is a
candidate for the skill.

**This has already gone wrong.** Redis atomicity moved from `WATCH/MULTI/EXEC` to a
server-side compare-and-set script in 0.6.1 — because the former silently lost concurrent
writes on a shared connection — and `originId` arrived in 0.7.0. The skill went on
describing the superseded mechanism and never mentioned the new feature, because the two
repositories had nothing connecting them. The submodule and this section exist so that it
does not repeat.

### Closing work that touched the skill

1. Use the same branch name in both repositories.
2. Commit **and push** the skill repository **before** updating the pointer here: a
   pointer to an unpushed commit leaves the submodule unresolvable for anyone cloning.
3. If your environment also mounts the skill elsewhere, refresh it with
   `git submodule update --remote --merge`.

### Working with the submodule

Clone with `--recurse-submodules`, or run `git submodule update --init` afterwards.

The submodule is checked out on its branch, but some git commands detach it — check with
`cd .claude/skills/krules-typescript && git branch --show-current` before editing.

Switching to a branch that does not mount it can fail with *"untracked working tree files
would be overwritten"*. That is expected: run
`git submodule deinit -f .claude/skills/krules-typescript` before the switch, and
`git submodule update --init` after the merge.
