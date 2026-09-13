#!/usr/bin/env bash
# THE BETRAYED WILL — test runner (§22 required regression baseline)
#
# Usage:
#   ./run.sh                     run every suite in the required order
#   ./run.sh verify.mjs          run one suite by filename
#   ./run.sh verify movement     run suites matching a substring
#   ./run.sh --list              list available suites
#
# Exit code is non-zero if ANY suite fails, so this gates CI and the CEO's
# release-readiness decision. No suite may be deleted to make this pass
# (charter C-5).

set -uo pipefail

cd "$(dirname "$0")" || exit 1

TEST_DIR="tests"

# §22 required regression baseline, in mandated order.
REQUIRED_SUITES=(
  verify.mjs
  run-deep.mjs
  movement-test.mjs
  camera-test.mjs
  combat-test.mjs
  input-test.mjs
  ai-test.mjs
  reach-test.mjs
  runtime-test.mjs
  playthrough.mjs
  battle-test.mjs
)
# battle-test.mjs is appended rather than inserted: the mandated suites keep their
# mandated relative order and nothing is displaced. It is required rather than merely
# additional because it is the only gate that drives combat through the real frame
# loop. combat-test.mjs and ai-test.mjs both call the resolvers directly, which is how
# a game in which nothing resolved a single blow - guards dealing no damage, the player
# dealing none, three required objectives unreachable - passed every suite it had.
# ai-test.mjs and input-test.mjs are additions beyond the seven §22 names, not
# substitutions: the mandated suites keep their mandated relative order, and both
# additions sit between them rather than displacing any.
#
# Enemy AI gets its own gate because §11's "must not cheat" lives there, and is too
# important to be covered incidentally by combat-test. Input gets one for the same
# reason from the other side: a game that cannot be controlled cannot be played at
# all, and its failures are quiet ones - a latched edge reads as twitchy combat, an
# axis that is only written when non-zero reads as drifting, neither of which throws.
# Save STORAGE is folded into run-deep group H, alongside the existing save/mission
# integration tests, because what a save contains and whether it survives a full
# disk are the same question asked at two depths.

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required but was not found on PATH." >&2
  exit 127
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node >= 18 required (found ${NODE_MAJOR})." >&2
  exit 127
fi

list_suites() {
  echo "Required regression baseline (§22):"
  for s in "${REQUIRED_SUITES[@]}"; do
    if [ -f "$TEST_DIR/$s" ]; then echo "  [present] $s"; else echo "  [MISSING] $s"; fi
  done
  echo
  echo "Additional suites:"
  for f in "$TEST_DIR"/*.mjs; do
    base="$(basename "$f")"
    # Any file ending in harness.mjs is imported by suites, never run as one.
    # Matching only the exact name let a second shared helper be discovered as a
    # suite that passes by declaring no tests - a green line measuring nothing.
    case "$base" in *harness.mjs) continue ;; esac
    skip=0
    for s in "${REQUIRED_SUITES[@]}"; do [ "$base" = "$s" ] && skip=1; done
    [ "$skip" -eq 0 ] && echo "  $base"
  done
}

if [ "${1:-}" = "--list" ]; then
  list_suites
  exit 0
fi

run_one() {
  local suite="$1"
  local file="$TEST_DIR/$suite"
  if [ ! -f "$file" ]; then
    echo "──────────────────────────────────────────────────────────────────"
    echo "MISSING SUITE: $suite"
    echo "A required suite is absent. This is a P0 gap, not a pass. (charter C-5)"
    echo "RESULT 0/0 FAIL 0ms"
    return 1
  fi
  node --experimental-vm-modules "$file"
  return $?
}

declare -a TARGETS=()
declare -a RESULTS=()
OVERALL=0

if [ "$#" -eq 0 ]; then
  # Full baseline plus every additional suite.
  for s in "${REQUIRED_SUITES[@]}"; do TARGETS+=("$s"); done
  for f in "$TEST_DIR"/*.mjs; do
    base="$(basename "$f")"
    case "$base" in *harness.mjs) continue ;; esac
    skip=0
    for s in "${REQUIRED_SUITES[@]}"; do [ "$base" = "$s" ] && skip=1; done
    [ "$skip" -eq 0 ] && TARGETS+=("$base")
  done
else
  for arg in "$@"; do
    matched=0
    for f in "$TEST_DIR"/*.mjs; do
      base="$(basename "$f")"
      case "$base" in *harness.mjs) continue ;; esac
      if [ "$base" = "$arg" ] || [ "$base" = "$arg.mjs" ] || [[ "$base" == *"$arg"* ]]; then
        TARGETS+=("$base")
        matched=1
      fi
    done
    if [ "$matched" -eq 0 ]; then
      echo "WARNING: no suite matches \"$arg\"" >&2
      TARGETS+=("$arg.mjs")   # let run_one report it as MISSING
    fi
  done
fi

START_ALL=$(date +%s%3N 2>/dev/null || echo 0)

for suite in "${TARGETS[@]}"; do
  echo
  echo "══════════════════════════════════════════════════════════════════"
  echo " SUITE: $suite"
  echo "══════════════════════════════════════════════════════════════════"
  if run_one "$suite"; then
    RESULTS+=("PASS  $suite")
  else
    RESULTS+=("FAIL  $suite")
    OVERALL=1
  fi
done

END_ALL=$(date +%s%3N 2>/dev/null || echo 0)
ELAPSED=$((END_ALL - START_ALL))

echo
echo "══════════════════════════════════════════════════════════════════"
echo " REGRESSION BASELINE SUMMARY"
echo "══════════════════════════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do
  case "$r" in
    PASS*) echo "  $(printf '%s' "$r")" ;;
    *)     echo "  $(printf '%s' "$r")" ;;
  esac
done

# Explicitly verify every §22 required suite ran.
MISSING=0
for s in "${REQUIRED_SUITES[@]}"; do
  [ -f "$TEST_DIR/$s" ] || { echo "  REQUIRED SUITE ABSENT: $s"; MISSING=1; OVERALL=1; }
done

echo "──────────────────────────────────────────────────────────────────"
echo " suites: ${#TARGETS[@]}   elapsed: ${ELAPSED}ms"
if [ "$OVERALL" -eq 0 ]; then
  echo " BASELINE: PASS"
else
  echo " BASELINE: FAIL"
fi
echo "──────────────────────────────────────────────────────────────────"

exit "$OVERALL"
