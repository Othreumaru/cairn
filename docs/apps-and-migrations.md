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
- User-defined generics.

## What Cairn already has

These are the foundations everything below builds on:

- Code is content-addressed and immutable; a namespace is a table of names to hashes.
- `live` only moves through the deploy gate, as one pointer assignment.
- Structural subtyping on closed, immutable records, with exact `compatible` / `incompatible`
  classification of type changes.
- Affected tests run when code is staged; results are cached by hash, so a deploy only reads
  the cache.
- Builtins are versioned, so a hash fully determines behaviour.
- Recursion groups are detected and hashed together (`Entry.group`).

## 1. Language prerequisites

The app architecture depends on features Cairn does not have yet.

1. **Tagged unions and `case`.** Messages, commands and results are sum types:

   ```
   type Msg = Visit | Reset | SetName(string)

   case msg of
     Visit      => ...
     Reset      => ...
     SetName(n) => ...
   ```

   Unions are **structural**, like records: a union is the set of its tags, and a union with
   fewer variants is a subtype of one with more. This is what makes the `Msg` rules in sections 4
   and 5 work. The cost is that tags are global names: `Reset` means the same thing in every
   union that has it. `case` must be exhaustive.

2. **Lists**, with total operations only (`map`, `fold`, `filter`, `length`). Anything that could
   fail returns a result type: `head(xs)` returns `Maybe(T)`.

3. **Built-in parameterized types.** `List(T)`, `Maybe(T)` and `Result(E, T)`, and the builtins
   over them (`map`, `fold`, …), are parameterized. They are special-cased in the checker, the way
   Go handled slices and maps before it had generics. Bidirectional checking already lets
   `map(xs, x => x * 2)` infer `x` from context. User-defined generic functions and types are not
   required.

4. **Type aliases** (`type Model = { visits: number }`). Non-recursive aliases are expanded before
   hashing, so naming a type never changes a hash. **Recursive** types
   (`type Tree = Leaf | Node(Tree, Tree)`) cannot be expanded; they are hashed as a group, the same
   way recursive definitions already are in `hash.ts`.

5. **`NaN` and `Infinity` never exist as Cairn values.** Number operations currently follow
   JavaScript (IEEE 754), so `1 / 0`, `0 / 0` and overflow (`1e308 * 10`) yield `Infinity` or
   `NaN`. Those values fail silently in exactly the places Cairn relies on: `NaN == NaN` is false,
   so a test can fail and be cached as a fact about its hash; JSON has no representation for them
   (`JSON.stringify` turns them into `null`), so a REST response would break its declared type;
   and they spread through every later computation while still type-checking as `number`.

   The rules:

   - **Division by a non-zero literal** (`x / 100`) returns a plain `number`. The checker can see
     the divisor is not zero, and this is by far the most common division.
   - **Division by anything else** returns `Result(DivByZero, number)`. A `Result` is not a
     number, and `case` is exhaustive, so the checker makes the code decide what a zero means
     where the division is written:

     ```
     def avg(total: number, count: number): number =
       case total / count of
         Ok(v)  => v
         Err(_) => 0
     ```

     Without the `case`, `total / count` is rejected: "expected number, but 'total / count' is
     Result(DivByZero, number) (count may be 0)". Shorter forms: `withDefault(0, total / count)`;
     returning the `Result` to the caller; or, in a route, turning `Err` into a 400.
   - **`nonZero(x)`** returns `Result(IsZero, NonZero)`. Division by a `NonZero` returns a plain
     `number`, so a value checked once can be divided by freely.
   - **Overflow** is an error raised at the operation that overflowed, never a value. It is too rare
     to justify a `Result` on every multiplication. Inside a migration it is caught by the
     transactional switch (section 4).

## 2. Apps

An app is a new kind of declaration, alongside `def` and `test`. It declares its routes, each
with its own types:

