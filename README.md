# Cairn

A toy language exploring three ideas together:

1. **Content-addressed code** (Unison-style): every definition is identified by the hash of its normalised AST, not by its name.
2. **Static change-impact analysis**: because dependencies are by hash, the exact set of code affected by an edit is a graph query, and it is type-checked before anything is staged.
3. **A runtime with a deploy gate**: tests run *inside the runtime* as soon as code is staged, results are cached by hash (so only affected tests run), and a deploy only reads those results: if they all pass, it is an atomic pointer swap with rollback.

The surface language is a small, JS-flavoured, pure functional language with closed, immutable records, structural subtyping and bidirectional type checking.

```
def subtotal(o: { qty: number, price: number }): number = o.qty * o.price
def fee(o: { qty: number, price: number }): number = max(subtotal(o) * 0.01, 1)
def applyTwice(f: (n: number) => number, x: number): number = f(f(x))

test minFee        = fee({ qty: 1, price: 1 }) == 1
test extraFieldsOk = subtotal({ qty: 2, price: 3, venue: "LSE" }) == 6   // width subtyping
test inferred      = applyTwice(x => x * 3, 2) == 18                     // contextual typing
```

## Running it

Requires Node 26+, which runs the TypeScript sources directly (type stripping), so there is no
build step and no loader. `npm install` only fetches TypeScript, for `npm run typecheck`.

```sh
npm install
npm test               # 45 unit tests
sh examples/demo.sh    # end-to-end walkthrough (output also in DEMO.md)
./cairn                # CLI help
```

The workflow is the Unison "scratch file" model: a source file holds only what you are adding or editing, and the codebase works out everything that depends on it.

```sh
./cairn update examples/v1.cairn          # type-check, hash, show impact, stage into dev
./cairn update examples/v3-min-fee.cairn  # edit one definition; dependents are re-checked, affected tests run now
./cairn deploy                            # gate: all cached results pass? then swap live
./cairn eval 'fee({ qty: 100, price: 1 })'
./cairn dependents subtotal               # blast radius of a change, before you make it
./cairn rename fee commission             # free: no hash changes, no tests run
./cairn upgrade                           # move code onto new builtin versions; affected tests re-run
./cairn rollback
```

State lives in `./.cairn/state.json` (override with `CAIRN_HOME`).

## Recursion is explicit

Recursion is only allowed in a `partial def`, and total code may not call partial code, so a
definition that calls a partial one must be marked `partial` too:

```
partial def fact(n: number): number = if n <= 1 then 1 else n * fact(n - 1)
def twice(n: number): number = fact(n) * 2
```

```
✗ twice: 'twice' calls partial 'fact', and total code may not call partial code: declare it 'partial def twice'
```

The marker therefore appears everywhere a risk of not terminating reaches, which makes the tricky
code easy to find for people and tools. (The design plans `map`, `filter`, `fold` and `range` for
everyday iteration, so most code will not need `partial` at all.) Tests may call partial code: they
always run under the evaluation budget.

`cairn risks` lists every place the guarantees stop, for the whole codebase or, with `--deploy`, for
what changed since live:

```
may not terminate:
  fact           recursive
  isEven         mutually recursive
not fully tested:
  isOdd          'if n == 0' never true
```

## Test coverage

Every test run records which definitions it ran and which branch of each `if` it took. Like the
test's result, that is a permanent fact about the test's hash, so it is cached with the result and
measured once. Each definition counts one unit for running and one per branch of each `if`.

`update` and `deploy` report coverage of what changed since live, and `cairn coverage` lists every
gap:

```
coverage: 50% of changed definitions (2/4 units), minimum 80% — NOT MET
  fee (2/3): 'if o.qty * o.price < 100' never false
  label (0/1): never run by any test
```

A project chooses its own minimum in `cairn.json`, which the deploy gate enforces:

```json
{ "coverage": { "minimum": 80, "of": "changed" } }
```

- `minimum`: a percentage from 0 to 100. The default, 0, only reports.
- `of`: `"changed"` (definitions new or changed since live, the default) or `"all"`.
- `--min-coverage N` on `update`, `deploy` or `coverage` overrides the minimum for one command.

Coverage says code ran, not that it was checked, so a high minimum is a choice for each project,
not a default.

## Mutation testing

Mutation testing checks what coverage cannot: whether the tests would notice a mistake. It makes
small deliberate changes to each definition (`<` to `<=`, `+` to `-`, a negated condition, `100` to
`101`, ...) and runs the tests that reach it. A change no test notices has *survived*:

