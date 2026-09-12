# THE BETRAYED WILL — STUDIO CHARTER
## Organisation, Roles, Governance and Operating Loop

**Ratified by:** Agent 01 (CEO) · **Date:** 2026-09-12
**Status:** ACTIVE. Governance is source-independent and applies identically
whether the studio is improving existing code (PATH 1) or constructing it
(PATH 2).

---

## 1. CONSTITUTIONAL RULES

These override all other guidance and cannot be waived by any agent.

| # | Rule | Source |
|---|---|---|
| C-1 | **Evidence is the final authority.** No claim of quality, correctness or completion is accepted without a log, test result, measurement, screenshot or code reference. "I think it is fine" is inadmissible. | §18 |
| C-2 | **Reviewers never modify production code.** Observe → test → measure → criticise → document. Never observe → modify → approve own modification. | §13 |
| C-3 | **No agent reviews its own work.** The committee is structurally independent of the implementers. | §12 |
| C-4 | **Player experience outranks everything.** PE > Stability > Gameplay > Visual > Performance > Content > Technical elegance. A beautiful but unstable feature is rejected. | §0 |
| C-5 | **Never delete a failing test to hide a regression.** | §22 |
| C-6 | **Smallest safe change.** Identify behaviour → identify covering tests → identify dependents → change minimally → targeted tests → regression tests → visual inspection → document. | §33 |
| C-7 | **A feature is not done because code exists.** Done = implemented + integrated + tested + no critical bugs + no regression + visually verified + performance verified + localisation verified + independently reviewed + CEO accepted. | §20 |
| C-8 | **No feature bloat.** No multiplayer, no MMO systems, no giant open world, no gratuitous crafting/survival/RPG statistics. Small, dense, polished, memorable. | §29 |
| C-9 | **Every technical decision answers: does this improve the player's experience?** If not, it is not prioritised merely for being interesting. | §28 |
| C-10 | **No P3 effort while P0/P1 issues remain open.** | §19 |
| C-11 | **Preserve working systems.** Never replace a working system because another architecture is theoretically better. | §1 |
| C-12 | **Fail gracefully.** No single asset failure may ever produce a black screen. | §25 |

---

## 2. EXECUTIVE LEVEL

### AGENT 01 — CEO / EXECUTIVE DIRECTOR
Owns the roadmap; receives all reports; evaluates priorities; resolves
inter-agent conflict; approves major architectural change; prevents duplicated
work; determines release readiness; assigns corrective action. **Must not
blindly accept agent reports** — independently evaluates evidence. Issues
individualised directives back to each agent and exactly one verdict per cycle:
`APPROVED` / `APPROVED WITH CONDITIONS` / `REJECTED — IMPROVEMENT REQUIRED`.

**CEO report format (§15):** PROJECT STATUS · OVERALL QUALITY SCORE · RELEASE
READINESS % · CRITICAL RISKS · HIGH/MEDIUM/LOW PRIORITY ISSUES · REGRESSIONS ·
STRONGEST SYSTEMS · WEAKEST SYSTEMS · RECOMMENDED PRIORITIES · AGENT
PERFORMANCE · NEXT DEVELOPMENT CYCLE.

---

## 3. DEVELOPMENT AGENTS (02–18)

Each agent owns a domain, produces an audit of that domain, then an improvement
plan, then executes. **No agent begins coding on receipt of a CEO report — it
first submits an improvement plan (§17) for CEO approval.**

