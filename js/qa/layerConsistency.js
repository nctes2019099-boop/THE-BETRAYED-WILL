import { LAYER_STACK, WALKABLE, SOLID } from "../game/layers.js";
import { PLACE_DEFS } from "../content/places.js";
import { ENTITIES } from "../content/entities.js";
import { CAST } from "../content/cast.js";
import { SCENES, ENDINGS } from "../content/story.js";
import { generateTerrain, walkableAt } from "../game/terrain.js";
import { FLAG_DEFS } from "../content/flags.js";
import { DEPARTMENTS, AGENTS_TOTAL, AGENTS_PER_DEPT } from "../agents/departments.js";

export function runLayerConsistency(worldMaps, compiledEntities = ENTITIES) {
  const findings = [];
  const ok = (id, ar, en) => findings.push({ id, pass: true, ar, en });
  const fail = (id, ar, en) => findings.push({ id, pass: false, ar, en });

  const zs = LAYER_STACK.map((l) => l.z);
  const zSorted = zs.every((z, i) => i === 0 || z > zs[i - 1]);
  const unique = new Set(LAYER_STACK.map((l) => l.id)).size === LAYER_STACK.length;
  (zSorted && unique ? ok : fail)(
    "L01",
    "طبقات الرسم متفرّدة ومتصاعدة.",
    "Render layers are unique and strictly increasing."
  );

  const kinds = new Set(LAYER_STACK.map((l) => l.kind));
  (kinds.has("world") && kinds.has("actors") && kinds.has("ui") && kinds.has("camera") ? ok : fail)(
    "L02",
    "أنواع الطبقات تغطي العالم والممثلين والواجهة والكاميرا.",
    "Layer kinds cover world, actors, UI, and camera."
  );

  if (DEPARTMENTS.length * AGENTS_PER_DEPT === AGENTS_TOTAL) {
    ok("A01", "عدد الوكلاء 10000 بالضبط.", "Agent count is exactly 10,000.");
  } else fail("A01", "عدد الوكلاء غير صحيح.", "Agent count mismatch.");

  const placeIds = new Set(PLACE_DEFS.map((p) => p.id));
  for (const p of PLACE_DEFS) {
    if (!p.w || !p.h || p.w < 8 || p.h < 8) fail(`P-${p.id}-size`, `المكان ${p.id} صغير جداً.`, `Place ${p.id} too small.`);
    else ok(`P-${p.id}-size`, `أبعاد ${p.id} صالحة.`, `Place ${p.id} size ok.`);
    const map = worldMaps[p.id];
    if (!map) {
      fail(`P-${p.id}-map`, `لا توجد خريطة لـ ${p.id}.`, `No map for ${p.id}.`);
      continue;
    }
    if (map.tiles.length !== p.w * p.h) fail(`P-${p.id}-len`, "طول الخريطة لا يطابق الأبعاد.", "Map length mismatch.");
    else ok(`P-${p.id}-len`, "طول الخريطة مطابق.", "Map length matches.");
    const walk = walkableAt(map, p.spawn.x, p.spawn.y);
    (walk ? ok : fail)(`P-${p.id}-spawn`, `نقطة ظهور ${p.id} قابلة للمشي.`, `Spawn walkable in ${p.id}.`);
    for (const L of p.lights) {
      if (L.x < 0 || L.y < 0 || L.x >= p.w || L.y >= p.h) fail(`P-${p.id}-light`, "ضوء خارج الخريطة.", "Light out of bounds.");
    }
    for (const z of p.audioZones) {
      if (!placeIds.has(p.id)) fail(`P-${p.id}-az`, "منطقة صوت بلا مكان.", "Audio zone missing place.");
      if (z.x + z.w > p.w || z.y + z.h > p.h) fail(`P-${p.id}-azb`, "منطقة صوت خارج الحدود.", "Audio zone OOB.");
    }
  }

  for (const e of compiledEntities) {
    if (!placeIds.has(e.place)) {
      fail(`E-${e.id}-place`, `كيان ${e.id} في مكان غير موجود.`, `Entity place missing.`);
      continue;
    }
    const map = worldMaps[e.place];
    const def = PLACE_DEFS.find((p) => p.id === e.place);
    if (e.x < 1 || e.y < 1 || e.x >= def.w - 1 || e.y >= def.h - 1) {
      fail(`E-${e.id}-oob`, `كيان ${e.id} خارج الحدود.`, `Entity OOB.`);
    }
    if (map && (e.type === "npc" || e.type === "exit" || e.type === "item")) {
      if (!walkableAt(map, Math.round(e.x), Math.round(e.y))) {
        fail(`E-${e.id}-walk`, `كيان ${e.id} على بلاطة غير قابلة للمشي.`, `Entity on solid tile.`);
      } else ok(`E-${e.id}-walk`, `كيان ${e.id} على مسار صالح.`, `Entity walkable.`);
    }
    if (e.type === "exit") {
      if (!placeIds.has(e.to)) fail(`E-${e.id}-to`, "مخرج إلى مكان مجهول.", "Exit to unknown place.");
      else ok(`E-${e.id}-to`, "هدف المخرج موجود.", "Exit target exists.");
      if (e.need && !(e.need in FLAG_DEFS)) fail(`E-${e.id}-need`, "شرط علم غير معرّف.", "Unknown flag requirement.");
    }
    if (e.type === "npc" && !CAST[e.who]) fail(`E-${e.id}-who`, "شخصية غير معرّفة.", "Unknown character.");
    if (e.type === "inspect" || e.type === "item" || e.type === "combat") {
      if (e.scene && !SCENES[e.scene]) fail(`E-${e.id}-sc`, "مشهد مفقود.", "Missing scene.");
    }
  }

  for (const [id, sc] of Object.entries(SCENES)) {
    if (!sc.beats?.length) fail(`S-${id}`, `المشهد ${id} بلا نبضات.`, `Scene has no beats.`);
    for (const b of sc.beats) {
      if (b.who && !CAST[b.who]) fail(`S-${id}-who`, `متحدث مجهول في ${id}.`, `Unknown speaker.`);
      if (!b.ar || !b.en) fail(`S-${id}-i18n`, "نص غير ثنائي اللغة.", "Missing bilingual text.");
      if (b.choices) {
        for (const c of b.choices) {
          if (c.set) {
            for (const k of Object.keys(c.set)) {
              if (!(k in FLAG_DEFS)) fail(`S-${id}-flag`, `علم ${k} غير معرّف.`, `Undefined flag ${k}.`);
            }
          }
          if (c.ending && !ENDINGS[c.ending]) fail(`S-${id}-end`, "نهاية غير معرّفة.", "Unknown ending.");
        }
      }
    }
  }

  for (const p of PLACE_DEFS) {
    const map = worldMaps[p.id];
    if (!map) continue;
    let walkN = 0;
    let solidN = 0;
    for (let i = 0; i < map.tiles.length; i++) {
      const t = map.tiles[i];
      if (WALKABLE.has(t) && map.collision[i] === 0) walkN++;
      if (SOLID.has(t)) solidN++;
    }
    if (walkN < 20) fail(`C-${p.id}`, "مسارات غير كافية.", "Too few walkable tiles.");
    else ok(`C-${p.id}`, `تناسق التصادم في ${p.id}.`, `Collision consistency in ${p.id}.`);
    if (solidN < 10) fail(`C-${p.id}-s`, "جدران غير كافية.", "Too few solid tiles.");
  }

  const pass = findings.filter((f) => f.pass).length;
  const failN = findings.filter((f) => !f.pass).length;
  return { findings, pass, fail: failN, ok: failN === 0 };
}
