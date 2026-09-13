# PHASE LEDGER — WHAT IS ACTUALLY BUILT

**Maintained by:** Agent 01 (CEO) · **Opened:** 2026-09-13
**Authority:** Charter C-1. No entry here is accepted without a reproducible command
beside it. A phase is not marked done because code exists (C-7); it is marked done
when its exit gate can be demonstrated.

This ledger exists because `02_MASTER_ROADMAP.md` describes intended order and has
nowhere to record achieved state. Without it, every claim about progress lives only in
conversation, which is not evidence and does not survive a session.

---

## 0. GATE RESOLUTION

`02_MASTER_ROADMAP.md` was issued **⛔ BLOCKED**, pending an owner decision between
PATH 1 / 2 / 3.

**Resolved:** the owner selected **PATH 2 — authorised ground-up build**, which
explicitly overrides brief §0 ("DO NOT REBUILD THE GAME FROM SCRATCH"). §0 is
unsatisfiable in any case: `00_CEO_AUDIT_FINDING.md` establishes that the repository
contained one 20-byte `README.md` and nothing to preserve.

**Evidence standard set by the owner at the same time:** the §10 figures
(49 files / ~13,251 lines / the named suite scores) are **targets to genuinely reach**,
not claims to be repeated. No score is reported here unless the suite executes and
passes under a command given in the same row.

Phases A–L are therefore **unblocked and in execution**.

---

## 1. BASELINE — Phase 0

| Step | Status | Evidence |
|---|---|---|
| 0.1 Source of truth | ✅ CLOSED | Owner selected PATH 2 |
| 0.2a Harness-first | ✅ CLOSED | `bash run.sh` discovers and runs 12 suites |
| 0.2b Architecture lock | ✅ CLOSED | Three.js r186 vendored; ES modules; zero runtime dependency; all assets procedural |
| 0.3 True baseline | ✅ CLOSED | table in §2 below |
| 0.4 Performance baseline | 🟡 PARTIAL | telemetry is measured per frame (`game.diagnostics()`); no §24 ledger yet |
| 0.5 Domain audits | 🟡 PARTIAL | audits are being filed as phases close, not all 17 up front |
| Canon lock | ✅ CLOSED | `bash lint.sh` enforces prohibited names and all 8 canonical characters |

Reproduce the whole baseline:

```
bash lint.sh        # → LINT PASS, errors=0
bash run.sh         # → BASELINE: PASS, suites: 12
```

---

## 2. TEST BASELINE AS MEASURED

Every number below is the suite's own reported score, from
`node tests/<file>` on commit `9a44669`.

| Suite | Score | Command |
|---|---|---|
| verify.mjs | 38/38 PASS | `node tests/verify.mjs` |
| run-deep.mjs | 67/67 PASS | `node tests/run-deep.mjs` |
| movement-test.mjs | 38/38 PASS | `node tests/movement-test.mjs` |
| camera-test.mjs | 40/40 PASS | `node tests/camera-test.mjs` |
| combat-test.mjs | 98/98 PASS | `node tests/combat-test.mjs` |
| input-test.mjs | 57/57 PASS | `node tests/input-test.mjs` |
| ai-test.mjs | 79/79 PASS | `node tests/ai-test.mjs` |
| reach-test.mjs | 22/22 PASS | `node tests/reach-test.mjs` |
| runtime-test.mjs | 98/98 PASS | `node tests/runtime-test.mjs` |
| playthrough.mjs | 14/14 PASS | `node tests/playthrough.mjs` |
| cinematic-test.mjs | 35/35 PASS | `node tests/cinematic-test.mjs` |
| audio-test.mjs | 62/62 PASS | `node tests/audio-test.mjs` |
| **TOTAL** | **648/648 PASS** | `bash run.sh` |

Two shared helpers are imported by the suites and deliberately declare no tests, so
`run.sh` skips them by the `*harness.mjs` naming rule: `game-harness.mjs` (boot and
frame stepping) and `audio-harness.mjs` (a WebAudio-shaped recorder). A helper that
was discovered as a suite would print a green line measuring nothing, which is worse
than no line.

Prior baseline, for change tracking: 584 tests across 11 suites at commit `2f4c44d`.
The delta is audio-test.mjs (62) plus runtime-test VIII9 and VIII10 (2).

---

## 3. BUILD SCALE AS MEASURED

