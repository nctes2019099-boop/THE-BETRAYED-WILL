/**
 * THE BETRAYED WILL — materials.js
 *
 * The material library, built from the same MATERIALS table the world generator
 * already reads.
 *
 * Two rules shape this file.
 *
 * First, nothing is downloaded. Every texture here is drawn into a canvas at boot
 * from a seeded RNG, so the same build produces the same mud brick on every machine
 * and there is no asset pipeline to break. The brief forbids external assets; this is
 * what complying with that actually looks like in practice.
 *
 * Second, the renderer does not get to invent materials. A collider says
 * `material: 'bakedBrick'` and the mesh that draws it uses the color, roughness and
 * metalness the content layer declared for baked brick. If those two ever diverge the
 * world stops looking like the thing the simulation is reasoning about, and the
 * divergence is invisible until a player reports that a wall they could see through
 * blocked them.
 *
 * Textures are per-material and cached, so a region with four hundred mud-brick
 * colliders allocates one canvas, not four hundred.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { RNG, hashString } from '../core/rng.js';
import { MATERIALS } from '../content/world-data.js';

/** Texture edge length. 256 is enough to read as brick at arm's length and cheap to draw. */
const TEX_SIZE = 256;

/**
 * Which surface pattern a material gets.
 *
 * Grouped rather than per-material because the pattern is a property of how the
 * stuff is made, not of its color: every fired-brick surface in Mesopotamia is
 * laid in courses, and drawing four hundred of them by hand would produce four
 * hundred slightly different lies.
 */
const PATTERN = {
  mudBrick: 'brick', mudBrickDark: 'brick', bakedBrick: 'brick', bakedBrickGl: 'brickGlazed',
  plaster: 'mottle', limestone: 'mottle', sand: 'grain', silt: 'grain', ash: 'grain',
  palmWood: 'wood', poplarWood: 'wood', reed: 'weave', linen: 'weave', wool: 'weave',
  leather: 'mottle', clay: 'mottle', terracotta: 'mottle', bitumen: 'mottle',
  bronze: 'metal', copper: 'metal', iron: 'metal', gold: 'metal', lapis: 'metal',
  water: 'water', blood: 'mottle',
};

