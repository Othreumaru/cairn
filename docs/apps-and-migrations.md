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
- Keep everything that touches the outside world (HTTP, WebSockets, files, databases) in
  **plugins**, so new kinds of entry point and storage can be added without changing the language.
- **Prune** what old versions leave behind, so history does not grow forever.
- Let code be **proved**, not only tested, where a property can be stated, and keep tests for
  what proofs cannot cover.

## Non-goals (for now)

- A shared, mutable `Model` across several instances. Stateful apps run on one instance.
- Database storage plugins and lazy per-record migration. Storage is a plugin (section 9), so these
  can be added later without changing the design.
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

2. **Lists**, with total operations only (`map`, `fold`, `filter`, `length`, `range`). Anything
   that could fail returns a result type: `head(xs)` returns `Maybe(T)`. These replace most
   recursion (item 6).

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
   JavaScript (IEEE 754), so `1 / 0`, `0 / 0`, `1 % 0` and overflow (`1e308 * 10`) yield
   `Infinity` or `NaN`. Those values fail silently in exactly the places Cairn relies on: `NaN == NaN` is false,
   so a test can fail and be cached as a fact about its hash; JSON has no representation for them
   (`JSON.stringify` turns them into `null`), so a REST response would break its declared type;
   and they spread through every later computation while still type-checking as `number`.

   The rules, for division (`/`) and remainder (`%`) alike:

   - **Non-zero number literals have type `NonZero`**, a subtype of `number`, and negating a
     `NonZero` gives a `NonZero`. `100`, `0.01` and `-5` are `NonZero`; `0` is a `number`.
   - **Division by a `NonZero`** returns a plain `number`. With the previous rule, this makes
     `x / 100`, by far the most common division, an ordinary `number` through subtyping, with no
     special case for literals.
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
     Result(DivByZero, number) (count may be 0)". `%` works the same way. Shorter forms: `withDefault(0, total / count)`;
     returning the `Result` to the caller; or, in a route, turning `Err` into a 400.
   - **`nonZero(x)`** returns `Result(IsZero, NonZero)`, so a value checked once can be divided by
     freely.
   - **Overflow** is an error raised at the operation that overflowed, never a value. It is too rare
     to justify a `Result` on every multiplication. Inside a migration it is caught by the
     transactional switch (section 4).

6. **Recursion is restricted by default**, so that code terminates and can be proved (section 11).
   There are three levels:

   - **Default: no general recursion.** Code iterates with `map`, `filter`, `fold` and `range`:
     `fact(n)` is `fold(range(1, n + 1), 1, (acc, i) => acc * i)`. Such code is total, so it can be
     used anywhere, including migrations, invariants and proved properties.
   - **Structural recursion**, once recursive types exist: a function may call itself only on a part
     of its input (the children of a tree node, the tail of a list). The checker verifies that from
     the code alone, so it still always terminates. This is how Agda and Lean handle it.
   - **`partial def`**, an explicit escape hatch for general recursion (unbounded search, parsing
     arbitrary nested input, iterating to convergence). It runs under the evaluation budget as all
     code does today, cannot be used in migrations, fixes, invariants or proved properties, and is
     visible in review and in the hash.

   **Total code may not call partial code** (the rule Idris uses). A definition that calls a
   `partial def`, directly or through others, must be marked `partial` itself, so the marker
   appears everywhere the risk of not terminating reaches, not only where the recursion is
   written. "Is this guaranteed to finish?" is answered by the declaration, and the guarantees
   for migrations, invariants and proofs hold automatically, because they only accept total code.
   Marking one deep function `partial` forces its callers to say so too; that is deliberate. Tests
   are exempt: they always run under the evaluation budget and nothing is built on them.

   Removing recursion does not remove the need for induction: proving something about a `fold`
   over a list of any length still needs it. The gain is that induction happens in one place the
   language owns. The verifier knows the induction rule for `fold`, checked once, instead of facing
   every user's own recursion pattern. Starlark, Dhall and Clarity forbid general recursion
   outright, and run real workloads; the escape hatch keeps the rare algorithm that needs it
   possible.

   This also turns section 4's rule that migrations must terminate from a special case into the
   general rule.

7. **An exact number type** is needed before the solver reasons about numbers (section 11).
   Cairn's numbers are JavaScript floats, where `0.1 + 0.2 != 0.3`. A solver either treats them as
   exact reals, which is unsound for rounding, or models IEEE floats precisely, which is slow. An
   exact decimal (or integer) type, at least for money-like values, keeps proofs both sound and
   fast. Which one is an open question.

## 2. Apps

An app is a new kind of declaration, alongside `def` and `test`. It declares its routes, each
with its own request and response types. (HTTP routes are provided by the `http` plugin, see
section 9; whether bindings are grouped in an `app` block as below or written as annotations on
each definition is an open question.)