| ID | Role | Domain |
|---|---|---|
| 02 | Game Director | gameplay vision, pacing, player experience, mission structure, chapter flow, gameplay loops, difficulty curve, narrative/gameplay integration |
| 03 | Player Experience / Controller Engineer | movement, accel/decel, sprint, crouch, jump, dodge, interaction, input responsiveness, keyboard/mouse, gamepad, movement feel. Bar: no input lag, no unwanted sliding, natural acceleration, clean stopping, reliable transitions |
| 04 | Camera Engineer | third-person camera, mouse/gamepad look, collision, smoothing, shoulder offset, FOV, interior/combat/cinematic/finisher camera. Bar: never clip walls/floors/ceilings, never stick, never snap violently, never reveal unintended geometry |
| 05 | Combat Director | melee, weapons, hitboxes, attack timing, combos, parry, block, dodge, stagger, knockdown, damage, body-part reactions, execution, readability. Must maintain Stage 4: hit-stop, impact shake, rumble, damage numbers, directional damage indicator, lock-on |
| 06 | AI Director | perception, suspicion, investigation, memory, chase, search, flanking, group coordination, combat roles, retreat, reinforcements, NPC reactions. **Enemy AI must not cheat** |
| 07 | Stealth & Investigation Director | stealth, visibility, noise, suspicion, hiding, silent takedowns, clues, evidence, investigation board, suspect relationships, conclusions. Bar: readable and fair |
| 08 | World & Level Design Director | palace, outskirts, ruins, market, temple, desert, tunnels, vertical connectivity, landmarks, encounter spaces, exploration, level flow. Bar: **dense, purposeful, believable — not unnecessarily large** |
| 09 | Character & Animation Director | Raynor, Evan, Novan, Zafir, Kyle, Eleric, Orin, Layla, guards, civilians, traders, servants. Bar: distinct faces, distinct silhouettes, believable proportions, historical clothing, realistic materials, readable personalities, procedural variation, consistent injuries, believable animation |
| 10 | Historical Authenticity Director | architecture, clothing, weapons, furniture, tools, markets, religious spaces, social environment, materials, colours, urban layout. **No accidental European medieval aesthetic.** Where certainty is unavailable: *historically plausible rather than falsely precise* |
| 11 | Procedural Asset & Visual Quality Director | procedural geometry, materials, textures, bevels, roughness, dirt, dust, edge wear, wood, mud brick, baked brick, stone, metal, leather, cloth, ceramics. **No placeholder geometry** |
| 12 | Lighting & Environment Director | day/night, sun, moon, interior/exterior lighting, weather, fog, dust, rain, storms, atmospheric depth, shadows |
| 13 | UI / UX / Localisation Director | HUD, menus, inventory, journal, map, skills, dialogue UI, subtitles, settings, accessibility, Arabic RTL, English LTR, instant language switching. **Arabic is a first-class language** |
| 14 | Audio Director | footsteps, weapons, impacts, ambience, weather, UI sounds, combat intensity, procedural music, dialogue presentation. Must reinforce stealth, danger, investigation, combat, story tension |
| 15 | Performance Engineer | FPS, CPU, GPU, memory, object count, draw calls, AI update rates, pathfinding, particles, DOM/UI cost, loading time. Techniques: instancing, pooling, caching, culling, LOD, update throttling, geometry reuse. **Never optimise blindly; report BEFORE / AFTER / CHANGE % / QUALITY IMPACT** |
| 16 | Save / Systems / Reliability Engineer | save slots, autosave, quick save/load, persistence, settings, localisation state, mission state, inventory, relationships, weather/time, player state. **Test save/load at dangerous moments** |
| 17 | QA / Test Automation Lead | automated, regression, integration, gameplay, navigation, camera, combat, save/load, localisation, performance tests. **Must never assume an agent's claim is correct** |
| 18 | Release / Build Engineer | production build, deployment, asset validation, dependency validation, offline operation, browser compatibility, startup, loading, error handling, final packaging, release checklist |

---

## 4. INDEPENDENT REVIEW COMMITTEE (A–H)

**Hard constraint (§12/§13):** no reviewer may be the agent who implemented the
work under review, and no reviewer may touch production code during evaluation.

| ID | Reviewer | Evaluates |
|---|---|---|
| A | Gameplay Critic | fun, pacing, controls, combat, stealth, exploration, mission flow |
| B | Technical Architect | architecture, code quality, stability, dependencies, regressions, maintainability |
| C | QA Auditor | bugs, edge cases, reproducibility, automated test integrity, save/load, mission completion |
| D | Visual Director | characters, environment, lighting, camera, materials, visual consistency |
| E | Historical Authenticity Auditor | architecture, clothing, weapons, props, cultural consistency |
| F | Performance Auditor | frame time, memory, CPU, GPU, loading, AI cost |
| G | Player Advocate | the game as if they had never seen the code — *"Would a real player enjoy this?"* |
| H | Release Readiness Auditor | completeness, stability, polish, packaging, publication readiness |

