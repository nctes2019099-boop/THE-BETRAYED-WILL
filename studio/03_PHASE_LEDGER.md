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
| 0.2a Harness-first | ✅ CLOSED | `bash run.sh` discovers and runs 13 suites |
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
| battle-test.mjs | 58/58 PASS | `node tests/battle-test.mjs` |
| cinematic-test.mjs | 35/35 PASS | `node tests/cinematic-test.mjs` |
| audio-test.mjs | 62/62 PASS | `node tests/audio-test.mjs` |
| **TOTAL** | **706/706 PASS** | `bash run.sh` |

`battle-test.mjs` is a **required** suite, not an additional one. It is the only gate
that drives combat through the real frame loop; the two suites that already covered
melee both call the resolvers directly, and that is precisely how §7's P0 shipped green.

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
| Source and test files | 54 | `bash lint.sh` reports "files checked" |
| Authored lines | ~37,302 | `find src tests tools index.html run.sh lint.sh -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.html' -o -name '*.sh' \) \| xargs wc -l` |
| `src/` modules | 35 | `find src -name '*.js' \| wc -l` |

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
| **D** Finisher & contextual combat camera | zero geometry penetration; no violent snap | 🟢 SUBSTANTIALLY MET | `camera-test` 40/40, `cinematic-test` 35/35, `battle-test` 58/58. Melee, blocking, parry, dodging, lock-on, hitstop, **takedowns and the execution** are all reachable in play and gated. The camera's FINISHER mode is fed a victim and holds a finite position through the whole act (battle-test N3). Was 🟡 for one commit while `canTakedown()` and `canFinisher()` had no call site; see §7.2. |
| **E** Fall / ledge systems | fall damage and ledge grab functional; vertical traversal tested | 🟢 SUBSTANTIALLY MET | `movement-test` 38/38. `PLAYER_LANDED`, `PLAYER_LEDGE_GRAB`, authored light/heavy landing noise split at `FALL_DAMAGE_SAFE_HEIGHT`. |
| **F** Character visual quality | distinct faces and silhouettes; historical clothing; no placeholders | 🟡 PARTIAL | `render/characters.js` builds a proportioned rig with beard, silhouette and stride. **Not screenshot-verified**, which the gate requires. The brief's 22 distinct models are not built; the rig is parameterised over the cast. |
| **G** World visual & historical authenticity | dense, purposeful, believable; no European/Gothic/modern elements | 🟡 PARTIAL | 20 regions, 142 landmarks, 26 materials. Historical vocabulary gate passes in `lint.sh`. Visual density is not independently reviewed. |
| **H** Mission / story polish | all chapters, missions, trees, clues and cinematics completable | 🟢 SUBSTANTIALLY MET | `playthrough` 14/14, `cinematic-test` 35/35, `battle-test` 58/58. All §4 content counts reached; objectives defer completion until a cinematic has actually run. **Every required objective in the story is now satisfiable from play** — battle-test J4 asserts an empty blocked list and counts the six event-driven objectives it is checking. Was 🟡 for one commit while m11/o5 was open; see §7. |
| **I** UI / UX / audio / localisation | Arabic complete and RTL correct; instant switching; no major missing audio; music transitions | 🟢 SUBSTANTIALLY MET | Arabic is the default and RTL-first. Language switching is instant and re-renders every `data-i18n` node. **Audio closed 2026-09-13** — see §6. runtime VIII10 now proves every key exists in both languages. |
| **J** Performance | §24 ledger within budget; every optimisation reports BEFORE/AFTER/CHANGE %/QUALITY IMPACT | 🟡 PARTIAL | Per-frame telemetry is measured and exposed. No optimisation has yet been performed, so no BEFORE/AFTER rows exist to report. |
| **K** Full QA | all regression suites pass; Level 3 playthrough; §25 reliability matrix | 🟡 PARTIAL | 706/706 across 13 suites. The §25 reliability matrix is not yet written. |
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

**Six** cues are declared **pending** rather than left as dead data, each with the reason
recorded in `MANUAL_CUES`: three await the bow (phase C), two await the investigation
board, one awaits AI vocalisation. The seventh — `takedown` — was closed on 2026-09-13
when stealth takedowns became performable; see §7.2. Reproduce the
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

## 7. COMBAT RESOLUTION — P0, CLOSED 2026-09-13

Found while starting phase C, and it outranked it: **nothing in the running game
resolved a blow.** `resolveMelee()` and `AISquad.resolveAttacks()` were both complete
and both unit-tested, and `main.js` called neither. Guards swung, animated, emitted
`COMBAT_ATTACK` and rolled their cooldowns, and dealt no damage. The player swung and
dealt no damage. Falling was the only damage path that ran. `EventKind.KILL` was never
notified, so three non-optional COMBAT objectives — m06/o5 (2 kills), m10/o3 (3),
m11/o2 (1) — could never move, and the story could not be finished.