```
type Model = { visits: number }

app api = {
  init: { visits: 0 },
  routes: {
    "GET /visits": (req: {}, model) => Reply({
      response: { status: 200, body: { visits: model.visits } },
      model: model,
      cmds: []
    }),
    "GET /users/:id": (req: { params: { id: string } }, model) =>
      Await(Http.get(service("users"), "/" ++ req.params.id), (result, model) => Reply({
        response: case result of
          Ok(user) => { status: 200, body: { name: user.name } }
          Err(_)   => { status: 502, body: { error: "user service unavailable" } },
        model: model,
        cmds: []
      })),
    "POST /fee": (req: { body: { qty: number, price: number } }, model) => Reply({
      response: { status: 200, body: { fee: fee(req.body) } },
      model: { ...model, visits: model.visits + 1 },
      cmds: []
    })
  },
  onMsg: (msg: Msg, model) => { model: model, cmds: [] }
}
```

- Each route takes a request record `In` with up to three fields: `params` (path parameters),
  `query` and `body`. A route with nothing to read declares `{}`. The checker checks that the
  `params` fields match the `:name` segments of the route's path.
- A route returns one of two things:
  - `Reply({ response: Response(Out), model: Model, cmds: List(Cmd) })`: answer now.
  - `Await(cmd, (result, model) => ...)`: perform `cmd`, then continue with its result and the
    model as it is when the result arrives, returning `Reply` or another `Await`. The request stays
    open meanwhile. This is how a route answers with data from another service.
- `onMsg` receives results of commands that were not awaited (section 7).
- The checker infers `Model` from `init`, checks each route and continuation against these
  shapes, and infers `Out` from the responses a route returns.
- Because each route has visible request and response types, the runtime can check requests, the
  API can be versioned per route (section 6), and an OpenAPI description can be generated
  (section 8).
- A **stateless** app omits `init`, `model` and `onMsg`: routes return `Reply(Response(Out))` or
  `Await(cmd, result => ...)`. Stateless apps are the first target, because they scale across
  instances without shared state.

Why `Await` rather than replying from `onMsg`: having `onMsg` send a delayed response would split
one endpoint across several functions, and the checker could no longer tie a response type to the
route that owes it. With `Await` the whole endpoint is one expression with one response type.

### Running routes

- **The state is always exactly its type.** Each time a route, `onMsg`, migration or `fix` returns
  a new model, the runtime projects it onto the `Model` type before storing it, as responses are
  projected onto their declared types. With width subtyping a value can carry fields its type does
  not mention; projecting means no such hidden field ever survives in the state, and nothing (a
  rollback check, a migration, a later version) can come to depend on one.
- **Requests to a stateful app are processed one at a time**, like Elm's update loop: a route (or
  continuation) runs to completion before the next starts, so two requests can never both read
  and overwrite the same model. Routes are pure and synchronous, so this costs little. Waiting for
  an `Await`ed command does not hold the queue; only running Cairn code does.
- **Each request has an evaluation budget**, using the evaluator's existing fuel limit, because
  routes may recurse. Running out of budget, or a numeric overflow, ends the request with a 500:
  the model is left unchanged and the route's commands are discarded.

### The edge between JSON and Cairn values

- Bodies map to JSON: numbers, strings, booleans, records, lists and tagged unions.
- A **request body is checked against the route's `In` type** at the edge. A mismatch is a 400 and
  never reaches Cairn code.
- A **response body is projected onto the route's `Out` type** before it is serialized: fields the
  type does not mention are dropped. This is required, not cosmetic. With width subtyping a value
  can carry more fields than its type shows (a `{ name }` may really be `{ name, passwordHash }`),
  and serializing the raw value would leak them.
- Tests of an app are ordinary pure tests on the data a route returns, so they are cached by hash
  like every other test. A route's `Await` continuation is a function, so tests can call it with
  a chosen result.

## 3. Serving and instant deploys across instances

`cairn serve --port N` starts an instance that serves the apps in `live`. In plugin terms
(section 9), this is the `http` entry-point plugin; the mechanics below apply to every
entry-point plugin.

The current single `state.json` (read and rewritten whole by every command) is split along the
line the design already draws:

| Part | Mutability | Requirements |
|---|---|---|
| Code store: one entry per hash | immutable; append-only within the pruning horizon | any shared storage; instances cache entries until they are pruned |
| Test cache: one result per test hash | as above | as above |
| `live` pointer and deploy history | mutable | atomic compare-and-swap, so two concurrent deploys cannot both win |

A deploy of a **stateless** app works like this:

1. The deployer swaps the `live` pointer with compare-and-swap.
2. Instances are **notified** (a file watch locally; pub/sub or a watch API in production).
3. Each instance fetches only the hashes it does not have yet, then switches its local pointer
   in one step.
4. Requests already running, including ones waiting in an `Await`, finish on the version they
   started on: each request records the namespace it began with, so a single request never mixes
   versions and nothing has to be drained.

A deploy of a **stateful** app must not move `live` before its migrations have succeeded, or a
failed migration would leave `live` naming a version nobody serves. It is two-phase:

1. The deployer asks the instance holding the state to **prepare**: it pauses the request queue
   and runs the transactional switch (section 4) up to, but not including, the commit.
2. If preparing fails, the deploy is refused and the instance resumes on the old version. `live`
   never moved.
3. If it succeeds, the deployer swaps `live` with compare-and-swap. If the swap wins, the instance
   commits; if another deploy won the swap first, the instance discards the prepared state and
   resumes on the old version.

Every response carries the namespace it was served from (`X-Cairn-Namespace: ns#2e35…`), and each
instance reports the namespace it is serving, so `cairn status` can show a deploy reaching every
instance.

Instances flip a few milliseconds apart. Where that matters, a two-phase deploy closes the gap:
announce the new namespace, wait for every instance to fetch it and acknowledge, then flip.

The first implementation targets several local processes sharing a directory
(`store/<hash>.json` plus a `live` file replaced by atomic rename, watched by each instance).

## 4. State migrations

### When a migration is required

Whenever an `update` changes the type of a stateful app, the checker compares the type dev had
just before with the new one. If a migration is required, **the same update must provide it**,
otherwise the update is refused and nothing is staged. That matches how Cairn already treats an
incompatible type change, whose broken dependents must be fixed in the same file. This applies to the `Model` and to `Msg`: messages produced by the
old version (results of commands it issued) can be delivered after the switch, so the new `onMsg`
must accept them.

| Change (for `Model` and for `Msg`) | Migration |
|---|---|
| `Old` and `New` are the same type | not needed |
| `Old <: New` (a `Model` field removed; a `Msg` variant added) | not needed: existing values are already valid |
| anything else | **required**: the update is refused without one |

A migration is declared like a function from the old type to the new one:

```
migration addLastVisit(old: { visits: number }): { visits: number, lastVisit: string } =
  { ...old, lastVisit: "" }
```

`Msg` migrations have the same form. They are applied to messages waiting to be processed during
the switch, and also to command results that arrive **after** it: a command the old version started
may finish later, and its result is an old-type `Msg`. Each command is therefore tagged with the
deploy that issued it, and when its result arrives, the `Msg` migrations logged by every deploy
since then are applied first. The deploy history keeps those logs, so this is always possible.

An `Await` continuation is old code with an old `Model` type, so it cannot simply continue after a
deploy that changed the `Model` or `Msg`. Requests waiting in an `Await` across such a deploy are
answered with `503 Service Unavailable` and `Retry-After`; requests waiting across a deploy that
changed neither type continue normally on the version they started on.

A `migration` must change the type: one from a type to itself does nothing a migration is for, and
is rejected. Changing data without changing its type is a `fix` (see "Fix forward" below).

### Migrations form an ordered log

Which migrations run is decided by an **ordered log**, not by searching for a path between types,
in the same way as database migration tools such as Rails, Django or Flyway.

1. Each `update` that requires a migration, or adds a `fix`, **appends one step** to dev's pending
   log. A step's input type must accept the type dev had just before (`current <: input`), so the
   log always chains: `A → B`, then `B → C`. Changes that need no migration (`Old <: New`) add no
   step; the next step's input type just has to accept the subtype.
2. `deploy` runs the pending log **in order** on the live state, inside the transactional switch
   below, then records the log in the deploy history and clears it.
3. The gate checks that the log composes: it starts from the type of the live **state** and ends at
   the new one. The runtime tracks the state's type separately from the live code's `Model`, since
   the two differ after a rollback (section 5).

Until it is deployed, the pending log refers to migrations **by name**. Updating a pending migration
(`addLastVisit` with a corrected body) replaces its step in place, and deleting one removes its
step; either way the log is re-checked and must still compose. A bug in a migration that has not
been deployed is therefore fixed by editing it, like any other code. On deploy, each step is frozen
by hash in the deploy history.

Why a log rather than a graph of migrations between type hashes:

- **There is exactly one sequence.** In a graph, `A → B → C` and a direct `A → C` would both be
  valid paths, and since they are different functions, the migrated state would depend on which
  path was picked. Store entries are immutable and only leave the store when pruned (section 10),
  so a stray edge could not even be removed.
- **Fixes run.** A `fix` is a step in the log. In a graph it would be a self-loop, and a path search
  from `A` to `A` finds the empty path, so the fix would never run.
- **Same type at both ends does not mean nothing happened.** After `A → B → A`, the state has been
  through `B`: if `B` dropped a field and the step back re-added it with a default, the data
  changed. The log runs both steps, as the code did.
- **Lagging instances are simple.** Each deploy's log is kept in the deploy history, so an instance
  several deploys behind (once stateful apps run on several instances) replays the logs in order.

Each migration is still content-addressed like any other definition: it has a hash, and its tests
are cached by it. Only the choice of what runs comes from the log.