| Measure | Value | Command |
|---|---|---|
| Source and test files | 53 | `bash lint.sh` reports "files checked" |
| Authored lines | ~35,934 | `find src tests tools index.html run.sh lint.sh -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.html' -o -name '*.sh' \) \| xargs wc -l` |
| `src/` modules | 36 | `find src -name '*.js' \| wc -l` |

`vendor/three/` is excluded from every figure above, per the brief.

Against the §10 target of ~49 files / ~13,251 lines this is **over** on both. Line
count is not a quality measure and is recorded only because the brief named it; the
density that matters is in §4.

---

## 4. CONTENT SCALE AS MEASURED

All figures read from the content modules, which are the single source. Reproduce with
`node tests/verify.mjs` and `node tests/playthrough.mjs`, which assert them.

| Item | Brief target | Built | Source |
|---|---|---|---|
| Chapters | Prologue + 6 + Epilogue = 8 | **8** | `CHAPTERS` in `src/content/story.js` |
| Missions | 11 | **11** | `MISSIONS` |
| Dialogue trees | 14 | **14** | `DIALOGUE_TREES` in `src/content/dialogue.js` |
| Clues | 10 | **10** | `CLUES` |
| Cinematics | 9 | **9** | `CINEMATICS` |
| Named characters | 7 family + Layla | **10** cast, **9** minor roles | `CHARACTERS`, `MINOR_ROLES` |
| Regions | — | **20** | `REGIONS` in `src/content/world-data.js` |
| Landmarks | — | **142** | `LANDMARKS` |
| Materials | — | **26** | `MATERIALS` |

Canon is enforced by `bash lint.sh`, which fails on any prohibited name
(رسلان / سامر / مالك) and on the absence of any canonical character. The historical
gate scans 31 rejected medieval-European and modern terms.

---

## 5. PHASE STATUS (§31 ORDER)

Status is the exit gate, not the existence of code.

| Phase | Gate | Status | Evidence / gap |
|---|---|---|---|
| **A** AI and enemy behaviour | AI never cheats; perception, memory, flanking, retreat verified | 🟢 SUBSTANTIALLY MET | `ai-test` 79/79. Perception truth carries the real noise radius (`main.js._buildTruth`); hearing verified end to end by runtime-test IX6/IX7. The AI reads only `truth`, never player state. |
| **B** Input / gamepad | full gamepad navigation; no lag, sliding or unwanted drift | 🟢 SUBSTANTIALLY MET | `input-test` 57/57; runtime VIII2–VIII4 cover the touch surface. Gamepad poller wired in `core/input.js`. |
| **C** Real bow / projectile | bow fires a true projectile — travel, drop, impact | 🔴 **NOT BUILT** | `PROJ` constants exist and are referenced by nothing: `grep -rn "PROJ\." src/` returns no hits. `main.js` tracks `aiming` / `drawing` intent with no system consuming it. Three audio cues are marked pending on this. |
| **D** Finisher & contextual combat camera | zero geometry penetration; no violent snap | 🟢 SUBSTANTIALLY MET | `camera-test` 40/40, `cinematic-test` 35/35. Finisher gates in `combat.js`; `PlayerState.FINISHER` with invulnerability in `player.js`. |
| **E** Fall / ledge systems | fall damage and ledge grab functional; vertical traversal tested | 🟢 SUBSTANTIALLY MET | `movement-test` 38/38. `PLAYER_LANDED`, `PLAYER_LEDGE_GRAB`, authored light/heavy landing noise split at `FALL_DAMAGE_SAFE_HEIGHT`. |
| **F** Character visual quality | distinct faces and silhouettes; historical clothing; no placeholders | 🟡 PARTIAL | `render/characters.js` builds a proportioned rig with beard, silhouette and stride. **Not screenshot-verified**, which the gate requires. The brief's 22 distinct models are not built; the rig is parameterised over the cast. |
| **G** World visual & historical authenticity | dense, purposeful, believable; no European/Gothic/modern elements | 🟡 PARTIAL | 20 regions, 142 landmarks, 26 materials. Historical vocabulary gate passes in `lint.sh`. Visual density is not independently reviewed. |
| **H** Mission / story polish | all chapters, missions, trees, clues and cinematics completable | 🟢 SUBSTANTIALLY MET | `playthrough` 14/14, `cinematic-test` 35/35. All §4 content counts reached. Objectives defer completion until a cinematic has actually run. |
| **I** UI / UX / audio / localisation | Arabic complete and RTL correct; instant switching; no major missing audio; music transitions | 🟢 SUBSTANTIALLY MET | Arabic is the default and RTL-first. Language switching is instant and re-renders every `data-i18n` node. **Audio closed 2026-09-13** — see §6. runtime VIII10 now proves every key exists in both languages. |
| **J** Performance | §24 ledger within budget; every optimisation reports BEFORE/AFTER/CHANGE %/QUALITY IMPACT | 🟡 PARTIAL | Per-frame telemetry is measured and exposed. No optimisation has yet been performed, so no BEFORE/AFTER rows exist to report. |
| **K** Full QA | all regression suites pass; Level 3 playthrough; §25 reliability matrix | 🟡 PARTIAL | 648/648 across 12 suites. The §25 reliability matrix is not yet written. |
| **L** Release preparation | §36 Final Release Gate — all ten blocks green | 🔴 NOT STARTED | Certifies a frozen build. C and F are open. |