Every suite passed while this was true. `combat-test` calls the resolver; `ai-test`
calls `resolveAttacks()`; `playthrough` walks the story through `StoryDirector`, which
synthesises the events it needs to prove the story is *solvable*. Solvable it was.
Playable it was not, and no test distinguished the two.

| Wired | How |
|---|---|
| Blows resolve in both directions | `main.js._resolveCombat()`, called last in `_fixedUpdate` so a swing is judged against this frame's positions, through the one `resolveMelee()` |
| The player's swing picks a target | `_pickStrikeTarget()` — a selection, not a second reach test. `resolveMelee()` consumes a swing on the first defender it touches, so iterating the crowd in array order hits whoever is first, not whoever was faced |
| Kills reach the story | `missions.notify({ kind: EventKind.KILL, id })` |
| Impact freeze | `hitstopActive()` scales the world to `HITSTOP_TIME_SCALE`; `advanceHitstop()` runs on **real** dt. Scaling the timer by the factor it scales the world with makes the freeze permanent, because the clock that ends it is the clock it slows |
| Lock-on | `_updateLockOn()` sets `player.lockTarget`, which the camera (`CameraMode.LOCKED`) and the turn rate (`MOVE.TURN_RATE_LOCKED`) already read and could never reach |
| A fight is heard | `_worldNoise()` at `STEALTH.NOISE_COMBAT_HIT` / `NOISE_BODY_FALL`, routed by position through `squad.notifyAll('alarm')`, emitted `local: false` |
| Arriving somewhere | `setRegion()` now notifies `EventKind.REGION`. Three GOTO objectives name a region rather than a landmark — m07/o5, m09/o4, m11/o3 — and a region change that notified nothing left two of them permanently incomplete |
| Leaving under pursuit | `setRegion()` notifies `EventKind.ESCAPE` for the region being left, judged **before** `_populateAgents()` replaces the squad. This unblocks m07/o1 and m07/o3 |

Two things were deliberately not folded together. A blow's noise is sent to nearby
agents by position and is *not* added to the player's own `noiseRadius` latch: feeding
both would make every agent in the region hear one sword hit twice and raise suspicion
twice as fast as authored, which is the AI cheating by double-counting. And hitstop
scales the world but not its own timer, for the reason in the table.

### 7.1 The last objective, closed the same day

The combat P0 exposed a second gap of the same shape: `EventKind.RETURN` was only ever
produced by `StoryDirector`, so **m11/o5 — "read the true will aloud", the last required
objective of the last mission — could not be completed by playing.** `playthrough` passed
throughout, because the director synthesises the events it needs.

RETURN is the one objective type whose target is a thing the player carries rather than a
place, so the place has to come from somewhere else, and hardcoding "at Layla's hearth"
would put m11 in the code. It is derived instead: `MissionManager#presentationPlace()`
walks back through the mission's own objectives to the nearest preceding **required** beat
that names a landmark, and `DIALOGUE_MAP` already records which landmark each tree is
staged at. For m11 that is o4, the hearth conversation, so the reading resolves to
`lm-ll-hearth` from authored data. Nothing in `mission.js` knows m11 exists.

Three rules make it a scene rather than a loophole, each with a test that fails without
it: the beat the place came from must be **complete** (the reading follows the
conversation, L4); the player must be **carrying** the document (L5); and the landmark
must be **that** one (L3 — the loom, the table and the chest in the same room offer
nothing).

`presentationAt()` is public because the prompt needs it. A hearth that keeps saying
"Talk" after the conversation is over is a hearth nobody reads at, so the verb becomes
"اقرأ جهارًا / Read aloud" — which exposed a third defect: `_publishPrompt()` compared
only `id` and `kind`, so a verb change at the same landmark was swallowed and the HUD
would have kept the stale text forever (L6).

`battle-test.mjs` (45 tests, 7 groups) was written against this. Group E drives a booted
`Game` and a real button press rather than calling the resolver — the only form of the
test that could have caught the bug. Group J generalises it: every combat export and
every mission event kind must have a call site in `src/`, or be named in a pending list
with a reason. It splits `mission.js` at `#satisfy()` to tell the manager API the game
calls from the autopilot that plays the story for it, which is the distinction whose
absence let this ship.

---

### 7.2 Takedowns, executions, and the third instance of the same bug

`canTakedown()` and `canFinisher()` were the two combat gates with no call site, named as
pending by battle-test J2 the moment that audit existed. Both are wired now:

| | |
|---|---|
| **Takedown** | Offered by the interaction prompt — the same key as everything else, because a takedown is something you do to the world in front of you and the player should not need a second vocabulary. `_takedownCandidate()` takes the *nearest* qualifying guard rather than the first in array order, re-checks the gate at the moment of the act, and refuses outright when `_detectionLevel === 'combat'`. Lethal, and it notifies `EventKind.TAKEDOWN` and **not** `KILL`: the content asks for them as different things — m04/o5 wants a watching servant silenced, m06/o5 wants guards faced — and counting one as the other would let a player who never drew a sword complete a mission written about a fight. |
| **Execution** | Judged *before* `resolveMelee()`, at the moment a swing connects, because it replaces the blow rather than following it: running the ordinary resolver first would spend the swing on 9 damage and a stagger before the moment arrived. `player.startFinisher()` and the camera's FINISHER mode were both written and both unreachable, since nothing put a victim in `ctx.finisher`. |

Both are loud or quiet by exactly the authored amount, and the difference is the design:
`NOISE_TAKEDOWN` is 6.5 m against `NOISE_COMBAT_HIT`'s 22 m. A silent removal that rang
out like a sword fight would take away the only reason to use one (M3, N6).

**The third instance of the same bug class.** Wiring the takedown exposed that
`EnemyAgent` passed its bus to the agent and **not to the `Combatant` it builds**, so
`Combatant.die()` — the one place every death passes through — emitted `COMBAT_KILL` into
a null bus. A guard killed by anything other than `resolveMelee()` died silently: no HUD,
no music sting, no cue. `resolveMelee()` had its own `COMBAT_KILL` emission, which is why
a sword kill looked fine and hid it.

That emission is now removed and the body has the bus, so there is **one death event from
one place**, whichever way the death happened. No information was lost: the `COMBAT_HIT`
beside it already carries attacker, defender and kind with `killed: true`, and `die()`
carries the attacker as `source`.

**And a wrong sound, found by the same audit.** `_worldNoise()`'s `source` string is the
cue id, and `NOISE_EMITTED` falls back to `'land-light'` for anything the catalogue does
not know. The combat noise was emitted as `'combat-hit'`, which is not a cue — so a sword
connecting with a person played a soft landing. The hearing model was right, the sound was
wrong, and nothing connected the two. It is `'hit-flesh'` now, the cue `COMBAT_HIT`
already plays, with `CUE_COOLDOWNS` making one blow one sound. battle-test **F5** asserts
every world-noise source a fight makes is a cue the catalogue actually has.

**One reporter defect, fixed.** `harness.mjs` printed a failed assertion's detail with
`JSON.stringify`, which throws on a cycle — and an agent holds its squad, which holds its
agents. The throw landed in the reporter, after every test had run, so one circular value
in one failed assertion replaced the whole failure list *and the RESULT line* with a stack
trace, and `run.sh` read a missing RESULT as a crash rather than as the failures it was
about to be told about. It uses the harness's own `fmt()`, which already caught cycles and
was simply not being used.

battle-test is now 58 tests in 9 groups; `PENDING_WIRING` and `PENDING_EVENTS` are both
empty, and stay in the file because the audit that reads them is what found the gaps.

Teeth verified by mutation, each caught by exactly the test that should catch it:
takedown ignoring detection → M4; takedown at the combat radius → M3; finisher ignoring
`FINISHER_HEALTH_THRESHOLD` → N4, E2, E5, J2; noise source that is not a cue → F1, F4, F5,
N6. Restored, 58/58.

---

## 8. OPEN BLOCKERS

Ordered by charter C-4 (player experience first) and C-10 (no P3 while a P0/P1 is open).
The combat P0 that headed this list is closed — see §7.

| # | Priority | Item | Why it blocks |
|---|---|---|---|
| 1 | ~~**P0**~~ | ~~m11/o5 — the last objective of the last mission cannot be completed from play~~ | **CLOSED 2026-09-13**, see §7.1. battle-test J4 now asserts the blocked list is *empty*, so a second objective of this kind fails the baseline instead of being discovered by a player. |
| 2 | ~~**P1**~~ | ~~Takedowns and finishers have no input path~~ | **CLOSED 2026-09-13**, see §7.2. Both gates are called from `main.js`, m04/o5 is reachable, the `takedown` audio cue is out of `MANUAL_CUES`, and battle-test J2's pending list is empty. |
| 3 | **P1** | Phase C — no bow or projectile system | The gate requires a true projectile, not long-reach melee. `aiming` and `drawing` intent are sampled every frame and consumed by nothing, so the player can hold a button that does nothing. Three authored audio cues wait on it. |
| 4 | **P1** | Phase F — no visual verification | The gate requires screenshot verification and distinct faces. Nothing has been looked at. A rig that is correct in arithmetic and wrong on screen passes every suite written so far. |
| 5 | **P2** | Phase J — no §24 metric ledger | Performance claims cannot be made without a BEFORE row, and no optimisation has been attempted, so there is no BEFORE to record. |
| 6 | **P2** | Phase K — no §25 reliability matrix | Full QA cannot certify against a matrix that does not exist. |
| 7 | **P2** | Investigation board not built | Two audio cues and the traitor's proof-of-method surface wait on it. The 10 clues are collectable; nothing links them. |

---

*— Agent 01, CEO / Executive Director*
