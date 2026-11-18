# Cairn demo transcript

Output of `sh examples/demo.sh`. Source files for each step are in `examples/`.

```text

────────────────────────────────────────────────────────
## 1. Load v1 (every test is new, so all run as it is staged) and deploy it from the cache

$ cairn update examples/v1.cairn
impact of examples/v1.cairn:
  + subtotal  #e4d86384  new
  + fee  #65426a48  new
  + total  #ab5b7c78  new
  + receipt  #1e02252e  new
  + applyTwice  #7466041e  new
  + fact  #0b832814  new
  + isEven  #5c57a799  new
  + isOdd  #30a45385  new
  + subtotalWorks  #0086fa0c  new
  + feeIsOnePercent  #81ad3d13  new
  + totalAddsFee  #0dc58c04  new
  + receiptFormat  #6ebb5c46  new
  + extraFieldsOk  #398df5d5  new
  + lambdaInferred  #340f629b  new
  + factorial  #832eaa71  new
  + parity  #7ec94329  new

tests: running 8 now, 0 cached
    ✓ extraFieldsOk        RAN 0.28ms  (new test)
    ✓ factorial            RAN 0.26ms  (new test)
    ✓ feeIsOnePercent      RAN 0.03ms  (new test)
    ✓ lambdaInferred       RAN 0.06ms  (new test)
    ✓ parity               RAN 0.13ms  (new test)
    ✓ receiptFormat        RAN 0.07ms  (new test)
    ✓ subtotalWorks        RAN 0.01ms  (new test)
    ✓ totalAddsFee         RAN 0.01ms  (new test)
coverage: 93% of changed definitions (13/14 units)
  isOdd (2/3): 'if n == 0' never true
dev is now ns#01bb4332

$ cairn deploy
deploy: dev ns#01bb4332 → live (currently (empty))
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #832eaa71
    ✓ feeIsOnePercent      cached #81ad3d13
    ✓ lambdaInferred       cached #340f629b
    ✓ parity               cached #7ec94329
    ✓ receiptFormat        cached #6ebb5c46
    ✓ subtotalWorks        cached #0086fa0c
    ✓ totalAddsFee         cached #0dc58c04
  changes: +16 added, ~0 changed, -0 removed
  tests: 8 total — 0 ran, 8 served from cache
  coverage: 93% of changed definitions (13/14 units)
    isOdd (2/3): 'if n == 0' never true

ACCEPTED — atomic swap: live is now ns#01bb4332


────────────────────────────────────────────────────────
## 2. Cosmetic edit: reformat, rename parameters, reorder fields — no hash changes

$ cairn update examples/v2-cosmetic.cairn
impact of examples/v2-cosmetic.cairn:
  = 16 definition(s) unchanged (identical hashes)

no changes — every definition hashes to what is already in the codebase.


────────────────────────────────────────────────────────
## 3. Edit one definition; the codebase finds every dependent and re-checks it

$ cairn update examples/v3-min-fee.cairn
impact of examples/v3-min-fee.cairn:
  ~ fee  #65426a48 → #0d84cb6d  body changed, type unchanged
  + minFeeApplies  #11f65d3e  new
  ↻ feeIsOnePercent  #81ad3d13 → #e1603cc4  re-checked OK, rehashed (via feeIsOnePercent ← fee)
  ↻ total  #ab5b7c78 → #230576bb  re-checked OK, rehashed (via total ← fee)
  ↻ receipt  #1e02252e → #4ff7dfba  re-checked OK, rehashed (via receipt ← total ← fee)
  ↻ totalAddsFee  #0dc58c04 → #ad9cdf59  re-checked OK, rehashed (via totalAddsFee ← total ← fee)
  ↻ receiptFormat  #6ebb5c46 → #9977ae58  re-checked OK, rehashed (via receiptFormat ← receipt ← total ← fee)

tests: running 4 now, 5 cached
    ✓ feeIsOnePercent      RAN 0.32ms  (affected via feeIsOnePercent → fee)
    ✓ minFeeApplies        RAN 0.14ms  (new test)
    ✓ receiptFormat        RAN 0.22ms  (affected via receiptFormat → receipt → total → fee)
    ✓ totalAddsFee         RAN 0.03ms  (affected via totalAddsFee → total → fee)
coverage: 100% of changed definitions (3/3 units)
dev is now ns#e93af1a0

$ cairn deploy
deploy: dev ns#e93af1a0 → live (currently ns#01bb4332)
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #832eaa71
    ✓ feeIsOnePercent      cached #e1603cc4
    ✓ lambdaInferred       cached #340f629b
    ✓ minFeeApplies        cached #11f65d3e
    ✓ parity               cached #7ec94329
    ✓ receiptFormat        cached #9977ae58
    ✓ subtotalWorks        cached #0086fa0c
    ✓ totalAddsFee         cached #ad9cdf59
  changes: +1 added, ~6 changed, -0 removed
  tests: 9 total — 0 ran, 9 served from cache
  coverage: 100% of changed definitions (3/3 units)

ACCEPTED — atomic swap: live is now ns#e93af1a0


────────────────────────────────────────────────────────
## 4. A typo that type-checks: staging runs the 4 affected tests, and the gate rejects it from the cache

$ cairn update examples/v4-bug.cairn
impact of examples/v4-bug.cairn:
  ~ fee  #0d84cb6d → #ccf5aa3c  body changed, type unchanged
  ↻ feeIsOnePercent  #e1603cc4 → #992dbcd7  re-checked OK, rehashed (via feeIsOnePercent ← fee)
  ↻ total  #230576bb → #b7814efb  re-checked OK, rehashed (via total ← fee)
  ↻ minFeeApplies  #11f65d3e → #f69f195e  re-checked OK, rehashed (via minFeeApplies ← fee)
  ↻ receipt  #4ff7dfba → #f237a533  re-checked OK, rehashed (via receipt ← total ← fee)
  ↻ totalAddsFee  #ad9cdf59 → #21273940  re-checked OK, rehashed (via totalAddsFee ← total ← fee)
  ↻ receiptFormat  #9977ae58 → #54cb5693  re-checked OK, rehashed (via receiptFormat ← receipt ← total ← fee)

tests: running 4 now, 5 cached
    ✗ feeIsOnePercent      RAN 0.33ms — evaluated to false  (affected via feeIsOnePercent → fee)
    ✓ minFeeApplies        RAN 0.12ms  (affected via minFeeApplies → fee)
    ✗ receiptFormat        RAN 0.22ms — evaluated to false  (affected via receiptFormat → receipt → total → fee)
    ✗ totalAddsFee         RAN 0.04ms — evaluated to false  (affected via totalAddsFee → total → fee)
  3 test(s) failing (feeIsOnePercent, receiptFormat, totalAddsFee): staged, but deploy will refuse until they pass
coverage: 100% of changed definitions (3/3 units)
dev is now ns#0629f7da

$ cairn deploy
deploy: dev ns#0629f7da → live (currently ns#e93af1a0)
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #832eaa71
    ✗ feeIsOnePercent      cached #992dbcd7
    ✓ lambdaInferred       cached #340f629b
    ✓ minFeeApplies        cached #f69f195e
    ✓ parity               cached #7ec94329
    ✗ receiptFormat        cached #54cb5693
    ✓ subtotalWorks        cached #0086fa0c
    ✗ totalAddsFee         cached #21273940
  changes: +0 added, ~7 changed, -0 removed
  tests: 9 total — 0 ran, 9 served from cache

REJECTED — 3 test(s) failed: feeIsOnePercent, receiptFormat, totalAddsFee. live unchanged at ns#e93af1a0.

$ cairn eval fee({ qty: 100, price: 1 })
1 : number

$ cairn eval --dev fee({ qty: 100, price: 1 })
10 : number


────────────────────────────────────────────────────────
## 5. Revert the typo: the code hashes back to v3, so nothing needs to run

$ cairn update examples/v5-revert.cairn
impact of examples/v5-revert.cairn:
  ~ fee  #ccf5aa3c → #0d84cb6d  body changed, type unchanged  [known hash]
  ↻ feeIsOnePercent  #992dbcd7 → #e1603cc4  re-checked OK, rehashed (via feeIsOnePercent ← fee)  [known hash]
  ↻ total  #b7814efb → #230576bb  re-checked OK, rehashed (via total ← fee)  [known hash]
  ↻ minFeeApplies  #f69f195e → #11f65d3e  re-checked OK, rehashed (via minFeeApplies ← fee)  [known hash]
  ↻ receipt  #f237a533 → #4ff7dfba  re-checked OK, rehashed (via receipt ← total ← fee)  [known hash]
  ↻ totalAddsFee  #21273940 → #ad9cdf59  re-checked OK, rehashed (via totalAddsFee ← total ← fee)  [known hash]
  ↻ receiptFormat  #54cb5693 → #9977ae58  re-checked OK, rehashed (via receiptFormat ← receipt ← total ← fee)  [known hash]

tests: 0 will run on next deploy, 9 cached
dev is now ns#e93af1a0

$ cairn deploy
deploy: dev ns#e93af1a0 → live (currently ns#e93af1a0)
  nothing to deploy: live already serves this exact namespace (same hash)


────────────────────────────────────────────────────────
## 6. An incompatible signature change is rejected before it can even be staged

$ cairn dependents subtotal
changing 'subtotal' would affect 9 definition(s), including 6 test(s):
  test extraFieldsOk
  def  fee
  test feeIsOnePercent
  test minFeeApplies
  def  receipt
  test receiptFormat
  test subtotalWorks
  def  total
  test totalAddsFee

$ cairn update examples/v6-breaking-type.cairn
impact of examples/v6-breaking-type.cairn:
  ~ subtotal  #e4d86384 → #31c9ab3c  type changed INCOMPATIBLY: ({ price: number, qty: number }) => number  ⟶  ({ ccy: string, price: number, qty: number }) => number
  ✗ extraFieldsOk  #398df5d5  BROKEN (via extraFieldsOk ← subtotal): in call subtotal({ price: 3, qty: 2, venue: "LSE" }), argument 1: record is missing field(s) 'ccy' required by { ccy: string, price: number, qty: number }
  ✗ fee  #0d84cb6d  BROKEN (via fee ← subtotal): in call subtotal(o), argument 1: expected { ccy: string, price: number, qty: number } but got { price: number, qty: number } (missing field ccy)
  ✗ total  #230576bb  BROKEN (via total ← subtotal): in call subtotal(o), argument 1: expected { ccy: string, price: number, qty: number } but got { price: number, qty: number } (missing field ccy)
  ✗ subtotalWorks  #0086fa0c  BROKEN (via subtotalWorks ← subtotal): in call subtotal({ price: 5, qty: 10 }), argument 1: record is missing field(s) 'ccy' required by { ccy: string, price: number, qty: number }
  ↻ feeIsOnePercent  #e1603cc4  still type-checks (via feeIsOnePercent ← fee ← subtotal)
  ↻ minFeeApplies  #11f65d3e  still type-checks (via minFeeApplies ← fee ← subtotal)
  ↻ receipt  #4ff7dfba  still type-checks (via receipt ← total ← subtotal)
  ↻ totalAddsFee  #ad9cdf59  still type-checks (via totalAddsFee ← total ← subtotal)
  ↻ receiptFormat  #9977ae58  still type-checks (via receiptFormat ← receipt ← total ← subtotal)

REJECTED — the change breaks the definitions marked ✗. Nothing applied.
Update them in the same file (or keep the old type) and try again.


────────────────────────────────────────────────────────
## 7. Renames are free: same hashes, so every test result is reused

$ cairn rename fee commission
renamed fee → commission (hash #0d84cb6d unchanged; no code was touched, no tests need to run)

$ cairn view total
#230576bb  def total(o: { price: number, qty: number }): number = subtotal(o) + commission(o)

$ cairn deploy
deploy: dev ns#21a90592 → live (currently ns#e93af1a0)
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #832eaa71
    ✓ feeIsOnePercent      cached #e1603cc4
    ✓ lambdaInferred       cached #340f629b
    ✓ minFeeApplies        cached #11f65d3e
    ✓ parity               cached #7ec94329
    ✓ receiptFormat        cached #9977ae58
    ✓ subtotalWorks        cached #0086fa0c
    ✓ totalAddsFee         cached #ad9cdf59
  changes: +1 added, ~0 changed, -1 removed
  tests: 9 total — 0 ran, 9 served from cache

ACCEPTED — atomic swap: live is now ns#21a90592


────────────────────────────────────────────────────────
## 8. A non-terminating test fails the gate instead of hanging it

$ cairn update examples/v7-loop.cairn
impact of examples/v7-loop.cairn:
  + settle  #451715cf  new
  + settleTerminates  #de485894  new

tests: running 1 now, 9 cached
    ✗ settleTerminates     RAN 9.54ms — stack overflow (possible infinite recursion)  (new test)
  1 test(s) failing (settleTerminates): staged, but deploy will refuse until they pass
coverage: 67% of changed definitions (2/3 units)
  settle (2/3): 'if n == 0' never true
dev is now ns#e9822ee3

$ cairn deploy
deploy: dev ns#e9822ee3 → live (currently ns#21a90592)
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #832eaa71
    ✓ feeIsOnePercent      cached #e1603cc4
    ✓ lambdaInferred       cached #340f629b
    ✓ minFeeApplies        cached #11f65d3e
    ✓ parity               cached #7ec94329
    ✓ receiptFormat        cached #9977ae58
    ✗ settleTerminates     cached #de485894
    ✓ subtotalWorks        cached #0086fa0c
    ✓ totalAddsFee         cached #ad9cdf59
  changes: +2 added, ~0 changed, -0 removed
  tests: 10 total — 0 ran, 10 served from cache

REJECTED — 1 test(s) failed: settleTerminates. live unchanged at ns#21a90592.


────────────────────────────────────────────────────────
## 9. Roll live back to the previous version

$ cairn rollback
rolled back live: ns#21a90592 → ns#e93af1a0

$ cairn eval fee({ qty: 1, price: 1 })
1 : number

$ cairn status
definitions in store: 32
dev:  ns#e9822ee3  (19 names)
live: ns#e93af1a0  (17 names)
deploy history: 1 previous version(s); cached test results: 17

```