```
def shipping(total: number): number = if total < 100 then 5 else 0
test small = shipping(20) == 5
test big = shipping(250) == 0
```

```
$ cairn mutate
mutation: 60% of mutants killed in changed definitions (3/5)
  survived — shipping: '<' → '<=' in 'total < 100': no test fails
  survived — shipping: 100 → 101 in '100': no test fails
```

Coverage is 100% here, yet nothing checks a total of exactly 100. Adding
`test exactlyHundred = shipping(100) == 0` kills both.

It is cheap in Cairn: a mutant is handed to the evaluator in place of the original's hash, so
nothing is restaged; only tests whose coverage reaches the definition run; and each verdict is a
permanent fact about the pair (mutant, test), cached in the state, so repeat runs are free.

`cairn mutate [--all]` reports; a minimum in `cairn.json` makes the deploy gate enforce it:

```json
{ "mutation": { "minimum": 70, "of": "changed" } }
```

Some mutants can never be killed because they do not change behaviour (an *equivalent mutant*,
such as moving a threshold where both sides give the same result), so 100% is not always reachable.

## Plugins: HTTP and WebSockets

Everything that touches the outside world is a plugin. A binding attaches a `def` to one:

```
@http("POST /quote")
def quote(req: { body: { qty: number, price: number } }): { total: number } =
  { total: subtotal(req.body) + fee(req.body) }

@ws("/live")
def liveQuote(msg: { qty: number, price: number }): { total: number } =
  { total: subtotal(msg) + fee(msg) }

test quoteAddsFee = quote({ body: { qty: 100, price: 1 } }).total == 101
```

```sh
./cairn serve --http 3001 --ws 4001       # serve live through both plugins; repeat on other ports
./cairn bindings                          # list the bindings in live
sh examples/serve-demo.sh                 # three instances, one deploy switches all of them
```

- **Bindings are checked by their plugin at `update` time** (path parameters that match the path,
  data-only types, no two routes on one path), and the binding, including the plugin's version, is
  part of the def's hash. Bound defs stay ordinary functions, so tests call them directly.
- **`http`**: a request record with optional `params`, `query` and `body`. Requests are checked
  against it before any Cairn code runs (400 on a mismatch); responses are projected onto the
  declared type, so fields a value carries but its type does not mention are never sent. Every
  response carries `X-Cairn-Namespace`.
- **`ws`**: each JSON message is checked against the parameter type and answered with the result.
  A connection lives across deploys and is answered by the new code, as long as the message types
  are unchanged; when a deploy changes them, it is closed with 1012 so the client reconnects.
- Each instance watches the state file, which is saved by atomic rename, so a `deploy` or
  `rollback` switches every running instance within milliseconds, without restarts. Each call has
  an evaluation budget; a runaway one gets an error instead of hanging the instance.

Plugins implement one interface (`src/plugins/types.ts`) and reach the codebase only through the
`Runtime` the host gives them. This is the first slice of the design in
[`docs/apps-and-migrations.md`](docs/apps-and-migrations.md): stateless bindings only, served from
one shared state file on one machine.

## How it maps to the design discussion

