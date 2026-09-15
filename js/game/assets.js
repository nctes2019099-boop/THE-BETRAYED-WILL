import { CAST } from "../content/cast.js";

const SPRITE_FILES = {
  lyen: "assets/art/sprites/lyen.png",
  runa: "assets/art/sprites/runa.png",
  pharos: "assets/art/sprites/pharos.png",
  theWill: "assets/art/sprites/will.png",
  serath: "assets/art/sprites/serath.png",
  orlen: "assets/art/sprites/orlen.png",
  maia: "assets/art/sprites/maia.png",
  guardian: "assets/art/sprites/guardian.png",
  aldric: "assets/art/sprites/will.png",
};

const PLACE_ART = {
  harbor: "assets/art/harbor.png",
  inn: "assets/art/inn.png",
  moors: "assets/art/moors.png",
  watch: "assets/art/moors.png",
  court: "assets/art/court.png",
  archives: "assets/art/vault.png",
  vault: "assets/art/vault.png",
  throne: "assets/art/court.png",
};

export const TEX = 128;

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h ?? w;
  return c;
}

function chromaKey(img) {
  if (!img) return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = canvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const excess = g - Math.max(r, b);
    if (g > 70 && excess > 28 && g > r + 8 && g > b + 8) {
      const t = Math.min(1, Math.max(0, (excess - 28) / 50));
      d[i + 3] = Math.floor(d[i + 3] * (1 - t));
      if (t > 0.35) {
        d[i + 1] = Math.min(g, Math.max(r, b) + 8);
      }
    }
    if (d[i + 3] > 16) {
      const x = p % w;
      const y = (p / w) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  ctx.putImageData(id, 0, 0);
  if (maxX <= minX || maxY <= minY) return c;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const out = canvas(maxX - minX + 1, maxY - minY + 1);
  out.getContext("2d").drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function grade(src, ops, size = TEX) {
  const c = canvas(size);
  const ctx = c.getContext("2d");
  if (src) ctx.drawImage(src, 0, 0, size, size);
  else {
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, size, size);
  }
  for (const op of ops) {
    ctx.globalCompositeOperation = op.mode || "source-over";
    ctx.globalAlpha = op.a ?? 1;
    ctx.fillStyle = op.fill;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return c;
}

function bakeWood(src, size = TEX) {
  const c = grade(src, [
    { mode: "multiply", fill: "#7a4a28", a: 0.85 },
    { mode: "overlay", fill: "#3a2010", a: 0.35 },
  ], size);
  const ctx = c.getContext("2d");
  ctx.strokeStyle = "rgba(18,8,4,0.5)";
  ctx.lineWidth = 3;
  const plank = size / 5;
  for (let y = 0; y < size; y += plank) {
    ctx.beginPath();
    ctx.moveTo(0, y + 1);
    ctx.lineTo(size, y + (y % 7) - 2);
    ctx.stroke();
  }
  return c;
}

function bakeMarble(src, size = TEX) {
  const c = grade(src, [
    { mode: "overlay", fill: "#d8d2c8", a: 0.5 },
    { mode: "multiply", fill: "#9a9590", a: 0.3 },
    { mode: "screen", fill: "#5a5854", a: 0.12 },
  ], size);
  const ctx = c.getContext("2d");
  ctx.globalCompositeOperation = "overlay";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 18, 0);
    ctx.bezierCurveTo(40 + i * 10, 40, 20, 90, size, 60 + i * 8);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  return c;
}

function bakeWater(src, size = TEX) {
  return grade(src, [
    { mode: "multiply", fill: "#0c2438", a: 0.92 },
    { mode: "overlay", fill: "#1a5a78", a: 0.4 },
  ], size);
}

function bakeMoor(src, size = TEX) {
  return grade(src, [
    { mode: "multiply", fill: "#1a2a18", a: 0.75 },
    { mode: "overlay", fill: "#2a4a28", a: 0.35 },
  ], size);
}

export async function loadAssets() {
  const pack = {
    sprites: {},
    portraits: {},
    placeArt: {},
    tex: {},
    patterns: {},
    crest: null,
    ready: false,
  };

  const [cobble, wall, crest, ...rest] = await Promise.all([
    loadImage("assets/art/tex/cobble.png"),
    loadImage("assets/art/tex/wall.png"),
    loadImage("assets/art/crest.png"),
    ...Object.entries(SPRITE_FILES).map(async ([id, src]) => [id, chromaKey(await loadImage(src))]),
    ...Object.entries(PLACE_ART).map(async ([id, src]) => ["place:" + id, await loadImage(src)]),
  ]);

  pack.crest = crest;
  for (const item of rest) {
    if (!item) continue;
    if (Array.isArray(item)) {
      const [k, v] = item;
      if (k.startsWith("place:")) pack.placeArt[k.slice(6)] = v;
      else pack.sprites[k] = v;
    }
  }

  pack.tex.cobble = grade(cobble, [{ mode: "multiply", fill: "#6a5a48", a: 0.25 }]);
  pack.tex.ash = grade(cobble, [
    { mode: "multiply", fill: "#4a4034", a: 0.45 },
    { mode: "overlay", fill: "#2a241c", a: 0.2 },
  ]);
  pack.tex.path = grade(cobble, [{ mode: "overlay", fill: "#8a6a40", a: 0.35 }]);
  pack.tex.stone = grade(cobble, [{ mode: "multiply", fill: "#5a6068", a: 0.4 }]);
  pack.tex.sand = grade(cobble, [{ mode: "overlay", fill: "#c2a060", a: 0.4 }]);
  pack.tex.bridge = bakeWood(cobble);
  pack.tex.wood = bakeWood(cobble);
  pack.tex.marble = bakeMarble(cobble);
  pack.tex.water = bakeWater(cobble);
  pack.tex.moor = bakeMoor(cobble);
  pack.tex.grass = bakeMoor(cobble);
  pack.tex.rug = grade(cobble, [
    { mode: "multiply", fill: "#5a1020", a: 0.7 },
    { mode: "overlay", fill: "#8a2030", a: 0.35 },
  ]);
  pack.tex.wall = wall ? grade(wall, [{ mode: "multiply", fill: "#1a1614", a: 0.15 }]) : pack.tex.stone;
  pack.tex.column = pack.tex.wall;
  pack.tex.door = pack.tex.wall;
  pack.tex.rail = pack.tex.wall;

  for (const [id, spr] of Object.entries(pack.sprites)) {
    if (!spr) continue;
    const h = 280;
    const w = Math.max(1, Math.round((h * spr.width) / spr.height));
    const p = canvas(w, h);
    p.getContext("2d").drawImage(spr, 0, 0, w, h);
    pack.portraits[id] = p.toDataURL("image/png");
  }
  if (CAST.maia && pack.portraits.maia) CAST.maia.portrait = pack.portraits.maia;
  if (CAST.orlen && pack.portraits.orlen) CAST.orlen.portrait = pack.portraits.orlen;
  if (CAST.serath && pack.portraits.serath) CAST.serath.portrait = pack.portraits.serath;
  if (CAST.guardian && pack.portraits.guardian) CAST.guardian.portrait = pack.portraits.guardian;
  if (CAST.aldric && pack.portraits.theWill) CAST.aldric.portrait = pack.portraits.theWill;

  pack.ready = true;
  return pack;
}

export function spriteFor(who, assets) {
  if (!assets?.sprites) return null;
  if (who === "theWill") return assets.sprites.theWill;
  return assets.sprites[who] || null;
}