```
type Model = { visits: number }

app api = {
  init: { visits: 0 },
  routes: {
    "GET /visits": (model) => {
      response: { status: 200, body: { visits: model.visits } },
      model: model,
      cmds: []
    },
    "POST /fee": (body: { qty: number, price: number }, model) => {
      response: { status: 200, body: { fee: fee(body) } },
      model: { ...model, visits: model.visits + 1 },
      cmds: []
    }
  },
  onMsg: (msg: Msg, model) => { model: model, cmds: [] }
}
```

- The checker infers `Model` from `init`, and checks each route against
  `(body: In, model: Model) => { response: Response(Out), model: Model, cmds: List(Cmd) }`, where
  `In` and `Out` are that route's own types. `onMsg` receives the results of commands (section 7).
- Because each route has visible input and output types, the runtime can check request bodies,
  the API can be versioned per route (section 6), and an OpenAPI description can be generated
  (section 8).
- A **stateless** app omits `init`, `model` and `onMsg`: each route is `(body: In) => Response(Out)`.
  Stateless apps are the first target, because they scale across instances without shared state.
- The runtime owns the model, calls the matching route for each request, keeps the returned model
  and performs the returned commands.

### The edge between JSON and Cairn values

- Bodies map to JSON: numbers, strings, booleans, records, lists and tagged unions.
- A **request body is checked against the route's `In` type** at the edge. A mismatch is a 400 and
  never reaches Cairn code.
- A **response body is projected onto the route's `Out` type** before it is serialized: fields the
  type does not mention are dropped. This is required, not cosmetic. With width subtyping a value
  can carry more fields than its type shows (a `{ name }` may really be `{ name, passwordHash }`),
  and serializing the raw value would leak them.
- Tests of an app are ordinary pure tests on the data a route returns, so they are cached by hash
  like every other test.

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
4. For **stateless** apps, requests already running finish on the version they started on: each
   request records the namespace it began with, so a single request never mixes versions and
   nothing has to be drained. Stateful apps are different; see the transactional switch in
   section 4.

Every response carries the namespace it was served from (`X-Cairn-Namespace: ns#2e35…`), and each
instance reports the namespace it is serving, so `cairn status` can show a deploy reaching every
instance.

Instances flip a few milliseconds apart. Where that matters, a two-phase deploy closes the gap:
announce the new namespace, wait for every instance to fetch it and acknowledge, then flip.

The first implementation targets several local processes sharing a directory
(`store/<hash>.json` plus a `live` file replaced by atomic rename, watched by each instance).

## 4. State migrations

### When a migration is required

On each deploy of a stateful app, the gate compares the live types with the new ones. This
applies to the `Model` and to `Msg`: messages produced by the old version (results of commands
it issued) can be delivered after the switch, so the new `onMsg` must accept them.

| Change (for `Model` and for `Msg`) | Migration |
|---|---|
| `Old` and `New` are the same type | not needed |
| `Old <: New` (a `Model` field removed; a `Msg` variant added) | not needed: existing values are already valid |
| anything else | **required**: the deploy is refused without one |

A migration is declared like a function from the old type to the new one:

```
migration addLastVisit(old: { visits: number }): { visits: number, lastVisit: string } =
  { ...old, lastVisit: "" }
```

`Msg` migrations have the same form and are applied to pending messages during the switch.

### Migrations are content-addressed

Types are structural, so each type has a hash. A migration is stored as an edge from one type
hash to another. That gives:

- **Chaining.** A target several versions ahead is reached by following edges
  (`#v1 → #v2 → #v3`). The gate's question is "is there a path from the live type to the new
  type?".
- **Deduplication.** The same type change written twice is the same hash.

### Migrations cannot fail

Each way a migration could fail is ruled out or made harmless:

| Failure | Prevention |
|---|---|
| Returns the wrong shape | The type checker: the result must be exactly `New`. |
| Produces invalid data or crashes partway | `NaN` and `Infinity` cannot occur, and division by zero must be handled in the types (section 1). The one remaining runtime error is numeric overflow, which is very rare; if it happens, the transactional switch leaves everything unchanged. |
| Never finishes | A migration and everything it reaches must be **non-recursive**. Hashing already finds recursion groups, so the check is cheap. Iteration uses total list operations only. |
| Exceeds memory or time | The **transactional switch** below: if the real run fails, nothing changes. A **dry run** on the live state at `update` time gives early warning, but the state can change before the switch, so the dry run is not the guarantee. |
| Does the wrong thing | Not decidable. Tests, cached like all others, and replay (section 8). |

