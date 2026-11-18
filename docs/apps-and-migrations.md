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
   JavaScript (IEEE 754), so `1 / 0`, `0 / 0`, `1 % 0` and overflow (`1e308 * 10`) yield
   `Infinity` or `NaN`. Those values fail silently in exactly the places Cairn relies on: `NaN == NaN` is false,
   so a test can fail and be cached as a fact about its hash; JSON has no representation for them
   (`JSON.stringify` turns them into `null`), so a REST response would break its declared type;
   and they spread through every later computation while still type-checking as `number`.

   The rules, for division (`/`) and remainder (`%`) alike:

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
     Result(DivByZero, number) (count may be 0)". `%` works the same way. Shorter forms: `withDefault(0, total / count)`;
     returning the `Result` to the caller; or, in a route, turning `Err` into a 400.
   - **`nonZero(x)`** returns `Result(IsZero, NonZero)`. Division or remainder by a `NonZero`
     returns a plain `number`, so a value checked once can be divided by freely.
   - **Overflow** is an error raised at the operation that overflowed, never a value. It is too rare
     to justify a `Result` on every multiplication. Inside a migration it is caught by the
     transactional switch (section 4).

## 2. Apps

An app is a new kind of declaration, alongside `def` and `test`. It declares its routes, each
with its own request and response types:

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
      Await(Http.get("https://users.internal/" ++ req.params.id), (result, model) => Reply({
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

`cairn serve --port N` starts an instance that serves the apps in `live`.

The current single `state.json` (read and rewritten whole by every command) is split along the
line the design already draws:

| Part | Mutability | Requirements |
|---|---|---|
| Code store: one entry per hash | append-only | any shared storage; instances cache entries forever |
| Test cache: one result per test hash | append-only | as above |
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
  path was picked. Edges in an append-only store cannot be deleted, so a stray one could not even
  be removed.
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
| Never finishes | A migration and everything it reaches must be **non-recursive**. Hashing already finds recursion groups, so the check is cheap. Iteration uses total list operations only. |
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

A `fix` must have the same input and output type. It is checked like a migration (non-recursive,
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
3. **Otherwise:** refused, with the reason (for example, "state field `lastVisit` is missing, but
   the target expects it"). The user fixes forward.

Consequences:

| Deploy being rolled back | Rollback |
|---|---|
| Body-only change | allowed |
| A `fix` | allowed, but the data stays fixed: rollback does not undo migrations or fixes |
| Added a field (a migration ran) | allowed: `{visits, lastVisit} <: {visits}`, the old code ignores the field |
| Removed a field | allowed only if the value check finds the field still present |
| Changed a field's type | refused |

Pending messages follow the same rule: rolling back past a deploy that added `Msg.Reset` is
allowed only if no `Reset` message is pending.

After a rollback, the state's type is the target's `Model` type `T`: the restored code writes values
of that type from its first request on. Rolling back across a deploy therefore **returns that
deploy's migration log to the front of the pending log**, so that deploying forward again has a log
that composes from `T`. Redeploying runs those migrations again. That is type-safe, but data they
set is set again: redeploying after rolling back past `addLastVisit` resets `lastVisit` to `""`,
even on records the old code happened to preserve. `cairn deploy --dry-run` (section 8) shows this
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
delivers its result to the waiting continuation. The first command is an outgoing HTTP request;
storage comes later. Command results are where messages from an old version can outlive a deploy,
which is why section 4 covers late `Msg` results and waiting continuations.

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
- **Canary deploys.** Send a percentage of requests to the new namespace: two pointers and a
  weighted choice. For stateful apps this has the same restriction as several majors.

## Implementation order

1. Tagged unions with `case`, lists and the built-in parameterized types, type aliases (including
   recursive types), and the number rules (division returning `Result` unless the divisor is a
   non-zero literal or `NonZero`; overflow as an error).
2. Stateless `app` declarations with typed routes (path parameters, query, body), `cairn serve`,
   request checking and response projection, per-request evaluation budgets, the
   `X-Cairn-Namespace` header; the store split; instant deploys across several local instances.
3. Computed API versions, and `cairn deploy --dry-run`.
4. Stateful apps: `init` and `Model` on a single instance, the one-at-a-time request queue, the
   migration requirement for `Model`, totality checks, the migration log, the transactional switch
   and two-phase deploy, `fix` declarations and required migration tests.
5. The rollback rule (including returning migration logs to pending) and the state counter.
6. Commands, `Await` and `onMsg`, with `Msg` migrations, commands tagged by deploy, and the 503
   rule for continuations waiting across a state change.
7. Replay against recorded requests; OpenAPI generation; HTTP caching.
8. Several major versions and canaries, for stateless apps and for stateful apps whose versions
   share the same `Model` type.

## Open questions

- **Stateful apps across instances.** Where does a stateful app's model live once it outgrows one
  instance, and how does the transactional switch work there?
- **The first version.** Does the first deploy of an app start at `1.0.0` or `0.1.0`, and do
  `0.x` versions relax the rules as in semver?
