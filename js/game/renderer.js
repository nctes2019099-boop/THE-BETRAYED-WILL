import { TILE, LAYER_STACK } from "./layers.js";
import { cameraOffset } from "./camera.js";

export const TILE_SIZE = 40;

const TILE_COLOR = {
  [TILE.VOID]: "#050308",
  [TILE.ASH]: "#3a342c",
  [TILE.PATH]: "#5a4a38",
  [TILE.STONE]: "#4a4e55",
  [TILE.WATER]: "#1a3348",
  [TILE.WALL]: "#1a1614",
  [TILE.WOOD]: "#4a301c",
  [TILE.MARBLE]: "#6a6864",
  [TILE.GRASS]: "#2a3a24",
  [TILE.MOOR]: "#243028",
  [TILE.DOOR]: "#6a4020",
  [TILE.COLUMN]: "#2c2826",
  [TILE.RUG]: "#5a2030",
  [TILE.RAIL]: "#2a2420",
  [TILE.SAND]: "#6a5a40",
  [TILE.BRIDGE]: "#5a4030",
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  const particles = [];
  let t = 0;
  const rand = () => Math.random();

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, dpr };
  }

  function spawnWeather(kind, w, h) {
    if (kind === "none") return;
    if (particles.length > 220) return;
    particles.push({
      x: rand() * w,
      y: -10,
      vx: kind === "ashfall" ? 12 : kind === "mist" ? 20 : 8,
      vy: kind === "mist" ? 8 : 40 + rand() * 40,
      a: 0.15 + rand() * 0.35,
      s: kind === "mist" ? 8 + rand() * 18 : 1 + rand() * 2,
      kind,
    });
  }

  function drawTiles(map, cam, view) {
    const ts = TILE_SIZE * cam.zoom;
    const ox = view.w / 2 - cam.x * ts + view.shake.x;
    const oy = view.h / 2 - cam.y * ts + view.shake.y;
    const x0 = Math.max(0, Math.floor((0 - ox) / ts) - 1);
    const y0 = Math.max(0, Math.floor((0 - oy) / ts) - 1);
    const x1 = Math.min(map.w, Math.ceil((view.w - ox) / ts) + 1);
    const y1 = Math.min(map.h, Math.ceil((view.h - oy) / ts) + 1);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const t0 = map.tiles[y * map.w + x];
        ctx.fillStyle = TILE_COLOR[t0] || "#111";
        ctx.fillRect(ox + x * ts, oy + y * ts, ts + 0.5, ts + 0.5);
        if (t0 === TILE.WATER) {
          ctx.fillStyle = `rgba(80,160,200,${0.08 + Math.sin(t * 2 + x * 0.3 + y * 0.2) * 0.05})`;
          ctx.fillRect(ox + x * ts, oy + y * ts, ts, ts);
        }
        if (t0 === TILE.WALL) {
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fillRect(ox + x * ts, oy + y * ts, ts, ts * 0.18);
        }
        if (t0 === TILE.COLUMN) {
          ctx.fillStyle = "#8a8070";
          ctx.beginPath();
          ctx.arc(ox + x * ts + ts / 2, oy + y * ts + ts / 2, ts * 0.28, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    return { ox, oy, ts };
  }

  function drawActor(px, py, color, isPlayer, ox, oy, ts) {
    const x = ox + px * ts;
    const y = oy + py * ts;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(x, y + ts * 0.18, ts * 0.22, ts * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y - ts * 0.08, ts * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = isPlayer ? "#1a120c" : "#120c0a";
    ctx.fillRect(x - ts * 0.16, y + ts * 0.02, ts * 0.32, ts * 0.28);
    if (isPlayer) {
      ctx.strokeStyle = "rgba(232,196,120,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y - ts * 0.08, ts * 0.28, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawLights(lights, ox, oy, ts, w, h) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const L of lights) {
      const x = ox + L.x * ts;
      const y = oy + L.y * ts;
      const r = L.r * ts * (1.05 + Math.sin(t * 3 + L.x) * 0.05);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, hexA(L.c, L.a));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
    ctx.fillStyle = "rgba(6,4,10,0.28)";
    ctx.fillRect(0, 0, w, h);
  }

  function drawWeather(kind, dt, w, h) {
    spawnWeather(kind, w, h);
    spawnWeather(kind, w, h);
    ctx.fillStyle = "#c8c0b0";
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y > h + 20) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = p.a;
      if (p.kind === "mist") {
        ctx.fillStyle = "#9ab0b8";
        ctx.fillRect(p.x, p.y, p.s, p.s * 0.4);
      } else {
        ctx.fillStyle = p.kind === "embers" ? "#ff8040" : "#c8c0b0";
        ctx.fillRect(p.x, p.y, p.s, p.s);
      }
    }
    ctx.globalAlpha = 1;
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
    ctx.fillStyle = "#07060a";
    ctx.fillRect(0, 0, w, h);
    const cam = state.camera;
    const shake = cameraOffset(cam, rand);
    const view = { w, h, shake };
    const map = state.map;
    if (!map) return { w, h };
    const { ox, oy, ts } = drawTiles(map, cam, view);

    for (const e of state.placeEntities) {
      if (e.type === "item" && state.flags[e.flag]) continue;
      if (e.type === "item") {
        ctx.fillStyle = "#e8c060";
        ctx.globalAlpha = 0.7 + Math.sin(t * 4) * 0.3;
        ctx.beginPath();
        ctx.arc(ox + e.x * ts, oy + e.y * ts, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (e.type === "exit") {
        ctx.strokeStyle = "rgba(200,170,90,0.45)";
        ctx.strokeRect(ox + e.x * ts - ts * 0.3, oy + e.y * ts - ts * 0.3, ts * 0.6, ts * 0.6);
      }
      if (e.type === "npc") {
        const who = state.cast[e.who];
        drawActor(e.wx ?? e.x, e.wy ?? e.y, who?.color || "#aaa", false, ox, oy, ts);
      }
      if (e.type === "combat" && !state.flags[e.flag]) {
        ctx.fillStyle = "#a03040";
        ctx.beginPath();
        ctx.arc(ox + e.x * ts, oy + e.y * ts, 7 + Math.sin(t * 5) * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawActor(state.player.x, state.player.y, state.cast.lyen.color, true, ox, oy, ts);
    drawLights(state.place.lights, ox, oy, ts, w, h);
    drawWeather(state.place.weather, dt, w, h);
    letterbox(h, w, cam.letterbox);
    return { w, h, ox, oy, ts };
  }

  return { frame, resize, layers: LAYER_STACK };
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
