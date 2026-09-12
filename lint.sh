#!/usr/bin/env bash
# THE BETRAYED WILL — static lint (§22: `bash lint.sh` must PASS)
#
# Zero-dependency linter. There is no ESLint in this project because §8 forbids
# external runtime dependencies and the build must work offline, so the rules
# that matter are enforced here directly:
#
#   1. every JS/MJS file parses (node --check)
#   2. no file mixes tabs and spaces for indentation
#   3. no trailing whitespace
#   4. no `debugger` statements
#   5. no `console.log` in src/ (diagnostics must go through src/core/diagnostics.js)
#   6. the simulation layer never imports Three.js or touches the DOM — this is
#      the architectural invariant that keeps the whole game headless-testable
#   7. no forbidden canon names (§4: رسلان / سامر / مالك)
#   8. no historically rejected vocabulary in world/asset data (§26)
#   9. no `TODO`/`FIXME` without an owner tag
#  10. every module resolves (import graph is loadable)

set -uo pipefail
cd "$(dirname "$0")" || exit 1

COLOR=1
[ -t 1 ] || COLOR=0
red()   { [ "$COLOR" = 1 ] && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
green() { [ "$COLOR" = 1 ] && printf '\033[32m%s\033[0m' "$1" || printf '%s' "$1"; }
dim()   { [ "$COLOR" = 1 ] && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
bold()  { [ "$COLOR" = 1 ] && printf '\033[1m%s\033[0m' "$1" || printf '%s' "$1"; }

ERRORS=0
WARNINGS=0
CHECKED=0

err()  { ERRORS=$((ERRORS + 1));  printf '  %s %s\n' "$(red '✗')" "$1"; }
warn() { WARNINGS=$((WARNINGS + 1)); printf '  %s %s\n' "$(dim '!')" "$1"; }
ok()   { printf '  %s %s\n' "$(green '✓')" "$1"; }

# Collect source files. vendor/ is excluded: Three.js is a vendored third-party
# artefact and is not subject to this project's style rules (or line counts).
mapfile -t FILES < <(find src tests tools -type f \( -name '*.js' -o -name '*.mjs' \) 2>/dev/null | sort)

printf '\n%s\n' "$(bold 'THE BETRAYED WILL — lint')"
printf '%s\n' "$(dim '────────────────────────────────────────────────────────────────')"
printf '  %s\n' "$(dim "files in scope: ${#FILES[@]} (vendor/ excluded)")"

# ---------------------------------------------------------------- 1. syntax
SYNTAX_FAIL=0
for f in "${FILES[@]}"; do
  CHECKED=$((CHECKED + 1))
  if ! OUT=$(node --check "$f" 2>&1); then
    SYNTAX_FAIL=1
    err "syntax: $f"
    printf '      %s\n' "$(dim "$(printf '%s' "$OUT" | head -4)")"
  fi
done
[ "$SYNTAX_FAIL" -eq 0 ] && ok "syntax: all ${CHECKED} files parse"

# ------------------------------------------------------- 2. tabs vs spaces
MIXED=$(grep -rlP '^\t+ ' --include='*.js' --include='*.mjs' src tests tools 2>/dev/null || true)
TABBED=$(grep -rlP '^\t' --include='*.js' --include='*.mjs' src tests tools 2>/dev/null || true)
if [ -n "$MIXED$TABBED" ]; then
  for f in $MIXED $TABBED; do err "indentation uses tabs: $f"; done
else
  ok "indentation: spaces only, no mixing"
fi

# --------------------------------------------------- 3. trailing whitespace
TRAIL=$(grep -rln ' $' --include='*.js' --include='*.mjs' src tests tools 2>/dev/null || true)
if [ -n "$TRAIL" ]; then
  for f in $TRAIL; do err "trailing whitespace: $f"; done
else
  ok "no trailing whitespace"
fi

# --------------------------------------------------------- 4. debugger stmt
DBG=$(grep -rn '^\s*debugger\b' --include='*.js' --include='*.mjs' src tests tools 2>/dev/null || true)
if [ -n "$DBG" ]; then
  while IFS= read -r line; do err "debugger statement: $line"; done <<< "$DBG"
else
  ok "no debugger statements"
fi

# ------------------------------------------------- 5. console.log inside src
CLOG=$(grep -rn 'console\.log' --include='*.js' src 2>/dev/null | grep -v 'diagnostics.js' || true)
if [ -n "$CLOG" ]; then
  while IFS= read -r line; do err "console.log in src (use diagnostics): $line"; done <<< "$CLOG"
else
  ok "no stray console.log in src/"
fi

# --------------------------------------- 6. simulation layer purity (CRITICAL)
# This is the architectural invariant the entire test strategy depends on.
PURE_DIRS=(src/core src/sim src/content)
PURITY_FAIL=0
for d in "${PURE_DIRS[@]}"; do
  [ -d "$d" ] || continue
  # NOTE: POSIX ERE has no lookahead, so the previous `\bwindow\.(?!location)`
  # branch never matched anything at all - the window check was silently dead
  # here while the same check in verify.mjs was over-matching English prose.
  # Both now require an identifier character after the dot, which matches real
  # DOM access and not a sentence ending in "window.". tests/verify.mjs pins the
  # sensitivity of this pattern with positive and negative controls.
  HITS=$(grep -rnE "from '[^']*vendor/three|from \"[^\"]*vendor/three|from 'three'|require\('three'\)|\bdocument\.[A-Za-z_\$]|\bwindow\.[A-Za-z_\$]|\blocalStorage\b|\bHTMLElement\b|\bnavigator\.getGamepads" \
        --include='*.js' "$d" 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    PURITY_FAIL=1
    while IFS= read -r line; do err "purity violation in $d: $line"; done <<< "$HITS"
  fi
done
if [ "$PURITY_FAIL" -eq 0 ]; then
  ok "simulation purity: core/sim/content never import Three.js or DOM APIs"
else
  err "simulation purity FAILED — the whole headless test strategy depends on this invariant"
fi

# ------------------------------------------------------ 7. forbidden canon
# §4: the obsolete names must not appear anywhere in source or data.
CANON_FAIL=0
for name in 'رسلان' 'سامر' 'مالك'; do
  HITS=$(grep -rn -- "$name" --include='*.js' --include='*.mjs' --include='*.json' --include='*.html' src tests index.html 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    CANON_FAIL=1
    while IFS= read -r line; do err "forbidden obsolete canon name '$name': $line"; done <<< "$HITS"
  fi
done
if [ "$CANON_FAIL" -eq 0 ]; then
  ok "canon: no obsolete names (رسلان / سامر / مالك) present"
else
  err "canon FAILED — §4 forbids these names anywhere in source or data"
fi

# Verify every canonical family name actually appears somewhere in content.
CANONICAL=(Orin Raynor Novan Zafir Kyle Eleric Evan Layla)
MISSING_CANON=0
for name in "${CANONICAL[@]}"; do
  if ! grep -rq "$name" --include='*.js' src/content 2>/dev/null; then
    MISSING_CANON=1
    err "canonical character '$name' not found in src/content"
  fi
done
if [ "$MISSING_CANON" -eq 0 ]; then
  ok "canon: all 8 canonical characters present in content data"
else
  err "canon FAILED — every canonical family member must appear in content"
fi

# --------------------------------------- 8. historically rejected vocabulary
# §26 gate. Reject accidental European-medieval / modern aesthetics in data.
# Single source of truth: the term list is read out of the module that declares
# it, so lint.sh and validateWorldData() can never disagree about what is banned.
# If that import fails the gate FAILS rather than passing vacuously.
VOCAB_DECL='src/content/vocabulary.js'
REJECTED=()
while IFS= read -r t; do [ -n "$t" ] && REJECTED+=("$t"); done < <(
  node -e "import('./' + process.argv[1]).then(m => { for (const t of m.REJECTED_TERMS) process.stdout.write(t + '\\n'); }, () => process.exit(1));" "${VOCAB_DECL}" 2>/dev/null
)
if [ "${#REJECTED[@]}" -eq 0 ]; then
  err "historical gate could not load REJECTED_TERMS from ${VOCAB_DECL} — the gate would pass vacuously"
fi
# ${VOCAB_DECL} IS the declaration of the banned vocabulary, so it necessarily
# contains it. Excluded by exact path only — a rejected term anywhere else still
# fails the build.
HIST_FAIL=0
for term in "${REJECTED[@]}"; do
  HITS=$(grep -rni -- "$term" --include='*.js' src/content src/assets 2>/dev/null \
         | grep -v "^${VOCAB_DECL}:" || true)
  if [ -n "$HITS" ]; then
    HIST_FAIL=1
    while IFS= read -r line; do err "historically rejected term '$term': $line"; done <<< "$HITS"
  fi
done
if [ "$HIST_FAIL" -eq 0 ]; then
  ok "historical gate: no rejected medieval-European/modern vocabulary in content (${#REJECTED[@]} terms scanned)"
else
  err "historical gate FAILED — §26 requires a Babylonian/Mesopotamian material world"
fi

# ------------------------------------------------- 9. TODO without an owner
TODO=$(grep -rnE '//\s*(TODO|FIXME|XXX|HACK)(?!\()' --include='*.js' --include='*.mjs' src tests 2>/dev/null | grep -vE '(TODO|FIXME|XXX|HACK)\([A-Za-z0-9 _-]+\)' || true)
if [ -n "$TODO" ]; then
  TODO_HEAD=$(printf '%s\n' "$TODO" | head -20)
  while IFS= read -r line; do warn "unowned TODO: $line"; done <<< "$TODO_HEAD"
else
  ok "no unowned TODO/FIXME markers"
fi

# ------------------------------------------- 10. import graph actually loads
LOAD_STATUS=0
LOAD_OUT=$(node --input-type=module -e "
const files = process.argv.slice(1);
let failed = 0;
for (const f of files) {
  try { await import('file://' + process.cwd() + '/' + f); }
  catch (e) { failed++; console.error('LOAD FAIL ' + f + ': ' + (e && e.message)); }
}
process.exit(failed ? 1 : 0);
" "${FILES[@]}" 2>&1) || LOAD_STATUS=$?
if [ "$LOAD_STATUS" -ne 0 ]; then
  LOAD_FAILS=$(printf '%s\n' "$LOAD_OUT" | grep 'LOAD FAIL' || true)
  while IFS= read -r line; do err "$line"; done <<< "$LOAD_FAILS"
else
  ok "import graph: every module loads without error"
fi

# Constant-reference audit. Every `GROUP.KEY` in src/tests/tools must resolve in
# constants.js. A missing key is not a syntax error and not a lint error in any
# conventional sense: it reads as `undefined` at runtime and silently becomes
# NaN, which is exactly how the finisher camera shipped emitting a non-finite
# position on every execution. Checked here so the class of bug is unshippable.
CONST_STATUS=0
CONST_OUT=$(node tools/const-audit.mjs 2>&1) || CONST_STATUS=$?
if [ "$CONST_STATUS" -ne 0 ]; then
  while IFS= read -r line; do [ -n "$line" ] && err "$line"; done \
    <<< "$(printf '%s\n' "$CONST_OUT" | grep 'MISSING' || true)"
else
  ok "constant references: $(printf '%s\n' "$CONST_OUT" | grep -oE 'checked [0-9]+ constant references across [0-9]+ files' | head -1) - all resolve"
fi

printf '%s\n' "$(dim '────────────────────────────────────────────────────────────────')"
printf '  files checked: %s   errors: %s   warnings: %s\n' "$CHECKED" "$ERRORS" "$WARNINGS"
if [ "$ERRORS" -eq 0 ]; then
  printf '  %s\n' "$(green "$(bold 'LINT PASS')")"
  printf 'RESULT lint PASS errors=0 warnings=%s\n' "$WARNINGS"
  exit 0
else
  printf '  %s\n' "$(red "$(bold 'LINT FAIL')")"
  printf 'RESULT lint FAIL errors=%s warnings=%s\n' "$ERRORS" "$WARNINGS"
  exit 1
fi
