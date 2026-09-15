import { TILE, LAYER_STACK } from "./layers.js";
import { cameraOffset } from "./camera.js";
import { spriteFor } from "./assets.js";

export const TILE_SIZE = 52;

const FLOOR_TEX = {
  [TILE.ASH]: "ash",
  [TILE.PATH]: "path",
  [TILE.STONE]: "stone",
  [TILE.WATER]: "water",
  [TILE.WOOD]: "wood",
  [TILE.MARBLE]: "marble",
  [TILE.GRASS]: "grass",
  [TILE.MOOR]: "moor",
  [TILE.DOOR]: "path",
  [TILE.RUG]: "rug",
  [TILE.SAND]: "sand",
  [TILE.BRIDGE]: "bridge",
};

function isTall(t) {
  return t === TILE.WALL || t === TILE.RAIL || t === TILE.COLUMN;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const particles = [];
  let t = 0;
  let assets = null;
  const rand = () => Math.random();

  function use(a) {
    assets = a;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const tw = Math.floor(w * dpr);
    const th = Math.floor(h * dpr);
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return { w, h, dpr };
  }

  function tex(name) {
    return assets?.tex?.[name] || null;
  }

  function paintTile(img, dx, dy, dw, dh, u, v) {
    if (!img) {
      ctx.fillStyle = "#2a2420";
      ctx.fillRect(dx, dy, dw, dh);
      return;
    }
    ctx.drawImage(img, dx, dy, dw + 0.6, dh + 0.6);
    const shade = ((u * 13 + v * 7) & 7) * 0.028;
    ctx.fillStyle = `rgba(0,0,0,${shade})`;
    ctx.fillRect(dx, dy, dw, dh);
  }

  function drawBackdrop(place, cam, w, h) {
    const art = assets?.placeArt?.[place.id];
    ctx.fillStyle = "#07060c";
    ctx.fillRect(0, 0, w, h);
    if (!art) return;
    const scale = Math.max(w / art.naturalWidth, h / art.naturalHeight) * 1.12;
    const pw = art.naturalWidth * scale;
    const ph = art.naturalHeight * scale;
    const px = (w - pw) / 2 - (cam.x - 20) * 1.6;
    const py = (h - ph) / 2 - (cam.y - 14) * 1.2;
    ctx.globalAlpha = 0.4;
    ctx.drawImage(art, px, py, pw, ph);
    ctx.globalAlpha = 1;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(6,5,10,0.35)");
    g.addColorStop(0.45, "rgba(6,5,10,0.15)");
    g.addColorStop(1, "rgba(6,5,10,0.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  function drawFloors(map, ox, oy, ts, x0, y0, x1, y1) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const t0 = map.tiles[y * map.w + x];
        if (isTall(t0) && t0 !== TILE.COLUMN) continue;
        const name = FLOOR_TEX[t0] || "ash";
        const dx = ox + x * ts;
        const dy = oy + y * ts;
        const img = tex(name);
        paintTile(img, dx, dy, ts, ts, x, y);
        if (t0 === TILE.WATER) {
          ctx.fillStyle = `rgba(120,190,220,${0.07 + Math.sin(t * 2.2 + x * 0.4 + y * 0.35) * 0.05})`;
          ctx.fillRect(dx, dy, ts, ts);
        }
        if (t0 === TILE.PATH) {
          ctx.fillStyle = "rgba(0,0,0,0.12)";
          ctx.fillRect(dx, dy + ts * 0.82, ts, ts * 0.18);
        }
      }
    }
  }

  function drawWall(x, y, ox, oy, ts, map) {
    const dx = ox + x * ts;
    const base = oy + y * ts;
    const wallH = ts * 1.22;
    const top = base - wallH + ts * 0.18;
    const img = tex("wall");
    paintTile(img, dx, top, ts, wallH, x, y);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(dx, top, ts, wallH * 0.18);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(dx, top + 2, ts, 3);
    const below = y + 1 < map.h ? map.tiles[(y + 1) * map.w + x] : TILE.WALL;
    if (!isTall(below)) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(dx, base + ts * 0.02, ts, ts * 0.16);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, top + 0.5, ts - 1, wallH - 1);
  }

  function drawColumn(x, y, ox, oy, ts) {
    const cx = ox + x * ts + ts / 2;
    const base = oy + y * ts + ts * 0.55;
    const h = ts * 1.7;
    const img = tex("wall");
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - ts * 0.22, base - h, ts * 0.44, h);
    ctx.clip();
    if (img) ctx.drawImage(img, cx - ts * 0.22, base - h, ts * 0.44, h);
    else {
      ctx.fillStyle = "#3a3834";
      ctx.fillRect(cx - ts * 0.22, base - h, ts * 0.44, h);
    }
    ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.ellipse(cx, base + 4, ts * 0.28, ts * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(210,190,150,0.18)";
    ctx.fillRect(cx - ts * 0.24, base - h - 4, ts * 0.48, 10);
  }

  function drawDoor(x, y, ox, oy, ts) {
    const dx = ox + x * ts;
    const base = oy + y * ts;
    const wallH = ts * 1.15;
    const top = base - wallH + ts * 0.25;
    paintTile(tex("wall"), dx, top, ts, wallH, x, y);
    ctx.fillStyle = "rgba(8,6,10,0.82)";
    ctx.beginPath();
    ctx.moveTo(dx + ts * 0.18, base + ts * 0.15);
    ctx.lineTo(dx + ts * 0.18, top + ts * 0.35);
    ctx.quadraticCurveTo(dx + ts * 0.5, top + ts * 0.05, dx + ts * 0.82, top + ts * 0.35);
    ctx.lineTo(dx + ts * 0.82, base + ts * 0.15);
    ctx.fill();
    ctx.strokeStyle = "rgba(201,162,39,0.45)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawShadow(x, y, w, h) {
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSprite(spr, px, py, ox, oy, ts, dir, moving, ghost) {
    const feetX = ox + px * ts;
    const feetY = oy + py * ts;
    const bob = moving
      ? Math.abs(Math.sin(t * 13)) * ts * 0.045
      : Math.sin(t * 2.1 + px) * ts * 0.012;
    const h = ts * 2.42;
    const ratio = spr.width / spr.height;
    const w = Math.min(h * ratio, ts * 1.85);
    drawShadow(feetX, feetY + ts * 0.05, w * 0.22, ts * 0.11);
    ctx.save();
    ctx.translate(feetX, feetY + bob);
    if (dir === "left") ctx.scale(-1, 1);
    if (ghost) {
      ctx.globalAlpha = 0.72;
      ctx.filter = "sepia(0.35) hue-rotate(160deg) brightness(1.15)";
    }
    ctx.drawImage(spr, -w / 2, -h + ts * 0.1, w, h);
    ctx.restore();
  }

  function drawItem(e, ox, oy, ts) {
    const x = ox + (e.wx ?? e.x + 0.5) * ts;
    const y = oy + (e.wy ?? e.y + 0.5) * ts;
    const pulse = 0.75 + Math.sin(t * 4) * 0.25;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(x, y - 8, 2, x, y - 8, 22 * pulse);
    g.addColorStop(0, "rgba(255,210,120,0.7)");
    g.addColorStop(1, "rgba(255,180,60,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - 24, y - 32, 48, 48);
    ctx.restore();
    const crest = assets?.crest;
    if (crest) {
      ctx.drawImage(crest, x - 12, y - 26, 24, 24);
    } else {
      ctx.fillStyle = "#e8c060";
      ctx.beginPath();
      ctx.arc(x, y - 10, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawExit(e, ox, oy, ts) {
    const x = ox + (e.wx ?? e.x + 0.5) * ts;
    const y = oy + (e.wy ?? e.y + 0.5) * ts;
    const g = ctx.createRadialGradient(x, y, 4, x, y, ts * 0.7);
    g.addColorStop(0, "rgba(232,196,120,0.35)");
    g.addColorStop(1, "rgba(232,196,120,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, ts * 0.42, ts * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawGlint(x, y) {
    const a = 0.35 + Math.sin(t * 5 + x) * 0.2;
    ctx.fillStyle = `rgba(240,220,160,${a})`;
    ctx.beginPath();
    ctx.arc(x, y - 10, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawActor(who, px, py, ox, oy, ts, dir, moving) {
    const spr = spriteFor(who, assets);
    if (spr) {
      drawSprite(spr, px, py, ox, oy, ts, dir, moving, who === "aldric");
      return;
    }
    const color = "#c4b090";
    const x = ox + px * ts;
    const y = oy + py * ts;
    drawShadow(x, y, ts * 0.22, ts * 0.1);
    ctx.fillStyle = color;
    ctx.fillRect(x - ts * 0.16, y - ts * 0.85, ts * 0.32, ts * 0.85);
  }

  function spawnWeather(kind, w, h) {
    if (kind === "none") return;
    if (particles.length > 260) return;
    const mist = kind === "mist";
    particles.push({
      x: rand() * w,
      y: -12,
      vx: kind === "ashfall" ? 18 + rand() * 10 : mist ? 28 : 10,
      vy: mist ? 10 + rand() * 8 : 36 + rand() * 50,
      a: 0.12 + rand() * 0.35,
      s: mist ? 14 + rand() * 28 : 1.2 + rand() * 2.4,
      kind,
      rot: rand() * 6,
    });
  }

  function drawWeather(kind, dt, w, h) {
    spawnWeather(kind, w, h);
    spawnWeather(kind, w, h);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += dt;
      if (p.y > h + 30) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = p.a;
      if (p.kind === "mist") {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.s);
        g.addColorStop(0, "rgba(180,200,210,0.55)");
        g.addColorStop(1, "rgba(180,200,210,0)");
        ctx.fillStyle = g;
        ctx.fillRect(p.x - p.s, p.y - p.s * 0.5, p.s * 2, p.s);
      } else if (p.kind === "embers") {
        ctx.fillStyle = "#ff6a30";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = "#d8d0c4";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.s * 1.6, p.s * 0.6, p.rot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawLights(lights, ox, oy, ts, w, h) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const L of lights) {
      const x = ox + L.x * ts;
      const y = oy + L.y * ts;
      const r = L.r * ts * (1.08 + Math.sin(t * 2.6 + L.x) * 0.06);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, hexA(L.c, L.a * 0.85));
      g.addColorStop(0.45, hexA(L.c, L.a * 0.25));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
    const vg = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.15, w / 2, h * 0.5, h * 0.78);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(6,4,10,0.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  function letterbox(h, w, amount) {
    if (amount <= 0.001) return;
    const bar = h * amount;
    ctx.fillStyle = "#050308";
    ctx.fillRect(0, 0, w, bar);
    ctx.fillRect(0, h - bar, w, bar);
  }

  function frame(state, dt) {
    t += dt;
    const { w, h } = resize();
    const cam = state.camera;
    const shake = cameraOffset(cam, rand);
    const map = state.map;
    if (!map) {
      ctx.fillStyle = "#07060a";
      ctx.fillRect(0, 0, w, h);
      return { w, h };
    }
    drawBackdrop(state.place, cam, w, h);
    const ts = TILE_SIZE * cam.zoom;
    const ox = w / 2 - cam.x * ts + shake.x;
    const oy = h / 2 - cam.y * ts + shake.y;
    const x0 = Math.max(0, Math.floor((0 - ox) / ts) - 2);
    const y0 = Math.max(0, Math.floor((0 - oy) / ts) - 3);
    const x1 = Math.min(map.w, Math.ceil((w - ox) / ts) + 2);
    const y1 = Math.min(map.h, Math.ceil((h - oy) / ts) + 3);

    drawFloors(map, ox, oy, ts, x0, y0, x1, y1);

    const drawList = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const t0 = map.tiles[y * map.w + x];
        if (t0 === TILE.WALL || t0 === TILE.RAIL) drawList.push({ y: y + 0.55, kind: "wall", x, ty: y });
        else if (t0 === TILE.COLUMN) drawList.push({ y: y + 0.6, kind: "col", x, ty: y });
        else if (t0 === TILE.DOOR) drawList.push({ y: y + 0.5, kind: "door", x, ty: y });
      }
    }
    for (const e of state.placeEntities) {
      if (e.type === "item" && state.flags[e.flag]) continue;
      if (e.type === "combat" && state.flags[e.flag]) continue;
      if (e.type === "item") drawList.push({ y: e.y, kind: "item", e });
      else if (e.type === "exit") drawList.push({ y: e.y - 0.2, kind: "exit", e });
      else if (e.type === "inspect") drawList.push({ y: e.y, kind: "glint", e });
      else if (e.type === "npc") {
        drawList.push({
          y: e.wy ?? e.y,
          kind: "npc",
          e,
          who: e.who,
        });
      } else if (e.type === "combat") drawList.push({ y: e.y, kind: "foe", e });
    }
    drawList.push({
      y: state.player.y,
      kind: "player",
    });
    drawList.sort((a, b) => a.y - b.y);

    for (const d of drawList) {
      if (d.kind === "wall") drawWall(d.x, d.ty, ox, oy, ts, map);
      else if (d.kind === "col") drawColumn(d.x, d.ty, ox, oy, ts);
      else if (d.kind === "door") drawDoor(d.x, d.ty, ox, oy, ts);
      else if (d.kind === "item") drawItem(d.e, ox, oy, ts);
      else if (d.kind === "exit") drawExit(d.e, ox, oy, ts);
      else if (d.kind === "glint") drawGlint(ox + (d.e.wx ?? d.e.x + 0.5) * ts, oy + (d.e.wy ?? d.e.y + 0.5) * ts);
      else if (d.kind === "npc") {
        const dir = (d.e.wx ?? d.e.x) < state.player.x ? "right" : "left";
        drawActor(d.who, d.e.wx ?? d.e.x + 0.5, d.e.wy ?? d.e.y + 0.5, ox, oy, ts, dir, false);
      }
      else if (d.kind === "foe") {
        drawActor("guardian", d.e.x + 0.5, d.e.y + 0.5, ox, oy, ts, "left", true);
      }
      else if (d.kind === "player") {
        drawActor(
          "lyen",
          state.player.x,
          state.player.y,
          ox,
          oy,
          ts,
          state.player.dir || "down",
          state.player.moving
        );
      }
    }

    drawLights(state.place.lights, ox, oy, ts, w, h);
    drawWeather(state.place.weather, dt, w, h);
    letterbox(h, w, cam.letterbox);
    return { w, h, ox, oy, ts };
  }

  return { frame, resize, use, layers: LAYER_STACK };
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