### The switch is transactional

1. Stop accepting new requests, and **wait for requests already running to finish**. Routes are
   pure and synchronous, so this takes microseconds; it is required because a request running on
   the old version would otherwise return an old-type model after the migration.
2. Run the migrations on that exact state and on the pending messages.
3. On success, switch the code pointer and the state together, and resume.
4. On failure, discard the result and resume on the old version. Nothing changed.

So a migration either completes and the new version goes live, or it fails and the old version
keeps serving, untouched. No half-migrated state exists.

### Fix forward

A migration with a logic bug is corrected by deploying again. Because the corrected data often
has the same type, the gate also accepts an explicit **same-type data-fix migration**
(`New → New`), checked and applied exactly like any other migration. Without it, fixing data
would require inventing a fake type change.

## 5. Rollback

**Rollback restores code, not data.** It is a pointer change; the question is whether the current
state is valid for the code being restored. With current state type `S` and the target's `Model`
type `T`:

1. **Static:** if `S <: T`, rollback is allowed and safe for any state.
2. **By value:** otherwise, check the actual live state against `T`. State is plain immutable
   data, so this is exact and cheap. If it fits, rollback is allowed and safe for this state.
3. **Otherwise:** refused, with the reason (for example, "state field `lastVisit` is missing, but
   the target expects it"). The user fixes forward.

Consequences:

| Deploy being rolled back | Rollback |
|---|---|
| Body-only change | allowed |
| Same-type data fix | allowed, but the data stays fixed: rollback does not undo migrations |
| Added a field (a migration ran) | allowed: `{visits, lastVisit} <: {visits}`, the old code ignores the field |
| Removed a field | allowed only if the value check finds the field still present |
| Changed a field's type | refused |

Pending messages follow the same rule: rolling back past a deploy that added `Msg.Reset` is
allowed only if no `Reset` message is pending.

Rollback is transactional in the same way as deploy, including waiting for running requests.
Reverse migrations are not part of this design: a reverse exists only when the forward migration
loses no information, and the new version writes data the old one cannot represent anyway.

## 6. Computed versions

Every deploy is given a version, computed from the change and never typed by hand. The namespace
hash remains the identity; the version is a readable label for it.

A version has two parts, because two different audiences read it:

```
v2.3.0+s4
 └─┬──┘ └┬┘
   │     └── state counter: for operators (how far back rollback is statically safe)
   └──────── API version: semver, for clients (what they can rely on)
```

A deploy log line shows both, with the reasons:
`ns#2e35… → v2.3.1+s5 (patch: no route types changed; state: removed field lastVisit, one-way)`.

A version must be a function of the code alone, so the same deploy always gets the same version.
Both parts therefore use only **static** checks: the value-based rollback check from section 5
depends on the state at the moment and never affects a version.

### API version (for clients)

Semantic versioning over **route types only**: the `In` and `Out` types of every route. A route may
change compatibly by accepting more (`old In <: new In`) and returning less (`new Out <: old Out`),
which is exactly the existing function subtyping rule. Internal definitions and the `Model` never
affect it.

| Change | API version |
|---|---|
| Namespace hash unchanged (renames, reformatting) | no new version |
| All route types identical (behaviour or internal changes only) | patch |
| Added routes, or compatible route changes | minor |
| A route removed, or changed incompatibly | major |

Types cannot see a change in meaning, so a behaviour change with identical types is labelled a
patch even if callers care. Two things narrow that gap:

- **Tests** are the written contract: a deploy that **changes or deletes a passing test** is at
  least minor. Added tests do not count.
- **Replay** (section 8) shows whether real responses would change.

### State counter (for operators)

The counter goes up by one on every deploy that rollback cannot statically undo: when the new
`Model` or `Msg` type is not a subtype of the previous one (`S_new <: S_old` fails). Otherwise it
stays the same. Stateless apps have no state part.

| Change to `Model` / `Msg` | State counter |
|---|---|
| Unchanged, or `new <: old` (a `Model` field added; a `Msg` variant removed) | stays `s4` |
| Anything else (a `Model` field removed or retyped; a `Msg` variant added) | `s4 → s5` |

Because subtyping is transitive, **rollback to any version with the same state counter is
statically safe**: every step in between was. Crossing a boundary (`s5` back to `s4`) is only
allowed if the value check in section 5 passes. So the version label alone answers "can I roll
back to this?".

The state part is written as semver *build metadata* (`+s4`), which semver tools ignore when
comparing versions, so clients' tooling only ever sees `2.3.0`.

### Several major versions at once (later)

All old code remains in the store, so an instance can serve several major versions side by side,
selected per request (`X-Cairn-Version: 2` or a `/v2/...` prefix). Old clients keep working while
a new major rolls out, and a major is retired when nobody calls it.

This works for **stateless** apps. For a stateful app, both majors write the same model, so it
works only when **both use exactly the same `Model` type**, or when the old major is read-only (its
routes may not return a changed model). Otherwise the old major would write old-type values. Since
API versions no longer move with state changes, the same-type case is common: a breaking route
change often leaves the `Model` untouched.

## 7. Commands

Routes and `onMsg` return a list of commands (`Cmd`). The runtime performs them after the new
model is stored and delivers each result to `onMsg` as a `Msg`. The first command is an outgoing
HTTP request; storage comes later. Command results are where messages from an old version can
outlive a deploy, which is why section 4 covers `Msg`.

## 8. Cheap additions

These fall out of the design with little extra work:

- **Deploy preview.** `cairn deploy --dry-run` prints the computed version, the migrations that
  would run and whether rollback would be safe, without deploying. Everything it shows is already
  computed by the gate.
- **OpenAPI from routes.** Route types give an OpenAPI description, JSON Schemas for every body,
  and typed clients, with no annotations.
- **HTTP caching for stateless routes.** A stateless route's response is fully determined by the
  route's hash and the request, so the hash can serve as the `ETag`, and responses can be cached
  exactly.
- **Replay.** Routes are pure, so recorded production requests can be replayed against a candidate
  before it is deployed, and the responses compared with what live returned. This turns
  "types cannot see a change in meaning" into a check the gate can run: a "patch" that changes
  real responses is reported. This is the README's "shadow deploys" idea, built into the gate.
- **Time-travel debugging.** If the runtime logs every request and message, the state at any
  point is a fold of the routes over that log from `init`, so any bug can be reproduced exactly by
  replay, as in Elm's debugger.
- **Canary deploys.** Send a percentage of requests to the new namespace: two pointers and a
  weighted choice. For stateful apps this has the same restriction as several majors.

## Implementation order

1. Tagged unions with `case`, lists and the built-in parameterized types, type aliases (including
   recursive types), and the number rules (division returning `Result` unless the divisor is a
   non-zero literal or `NonZero`; overflow as an error).
2. Stateless `app` declarations with typed routes, `cairn serve`, request checking and response
   projection, the `X-Cairn-Namespace` header; the store split; instant deploys across several
   local instances.
3. Computed API versions, and `cairn deploy --dry-run`.
4. Stateful apps: `init` and `Model` on a single instance, the migration requirement for `Model`,
   totality checks, the transactional switch and data-fix migrations.
5. The rollback rule and the state counter.
6. Commands and `onMsg`, with `Msg` migrations.
7. Replay against recorded requests; OpenAPI generation; HTTP caching.
8. Several major versions and canaries for stateless apps.

## Open questions

- **Several migration paths.** If more than one chain leads from the live type to the new one,
  should the gate pick the shortest, or require the path to be unique?
- **Stateful apps across instances.** Where does a stateful app's model live once it outgrows one
  instance, and how does the transactional switch work there?
- **The first version.** Does the first deploy of an app start at `1.0.0` or `0.1.0`, and do
  `0.x` versions relax the rules as in semver?