Pending steps are never merged automatically: if dev changes the type twice before a deploy, both
steps run. Migrations run in memory, so a longer log costs microseconds. Replacing a chain with
one direct migration (checked by comparing results) can be added later if long histories or
large stored data make it worthwhile.

### Every migration needs a test

Migrations change real data permanently, so the gate refuses a deploy when a `migration` or `fix`
in the pending log has no test that uses it. Migrations and fixes can be called like functions, so
a test calls them directly:

```
test addsEmptyLastVisit = addLastVisit({ visits: 3 }).lastVisit == ""
```
 The reverse dependency index behind
`cairn dependents` already answers "which tests reach this hash?", so the check is cheap.

### Migrations cannot fail

Each way a migration could fail is ruled out or made harmless:

| Failure | Prevention |
|---|---|
| Returns the wrong shape | The type checker: the result must be exactly `New`. |
| Produces invalid data or crashes partway | `NaN` and `Infinity` cannot occur, and division by zero must be handled in the types (section 1). The one remaining runtime error is numeric overflow, which is very rare; if it happens, the transactional switch leaves everything unchanged. |
| Never finishes | A migration and everything it reaches must be total: no `partial def` (section 1, item 6). Hashing already finds recursion groups, so the check is cheap. Iteration uses total list operations only. |
| Exceeds memory or time | The **transactional switch** below: if the real run fails, nothing changes. A **dry run** on the live state at `update` time gives early warning, but the state can change before the switch, so the dry run is not the guarantee. |
| Does the wrong thing | Not decidable. At least one test per migration (required), and replay (section 8). |

### The switch is transactional

1. Pause the request queue. Requests run one at a time (section 2), so this only means letting the
   current one finish, which takes microseconds; it is required because a request running on the
   old version would otherwise return an old-type model after the migration. Requests waiting in an
   `Await` are handled as described above.
2. Run the pending log, in order, on that exact state and on the pending messages.
3. On success, switch the code pointer and the state together, and resume. Across several
   instances, this commit is the second phase of the deploy in section 3.
4. On failure, discard the result and resume on the old version. Nothing changed.

So a migration either completes and the new version goes live, or it fails and the old version
keeps serving, untouched. No half-migrated state exists.

### Fix forward

A migration with a logic bug is corrected by deploying again. Because the corrected data often
has the same type, there is a separate declaration for it:

```
fix backfillLastVisit(m: Model): Model = { ...m, lastVisit: guessFrom(m.visits) }
```

A `fix` must have the same input and output type. It is checked like a migration (total, no `partial def`,
no invalid operations, at least one test), appended to the log, and always runs once, in order. It
is a separate keyword so the checker never confuses an intended fix with a pointless same-type
migration. Without it, fixing data would require inventing a fake type change.

## 5. Rollback

**Rollback restores code, not data.** It is a pointer change; the question is whether the current
state is valid for the code being restored. With current state type `S` and the target's `Model`
type `T`:

1. **Static:** if `S <: T`, rollback is allowed and safe for any state.
2. **By value:** otherwise, check the actual live state against `T`. State is plain immutable
   data, so this is exact and cheap. If it fits, rollback is allowed and safe for this state.
