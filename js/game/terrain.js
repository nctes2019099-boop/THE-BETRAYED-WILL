import { TILE, WALKABLE, SOLID } from "./layers.js";
import { mulberry32 } from "../agents/swarm.js";

function idx(x, y, w) {
  return y * w + x;
}

function fillRect(tiles, w, h, x, y, rw, rh, t) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(w, x + rw);
  const y1 = Math.min(h, y + rh);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) tiles[idx(xx, yy, w)] = t;
  }
}

function frame(tiles, w, h, t) {
  for (let x = 0; x < w; x++) {
    tiles[idx(x, 0, w)] = t;
    tiles[idx(x, h - 1, w)] = t;
  }
  for (let y = 0; y < h; y++) {
    tiles[idx(0, y, w)] = t;
    tiles[idx(w - 1, y, w)] = t;
  }
}

function carvePath(tiles, w, h, x0, y0, x1, y1, t) {
  let x = x0;
  let y = y0;
  while (x !== x1 || y !== y1) {
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) tiles[idx(x, y, w)] = t;
    if (x !== x1 && (y === y1 || Math.abs(x - x1) >= Math.abs(y - y1))) x += Math.sign(x1 - x);
    else y += Math.sign(y1 - y);
  }
}

const BIOME_FILL = {
  ash: TILE.ASH,
  wood: TILE.WOOD,
  moor: TILE.MOOR,
  stone: TILE.STONE,
  marble: TILE.MARBLE,
  vault: TILE.STONE,
};