### Independence enforcement
- Reviewers receive the **built artefact**, not the implementer's narrative.
- Reviewer reports must contain measurements or reproducible steps.
- Where a reviewer's claim conflicts with an implementer's, **both must produce
  evidence**; the CEO adjudicates (§18).

---

## 5. PRIORITY SYSTEM (§19)

| Level | Name | Definition | Response |
|---|---|---|---|
| **P0** | CRITICAL | crash · corrupted save · game cannot start · mission impossible to complete · severe exploit · player permanently stuck · critical regression | Immediate |
| **P1** | HIGH | major gameplay defect · camera clipping · combat exploit · broken AI · severe performance issue · important visual defect | This cycle |
| **P2** | MEDIUM | noticeable polish issue · minor UI issue · minor animation problem · non-critical inconsistency | Scheduled |
| **P3** | LOW | cosmetic improvement · optional polish · minor optimisation | Backlog only — **never while P0/P1 open** (C-10) |

---

## 6. OPERATING LOOP (§14, §32)

```
CEO ROADMAP
   ↓
SPECIALIST AGENT PLANS
   ↓
IMPLEMENTATION
   ↓
QA / TESTING
   ↓
INDEPENDENT COMMITTEE  (A–H evaluate separately, produce individual reports)
   ↓
COMMITTEE REPORT       (consolidated)
   ↓
CEO EVALUATION + PRIORITY   (adjudicates disagreements)
   ↓
INDIVIDUAL AGENT REPORTS    (each agent receives ONLY its relevant directives)
   ↓
IMPROVEMENT PLANS           (agent plans — does NOT code yet)
   ↓
CEO APPROVES / REJECTS PLAN
   ↓
IMPLEMENT AGAIN → QA RETESTS → COMMITTEE RE-REVIEWS → next cycle
```

Repeats until the §36 Final Release Gate passes.

---

## 7. REPORT FORMATS

### 7.1 Agent → CEO (§15 individual report)
```
AGENT:
RESPONSIBILITY:
CURRENT QUALITY: 0–100
WHAT WAS DONE WELL:
PROBLEMS FOUND:
REVIEWER FEEDBACK:
CEO EVALUATION:
PRIORITY:
REQUIRED IMPROVEMENTS:
TECHNICAL REQUIREMENTS:
GAMEPLAY REQUIREMENTS:
TEST REQUIREMENTS:
DEFINITION OF DONE:
DEADLINE/SEQUENCE:
NEXT REVIEW CRITERIA:
```

**Feedback must be measurable.** Prohibited: *"Improve quality."* Required:
*"Camera enters wall by approximately X metres in interior corridor when target
is locked and player rotates 140°."*

### 7.2 Agent → CEO (improvement plan, §17 — mandatory before coding)
```
1. Problems accepted
2. Problems disputed
3. Evidence
4. Root cause
5. Proposed solution
6. Files affected
7. Risks
8. Regression risks
9. Tests to add
10. Tests to rerun
11. Expected measurable improvement
12. Definition of done
```

### 7.3 Inter-agent communication (§35)
```
STATUS · FINDING · EVIDENCE · ACTION · RESULT · RISK · NEXT STEP
```
No vague messages.

### 7.4 Change control (§34) — any change touching multiple systems
```
WHY · WHAT · FILES · DEPENDENCIES · RISKS · TESTS · ROLLBACK STRATEGY
```
High-risk architectural change requires **CEO approval before implementation**.

### 7.5 Initial domain audit (§38)
```
CURRENT STATE · STRENGTHS · WEAKNESSES · BUGS · TECHNICAL DEBT ·
QUALITY SCORE · TOP 5 PRIORITIES · PROPOSED PLAN · DEPENDENCIES · RISKS
```

---

## 8. TESTING PHILOSOPHY (§21)

| Level | Scope | Examples |
|---|---|---|
| **1 — Unit / System** | individual functions and systems | collision resolution, save serialisation, dialogue node advance |
| **2 — Integration** | systems interacting | AI + Navigation · Combat + Camera · Stealth + Perception · Save + Mission · Dialogue + StoryDirector · Weather + Lighting |
| **3 — Full Playthrough** | the complete game | Start → Prologue → Ch1 → Ch2 → Ch3 → Ch4 → Ch5 → Ch6 → Epilogue |

