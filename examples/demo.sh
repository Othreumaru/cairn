#!/usr/bin/env sh
# End-to-end walkthrough. Uses a throwaway state directory so it never touches ./.cairn.
cd "$(dirname "$0")/.."
export CAIRN_HOME="${TMPDIR:-/tmp}/cairn-demo-$$"
C=./cairn

step() { printf '\n────────────────────────────────────────────────────────\n## %s\n\n' "$1"; }
run() { printf '$ cairn %s\n' "$*"; $C "$@"; echo; }

step "1. Load v1 and deploy it (every test is new, so all run)"
run update examples/v1.cairn
run deploy

step "2. Cosmetic edit: reformat, rename parameters, reorder fields — no hash changes"
run update examples/v2-cosmetic.cairn

step "3. Edit one definition; the codebase finds every dependent and re-checks it"
run update examples/v3-min-fee.cairn
run deploy

step "4. A typo that type-checks: the deploy gate runs the 4 affected tests and rejects it"
run update examples/v4-bug.cairn
run deploy
run eval 'fee({ qty: 100, price: 1 })'
run eval --dev 'fee({ qty: 100, price: 1 })'

step "5. Revert the typo: the code hashes back to v3, so nothing needs to run"
run update examples/v5-revert.cairn
run deploy

step "6. An incompatible signature change is rejected before it can even be staged"
run dependents subtotal
run update examples/v6-breaking-type.cairn

step "7. Renames are free: same hashes, so every test result is reused"
run rename fee commission
run view total
run deploy

step "8. A non-terminating test fails the gate instead of hanging it"
run update examples/v7-loop.cairn
run deploy

step "9. Roll live back to the previous version"
run rollback
run eval 'fee({ qty: 1, price: 1 })'
run status

rm -rf "$CAIRN_HOME"