export function generateTerrain(place, seed = 99) {
  const { w, h, biome } = place;
  const tiles = new Uint8Array(w * h);
  const rand = mulberry32(seed + place.id.length * 9176);
  const fill = BIOME_FILL[biome] || TILE.ASH;
  tiles.fill(fill);
  frame(tiles, w, h, TILE.WALL);

  if (biome === "ash") {
    fillRect(tiles, w, h, 0, h - 7, w, 7, TILE.WATER);
    fillRect(tiles, w, h, 1, h - 8, w - 2, 2, TILE.SAND);
    fillRect(tiles, w, h, 8, 8, 12, 10, TILE.STONE);
    frameish(tiles, w, 8, 8, 12, 10, TILE.WALL);
    tiles[idx(14, 17, w)] = TILE.DOOR;
    fillRect(tiles, w, h, 28, 6, 10, 8, TILE.WOOD);
    frameish(tiles, w, 28, 6, 10, 8, TILE.WALL);
    tiles[idx(33, 13, w)] = TILE.DOOR;
    carvePath(tiles, w, h, 10, 22, 14, 17, TILE.PATH);
    carvePath(tiles, w, h, 14, 18, 33, 14, TILE.PATH);
    carvePath(tiles, w, h, 33, 14, 40, 20, TILE.PATH);
    fillRect(tiles, w, h, 18, h - 9, 8, 2, TILE.BRIDGE);
    scatter(tiles, w, h, rand, TILE.ASH, 40, (t) => t === TILE.ASH);
  }

  if (biome === "wood") {
    fillRect(tiles, w, h, 1, 1, w - 2, h - 2, TILE.WOOD);
    fillRect(tiles, w, h, 11, 5, 6, 6, TILE.RUG);
    fillRect(tiles, w, h, 2, 2, 6, 8, TILE.STONE);
    frameish(tiles, w, 2, 2, 6, 8, TILE.WALL);
    tiles[idx(5, 9, w)] = TILE.DOOR;
    tiles[idx(Math.floor(w / 2), h - 1, w)] = TILE.DOOR;
    fillRect(tiles, w, h, w - 8, 3, 5, 5, TILE.WOOD);
    frameish(tiles, w, w - 8, 3, 5, 5, TILE.WALL);
    tiles[idx(w - 6, 7, w)] = TILE.DOOR;
  }

  if (biome === "moor") {
    fillRect(tiles, w, h, 1, 1, w - 2, h - 2, TILE.MOOR);
    for (let i = 0; i < 18; i++) {
      const x = 3 + Math.floor(rand() * (w - 8));
      const y = 3 + Math.floor(rand() * (h - 8));
      fillRect(tiles, w, h, x, y, 2 + Math.floor(rand() * 4), 2 + Math.floor(rand() * 3), TILE.WATER);
    }
    carvePath(tiles, w, h, 8, 30, 28, 16, TILE.PATH);
    carvePath(tiles, w, h, 28, 16, 48, 10, TILE.PATH);
    carvePath(tiles, w, h, 28, 16, 12, 8, TILE.PATH);
    fillRect(tiles, w, h, 26, 14, 5, 5, TILE.STONE);
    for (const [x, y] of [[26, 12], [30, 12], [28, 10], [40, 18], [16, 20]]) {
      if (x > 0 && y > 0) tiles[idx(x, y, w)] = TILE.COLUMN;
    }
  }

  if (biome === "stone" && place.id === "watch") {
    fillRect(tiles, w, h, 1, 1, w - 2, h - 2, TILE.STONE);
    frameish(tiles, w, 6, 4, 12, 10, TILE.WALL);
    fillRect(tiles, w, h, 7, 5, 10, 8, TILE.STONE);
    tiles[idx(12, 13, w)] = TILE.DOOR;
    tiles[idx(12, h - 1, w)] = TILE.DOOR;
    fillRect(tiles, w, h, 10, 6, 4, 3, TILE.RUG);
  }

  if (biome === "stone" && place.id === "archives") {
    fillRect(tiles, w, h, 1, 1, w - 2, h - 2, TILE.STONE);
    for (let x = 4; x < w - 4; x += 4) {
      fillRect(tiles, w, h, x, 3, 1, 12, TILE.COLUMN);
    }
    fillRect(tiles, w, h, 13, 8, 6, 6, TILE.RUG);
    tiles[idx(16, h - 1, w)] = TILE.DOOR;
  }

  if (biome === "marble") {
    fillRect(tiles, w, h, 1, 1, w - 2, h - 2, TILE.MARBLE);
    fillRect(tiles, w, h, Math.floor(w / 2) - 3, 4, 6, 10, TILE.RUG);
    for (let x = 6; x < w - 5; x += 6) {
      tiles[idx(x, 5, w)] = TILE.COLUMN;
      tiles[idx(x, h - 6, w)] = TILE.COLUMN;
    }
    fillRect(tiles, w, h, Math.floor(w / 2) - 2, 3, 4, 3, TILE.STONE);
    tiles[idx(Math.floor(w / 2), h - 1, w)] = TILE.DOOR;
    if (place.id === "court") {
      fillRect(tiles, w, h, w - 10, 8, 8, 10, TILE.STONE);
      frameish(tiles, w, w - 10, 8, 8, 10, TILE.WALL);
      tiles[idx(w - 10, 13, w)] = TILE.DOOR;
    }
  }

  if (biome === "vault") {
    fillRect(tiles, w, h, 1, 1, w - 2, h - 2, TILE.STONE);
    fillRect(tiles, w, h, 16, 8, 10, 8, TILE.MARBLE);
    frameish(tiles, w, 16, 8, 10, 8, TILE.COLUMN);
    tiles[idx(21, 15, w)] = TILE.DOOR;
    carvePath(tiles, w, h, 6, 24, 21, 16, TILE.PATH);
    for (let y = 4; y < h - 4; y += 3) {
      tiles[idx(4, y, w)] = TILE.COLUMN;
      tiles[idx(w - 5, y, w)] = TILE.COLUMN;
    }
  }

  const collision = new Uint8Array(w * h);
  for (let i = 0; i < tiles.length; i++) collision[i] = SOLID.has(tiles[i]) ? 1 : 0;

  return { tiles, collision, w, h };
}

function frameish(tiles, w, x, y, rw, rh, t) {
  for (let xx = x; xx < x + rw; xx++) {
    tiles[idx(xx, y, w)] = t;
    tiles[idx(xx, y + rh - 1, w)] = t;
  }
  for (let yy = y; yy < y + rh; yy++) {
    tiles[idx(x, yy, w)] = t;
    tiles[idx(x + rw - 1, yy, w)] = t;
  }
}

function scatter(tiles, w, h, rand, t, n, pred) {
  for (let i = 0; i < n; i++) {
    const x = 1 + Math.floor(rand() * (w - 2));
    const y = 1 + Math.floor(rand() * (h - 2));
    const i0 = idx(x, y, w);
    if (pred(tiles[i0])) tiles[i0] = t;
  }
}

export function walkableAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
  return map.collision[y * map.w + x] === 0 && WALKABLE.has(map.tiles[y * map.w + x]);
}