3. **Otherwise:** refused, with the reason (for example, "the state contains `Suspended`, a variant
   the target's `Model` does not have"). The user fixes forward.

Because the state is always projected onto its type (section 2), the value check never depends on
fields the type does not mention. It is useful where a type allows more than the data uses: which
union variants actually occur in the state, and which messages are actually pending.

Consequences:

| Deploy being rolled back | Rollback |
|---|---|
| Body-only change | allowed |
| A `fix` | allowed, but the data stays fixed: rollback does not undo migrations or fixes |
| Added a field (a migration ran) | allowed: `{visits, lastVisit} <: {visits}`, the old code ignores the field |
| Removed a field | refused: the state no longer has the field, and never keeps fields its type does not mention |
| Added a union variant (`Active \| Archived` to `Active \| Archived \| Suspended`) | allowed only if the value check finds no `Suspended` in the state |
| Changed a field's type | refused |

Pending messages follow the same rule: rolling back past a deploy that added `Msg.Reset` is
allowed only if no `Reset` message is pending.

After a rollback, the state's type is the target's `Model` type `T`: the restored code writes values
of that type from its first request on. Rolling back across a deploy therefore **returns that
deploy's migration log to the front of the pending log**, so that deploying forward again has a log
that composes from `T`. Redeploying runs those migrations again. That is type-safe, but data they
set is set again: redeploying after rolling back past `addLastVisit` resets `lastVisit` to `""`,
because the rollback projected the state onto `T` and dropped it. `cairn deploy --dry-run` (section 8) shows this
before it happens.

Rollback is transactional in the same way as deploy, including pausing the request queue.
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

- **Tests** are the written contract: a deploy that **edits or deletes a passing test** is at
  least minor. "Edits" means the test's own source changed. A test that was only rehashed because
  something it uses changed does not count, or every behaviour change with tests would be minor;
  `update` already tells edited definitions apart from rehashed ones. Added tests do not count
  either.
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
model is stored and delivers each result to `onMsg` as a `Msg`. A command used in `Await` instead
delivers its result to the waiting continuation. Commands are provided by plugins (section 9): the
first is an outgoing HTTP request. Every command has a **maximum lifetime**, set by its plugin (an
HTTP call times out, for example); after it, the command's result can no longer arrive. Command
results are where messages from an old version can outlive a deploy, which is why section 4 covers
late `Msg` results and waiting continuations, and the lifetimes are what make pruning them safe
(section 10).

## 8. Cheap additions

These fall out of the design with little extra work:

- **Deploy preview.** `cairn deploy --dry-run` prints the computed version, the migrations that
  would run and whether rollback would be safe, without deploying. Everything it shows is already
  computed by the gate.
- **OpenAPI from routes.** Route types give an OpenAPI description, JSON Schemas for every body,
  and typed clients, with no annotations.
- **HTTP caching for stateless routes.** A stateless route that does not `Await` a command has a
  response fully determined by the route's hash and the request, so the hash can serve as the
  `ETag`, and responses can be cached exactly. Routes that `Await` depend on another service and
  are not cached this way.
- **Replay.** Routes are pure, so recorded production requests can be replayed against a candidate
  before it is deployed, and the responses compared with what live returned. For routes that
  `Await` a command, the recorded command results are replayed too, so nothing is sent to other
  services. This turns
  "types cannot see a change in meaning" into a check the gate can run: a "patch" that changes
  real responses is reported. This is the README's "shadow deploys" idea, built into the gate.
- **Time-travel debugging.** If the runtime logs every request, message and deploy, the state at
  any point is a fold over that log from `init`: requests and messages through the code that was
  live at the time, and each deploy through its migration log. Any bug can then be reproduced
  exactly by replay, as in Elm's debugger.
- **Coverage as a cached fact.** The definitions and `if` branches a test reaches are as
  deterministic as its result, so they are cached with it and measured once per test hash. Each
  project sets its own minimum in `cairn.json` (none by default), over definitions changed since
  live or over all of them, and the deploy gate enforces it. Coverage says code ran, not that it was
  checked, which is why no minimum is imposed by default. (Built in the prototype.)
- **Mutation testing.** Coverage cannot tell whether tests would notice a mistake; mutation
  testing can. Small deliberate changes (`<` to `<=`, a negated condition, `n` to `n + 1`) are
  evaluated in place of the original hash, only against tests whose coverage reaches the
  definition, and each verdict is cached per (mutant, test), so the usual cost of mutation testing
  mostly disappears. A project can set a minimum score for the deploy gate. (Built in the
  prototype.)
- **A risk report.** Every place Cairn's guarantees stop is explicit: `partial def` (may not
  terminate), plugin bindings (trusted host code), `migration` and `fix` (permanent data changes),
  properties only checked on samples, survived mutants, coverage gaps, and overrides such as
  `--force`. Because all of it is structured data about hashes, `cairn risks` can list it for the
  whole codebase or for one deploy, so a reviewer, human or AI, starts where the risk is rather than
  reading every change equally. Reviews can be cached by hash too: "this partial function was
  reviewed, and its loop terminates because X" is a statement about one hash, valid until the code
  changes, like a test result. (`partial def` and a first `cairn risks` are built in the
  prototype.)
- **Canary deploys.** Send a percentage of requests to the new namespace: two pointers and a
  weighted choice. For stateful apps this has the same restriction as several majors.

## 9. Plugins

The language stays small and pure. Everything that touches the outside world is a **plugin**:
trusted host code (TypeScript, the runtime's language) that connects Cairn values and functions to
one kind of place. Darklang's built-in handlers (HTTP, cron, worker) and datastores are the closest
precedent; here they are pluggable, so new ones can be added without changing the language.

### Two kinds of plugin

- **Entry points** bring events in: HTTP, WebSockets, cron, queue consumers, a CLI. The plugin
  listens, turns each event into a call of a Cairn function with a typed input, and maps the typed
  result back out. The prototype's `http` and `ws` plugins are this.
- **Effects and storage** take things out: outgoing HTTP calls, files, databases, and where a
  stateful app's `Model` lives (in memory, a JSON file, a SQL table). These plugins perform the
  commands Cairn code returns, and keep state.

### Plugins decide how types map

Cairn types are structural data: the checker holds `{ id: string, qty: number }` as a plain value.
A plugin receives the declared type and decides what it means in its world:

| Plugin | `{ id: string, qty: number }` becomes |
|---|---|
| `http` | a JSON body, checked on the way in and projected on the way out, plus an OpenAPI schema |
| `sql` storage | a table `(id TEXT PRIMARY KEY, qty REAL)`, plus the `ALTER TABLE` when the type changes |
| `file` storage | a JSON file, written atomically |
| `ws` | a typed message format on a channel |

A plugin can **reject types it cannot handle at `update` time**: a SQL plugin may refuse nested
records it has no mapping for. The error appears before anything is staged, like a type error,
never at runtime in production.

### Bindings

A binding attaches a definition to a plugin. One syntax serves every plugin, and each plugin parses
its own arguments:

```
@http("POST /quote")
def quote(req: { body: { qty: number, price: number } }): { total: number } = ...

@ws("/chat")
def chat(msg: ChatMsg, conn: Conn): List(ChatMsg) = ...

@cron("*/5 * * * *")
def cleanup(now: number): List(Cmd) = ...

@store("visits")
type Model = { visits: number }
```

The binding, its arguments and the plugin's version are hashed with the definition (the prototype
does this), so changing a binding changes the hash.

