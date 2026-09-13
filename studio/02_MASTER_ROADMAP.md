# MASTER DEVELOPMENT ROADMAP
## Agent 01 (CEO) — Issued 2026-09-12

**Gate status:** ✅ **RESOLVED — PATH 2.** The owner selected the authorised
ground-up build, which overrides brief §0 ("DO NOT REBUILD THE GAME FROM SCRATCH").
§0 was unsatisfiable in any case: `00_CEO_AUDIT_FINDING.md` establishes that the
repository contained one 20-byte `README.md`, so there was nothing to preserve.
Phases A–L are unblocked and in execution.

**Achieved state is recorded in `03_PHASE_LEDGER.md`,** which exists because this
document describes intended order and has nowhere to put it. Every entry there carries
the command that reproduces it, per C-1.

**Why it was gated:** §38 requires the CEO to consolidate real specialist audits into a
roadmap. With an empty repository there was nothing for Agents 02–18 to audit, so any
phase sequencing produced then would have been speculation, not evidence — violating
C-1. That condition no longer holds: the repository now builds, and the audits are being
filed as phases close rather than all up front.

---

## 0. PHASE 0 — BASELINE ESTABLISHMENT (precedes everything)

Mandatory under every path. Nothing else is authorised until Phase 0 closes.

| Step | Owner | Output | Exit criterion |
|---|---|---|---|
| 0.1 Resolve source of truth | CEO + Owner | PATH 1 / 2 / 3 selected | Owner decision recorded |
| 0.2 Make the §22 harness runnable | Agent 17 | `run.sh`, `lint.sh`, 7 test suites | all 7 suites execute and report a numeric score |
| 0.3 Record the true baseline | Agent 17 + Reviewer C | baseline ledger | every suite has a measured, reproducible number |
| 0.4 Performance baseline | Agent 15 + Reviewer F | §24 metric ledger | boot/menu/worldgen/FPS/frame/AI/render/UI/memory/objects/pathfinding all measured |
| 0.5 Domain audits (Agents 02–18) | each agent | §38 audit per domain | 17 audits filed, each with evidence |
| 0.6 Committee review of the audit | Reviewers A–H | independent reports | 8 reports filed, no reviewer touched code |
| 0.7 CEO consolidation | Agent 01 | §15 report + phase order | exactly one verdict issued |

**Phase 0 is the only phase whose content is certain.** The sequencing below is
provisional and will be re-derived from Phase 0 evidence — §31 permits the CEO to
reorder phases "only when evidence justifies doing so."

---

## 1. PROVISIONAL PHASE ORDER (§31)

Ordering rationale: player-facing reliability first (C-4), content-bearing
systems before polish, performance and packaging last so they measure a real
build rather than a moving target.

| Phase | Name | Lead agent | Supporting | Reviewer | Gate to exit |
|---|---|---|---|---|---|
| **A** | AI and enemy behaviour | 06 | 08, 07, 17 | A, B, G | AI never cheats; perception/memory/flanking/retreat verified by test + playthrough |
| **B** | Complete input / gamepad | 03 | 04, 13 | A, G | full gamepad navigation; no input lag; no unwanted sliding; clean stopping |
| **C** | Real bow / projectile system | 05 | 06, 15 | A, B, F | bow fires a true projectile — not long-reach melee; travel, drop, impact verified |
| **D** | Finisher & contextual combat camera | 04 | 05, 09 | A, D | zero wall/floor/ceiling penetration; no violent snap; no unintended geometry revealed |
| **E** | Fall / ledge systems | 03 | 08, 05 | A, C | fall damage + ledge grab functional; vertical traversal tested across all levels |
| **F** | Character visual quality | 09 | 11, 10 | D, E | distinct faces & silhouettes; historical clothing; no placeholder geometry; screenshot-verified |
| **G** | World visual & historical authenticity | 08 | 10, 11, 12 | D, E | dense, purposeful, believable; no European medieval / Gothic / modern elements |
| **H** | Mission / story polish | 02 | 07, 13, 16 | A, C, G | 6 chapters + epilogue, 11 missions, 14 dialogue trees, 10 clues, 9 cinematics all completable |
| **I** | UI / UX / audio / localisation | 13 | 14, 03 | G, H | Arabic complete + RTL correct; instant switching; no major missing audio; music transitions |
| **J** | Performance | 15 | all | F | §24 ledger within budget; every optimisation reports BEFORE/AFTER/CHANGE %/QUALITY IMPACT |
| **K** | Full QA | 17 | 16, 18 | C, H | all regression suites pass; Level 3 playthrough passes; §25 reliability matrix passes |
| **L** | Release preparation | 18 | 01 | H | §36 Final Release Gate — all ten blocks green |

