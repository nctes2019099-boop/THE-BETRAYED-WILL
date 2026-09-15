import { PLACE_DEFS } from "../content/places.js";
import { ENTITIES } from "../content/entities.js";
import { generateTerrain, walkableAt } from "./terrain.js";

function nearestWalkable(map, x, y) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (walkableAt(map, ix, iy)) return { x: ix, y: iy };
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (walkableAt(map, ix + dx, iy + dy)) return { x: ix + dx, y: iy + dy };
      }
    }
  }
  return { x: Math.max(1, Math.min(map.w - 2, ix)), y: Math.max(1, Math.min(map.h - 2, iy)) };
}

export function compileWorld(seed = 2019099) {
  const maps = Object.create(null);
  const places = Object.create(null);
  for (const def of PLACE_DEFS) {
    const map = generateTerrain(def, seed);
    const spawn = nearestWalkable(map, def.spawn.x, def.spawn.y);
    maps[def.id] = map;
    places[def.id] = { ...def, spawn };
  }

  const entities = ENTITIES.map((e) => {
    const map = maps[e.place];
    const p = nearestWalkable(map, e.x, e.y);
    const copy = { ...e, x: p.x, y: p.y, wx: p.x + 0.5, wy: p.y + 0.5 };
    if (e.type === "exit") {
      const dest = maps[e.to];
      if (dest) {
        const tp = nearestWalkable(dest, e.tx, e.ty);
        copy.tx = tp.x + 0.5;
        copy.ty = tp.y + 0.5;
      }
    }
    return copy;
  });

  return { maps, places, entities, seed };
}

export function entitiesIn(world, placeId) {
  return world.entities.filter((e) => e.place === placeId);
}