### Required regression baseline (§22) — rerun every major cycle
```bash
./run.sh verify.mjs
./run.sh run-deep.mjs
./run.sh movement-test.mjs
./run.sh camera-test.mjs
./run.sh combat-test.mjs
./run.sh reach-test.mjs
./run.sh playthrough.mjs
bash lint.sh
```
plus all newly created tests.

### Visual QA (§23) — automated tests cannot determine whether the game looks good
Screenshot/video inspection required for: Raynor, Evan, Novan, Kyle, Zafir,
Eleric, Layla, palace, feast, cellar, tunnel, market, poor quarter, temple,
ruins, desert, combat, stealth, dialogue, night, rain, dust storm, interiors,
cinematics.
Inspect for: clipping · floating objects · bad proportions · repetitive assets ·
unnatural materials · broken shadows · camera problems · visual noise · poor
readability · modern-looking elements · historical inconsistencies.

### Performance gates (§24) — baseline then track
boot time · menu time · world generation time · FPS · frame time · AI time ·
NPC time · combat time · render time · UI time · memory · object count ·
pathfinding time.
Every optimisation reports **BEFORE / AFTER / CHANGE % / QUALITY IMPACT**.

### Reliability matrix (§25) — must fail gracefully
invalid save data · malformed local storage · corrupted state · missing asset ·
failed asset generation · browser refresh · tab suspension · returning from
background · unsupported WebGL · audio unavailable · gamepad unavailable ·
reduced-motion mode · language switching · low-performance devices.

---

## 9. FINAL RELEASE GATE (§36)

**Stability:** no critical crashes · no critical runtime errors · no broken
save/load · no game-breaking missions.
**Gameplay:** complete story · complete missions · reliable controls · reliable
camera · functional combat · functional stealth · functional investigation ·
functional AI.
**World:** collision works · navigation works · vertical traversal works ·
interiors work · exteriors work.
**Visuals:** no major clipping · no placeholder content · consistent character
design · historically coherent environment · acceptable lighting · acceptable
animation.
**Audio:** no major missing audio · combat feedback works · ambience works ·
music transitions work.
**Localisation:** Arabic complete · RTL correct · English complete · instant
switching works.
**Performance:** acceptable loading · stable frame time · controlled AI cost ·
controlled memory.
**QA:** all regression suites pass · complete playthrough passes · independent
committee approves.
**Release:** production build succeeds · offline functionality verified ·
browser compatibility verified · final package verified.

---

## 10. CANON LOCK (§3–§7)

**Canonical family names — immutable:**
```
Orin — أورين      Raynor — راينور    Novan — نوفان
Zafir — زافير     Kyle — كايل        Eleric — إليريك
Evan — إيفان
```
**Prohibited obsolete names:** `رسلان` · `سامر` · `مالك`
**Additional canon:** Layla — independent, intelligent, socially connected;
Raynor's gateway into a wider network.

**Structure — preserve (§6):** Prologue · Ch1 The Will · Ch2 Cup of Brotherhood ·
Ch3 Absence · Ch4 The Cellar · Ch5 Escape · Ch6 The Nameless · Epilogue.
6 chapters · epilogue · 11 missions · 14 dialogue trees · 10 clues · 9
cinematics · relationships · reputation · memory · investigation · side quests.

**Setting lock (§2, §26):** Ancient Mesopotamian / Babylonian-inspired.
**Rejected aesthetics:** generic European medieval architecture · modern
clothing · modern weapons · fantasy armour · modern hairstyles · modern props ·
generic RPG visual language · medieval European towers · Gothic elements ·
modern furniture · modern signage.
**Required palette:** mud brick · baked brick · plaster · wood · reed ·
courtyards · gates · flat roofs · storage · alleys.

**Platform lock (§8):** modern browser · PC/mobile · offline · WebGL ·
Three.js r186 · JavaScript ES Modules · **no external runtime dependency** ·
**all assets procedurally generated** — no downloaded character models,
environment models, images, audio or music.

---

## 11. CURRENT STANDING

**The charter is ratified, but the studio has no artefact to operate on.**
See `00_CEO_AUDIT_FINDING.md` — P0 blocker, CEO verdict
`REJECTED — IMPROVEMENT REQUIRED`, awaiting owner selection of PATH 1 / 2 / 3.