### Dependency notes
- **B before C/D/E:** projectile, finisher-camera and traversal work all consume
  the input layer. Fixing input twice is wasted effort.
- **A before C:** bow combat is meaningless if enemies cannot perceive, react to
  or be interrupted by ranged threats.
- **F/G after C–E:** character and world art is expensive to re-shoot; lock
  gameplay camera and traversal behaviour first so framing requirements are known.
- **J after F/G:** asset quality drives object count and draw calls. Measuring
  performance before the visual target exists produces numbers that must be
  thrown away.
- **K/L last:** they certify a frozen build.
- **16 (save/reliability) runs continuously**, not as a phase — save/load must be
  exercised at dangerous moments throughout A–J.

---

## 2. PATH-SPECIFIC ENTRY CONDITIONS

### PATH 1 — real project supplied
Phase 0 becomes a genuine audit. Agents 02–18 audit *existing* code; the §10
claimed baselines (22/22, 10/10, 39/39, 13/13, 19/19, 24/24, 11/11, lint PASS,
camera penetration 0 m) are **re-measured, not trusted**. The §30 backlog is
verified before modification, per instruction "Do not assume they are already
fixed." C-11 applies in full: working systems are preserved. Phase order is then
re-derived from measured defect density.

### PATH 2 — authorised ground-up build ← **SELECTED**
Phase 0 expands into a **construction programme** and the §31 phases become build
targets rather than improvement targets. The owner additionally set the evidence
standard: the §10 figures (49 files / ~13,251 lines / the named suite scores) are
**targets to genuinely reach**, not claims to repeat, and no score is reported unless
the suite executes and passes under a command given alongside it. Mandatory additions:
- **0.2a** Harness-first: `run.sh` + 7 suites exist *before* gameplay code, so
  every later claim is evidence-backed (C-1). — ✅ closed; 12 suites, 648 tests.
- **0.2b** Architecture lock: Three.js r186, ES modules, zero external runtime
  dependency, fully procedural assets (§8) — approved by CEO before Phase A.
  — ✅ closed; `lint.sh` enforces the import graph and the audio system fetches nothing.
- Canon lock enforced from the first line of story data (§4–§7, charter §10).
  — ✅ closed and enforced by `lint.sh`, which fails on a prohibited name.
- Realistic expectation set with owner: ~13,000 lines across ~49 files, 22
  character models, 14 dialogue trees, 9 cinematics is a multi-cycle programme,
  not a single pass. C-8 still forbids bloat.

### PATH 3 — governance only
Phases A–L remain **unstarted**. Deliverables are the charter, this roadmap, the
change-control and release-gate documentation, and the report templates — all
already drafted and ready for handoff to a team with code.

---

## 3. STANDING CEO DIRECTIVES

1. **No agent codes before its §17 improvement plan is approved.**
2. **No P3 work while any P0/P1 is open** (C-10).
3. **Every optimisation carries BEFORE / AFTER / CHANGE % / QUALITY IMPACT** (§24).
4. **Every multi-system change carries WHY / WHAT / FILES / DEPENDENCIES / RISKS /
   TESTS / ROLLBACK STRATEGY** (§34).
5. **No test may be deleted because it exposes a regression** (C-5).
6. **One verdict per cycle** — `APPROVED` / `APPROVED WITH CONDITIONS` /
   `REJECTED — IMPROVEMENT REQUIRED`, with exact blockers named if rejected (§37).
7. **Quality over quantity.** "A smaller number of excellent improvements is
   better than hundreds of superficial modifications" (§39).

---

*— Agent 01, CEO / Executive Director*
