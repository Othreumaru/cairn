#!/usr/bin/env sh
# Three instances serving one API; one deploy switches all of them. Uses a throwaway state
# directory and ports 3001-3003.
cd "$(dirname "$0")/.."
export CAIRN_HOME="${TMPDIR:-/tmp}/cairn-serve-demo-$$"
C=./cairn
PIDS=""
cleanup() { [ -n "$PIDS" ] && kill $PIDS 2>/dev/null && wait $PIDS 2>/dev/null; rm -rf "$CAIRN_HOME"; }
trap cleanup EXIT INT TERM

step() { printf '\n## %s\n\n' "$1"; }
greet_all() { for p in 3001 3002 3003; do printf ':%s  ' $p; curl -s -i localhost:$p/greet/ada | tr -d '\r' | grep -i -E '^x-cairn|message' | tr '\n' ' '; echo; done; }

step "1. Stage and deploy v1, then start three instances"
$C update examples/api-v1.cairn
$C deploy | tail -1
for p in 3001 3002 3003; do $C serve --port $p & PIDS="$PIDS $!"; done
sleep 1

step "2. Every instance serves v1"
greet_all
echo
curl -s -X POST localhost:3001/quote -d '{"qty": 1, "price": 1}'
curl -s localhost:3002/accounts/7                                   # passwordHash is not sent
curl -s -X POST localhost:3003/quote -d '{"qty": "one", "price": 1}' # 400 before any Cairn code runs

step "3. Stage v2 (affected tests run now) and deploy it once"
$C update examples/api-v2.cairn
$C deploy | tail -1
sleep 0.3
greet_all
curl -s -X POST localhost:3002/quote -d '{"qty": 1, "price": 1}'
curl -s localhost:3003/version

step "4. Roll back: every instance switches back"
$C rollback
sleep 0.3
greet_all