Standing: **Agent 16 (save / reliability)** runs continuously, not as a phase. Save and
load are exercised in `runtime-test` against a real in-memory backend.

---

## 6. PHASE I — AUDIO, CLOSED 2026-09-13

Commit `9a44669`. Three modules under `src/audio/`, wired through `main.js` and
`index.html`.

| Deliverable | Evidence |
|---|---|
| Nothing fetched, decoded or shipped | `grep -rn "fetch\|decodeAudioData\|new Audio(" src/audio/` returns no hits |
| Six maqamat with quarter-tone degrees | audio-test A1, A2 |
| Tension drives mode, metre, tempo and layers | audio-test A3, A4, C10, C11 |
| 36-cue catalogue, every one reachable | audio-test A10, C2 |
| Voice budget steals the quietest rather than clipping | audio-test B6, B7, B8 |
| Footsteps derived from one noise radius, two consumers | audio-test A8, A9, C5, C6 |
| Ambience for all 20 regions, weather masking matching the AI | audio-test A12, B11, B12, C12, C13 |
| AudioContext created on a gesture, resumed there | audio-test B2, D2 |
| Silence is a supported configuration, not an error | audio-test B1, C20, D1 |
| Mix faders and mute in the pause menu, persisted | `index.html` `#faders`, `AUDIO_KEY` |

Seven cues are declared **pending** rather than left as dead data, each with the reason
recorded in `MANUAL_CUES`: three await the bow (phase C), two await the investigation
board, one awaits stealth takedown emission, one awaits AI vocalisation. Reproduce the
accounting with audio-test C2, which fails if any cue becomes unreachable without a
decision being recorded.

Seven defects were found while writing the suite and are listed in the commit message.
Two deserve restating here because both would have shipped silently:

1. **The scheduler dropped three of every four drum strikes.** The lookahead (0.35 s)
   was shorter than a maqsoum cycle (3.9 s), so a cycle was expanded, only the strikes
   inside the window were placed, and the cursor moved past the rest. The symptom is a
   drum playing a metre nobody wrote — musical, not an error, so nothing reports it.
2. **`index.html` read `isTouch` at module scope several hundred lines above its
   declaration.** A `const` in the temporal dead zone is a ReferenceError during module
   evaluation, before `boot()` runs: a title, a progress bar that never moves, and
   nothing printed, because the script that would have printed it is the one that died.
   Every existing page-integrity check passed, because the page is structurally fine and
   merely cannot run. This is now covered by runtime-test **VIII9**, whose teeth were
   verified by reintroducing the bug and confirming three violations were reported.

---

## 7. OPEN BLOCKERS

Ordered by charter C-4 (player experience first) and C-10 (no P3 while a P0/P1 is open).

| # | Priority | Item | Why it blocks |
|---|---|---|---|
| 1 | **P1** | Phase C — no bow or projectile system | The gate requires a true projectile, not long-reach melee. `aiming` and `drawing` intent are sampled every frame and consumed by nothing, so the player can hold a button that does nothing. Three authored audio cues wait on it. |
| 2 | **P1** | Phase F — no visual verification | The gate requires screenshot verification and distinct faces. Nothing has been looked at. A rig that is correct in arithmetic and wrong on screen passes every suite written so far. |
| 3 | **P2** | Phase J — no §24 metric ledger | Performance claims cannot be made without a BEFORE row, and no optimisation has been attempted, so there is no BEFORE to record. |
| 4 | **P2** | Phase K — no §25 reliability matrix | Full QA cannot certify against a matrix that does not exist. |
| 5 | **P2** | Investigation board not built | Two audio cues and the traitor's proof-of-method surface wait on it. The 10 clues are collectable; nothing links them. |

---

*— Agent 01, CEO / Executive Director*