| Idea | Where | What it does |
|---|---|---|
| Closed, immutable records | `types.ts`, `eval.ts` | No field adding at runtime; `{...r, f: v}` builds a new record. Records are frozen. |
| Structural subtyping | `types.ts` | Width (`{a,b,c} <: {a,b}`) and depth. Depth is sound *because* records are immutable. Functions are contravariant in parameters. |
| Bidirectional typing | `check.ts` | `synth` vs `check`. Top-level signatures are required; expected types flow into lambdas and record literals, so `applyTwice(x => x * 3, 2)` needs no annotation on `x`. |
| Content addressing | `hash.ts` | References become hashes, locals become de Bruijn levels, record fields are sorted. Renaming a local, reformatting or renaming a dependency never changes a hash. |
| Mutual recursion | `hash.ts`, `codebase.ts` | Strongly connected components are hashed as one group; members are `H(groupHash, i)`. Recursion is only allowed in `partial def`, and total code may not call partial code; `partial` is part of the hash. |
| Exact impact analysis | `codebase.ts` | An edit's transitive dependents are found via a reverse index, converted back to name-form, re-type-checked against the new types, and re-hashed. Incompatible changes are rejected with every broken dependent named. |
| Change classification | `codebase.ts` | Body-only, compatible type change (`new <: old`), or incompatible. Rehashes caused purely by a moved dependency are reported as propagated, not edited. |
| Test cache by hash | `runtime.ts` | A test result is a permanent fact about a hash. A test's hash transitively covers its dependencies, so cache invalidation is exact. Reverting code gets back old hashes and therefore old results. |
| Deploy gate | `runtime.ts`, `cli.ts` | `live` is only written by `deploy`: all tests must pass, then the namespace pointer is swapped atomically. `update` runs the affected tests as soon as code is staged (failing ones are still staged, but block the deploy), so a deploy normally only reads the cache and does no work. `--skip-tests` defers them to the deploy. |
| Rollback | `runtime.ts` | The previous namespace is just another pointer, and the code it refers to is still in the append-only store. |
| Versioned builtins | `builtins.ts`, `hash.ts`, `codebase.ts` | Builtins are immutable and versioned; hash-form code pins `name@version`, so a builtin's version is part of every hash that uses it. Publishing a new version changes nothing stored: old code (and rollback targets) keep running the old version. `upgrade` re-hashes the code still pinned to an old version, propagates to dependents, and the next deploy re-runs exactly the tests that reach the changed builtin. Code re-hashed for an unrelated edit keeps its pins. |
| Test coverage | `coverage.ts`, `eval.ts`, `config.ts` | The evaluator records the definitions and `if` branches a test reaches; the set is cached with the test's result, like the result itself. `cairn.json` sets a minimum the deploy gate enforces, over changed or all definitions. |
| Mutation testing | `mutation.ts` | Deliberate small mistakes are evaluated in place of the original hash, only against tests whose coverage reaches the definition; verdicts are cached per (mutant, test). `cairn.json` can set a minimum score for the deploy gate. |
| Plugins | `plugins/`, `host.ts`, `store.ts` | `@plugin(...)` bindings are checked by their plugin at update time and hashed with the def, including the plugin version. The host gives plugins a runtime and follows the state file, so one deploy switches every instance; `http` and `ws` check inputs against the declared types and project outputs onto them. |
| Runaway tests | `eval.ts`, `runtime.ts` | Evaluation budget plus stack-overflow capture: a non-terminating test fails the gate instead of hanging it. |

## Source layout

```
src/
  ast.ts        Expr / Type / Decl; name-form vs hash-form
  lexer.ts      tokens
  parser.ts     Pratt parser; lambda detection by lookahead
  pretty.ts     printer (code is rendered from the stored AST, like Unison)
  types.ts      subtyping, least upper bound
  check.ts      bidirectional checker
  builtins.ts   str, len, abs, floor, round2, max, min
  hash.ts       normalisation, canonical serialisation, SCC hashing, denormalisation
  eval.ts       interpreter over hash-form; globals fetched by hash
  codebase.ts   store, namespaces, update pipeline, impact report
  runtime.ts    deploy gate, test cache, rollback, eval
  host.ts       runs entry-point plugins against live and follows deploys
  plugins/      the plugin interface, the JSON mapping, and the http and ws plugins
  store.ts      loading and atomic saving of the state file
  coverage.ts   coverage units, recorded per test and reported per definition
  mutation.ts   mutation testing: mutants, verdicts cached per (mutant, test), scores
  risks.ts      where the guarantees stop: partial code, plugin boundaries, untested code
  config.ts     project settings from cairn.json (coverage and mutation policies)
  cli.ts        command line
test/           unit tests (node:test)
examples/       v1 … v7 scenario files + demo.sh
```

## Deliberate simplifications

- **No generics.** Without parametric polymorphism there is no unification at all. Adding row-polymorphic records would be the natural next step.
- **Equality is on primitives only.** Structural record equality would be easy to add.
- **Cycle-group member order uses names.** Unison orders members by a name-independent hash; here, renaming a member of a mutual-recursion group can change the group's hash.
- **Tests are boolean expressions.** No property-based tests or generators yet.
- **A single process plays both "runtime" and "CI".** There is no network, effects or `Remote` yet.

## Natural next steps

A proposal for apps served over HTTP, state migrations, safe rollback and computed versions is in [`docs/apps-and-migrations.md`](docs/apps-and-migrations.md).

1. **Row polymorphism** (`{ name: string | r }`) for HM-style inference over records.
2. **Algebraic effects with handlers**, so IO, mutable signals and `Remote` show up in types and tests run under fake handlers.
3. **Shadow deploys**: run the candidate hash alongside live on real inputs and diff the outputs. Purity makes this safe.
4. **Parallel gate**: affected tests are independent pure computations, so they can be sharded across workers by hash.
5. **Code shipping**: send a closure as `(hash, captured values)` and let the receiver fetch missing hashes from the store.
