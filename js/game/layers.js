/** Canonical render / simulation stack. Order is z-ascending. */
export const LAYER_STACK = [
  { id: "sky", ar: "السماء", en: "Sky", z: 0, kind: "backdrop" },
  { id: "terrain", ar: "التضاريس", en: "Terrain", z: 1, kind: "world" },
  { id: "water", ar: "الماء", en: "Water", z: 2, kind: "world" },
  { id: "paths", ar: "المسارات", en: "Paths", z: 3, kind: "world" },
  { id: "propsLow", ar: "العناصر المنخفضة", en: "Low Props", z: 4, kind: "world" },
  { id: "shadows", ar: "الظلال", en: "Shadows", z: 5, kind: "light" },
  { id: "characters", ar: "الشخصيات", en: "Characters", z: 6, kind: "actors" },
  { id: "propsHigh", ar: "العناصر العالية", en: "High Props", z: 7, kind: "world" },
  { id: "weather", ar: "الطقس", en: "Weather", z: 8, kind: "fx" },
  { id: "lighting", ar: "الإضاءة", en: "Lighting", z: 9, kind: "light" },
  { id: "fog", ar: "الضباب", en: "Fog", z: 10, kind: "fx" },
  { id: "cameraFx", ar: "تأثيرات الكاميرا", en: "Camera FX", z: 11, kind: "camera" },
  { id: "dialogue", ar: "الحوار", en: "Dialogue", z: 12, kind: "ui" },
  { id: "hud", ar: "الواجهة", en: "HUD", z: 13, kind: "ui" },
  { id: "letterbox", ar: "الإطار السينمائي", en: "Letterbox", z: 14, kind: "camera" },
  { id: "debug", ar: "التشخيص", en: "Debug", z: 15, kind: "qa" },
];

export const TILE = {
  VOID: 0,
  ASH: 1,
  PATH: 2,
  STONE: 3,
  WATER: 4,
  WALL: 5,
  WOOD: 6,
  MARBLE: 7,
  GRASS: 8,
  MOOR: 9,
  DOOR: 10,
  COLUMN: 11,
  RUG: 12,
  RAIL: 13,
  SAND: 14,
  BRIDGE: 15,
};

export const WALKABLE = new Set([
  TILE.ASH, TILE.PATH, TILE.STONE, TILE.WOOD, TILE.MARBLE,
  TILE.GRASS, TILE.MOOR, TILE.DOOR, TILE.RUG, TILE.SAND, TILE.BRIDGE,
]);

export const SOLID = new Set([TILE.VOID, TILE.WALL, TILE.WATER, TILE.COLUMN, TILE.RAIL]);

export function layerIndex(id) {
  return LAYER_STACK.findIndex((l) => l.id === id);
}