### Resources and environments

Code names **logical resources**, never environment details: `@store("visits")`, not a database
file; `service("users")`, not a hostname. A **deployment config**, kept outside the hash and
written per environment, maps each name to something real:

```
# production.cairn-env
store visits = sqlite("/var/lib/app/visits.db")
service users = "https://users.internal"
http port = 443
```

Otherwise pointing the same code at a staging database would change its hash, so the "same" app
would be different code in each environment, and a hash tested in staging could not be promoted to
production. With the split, the namespace hash means the same behaviour everywhere, and only the
config differs. The prototype already works this way for ports: `cairn serve --port` is a flag, not
code. The gate checks that every resource the code names is mapped in the target environment's
config before a deploy.

### How plugins fit the rest of the design

- **Plugins are pinned like builtins.** A plugin's mapping is observable behaviour (how a
  number is encoded, how a type becomes a table), so a binding records `http@2` in its hash, and
  moving to `http@3` goes through `cairn upgrade`, exactly like `round2@1 → 2`.
- **Tests stay pure.** Plugins only act at the edges: tests call bound functions directly, and
  effect plugins provide fakes for their commands.
- **Storage plugins take part in the transactional switch.** The two-phase deploy (section 3)
  becomes part of the storage interface: prepare, commit, abort. A SQL plugin implements it with a
  database transaction, a file plugin with write-then-rename. A Cairn migration transforms the
  data; the plugin changes the storage (`ALTER TABLE`).
- **Long-lived connections follow the `Await` rule.** A WebSocket open across a deploy carries on
  if its message types did not change; if they did, the plugin closes it with a "reconnect" code,
  for the same reason requests waiting in an `Await` get a 503.
- **Replay and time travel work for every plugin**, because the interface requires each plugin to
  record what comes in (events) and what comes back (command results).
- **Commands have lifetimes.** Each command a plugin offers declares its maximum lifetime, which
  makes automatic pruning safe (section 10).

### Interface sketch

```ts
interface CairnPlugin {
  name: string;
  version: number;

  // at update time
  checkBinding?(decl: Decl, args: Value[]): CairnError[];   // e.g. path params match, types supported
  mapType?(t: Type): Codec | CairnError;                     // how values cross the boundary

  // entry points
  start?(rt: Runtime): void;            // listen; call rt.invoke(name, input, onResult)
  onLive?(ns: Namespace): void;         // a deploy happened

  // effects
  commands?: Record<string, { run(input: Value): Promise<Value>; maxLifetimeMs: number }>;
  fakes?: Record<string, (input: Value) => Value>;          // for tests

  // storage and the transactional switch
  prepare?(migrate: (old: Value) => Value): Promise<Prepared>;
  commit?(p: Prepared): Promise<void>;
  abort?(p: Prepared): Promise<void>;
  snapshot?(): Promise<Value>;          // state at a pruning horizon (section 10)
}
```

### Trust and identity

Plugins are TypeScript, not Cairn, so they are not sandboxed: they are **trusted host code**, like
Elm's kernel modules. They are still identified exactly: a plugin's identity is
`name@version` **plus a hash of its package**, and both are recorded in the hash of every binding
that uses it. Two machines with different builds of `http@2` would otherwise behave differently
under the same namespace hash, and since plugins also run checks at `update` time, even staging
would depend on unpinned code. A runtime refuses to load a plugin whose package hash does not
match the one the namespace names.

## 10. Pruning

Several parts of the design keep old versions alive, and without pruning they grow forever:
migration logs in the deploy history (for lagging instances, late command results and rollbacks),
old `Msg` migrations, rollback targets back to the first deploy, old major versions served side by
side, and every code-store entry any of these still refers to.

### The support horizon

Pruning sets a **horizon**: a deploy before which the system stops promising anything. With the
horizon at `v2.3.0+s4`:

| Before the horizon | After pruning |
|---|---|
| Rollback | cannot cross the horizon |
| Late command results issued earlier | dropped and logged, or delivered as a typed `Expired`, so code can handle them |
| Instances that far behind | cannot replay logs; they load a **snapshot** of the state at the horizon |
| Migration logs and old `Msg` migrations | deleted |
| Older majors | retired; clients still pinned to them get `410 Gone` |
| Code only those things used | garbage-collected from the store |

