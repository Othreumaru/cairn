# Cairn demo transcript

Output of `sh examples/demo.sh`. Source files for each step are in `examples/`.

```text

────────────────────────────────────────────────────────
## 1. Load v1 and deploy it (every test is new, so all run)

$ cairn update examples/v1.cairn
impact of examples/v1.cairn:
  + subtotal  #e4d86384  new
  + fee  #65426a48  new
  + total  #ab5b7c78  new
  + receipt  #cfc0c092  new
  + applyTwice  #7466041e  new
  + fact  #44e16842  new
  + isEven  #e325cd66  new
  + isOdd  #7cd1bb8d  new
  + subtotalWorks  #0086fa0c  new
  + feeIsOnePercent  #81ad3d13  new
  + totalAddsFee  #0dc58c04  new
  + receiptFormat  #b6176d24  new
  + extraFieldsOk  #398df5d5  new
  + lambdaInferred  #340f629b  new
  + factorial  #f27e85cb  new
  + parity  #99a19c70  new

tests: 8 will run on next deploy (extraFieldsOk, factorial, feeIsOnePercent, lambdaInferred, parity, receiptFormat, subtotalWorks, totalAddsFee), 0 cached
dev is now ns#4a7260c9

$ cairn deploy
deploy: dev ns#4a7260c9 → live (currently (empty))
  gate:
    ✓ extraFieldsOk        RAN 0.27ms  (new test)
    ✓ factorial            RAN 0.14ms  (new test)
    ✓ feeIsOnePercent      RAN 0.15ms  (new test)
    ✓ lambdaInferred       RAN 0.03ms  (new test)
    ✓ parity               RAN 0.05ms  (new test)
    ✓ receiptFormat        RAN 0.07ms  (new test)
    ✓ subtotalWorks        RAN 0.01ms  (new test)
    ✓ totalAddsFee         RAN 0.02ms  (new test)
  changes: +16 added, ~0 changed, -0 removed
  tests: 8 total — 8 ran, 0 served from cache

ACCEPTED — atomic swap: live is now ns#4a7260c9


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
  ~ fee  #65426a48 → #de825fb2  body changed, type unchanged
  + minFeeApplies  #3a83cd28  new
  ↻ feeIsOnePercent  #81ad3d13 → #96115fc3  re-checked OK, rehashed (via feeIsOnePercent ← fee)
  ↻ total  #ab5b7c78 → #6e6d57e9  re-checked OK, rehashed (via total ← fee)
  ↻ receipt  #cfc0c092 → #765e6a2a  re-checked OK, rehashed (via receipt ← total ← fee)
  ↻ totalAddsFee  #0dc58c04 → #fab10756  re-checked OK, rehashed (via totalAddsFee ← total ← fee)
  ↻ receiptFormat  #b6176d24 → #abdf62a8  re-checked OK, rehashed (via receiptFormat ← receipt ← total ← fee)

tests: 4 will run on next deploy (feeIsOnePercent, receiptFormat, totalAddsFee, minFeeApplies), 5 cached
dev is now ns#09017f74

$ cairn deploy
deploy: dev ns#09017f74 → live (currently ns#4a7260c9)
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #f27e85cb
    ✓ feeIsOnePercent      RAN 0.40ms  (affected via feeIsOnePercent → fee)
    ✓ lambdaInferred       cached #340f629b
    ✓ minFeeApplies        RAN 0.18ms  (new test)
    ✓ parity               cached #99a19c70
    ✓ receiptFormat        RAN 0.11ms  (affected via receiptFormat → receipt → total → fee)
    ✓ subtotalWorks        cached #0086fa0c
    ✓ totalAddsFee         RAN 0.05ms  (affected via totalAddsFee → total → fee)
  changes: +1 added, ~6 changed, -0 removed
  tests: 9 total — 4 ran, 5 served from cache

ACCEPTED — atomic swap: live is now ns#09017f74


────────────────────────────────────────────────────────
## 4. A typo that type-checks: the deploy gate runs the 4 affected tests and rejects it

$ cairn update examples/v4-bug.cairn
impact of examples/v4-bug.cairn:
  ~ fee  #de825fb2 → #92c138d7  body changed, type unchanged
  ↻ feeIsOnePercent  #96115fc3 → #a53a51ad  re-checked OK, rehashed (via feeIsOnePercent ← fee)
  ↻ total  #6e6d57e9 → #f03bbd07  re-checked OK, rehashed (via total ← fee)
  ↻ minFeeApplies  #3a83cd28 → #a9771d4d  re-checked OK, rehashed (via minFeeApplies ← fee)
  ↻ receipt  #765e6a2a → #aa721ca4  re-checked OK, rehashed (via receipt ← total ← fee)
  ↻ totalAddsFee  #fab10756 → #e56c09af  re-checked OK, rehashed (via totalAddsFee ← total ← fee)
  ↻ receiptFormat  #abdf62a8 → #8ff237cc  re-checked OK, rehashed (via receiptFormat ← receipt ← total ← fee)

tests: 4 will run on next deploy (feeIsOnePercent, receiptFormat, totalAddsFee, minFeeApplies), 5 cached
dev is now ns#4151161b

$ cairn deploy
deploy: dev ns#4151161b → live (currently ns#09017f74)
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #f27e85cb
    ✗ feeIsOnePercent      RAN 0.40ms — evaluated to false  (affected via feeIsOnePercent → fee)
    ✓ lambdaInferred       cached #340f629b
    ✓ minFeeApplies        RAN 0.12ms  (affected via minFeeApplies → fee)
    ✓ parity               cached #99a19c70
    ✗ receiptFormat        RAN 0.18ms — evaluated to false  (affected via receiptFormat → receipt → total → fee)
    ✓ subtotalWorks        cached #0086fa0c
    ✗ totalAddsFee         RAN 0.03ms — evaluated to false  (affected via totalAddsFee → total → fee)
  changes: +0 added, ~7 changed, -0 removed
  tests: 9 total — 4 ran, 5 served from cache

REJECTED — 3 test(s) failed: feeIsOnePercent, receiptFormat, totalAddsFee. live unchanged at ns#09017f74.

$ cairn eval fee({ qty: 100, price: 1 })
1 : number

$ cairn eval --dev fee({ qty: 100, price: 1 })
10 : number


────────────────────────────────────────────────────────
## 5. Revert the typo: the code hashes back to v3, so nothing needs to run

$ cairn update examples/v5-revert.cairn
impact of examples/v5-revert.cairn:
  ~ fee  #92c138d7 → #de825fb2  body changed, type unchanged  [known hash]
  ↻ feeIsOnePercent  #a53a51ad → #96115fc3  re-checked OK, rehashed (via feeIsOnePercent ← fee)  [known hash]
  ↻ total  #f03bbd07 → #6e6d57e9  re-checked OK, rehashed (via total ← fee)  [known hash]
  ↻ minFeeApplies  #a9771d4d → #3a83cd28  re-checked OK, rehashed (via minFeeApplies ← fee)  [known hash]
  ↻ receipt  #aa721ca4 → #765e6a2a  re-checked OK, rehashed (via receipt ← total ← fee)  [known hash]
  ↻ totalAddsFee  #e56c09af → #fab10756  re-checked OK, rehashed (via totalAddsFee ← total ← fee)  [known hash]
  ↻ receiptFormat  #8ff237cc → #abdf62a8  re-checked OK, rehashed (via receiptFormat ← receipt ← total ← fee)  [known hash]

tests: 0 will run on next deploy, 9 cached
dev is now ns#09017f74

$ cairn deploy
deploy: dev ns#09017f74 → live (currently ns#09017f74)
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
  ✗ fee  #de825fb2  BROKEN (via fee ← subtotal): in call subtotal(o), argument 1: expected { ccy: string, price: number, qty: number } but got { price: number, qty: number } (missing field ccy)
  ✗ total  #6e6d57e9  BROKEN (via total ← subtotal): in call subtotal(o), argument 1: expected { ccy: string, price: number, qty: number } but got { price: number, qty: number } (missing field ccy)
  ✗ subtotalWorks  #0086fa0c  BROKEN (via subtotalWorks ← subtotal): in call subtotal({ price: 5, qty: 10 }), argument 1: record is missing field(s) 'ccy' required by { ccy: string, price: number, qty: number }
  ↻ feeIsOnePercent  #96115fc3  still type-checks (via feeIsOnePercent ← fee ← subtotal)
  ↻ minFeeApplies  #3a83cd28  still type-checks (via minFeeApplies ← fee ← subtotal)
  ↻ receipt  #765e6a2a  still type-checks (via receipt ← total ← subtotal)
  ↻ totalAddsFee  #fab10756  still type-checks (via totalAddsFee ← total ← subtotal)
  ↻ receiptFormat  #abdf62a8  still type-checks (via receiptFormat ← receipt ← total ← subtotal)

REJECTED — the change breaks the definitions marked ✗. Nothing applied.
Update them in the same file (or keep the old type) and try again.


────────────────────────────────────────────────────────
## 7. Renames are free: same hashes, so every test result is reused

$ cairn rename fee commission
renamed fee → commission (hash #de825fb2 unchanged; no code was touched, no tests need to run)

$ cairn view total
#6e6d57e9  def total(o: { price: number, qty: number }): number = subtotal(o) + commission(o)

$ cairn deploy
deploy: dev ns#fbd3d1b0 → live (currently ns#09017f74)
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #f27e85cb
    ✓ feeIsOnePercent      cached #96115fc3
    ✓ lambdaInferred       cached #340f629b
    ✓ minFeeApplies        cached #3a83cd28
    ✓ parity               cached #99a19c70
    ✓ receiptFormat        cached #abdf62a8
    ✓ subtotalWorks        cached #0086fa0c
    ✓ totalAddsFee         cached #fab10756
  changes: +1 added, ~0 changed, -1 removed
  tests: 9 total — 0 ran, 9 served from cache

ACCEPTED — atomic swap: live is now ns#fbd3d1b0


────────────────────────────────────────────────────────
## 8. A non-terminating test fails the gate instead of hanging it

$ cairn update examples/v7-loop.cairn
impact of examples/v7-loop.cairn:
  + settle  #154f3f53  new
  + settleTerminates  #f366becb  new

tests: 1 will run on next deploy (settleTerminates), 9 cached
dev is now ns#02cbe0d4

$ cairn deploy
deploy: dev ns#02cbe0d4 → live (currently ns#fbd3d1b0)
  gate:
    ✓ extraFieldsOk        cached #398df5d5
    ✓ factorial            cached #f27e85cb
    ✓ feeIsOnePercent      cached #96115fc3
    ✓ lambdaInferred       cached #340f629b
    ✓ minFeeApplies        cached #3a83cd28
    ✓ parity               cached #99a19c70
    ✓ receiptFormat        cached #abdf62a8
    ✗ settleTerminates     RAN 13.68ms — stack overflow (possible infinite recursion)  (new test)
    ✓ subtotalWorks        cached #0086fa0c
    ✓ totalAddsFee         cached #fab10756
  changes: +2 added, ~0 changed, -0 removed
  tests: 10 total — 1 ran, 9 served from cache

REJECTED — 1 test(s) failed: settleTerminates. live unchanged at ns#fbd3d1b0.


────────────────────────────────────────────────────────
## 9. Roll live back to the previous version

$ cairn rollback
rolled back live: ns#fbd3d1b0 → ns#09017f74

$ cairn eval fee({ qty: 1, price: 1 })
1 : number

$ cairn status
definitions in store: 32
dev:  ns#02cbe0d4  (19 names)
live: ns#09017f74  (17 names)
deploy history: 1 previous version(s); cached test results: 17

```
