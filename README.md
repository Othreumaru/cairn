# Cairn

A toy language exploring three ideas together:

1. **Content-addressed code** (Unison-style): every definition is identified by the hash of its normalised AST, not by its name.
2. **Static change-impact analysis**: because dependencies are by hash, the exact set of code affected by an edit is a graph query, and it is type-checked before anything is staged.
3. **A runtime with a deploy gate**: tests run *inside the runtime* before a deploy, results are cached by hash (so only affected tests run), and a passing deploy is an atomic pointer swap with rollback.

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

Requires Node 18+.

```sh
npm install
npm test               # 21 unit tests
sh examples/demo.sh    # end-to-end walkthrough (output also in DEMO.md)
./cairn                # CLI help
```

The workflow is the Unison "scratch file" model: a source file holds only what you are adding or editing, and the codebase works out everything that depends on it.

```sh
./cairn update examples/v1.cairn          # type-check, hash, show impact, stage into dev
./cairn update examples/v3-min-fee.cairn  # edit one definition; dependents are re-checked
./cairn deploy                            # gate: run affected tests, then swap live
./cairn eval 'fee({ qty: 100, price: 1 })'
./cairn dependents subtotal               # blast radius of a change, before you make it
./cairn rename fee commission             # free: no hash changes, no tests run
./cairn rollback
```

State lives in `./.cairn/state.json` (override with `CAIRN_HOME`).

## How it maps to the design discussion

| Idea | Where | What it does |
|---|---|---|
| Closed, immutable records | `types.ts`, `eval.ts` | No field adding at runtime; `{...r, f: v}` builds a new record. Records are frozen. |
| Structural subtyping | `types.ts` | Width (`{a,b,c} <: {a,b}`) and depth. Depth is sound *because* records are immutable. Functions are contravariant in parameters. |
| Bidirectional typing | `check.ts` | `synth` vs `check`. Top-level signatures are required; expected types flow into lambdas and record literals, so `applyTwice(x => x * 3, 2)` needs no annotation on `x`. |
| Content addressing | `hash.ts` | References become hashes, locals become de Bruijn levels, record fields are sorted. Renaming a local, reformatting or renaming a dependency never changes a hash. |
| Mutual recursion | `hash.ts` | Strongly connected components are hashed as one group; members are `H(groupHash, i)`. |
| Exact impact analysis | `codebase.ts` | An edit's transitive dependents are found via a reverse index, converted back to name-form, re-type-checked against the new types, and re-hashed. Incompatible changes are rejected with every broken dependent named. |
| Change classification | `codebase.ts` | Body-only, compatible type change (`new <: old`), or incompatible. Rehashes caused purely by a moved dependency are reported as propagated, not edited. |
| Test cache by hash | `runtime.ts` | A test result is a permanent fact about a hash. A test's hash transitively covers its dependencies, so cache invalidation is exact. Reverting code gets back old hashes and therefore old results. |
| Deploy gate | `runtime.ts` | `live` is only written by `deploy`: all tests must pass (cached or freshly run), then the namespace pointer is swapped atomically. |
| Rollback | `runtime.ts` | The previous namespace is just another pointer, and the code it refers to is still in the append-only store. |
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

1. **Row polymorphism** (`{ name: string | r }`) for HM-style inference over records.
2. **Algebraic effects with handlers**, so IO, mutable signals and `Remote` show up in types and tests run under fake handlers.
3. **Shadow deploys**: run the candidate hash alongside live on real inputs and diff the outputs. Purity makes this safe.
4. **Parallel gate**: affected tests are independent pure computations, so they can be sharded across workers by hash.
5. **Code shipping**: send a closure as `(hash, captured values)` and let the receiver fetch missing hashes from the store.
