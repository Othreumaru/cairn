# Apps, migrations and versioning

Status: **proposal**. Nothing here is implemented yet. Syntax is illustrative.

This document records the design for turning Cairn from a language with a deploy gate into
one that can run long-lived services: Elm-style apps served over HTTP by several instances,
with instant deploys, state migrations that cannot fail halfway, rollback when it is provably
safe, and version numbers the language works out for itself.

Prior art worth reading alongside: [Elm](https://elm-lang.org) (the app architecture and
`elm bump`), [Lamdera](https://lamdera.com) (Elm backends with type-checked migrations),
[Unison](https://www.unison-lang.org) (content-addressed code) and Ink & Switch's
[Cambria](https://www.inkandswitch.com/cambria/) (bidirectional schema migrations).

## Goals

- Run several instances of an app as HTTP endpoints, and have **one deploy switch all of them**
  to the new version without restarts.
- Keep the language **pure**: apps return descriptions of effects, and the runtime performs them.
- Make **state migrations a requirement the deploy gate enforces**, and make them unable to fail
  halfway.
- Let the language **decide when a rollback is safe**, instead of forbidding or always allowing it.
- **Compute version numbers** from what actually changed.

## Non-goals (for now)

- A shared, mutable `Model` across several instances. Stateful apps run on one instance.
- Persistent storage, databases and lazy per-record migration.
- Reverse migrations and bidirectional lenses.

## What Cairn already has

These are the foundations everything below builds on:

- Code is content-addressed and immutable; a namespace is a table of names to hashes.
- `live` only moves through the deploy gate, as one pointer assignment.
- Structural subtyping on closed, immutable records, with exact `compatible` / `incompatible`
  classification of type changes.
- Affected tests run when code is staged; results are cached by hash, so a deploy only reads
  the cache.
- Builtins are versioned, so a hash fully determines behaviour.
- Mutual recursion groups are detected during hashing (`Entry.group`).

## 1. Language prerequisites

The app architecture depends on features Cairn does not have yet.

1. **Tagged unions and `case`.** Messages, routes and commands are sum types:

   ```
   type Msg = Visit | Reset | SetName(string)

   case msg of
     Visit      => ...
     Reset      => ...
     SetName(n) => ...
   ```

   Subtyping extends naturally: a union with fewer variants is a subtype of one with more.
   `case` must be exhaustive.

2. **Lists**, with total operations only (`map`, `fold`, `filter`, `length`). Anything that could
   fail returns a result type: `head(xs)` returns `Maybe`.

3. **Type aliases** (`type Model = { visits: number }`), so app signatures stay readable. Aliases
   are expanded before hashing, so naming a type never changes a hash.

4. **No partial operations.** Division by zero currently yields `Infinity`/`NaN`, as in JavaScript.
   It should either return a result type or be a checked error, so that well-typed code cannot
   produce invalid data.

Generics are deliberately not a prerequisite: the checker special-cases `app` declarations,
the same way it already special-cases `test`.

## 2. Apps

An app is a new kind of declaration, alongside `def` and `test`:

```
type Model = { visits: number }

app api = {
  init: { visits: 0 },
  handle: (req, model) => {
    response: { status: 200, body: str(model.visits) },
    model: { ...model, visits: model.visits + 1 },
    cmds: []
  }
}
```

- The checker infers `Model` from `init` and checks `handle` against
  `(req: Request, model: Model) => { response: Response, model: Model, cmds: List(Cmd) }`.
- A **stateless** app omits `init` and `model`: `handle: (req: Request) => Response`. Stateless
  apps are the first target, because they scale across instances without shared state.
- The runtime owns the model, calls `handle` for each request, keeps the returned model and
  performs the returned commands.
- Request and response bodies map to JSON: numbers, strings, booleans, records and lists.
  A request body is checked against the handler's input type at the edge; a mismatch is a 400
  and never reaches Cairn code.
- Tests of an app are ordinary pure tests on the data `handle` returns, so they are cached by
  hash like every other test.

## 3. Serving and instant deploys across instances

`cairn serve --port N` starts an instance that serves the apps in `live`.

The current single `state.json` (read and rewritten whole by every command) is split along the
line the design already draws:

| Part | Mutability | Requirements |
|---|---|---|
| Code store: one entry per hash | append-only | any shared storage; instances cache entries forever |
| Test cache: one result per test hash | append-only | as above |
| `live` pointer and deploy history | mutable | atomic compare-and-swap, so two concurrent deploys cannot both win |

A deploy then works like this:

1. The deployer swaps the `live` pointer with compare-and-swap.
2. Instances are **notified** (a file watch locally; pub/sub or a watch API in production).
3. Each instance fetches only the hashes it does not have yet, then switches its local pointer
   in one step.
4. Requests already running finish on the version they started on: each request records the
   namespace it began with, so a single request never mixes versions.

Instances flip a few milliseconds apart. Where that matters, a two-phase deploy closes the gap:
announce the new namespace, wait for every instance to fetch it and acknowledge, then flip.

The first implementation targets several local processes sharing a directory
(`store/<hash>.json` plus a `live` file replaced by atomic rename, watched by each instance).

## 4. State migrations

### When a migration is required

On each deploy of a stateful app, the gate compares the live `Model` type `Old` with the new
one, `New`:

| Change | Migration |
|---|---|
| `Old` and `New` are the same type | not needed |
| `Old <: New` (for example, a field was removed) | not needed: existing state is already valid |
| anything else (a field was added, a field's type changed) | **required**: the deploy is refused without one |

A migration is declared like a function from the old type to the new one:

```
migration addLastVisit(old: { visits: number }): { visits: number, lastVisit: string } =
  { ...old, lastVisit: "" }
```

### Migrations are content-addressed

Types are structural, so each `Model` type has a hash. A migration is stored as an edge from
one type hash to another. That gives:

- **Chaining.** A target several versions ahead is reached by following edges
  (`#v1 → #v2 → #v3`). The gate's question is "is there a path from the live type to the new
  type?".
- **Deduplication.** The same type change written twice is the same hash.

### Migrations cannot fail

Each way a migration could fail is ruled out or made harmless:

| Failure | Prevention |
|---|---|
| Returns the wrong shape | The type checker: the result must be exactly `New`. |
| Crashes partway | No partial operations in the language (section 1). |
| Never finishes | A migration and everything it reaches must be **non-recursive**. Hashing already finds recursion groups, so the check is cheap. Iteration uses total list operations only. |
| Exceeds memory or time | **Dry run on the actual live state** before switching. Migrations are pure and deterministic, so a successful dry run proves the real run succeeds on that state. |
| Does the wrong thing | Not decidable. Tests, cached like all others. |

### The switch is transactional

1. Pause new requests briefly so the state stops changing.
2. Run the migration on that exact state.
3. On success, switch the code pointer and the state together.
4. On failure, discard the result and resume on the old version. Nothing changed.

So a migration either completes and the new version goes live, or it fails and the old version
keeps serving, untouched. No half-migrated state exists.

### Fix forward

A migration with a logic bug is corrected by deploying again. Because the corrected data often
has the same type, the gate also accepts an explicit **same-type data-fix migration**
(`New → New`), checked and applied exactly like any other migration. Without it, fixing data
would require inventing a fake type change.

## 5. Rollback

Rolling back code is a pointer change; the question is whether the current state is valid for
the code being restored. With current state type `S` and the target's `Model` type `T`:

1. **Static:** if `S <: T`, rollback is allowed and safe for any state.
2. **By value:** otherwise, check the actual live state against `T`. State is plain immutable
   data, so this is exact and cheap. If it fits, rollback is allowed and safe for this state.
3. **Otherwise:** refused, with the reason (for example, "state field `lastVisit` is missing, but
   the target expects it"). The user fixes forward.

Consequences:

| Deploy being rolled back | Rollback |
|---|---|
| Body-only change | allowed |
| Added a field (a migration ran) | allowed: `{visits, lastVisit} <: {visits}`, the old code ignores the field |
| Removed a field | allowed only if the value check finds the field still present |
| Changed a field's type | refused |

The same rule applies to queued messages once unions exist: rolling back past a deploy that
added `Msg.Reset` is allowed only if no `Reset` message is pending.

Rollback is transactional in the same way as deploy. Reverse migrations are not part of this
design: a reverse exists only when the forward migration loses no information, and the new
version writes data the old one cannot represent anyway.

## 6. Computed versions

Every deploy is given a semantic version, computed from the change and never typed by hand. The
namespace hash remains the identity; the version is a readable label for it
(`ns#2e35… → v2.2.0 (minor: added field lastVisit; rollback safe)`).

Two interfaces are compared against `live`:

- **API:** the types of what callers can reach (app endpoints). Cairn already classifies type
  changes as compatible (`new <: old`) or incompatible.
- **State:** the `Model` type and the rollback rule from section 5.

| Change | Version |
|---|---|
| Namespace hash unchanged (renames, reformatting) | no new version |
| Behaviour only; all types identical | patch |
| Additions or compatible type changes, and rollback is safe | minor |
| Incompatible API change, **or** rollback is not safe | major |

Types cannot see a change in meaning, so a behaviour change with identical types is labelled a
patch even if callers care. Tests narrow that gap: they are the written contract, so a deploy
that **changes or deletes a passing test** is at least minor. Added tests do not count.

### Several major versions at once (later)

All old code remains in the store, so an instance can serve several major versions side by side,
selected per request (`X-Cairn-Version: 2` or a `/v2/...` prefix). Old clients keep working while
a new major rolls out, and a major is retired when nobody calls it. If the versions share one
`Model`, the older one can only stay alive while the state passes the rollback check for it.

## Implementation order

1. Tagged unions with `case`, lists, type aliases, and no partial operations.
2. Stateless `app` declarations and `cairn serve`; the store split; instant deploys across
   several local instances.
3. Stateful apps: `init` and `Model` on a single instance, the migration requirement, totality
   checks, dry runs, the transactional switch and data-fix migrations.
4. The rollback rule.
5. Computed versions.
6. Commands performed by the runtime (HTTP first, then storage).
7. Several major versions served at once.

## Open questions

- **What is the API?** Proposed: only what apps expose. Plain `def`s are internal and never
  affect the major version.
- **Several migration paths.** If more than one chain leads from the live type to the new one,
  should the gate pick the shortest, or require the path to be unique?
- **Migrations and multiple instances.** Where does a stateful app's model live once it outgrows
  one instance, and how does the transactional switch work there?
- **The first version.** Does the first deploy of an app start at `1.0.0` or `0.1.0`, and do
  `0.x` versions relax the rules as in semver?
- **The command set.** Which commands come first, and how are their results delivered back to
  `handle` as messages?
