# THE BETRAYED WILL — الوصية المخذولة

Dark narrative RPG. A king's last will was forged. You are the struck-out heir.

The world is assembled by a **Council of 10,000 agents** across 25 ministries (400 each): building, development, processing, inspection, preparation, coordination, distribution, testing, copy, stories, plot, characters, scenarios, sound, camera, terrain, map, places, error handling, layer consistency, lighting, combat, UI, lore, and cinematics.

## Play

Open `index.html` via a local server (ES modules).

```bash
npm start
```

Then open the preview / `http://localhost:8080`.

- **WASD / arrows** move
- **E / Space** talk, take, continue
- **1–4** dialogue choices
- **M** local map
- **Tab** agent command center (100×100 swarm)
- **Q** Arabic / English

Four endings: restore the will, merge with it, burn every testament, or side with Chancellor Pharos.

## Tests

```bash
npm test
```

Layer-consistency QA checks z-order, walkable spawns, exit targets, bilingual scenes, flags, collision, audio zones, and lights.

## Pipeline

Preparation → Narrative → Cast → World → Systems → Presentation → Construct → Process → Verify → Ship.