This does not weaken immutability. A hash never changes meaning: pruning can make an entry
**unavailable**, never different. The store is immutable, and append-only within the horizon;
"immutable, not eternal".

The snapshot is the same idea as **squashing migrations** in database tools (Django's
`squashmigrations`, Rails' `schema.rb`): the state at the horizon becomes the new starting point,
and the history before it is dropped. Storage plugins produce it (`snapshot` in section 9).

Once no message older than the horizon can arrive, the migrations that converted old `Msg`
variants are no longer needed, so pruning is also how old variants stop being supported.

Because the state counter already marks one-way steps, a horizon is a minimum counter: "supported
states `s4`–`s7`".

### Automatic and explicit pruning

**Automatic**, for what is provably no longer needed. Nothing is lost, so the runtime does it
without asking:

- `Msg` migrations older than the longest command lifetime (section 7): no result can still arrive
  that needs them.
- Migration logs that every instance has already applied.

**Explicit**, for anything that changes a guarantee. A person decides, with `cairn prune --before
<version>` or a policy such as "keep the last 20 deploys or 30 days":

- moving the rollback horizon,
- retiring an old major,
- dropping time-travel history.

### The gate checks pruning

Pruning changes what is supported, so it gets the same preview as a deploy:

```
cairn prune --before v2.3.0+s4 --dry-run
  rollback: limited to v2.3.0+s4 and later (was: back to v1.0.0+s1)
  late results: 2 pending commands were issued before the horizon and will be dropped
  majors: v1 retired — 0 calls in the last 30 days
  store: 1,204 entries become unreachable and will be collected
```

A prune past `live` is refused. Retiring a major that still receives traffic, or dropping pending
command results, needs `--force`.

## 11. Verification

Tests check examples. A solver (an SMT solver such as Z3, available for Node as WebAssembly) can
prove a property for **every** input, or return a concrete counterexample. Cairn suits this
unusually well: verification is hard mainly because of mutation, hidden effects and unbounded
loops, and Cairn code has none of these (section 1, item 6).

### One kind of claim, several kinds of evidence

A test and a proof are two strengths of evidence for the same kind of statement:

```
test exactlyHundred = shipping(100) == 0
property freeShipping = forall total: number. total >= 100 => shipping(total) == 0
```

A `property` is written once, and Cairn uses the strongest evidence it can get:

1. **Proved:** the solver shows it holds for every input.
2. **Counterexample:** the solver finds an input where it fails (`total = 99.5`). That is a real
   failure, and the counterexample becomes an ordinary cached **test**, so it stays as a
   regression check after the bug is fixed.
3. **Unknown:** too hard, or the solver reached its work limit. Cairn falls back to checking
   inputs generated from the types (property testing): 0, -1, 1, very large and fractional numbers,
   `""` and Unicode strings, and records combining these. Weaker evidence, but nothing is blocked
   only because the solver gave up.

### Proofs are cached facts

"Property P holds for hash H" is as permanent as "test T passes", provided the solver is
deterministic: its version is pinned (recorded like builtins and plugins), and it is limited by an
amount of work rather than wall-clock time, so the same question always gets the same answer. A
proof is cached by (definition hash, property hash, solver version) and redone only when something
it depends on changes.

### The gate

By default, every test and property must at least pass (proved, or checked on generated inputs).
A project can demand more in `cairn.json`, like coverage and mutation minimums, for example that
properties about `Model` invariants and migrations must be **proved**.

### How it fits coverage and mutation testing

- **Mutation testing:** a mutant is also killed when a property stops being provable on it. And
  the solver can prove a mutant **equivalent** to the original (such as a threshold where both
  sides give the same result) and leave it out of the score, which fixes mutation testing's main
  weakness.
- **Coverage:** a proved property covers every path of the definitions it mentions, so proved code
  does not need example tests just to raise coverage.
- **Redundant tests:** a test that is one case of a proved property adds nothing; Cairn reports it.

### Where proofs pay off most

1. **State invariants:** `visits >= 0` on a `Model`, proved to hold after every route, migration
   and `fix`, for every possible request, where tests only sample.
2. **Migrations:** proved to produce a valid state for every old state, not only the one the dry
   run saw.
3. **Refinement types:** types with a condition, such as `{ n: number | n != 0 }`. `NonZero`
   (section 1) is one. With a solver, the checker knows that inside `if count != 0` the value is
   non-zero, so `total / count` is proved safe there without a `Result`. Subtyping extends
   naturally: `{ n | n > 5 } <: { n | n != 0 }` because `n > 5` implies `n != 0`.

### Why tests remain

Proofs replace most tests, not all of them:

- **Tests check the specification.** A proof shows the code matches the property, not that the
  property is what was meant: if the rule is "free shipping over 100" and the property says
  `total >= 100`, the proof succeeds anyway. A concrete example from the requirement ("an order of
  exactly 100 pays shipping") catches it. Examples are easier to get right than general statements,
  and two independent descriptions catch mistakes in either.
- **Some behaviour is as long to specify as to write.** Proofs suit partial properties ("never
  negative", "always valid"); the full specification of `fee`'s exact outputs is essentially its
  code again. For "this order costs exactly 2.50", a test is the specification.
- **Some things are out of reach:** `partial def`, undecidable questions, plugins (trusted
  TypeScript, including the JSON mapping) and the solver itself.

As verification grows, tests should shrink to a small set of examples that document intent.

### What to avoid

- **Mandatory proofs by default**, for the same reasons as mandatory 100% coverage: deploys would be
  blocked by solver limits and specification work.
- **Solver reasoning over floats** before an exact number type exists (section 1, item 7).

## Implementation order

**Prototype status.** Steps 2 and 3 exist in a first form. Defs are bound with
`@plugin(...)` annotations; a binding is checked by its plugin at `update` time and hashed with the
def, including the plugin's version. Two entry-point plugins implement one interface
(`src/plugins/types.ts`): `http` (typed request records, request checking, response projection,
the `X-Cairn-Namespace` header) and `ws` (typed JSON messages; connections live across deploys that
keep their message types and are closed with 1012 when a deploy changes them). Plugins reach the
codebase only through a `Runtime` the host provides. Instances follow a shared state file saved by
atomic rename, so one deploy switches every instance in milliseconds (`examples/serve-demo.sh`).
Test coverage and mutation testing (section 8) are built: both are cached per hash and can be
enforced by the deploy gate through `cairn.json`. `partial def` is built, with the rule that total
code may not call partial code, and a first `cairn risks` (partial code, plugin boundaries,
untested code); without lists and `fold` yet, all recursion is `partial` for now.
Not yet built: logical resources and per-environment config (ports are command-line flags),
pinning plugins by package hash and upgrading pinned plugin versions, `Reply`/`Await`, the store
split, and compare-and-swap between concurrent deployers.

1. Tagged unions with `case`, lists with `fold` and `range`, the built-in parameterized types, type
   aliases (including recursive types), and the number rules (`NonZero`, with non-zero literals
   typed `NonZero`; division returning `Result` unless the divisor is a `NonZero`; overflow as an
   error). Then restricted recursion: structural recursion and `partial def`, with existing
   recursive examples rewritten with `fold` or marked `partial`.
2. Stateless HTTP routes with typed requests (path parameters, query, body), `cairn serve`,
   request checking and response projection, per-request evaluation budgets, the
   `X-Cairn-Namespace` header; the store split; instant deploys across several local instances.
3. The plugin interface: bindings, type mapping and update-time checks, plugin versions pinned like
   builtins. HTTP becomes the first entry-point plugin; a WebSocket plugin shows the interface
   generalizes.
4. Computed API versions, and `cairn deploy --dry-run`.
5. Stateful apps: `init` and `Model` on a single instance, the one-at-a-time request queue, the
   migration requirement for `Model`, totality checks, the migration log, the transactional switch
   and two-phase deploy, `fix` declarations and required migration tests. Storage through the
   storage plugin interface, starting with in-memory and file storage.
6. The rollback rule (including returning migration logs to pending) and the state counter.
7. Commands, `Await` and `onMsg`, with `Msg` migrations, commands tagged by deploy, command
   lifetimes, and the 503 rule for continuations waiting across a state change.
8. Pruning: automatic pruning of what is provably unneeded, `cairn prune` with its preview,
   snapshots, and garbage collection of the store.
9. Replay against recorded requests; OpenAPI generation; HTTP caching.
10. Several major versions and canaries, for stateless apps and for stateful apps whose versions
    share the same `Model` type.
11. Verification: `property` declarations with property testing first (generators from types,
    counterexamples kept as tests); then the solver behind them, with proofs cached and the solver
    pinned; then proved `Model` invariants and migration properties; refinement types once the
    exact number type exists.

## Open questions

- **Stateful apps across instances.** Where does a stateful app's model live once it outgrows one
  instance, and how does the transactional switch work there?
- **The first version.** Does the first deploy of an app start at `1.0.0` or `0.1.0`, and do
  `0.x` versions relax the rules as in semver?
- **Binding syntax.** Annotations on each definition (`@http("POST /quote") def quote ...`, as in
  section 9), or bindings grouped in an `app` block (as in section 2)? Annotations keep one syntax
  for every plugin; an `app` block keeps an app's model and its routes together.
- **Plugin distribution and sandboxing.** Plugins are pinned by package hash (section 9). How are
  they packaged and fetched, and is sandboxing (for example, running plugins in a separate process
  with only the capabilities they declare) worth it later?
- **The exact number type.** A decimal type (exact for money, familiar from SQL), integers plus
  exact rationals, or both? And does it replace `number`, or sit beside it with floats kept for
  measurements?
- **Expired results.** Should a command result that arrives after its horizon be dropped silently
  (and logged), or delivered as a typed `Expired` value that code must handle?