function makeCanvas(size) {
  const canvas = typeof document !== 'undefined' && document.createElement
    ? document.createElement('canvas')
    : null;
  if (!canvas) return null;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

function hexToRgb(hex) {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

const rgb = (c, m = 1) => `rgb(${Math.round(c.r * m)},${Math.round(c.g * m)},${Math.round(c.b * m)})`;

/**
 * Draw one material's albedo into a canvas.
 *
 * Returns null when there is no DOM (a headless test importing this module gets a
 * working material with no texture rather than a crash), which is why every caller
 * treats the texture as optional.
 */
export function drawMaterialTexture(id) {
  const def = MATERIALS[id];
  if (!def) return null;
  const surface = makeCanvas(TEX_SIZE);
  if (!surface) return null;
  const { canvas, ctx } = surface;
  const rng = new RNG(hashString(`tex:${id}`));
  const base = hexToRgb(def.color);
  const pattern = PATTERN[id] ?? 'mottle';
  const S = TEX_SIZE;

  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, S, S);

  /** Speckle every pattern with low-frequency variation so no surface is flat. */
  const mottle = (amount, cells) => {
    for (let i = 0; i < cells; i++) {
      const x = rng.next() * S;
      const y = rng.next() * S;
      const r = 6 + rng.next() * 34;
      const m = 1 + (rng.next() * 2 - 1) * amount;
      ctx.fillStyle = rgb(base, m);
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  switch (pattern) {
    case 'brick':
    case 'brickGlazed': {
      // Running bond: every other course is offset by half a brick, which is what
      // makes a wall read as laid rather than printed.
      const rows = 8;
      const cols = 4;
      const bh = S / rows;
      const bw = S / cols;
      for (let r = 0; r < rows; r++) {
        const offset = (r % 2) * (bw / 2);
        for (let c = -1; c <= cols; c++) {
          const x = c * bw + offset;
          const y = r * bh;
          const tone = 1 + (rng.next() * 2 - 1) * (pattern === 'brickGlazed' ? 0.05 : 0.13);
          ctx.fillStyle = rgb(base, tone);
          ctx.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
        }
      }
      // Mortar is darker and rougher than the brick; drawing it as gaps alone leaves
      // the joints the same color as the brick lit from another angle.
      ctx.strokeStyle = rgb(base, 0.72);
      ctx.lineWidth = 3;
      for (let r = 0; r <= rows; r++) {
        ctx.beginPath(); ctx.moveTo(0, r * bh); ctx.lineTo(S, r * bh); ctx.stroke();
      }
      for (let r = 0; r < rows; r++) {
        const offset = (r % 2) * (bw / 2);
        for (let c = 0; c <= cols; c++) {
          const x = c * bw + offset;
          ctx.beginPath(); ctx.moveTo(x, r * bh); ctx.lineTo(x, (r + 1) * bh); ctx.stroke();
        }
      }
      if (pattern === 'brickGlazed') {
        // Glazed brick carries a specular sheen band; the roughness value already
        // says 0.34, and this is the albedo half of the same idea.
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, S * 0.34, S, S * 0.1);
        ctx.globalAlpha = 1;
      }
      mottle(0.06, 40);
      break;
    }
    case 'wood': {
      for (let i = 0; i < 90; i++) {
        const y = rng.next() * S;
        ctx.strokeStyle = rgb(base, 0.82 + rng.next() * 0.3);
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 0.6 + rng.next() * 2.2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        // Grain wanders. A straight line reads as plastic.
        for (let x = 0; x <= S; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.05 + i) * 2.4 + (rng.next() - 0.5) * 1.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Knots
      for (let i = 0; i < 3; i++) {
        const x = rng.next() * S, y = rng.next() * S;
        ctx.fillStyle = rgb(base, 0.66);
        ctx.beginPath(); ctx.ellipse(x, y, 7 + rng.next() * 5, 4 + rng.next() * 3, rng.next() * 3, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'weave': {
      const step = 8;
      for (let y = 0; y < S; y += step) {
        for (let x = 0; x < S; x += step) {
          const over = ((x / step) + (y / step)) % 2 === 0;
          ctx.fillStyle = rgb(base, over ? 1.08 : 0.9);
          ctx.globalAlpha = 0.5;
          ctx.fillRect(x, y, step - 1, step - 1);
        }
      }
      ctx.globalAlpha = 1;
      mottle(0.08, 50);
      break;
    }
    case 'metal': {
      mottle(0.1, 70);
      // Hammered facets and a little patina, because a perfectly even metal texture
      // reads as plastic under a moving light.
      for (let i = 0; i < 130; i++) {
        const x = rng.next() * S, y = rng.next() * S;
        ctx.strokeStyle = rgb(base, 1.16);
        ctx.globalAlpha = 0.1;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, 3 + rng.next() * 9, rng.next() * 3, rng.next() * 3 + 2); ctx.stroke();
      }
      if (id === 'copper' || id === 'bronze') {
        for (let i = 0; i < 26; i++) {
          ctx.fillStyle = 'rgb(74,124,110)';
          ctx.globalAlpha = 0.09;
          ctx.beginPath(); ctx.arc(rng.next() * S, rng.next() * S, 5 + rng.next() * 16, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'water': {
      for (let i = 0; i < 46; i++) {
        ctx.strokeStyle = rgb(base, 1.2);
        ctx.globalAlpha = 0.09;
        ctx.lineWidth = 1 + rng.next() * 3;
        const y = rng.next() * S;
        ctx.beginPath();
        for (let x = 0; x <= S; x += 12) ctx.lineTo(x, y + Math.sin(x * 0.06 + i * 0.7) * 5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'grain': {
      for (let i = 0; i < 5200; i++) {
        ctx.fillStyle = rgb(base, 0.88 + rng.next() * 0.26);
        ctx.globalAlpha = 0.4;
        ctx.fillRect(rng.next() * S, rng.next() * S, 1.6, 1.6);
      }
      ctx.globalAlpha = 1;
      mottle(0.07, 40);
      break;
    }
    default: { // mottle
      mottle(0.12, 120);
      for (let i = 0; i < 22; i++) {
        // Hairline cracks. Plaster and limestone are never unbroken.
        ctx.strokeStyle = rgb(base, 0.78);
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 0.7 + rng.next();
        let x = rng.next() * S, y = rng.next() * S;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < 7; s++) {
          x += (rng.next() - 0.5) * 46; y += (rng.next() - 0.5) * 46;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  return canvas;
}

export class MaterialLibrary {
  constructor({ anisotropy = 4, textures = true } = {}) {
    this.anisotropy = anisotropy;
    this.useTextures = textures !== false;
    this.textures = new Map();
    this.materials = new Map();
    this.stats = { built: 0, textured: 0, fallbacks: 0 };
  }

  /** The Three.js material for a content-layer material id. */
  get(id) {
    const key = MATERIALS[id] ? id : 'mudBrick';
    if (key !== id) this.stats.fallbacks++;
    if (this.materials.has(key)) return this.materials.get(key);

    const def = MATERIALS[key];
    const params = {
      color: def.color,
      roughness: def.roughness,
      metalness: def.metalness,
    };

    if (this.useTextures) {
      const canvas = drawMaterialTexture(key);
      if (canvas) {
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.anisotropy;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.textures.set(key, tex);
        params.map = tex;
        this.stats.textured++;
      }
    }
    if (key === 'water') {
      params.transparent = true;
      params.opacity = 0.82;
      params.roughness = 0.08;
    }

    const mat = new THREE.MeshStandardMaterial(params);
    mat.name = `mat:${key}`;
    this.materials.set(key, mat);
    this.stats.built++;
    return mat;
  }

  /**
   * Texture repeat for a surface of the given world size.
   *
   * Without this a 40 m wall stretches one 2 m brick pattern across itself and the
   * bricks become the size of doors. Repeat is derived from area so the texel
   * density is roughly constant, which is the whole point of tiling.
   */
  static repeatFor(widthM, heightM, texelM = 2.0) {
    return {
      x: Math.max(1, Math.round(widthM / texelM)),
      y: Math.max(1, Math.round(heightM / texelM)),
    };
  }

  /** A material whose texture repeats for a specific face size. Cached per size. */
  variant(id, repeatX, repeatY) {
    const cacheKey = `${id}@${repeatX}x${repeatY}`;
    if (this.materials.has(cacheKey)) return this.materials.get(cacheKey);
    const base = this.get(id);
    const clone = base.clone();
    if (base.map) {
      clone.map = base.map.clone();
      clone.map.repeat.set(repeatX, repeatY);
      clone.map.needsUpdate = true;
    }
    clone.name = cacheKey;
    this.materials.set(cacheKey, clone);
    return clone;
  }

  dispose() {
    for (const tex of this.textures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    this.textures.clear();
    this.materials.clear();
  }
}
