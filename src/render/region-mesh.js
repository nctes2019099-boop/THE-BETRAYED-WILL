/**
 * THE BETRAYED WILL — region-mesh.js
 *
 * Turns a built RegionSpace into Three.js geometry.
 *
 * ── The renderer reads the simulation, it does not parallel it ───────────────
 * Every solid surface here comes from `space.collision.colliders`, the same boxes
 * the movement, sight and camera systems resolve against. Nothing in this file
 * invents a wall. That is the difference between a world that looks right and a
 * world that IS right: if the meshes were authored separately from the colliders,
 * the two would drift, and the drift shows up as a wall you can see through or a
 * doorway you cannot walk into - the two bugs players report most and developers
 * reproduce least.
 *
 * ── Why merged geometry rather than instancing ───────────────────────────────
 * Colliders are all axis-aligned boxes, which makes InstancedMesh the obvious
 * answer, and it is the wrong one here. An instanced mesh shares one material, so
 * one texture repeat has to serve a 40 m perimeter wall and a 1 m storage crate
 * alike; whichever it is tuned for, the other looks wrong. These boxes are merged
 * per material instead, with UVs scaled from each face's own world dimensions, so
 * texel density is constant across the whole region AND the draw-call count is the
 * number of materials rather than the number of colliders. PERF.MAX_DRAW_CALLS is
 * 420; a full region lands in the tens.
 *
 * ── Props are dressing, and say so when they are unknown ─────────────────────
 * `space.props` carries kinds the generator scattered. An unrecognized kind falls
 * back to a plain box and is counted in diagnostics, because the alternative -
 * silently drawing nothing - is how a new landmark type ships invisible.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { PERF } from '../core/constants.js';
import { MATERIALS } from '../content/world-data.js';
import { RNG, hashCombine, hashString } from '../core/rng.js';

/** Metres of world surface one texture tile covers. */
const TEXEL_M = 2.0;

/** Ground mesh sampling step, in metres. */
const GROUND_STEP = 1.5;

/** Point lights per region. Torches are numerous; real-time lights are not free. */
const MAX_LIGHTS = 10;

const FACE_NORMALS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * Append one axis-aligned box, with UVs scaled to each face's world size.
 *
 * Non-indexed on purpose: 36 vertices per box is cheap at these counts, and it
 * keeps the per-face UV math in one place instead of split between a vertex table
 * and an index table that have to agree.
 */
function pushBox(acc, cx, cy, cz, sx, sy, sz, uOf, vOf) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const corners = [
    // +X, -X, +Y, -Y, +Z, -Z, each as four corners in CCW order from outside
    [[hx, -hy, -hz], [hx, -hy, hz], [hx, hy, hz], [hx, hy, -hz]],
    [[-hx, -hy, hz], [-hx, -hy, -hz], [-hx, hy, -hz], [-hx, hy, hz]],
    [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]],
    [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]],
    [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]],
    [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]],
  ];
  // World extents of each face, for texel-density-correct UVs.
  const faceSize = [
    [sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy],
  ];
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];

  for (let f = 0; f < 6; f++) {
    const n = FACE_NORMALS[f];
    const [fw, fh] = faceSize[f];
    const ru = Math.max(1, fw / TEXEL_M);
    const rv = Math.max(1, fh / TEXEL_M);
    const quad = corners[f];
    // Two triangles: 0,1,2 and 0,2,3
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const c = quad[idx];
      acc.pos.push(cx + c[0], cy + c[1], cz + c[2]);
      acc.nrm.push(n[0], n[1], n[2]);
      const uv = uvs[idx];
      acc.uv.push(uv[0] * ru, uv[1] * rv);
    }
  }
  if (typeof uOf === 'function') uOf(sx, sy, sz);
  if (typeof vOf === 'function') vOf(sx, sy, sz);
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m3 = new THREE.Matrix3();
const _matrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

/**
 * Append an already-built geometry into a merge accumulator at a transform.
 *
 * This is what lets a hundred scattered pebbles cost one draw call instead of a
 * hundred. The temporary geometry is disposed afterwards: its vertices have been
 * copied, and keeping it alive would hold CPU memory for something the GPU now owns.
 */
function appendGeometry(acc, geom, matrix) {
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  const uv = geom.attributes.uv;
  const index = geom.index;
  _m3.getNormalMatrix(matrix);
  const count = pos.count;
  const order = index ? Array.from(index.array) : Array.from({ length: count }, (_, i) => i);
  for (const i of order) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    acc.pos.push(_v.x, _v.y, _v.z);
    if (nrm) {
      _n.fromBufferAttribute(nrm, i).applyMatrix3(_m3).normalize();
      acc.nrm.push(_n.x, _n.y, _n.z);
    } else {
      acc.nrm.push(0, 1, 0);
    }
    acc.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
  }
  geom.dispose();
}

function finishGeometry(acc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
  g.computeBoundingSphere();
  return g;
}

export class RegionMesh {
  /**
   * @param {RegionSpace} space a built region from src/sim/world.js
   * @param {MaterialLibrary} mats
   */
  constructor(space, mats) {
    this.space = space;
    this.mats = mats;
    this.group = new THREE.Group();
    this.group.name = `region:${space.id}`;
    this.group.matrixAutoUpdate = false;

    this.lights = [];
    this.animated = [];
    this.diagnostics = {
      colliders: 0, mergedGroups: 0, props: 0, mergedProps: 0, unknownProps: [],
      groundVerts: 0, lights: 0, lightsCulled: 0, buildMs: 0,
    };

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._buildGround();
    this._buildSolids();
    this._buildProps();
    this._buildDoors();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.diagnostics.buildMs = t1 - t0;
  }

  /* --------------------------------------------------------------- ground */

  _buildGround() {
    const space = this.space;
    const [x0, x1] = space.bounds.x;
    const [z0, z1] = space.bounds.z;
    const w = x1 - x0;
    const d = z1 - z0;
    const nx = Math.max(2, Math.ceil(w / GROUND_STEP));
    const nz = Math.max(2, Math.ceil(d / GROUND_STEP));

    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];

    // Sampled from the same height field the collision world uses, so a descending
    // stairwell renders as the stairs the player actually walks down. A flat plane
    // with a heightFn underneath would put the floor through the steps.
    const heightAt = (x, z) => space.heightAt(x, z);

    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) {
        const x = x0 + (w * ix) / nx;
        const z = z0 + (d * iz) / nz;
        const y = heightAt(x, z);
        pos.push(x, y, z);
        uv.push((x - x0) / TEXEL_M, (z - z0) / TEXEL_M);
        nrm.push(0, 1, 0); // recomputed below from the actual surface
      }
    }
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = iz * (nx + 1) + ix;
        const b = a + 1;
        const c = a + (nx + 1);
        const e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, this.mats.get(space.region.ground ?? 'sand'));
    mesh.name = `ground:${space.id}`;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.ground = mesh;
    this.diagnostics.groundVerts = pos.length / 3;
  }

  /* --------------------------------------------------------------- solids */

  _buildSolids() {
    const byMaterial = new Map();
    for (const col of this.space.collision.colliders) {
      if (!col.enabled) continue;
      // A collider that blocks nothing is a trigger volume, not a surface. Drawing
      // it would put visible geometry where the player is meant to walk through.
      if (!col.blocksMovement && !col.blocksSight) continue;
      const id = MATERIALS[col.material] ? col.material : 'mudBrick';
      if (!byMaterial.has(id)) byMaterial.set(id, { pos: [], nrm: [], uv: [], count: 0 });
      const acc = byMaterial.get(id);
      const box = col.box;
      const cx = (box.min.x + box.max.x) / 2;
      const cy = (box.min.y + box.max.y) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      pushBox(acc, cx, cy, cz,
        box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
      acc.count++;
      this.diagnostics.colliders++;
    }

    for (const [id, acc] of byMaterial) {
      const mesh = new THREE.Mesh(finishGeometry(acc), this.mats.get(id));
      mesh.name = `solids:${id}`;
      mesh.castShadow = id !== 'plaster';
      mesh.receiveShadow = true;
      // Culling at the declared distance keeps far geometry out of the draw list.
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.diagnostics.mergedGroups++;
    }
  }

  /* ---------------------------------------------------------------- props */

  _buildProps() {
    // Scatter is merged per material; anything animated, lit or interactable is kept
    // as its own object, because a merged mesh cannot flicker, carry a light, or be
    // picked by a raycast.
    this._scatter = new Map();
    for (const prop of this.space.props ?? []) {
      if (SCATTER_KINDS.has(prop.kind)) {
        this._buildScatter(prop, this._scatterAcc(prop));
        this.diagnostics.props++;
        this.diagnostics.mergedProps++;
        continue;
      }
      const obj = this._buildProp(prop);
      if (obj) {
        this.group.add(obj);
        this.diagnostics.props++;
      }
    }
    for (const [id, acc] of this._scatter) {
      if (!acc.pos.length) continue;
      const mesh = new THREE.Mesh(finishGeometry(acc), this.mats.get(id));
      mesh.name = `scatter:${id}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.diagnostics.mergedGroups++;
    }
    this._scatter = null;
  }

  _scatterAcc(prop) {
    const want = prop.material ?? DEFAULT_MATERIAL[prop.kind] ?? 'silt';
    const id = MATERIALS[want] ? want : 'silt';
    if (!this._scatter.has(id)) this._scatter.set(id, { pos: [], nrm: [], uv: [], count: 0 });
    return this._scatter.get(id);
  }

  /**
   * The generator uses `radius` for landmark props and `r` for scattered ones.
   * Reading only one silently sizes half the dressing wrong, and a pebble scatter
   * drawn at a default radius is either invisible or a boulder.
   */
  static sizeOf(prop, fallback) {
    const v = prop.radius ?? prop.r ?? prop.w;
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /**
   * Variation seeded from position, never from Math.random: the same region must look
   * the same every time it is built, including after loading a save.
   */
  static rngOf(prop) {
    return new RNG(hashCombine(hashString(prop.kind),
      Math.round((prop.x ?? 0) * 100), Math.round((prop.z ?? 0) * 100)));
  }

  static materialIdOf(prop) {
    const want = prop.material ?? DEFAULT_MATERIAL[prop.kind] ?? 'palmWood';
    return MATERIALS[want] ? want : 'palmWood';
  }

  /**
   * Scatter kinds, drawn straight into a merge accumulator.
   *
   * A pebble scatter is a dozen stones. As separate meshes that is a dozen draw
   * calls for something the player glances at while walking past; merged by material
   * it is one, shared with every other pebble in the region.
   */
  _buildScatter(prop, acc) {
    const rng = RegionMesh.rngOf(prop);
    const x = prop.x ?? 0, y = prop.y ?? 0, z = prop.z ?? 0;
    // The material is chosen by the accumulator key, not per mesh: that is the whole
    // point of merging, and looking it up here would only invite someone to use it.
    const place = (geom, px, py, pz, rx, ry, rz, sx = 1, sy = 1, sz = 1) => {
      _euler.set(rx, ry, rz);
      _quat.setFromEuler(_euler);
      _scale.set(sx, sy, sz);
      _pos.set(px, py, pz);
      _matrix.compose(_pos, _quat, _scale);
      appendGeometry(acc, geom, _matrix);
    };

    switch (prop.kind) {
      case 'potsherd': {
        // Broken pottery: thin, differently-tilted shards. Whole vessels would be
        // wrong here - these are the fragments of something already broken.
        const r = RegionMesh.sizeOf(prop, 0.3);
        const shards = 3 + Math.floor(rng.next() * 3);
        for (let i = 0; i < shards; i++) {
          const a = rng.next() * Math.PI * 2;
          const d = rng.next() * r * 0.9;
          place(new THREE.BoxGeometry(r * (0.5 + rng.next() * 0.7), r * 0.11, r * (0.4 + rng.next() * 0.6)),
            x + Math.cos(a) * d, y + 0.02, z + Math.sin(a) * d,
            (rng.next() - 0.5) * 0.5, rng.next() * Math.PI, (rng.next() - 0.5) * 0.35);
        }
        break;
      }
      case 'scrub': {
        // Desert scrub: dry spikes radiating up and out, read as a silhouette.
        const r = RegionMesh.sizeOf(prop, 0.7);
        const blades = 5 + Math.floor(rng.next() * 5);
        for (let i = 0; i < blades; i++) {
          const h = r * (0.7 + rng.next() * 0.9);
          const a = (i / blades) * Math.PI * 2 + rng.next() * 0.6;
          place(new THREE.ConeGeometry(r * 0.13, h, 4, 1, true),
            x + Math.cos(a) * r * 0.22, y + h * 0.42, z + Math.sin(a) * r * 0.22,
            Math.cos(a) * 0.42, 0, -Math.sin(a) * 0.42);
        }
        break;
      }
      case 'pebbleScatter': {
        // Flat-ish stones sunk into the surface, so they do not read as floating
        // discs from a low camera.
        const r = RegionMesh.sizeOf(prop, 1.2);
        const count = 7 + Math.floor(rng.next() * 6);
        for (let i = 0; i < count; i++) {
          const s = r * (0.07 + rng.next() * 0.11);
          const a = rng.next() * Math.PI * 2;
          const d = Math.sqrt(rng.next()) * r;
          place(new THREE.SphereGeometry(s, 5, 4),
            x + Math.cos(a) * d, y + s * 0.45, z + Math.sin(a) * d,
            rng.next() * 0.6, rng.next() * Math.PI, 0, 1, 0.55 + rng.next() * 0.3, 1);
        }
        break;
      }
      default:
        break;
    }
  }

  _buildProp(prop) {
    const x = prop.x ?? 0, y = prop.y ?? 0, z = prop.z ?? 0;
    const size = (fallback) => RegionMesh.sizeOf(prop, fallback);
    // The material a kind is made of when the generator did not say. A dune is not
    // palm wood, and defaulting everything to timber turns the desert brown.
    const mat = this.mats.get(RegionMesh.materialIdOf(prop));
    const rng = RegionMesh.rngOf(prop);

    switch (prop.kind) {
      case 'rug':
      case 'floorInlay':
      case 'stain': {
        // A plane, not a thin box: it has no depth to see, and half the triangles
        // would be inside the floor where nothing can ever look at them.
        const w = prop.w ?? prop.radius ?? 2;
        const d = prop.d ?? prop.w ?? 2;
        const g = new THREE.PlaneGeometry(w, d);
        g.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(g, this.mats.get(prop.kind === 'stain' ? 'blood' : RegionMesh.materialIdOf(prop)));
        m.position.set(x, y + 0.012, z);
        m.receiveShadow = true;
        m.name = `prop:${prop.kind}`;
        return m;
      }
      case 'flame':
      case 'fire':
      case 'shrineLamp': {
        const group = new THREE.Group();
        const r = size(0.3);
        // Emissive core. Fire has no useful albedo under a night light, so the color
        // is the light itself rather than a surface responding to it.
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(r, 10, 8),
          new THREE.MeshBasicMaterial({ color: prop.kind === 'fire' ? 0xffb347 : 0xffcf70 }),
        );
        core.name = `flame:${prop.kind}`;
        core.position.set(x, y, z);
        group.add(core);
        this.animated.push({ kind: 'flame', obj: core, base: r, phase: x * 0.7 + z * 1.3 });

        const glow = new THREE.Mesh(
          new THREE.SphereGeometry(r * 2.6, 10, 8),
          new THREE.MeshBasicMaterial({
            color: 0xff8c2a, transparent: true, opacity: 0.16,
            blending: THREE.AdditiveBlending, depthWrite: false,
          }),
        );
        glow.position.set(x, y, z);
        group.add(glow);
        this.animated.push({ kind: 'glow', obj: glow, base: r * 2.6, phase: z * 0.9 });

        this._addLight(group, x, y + r, z, prop.light ?? 'torch');
        return group;
      }
      case 'palmCanopy': {
        // Fronds as flattened cones around a crown. A palm seen from a third-person
        // camera is a silhouette, and a silhouette needs the right outline more than
        // the right surface detail.
        const group = new THREE.Group();
        const r = size(4);
        const fronds = 9;
        for (let i = 0; i < fronds; i++) {
          const a = (i / fronds) * Math.PI * 2;
          const g = new THREE.ConeGeometry(r * 0.34, r * 1.15, 5, 1, true);
          const m = new THREE.Mesh(g, mat);
          m.position.set(x + Math.cos(a) * r * 0.42, y, z + Math.sin(a) * r * 0.42);
          m.rotation.set(Math.PI / 2 - 0.62, -a, 0);
          m.castShadow = true;
          group.add(m);
        }
        return group;
      }
      case 'chain': {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6), mat);
        m.position.set(x, y - 0.75, z);
        m.castShadow = true;
        return m;
      }
      case 'doorRing': {
        const m = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.035, 6, 14), mat);
        m.position.set(x, y, z);
        m.rotation.y = Math.PI / 2;
        m.castShadow = true;
        return m;
      }
      case 'lockedDoor': {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 0.14), this.mats.get('poplarWood'));
        m.position.set(x, y + 1.1, z);
        m.castShadow = true;
        m.name = `locked:${prop.id ?? 'door'}`;
        m.userData.interactable = prop;
        return m;
      }
      case 'duneCrest': {
        // A flattened hemisphere, not a cone: a cone has a visible apex and straight
        // sides, and no dune has either.
        const r = size(12);
        const g = new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
        const m = new THREE.Mesh(g, mat);
        m.position.set(x, y - r * 0.06, z);
        m.scale.set(1, 0.2, 1.35);
        m.receiveShadow = true;
        m.name = 'prop:duneCrest';
        return m;
      }
      case 'tent': {
        // A low hexagonal shelter with a door slit, so it reads as a place someone
        // could be in rather than a solid lump.
        const r = size(3);
        const group = new THREE.Group();
        const h = r * 0.78;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6, 1, true), mat);
        roof.position.set(x, y + h / 2, z);
        roof.rotation.y = rng.next() * Math.PI;
        roof.castShadow = true;
        group.add(roof);
        const door = new THREE.Mesh(
          new THREE.PlaneGeometry(r * 0.42, h * 0.62),
          new THREE.MeshBasicMaterial({ color: 0x1a1512, side: THREE.DoubleSide }),
        );
        door.position.set(x + r * 0.72, y + h * 0.31, z);
        door.rotation.y = Math.PI / 2;
        group.add(door);
        return group;
      }
      case 'reedBoat': {
        // A mashoof: long, narrow, upswept at both ends. A lathe profile gives a real
        // hull surface rather than a squashed box.
        const len = 4.6;
        const profile = [];
        const steps = 8;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          profile.push(new THREE.Vector2(Math.sin(t * Math.PI) ** 0.6 * 0.52, t * len - len / 2));
        }
        const g = new THREE.LatheGeometry(profile, 10);
        g.rotateX(Math.PI / 2);           // lie the hull along Z
        g.scale(1, 0.62, 1);              // flatten it: a boat is not a sausage
        const m = new THREE.Mesh(g, mat);
        m.position.set(x, y + 0.28, z);
        m.rotation.y = rng.next() * Math.PI * 2;
        m.castShadow = true;
        m.name = 'prop:reedBoat';
        return m;
      }
      default: {
        // Counted rather than dropped: a new prop kind shipping invisible is a bug
        // nobody can see in a screenshot of the region that was supposed to have it.
        const list = this.diagnostics.unknownProps;
        if (!list.includes(prop.kind)) list.push(prop.kind);
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat);
        m.position.set(x, y + 0.3, z);
        m.name = `prop:unknown:${prop.kind}`;
        return m;
      }
    }
  }

  _addLight(parent, x, y, z, kind) {
    if (this.lights.length >= MAX_LIGHTS) {
      this.diagnostics.lightsCulled++;
      return;
    }
    const preset = LIGHT_PRESETS[kind] ?? LIGHT_PRESETS.torch;
    const light = new THREE.PointLight(preset.color, preset.intensity, preset.distance, preset.decay);
    light.position.set(x, y, z);
    light.castShadow = false;   // shadow-casting point lights cost six faces each
    parent.add(light);
    this.lights.push({ light, base: preset.intensity, phase: x * 1.7 + z * 0.9, kind });
    this.diagnostics.lights++;
  }

  /* ---------------------------------------------------------------- doors */

  _buildDoors() {
    // A doorway gets a lintel and a threshold so it reads as a way out from across
    // the room. An opening in a wall with nothing marking it is something players
    // walk past, then report as "the region has no exit".
    const mat = this.mats.get('poplarWood');
    for (const door of this.space.doors ?? []) {
      const p = door.world;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.5), mat);
      frame.position.set(p.x, (p.y ?? 0) + 2.25, p.z);
      frame.castShadow = true;
      frame.name = `door:${door.toRegion}`;
      frame.userData.door = door;
      this.group.add(frame);
      this.doorMeshes = this.doorMeshes ?? [];
      this.doorMeshes.push(frame);
    }
  }

  /* ------------------------------------------------------------ per-frame */

  /**
   * Advance fire flicker and torch light.
   *
   * Two sine terms at unrelated frequencies rather than noise: it is cheaper, it is
   * deterministic for a given elapsed time, and a flame nobody is scrutinizing does
   * not need a turbulence model.
   */
  update(elapsedSec) {
    const t = elapsedSec;
    for (const a of this.animated) {
      if (a.kind === 'flame') {
        const s = 1 + Math.sin(t * 9.1 + a.phase) * 0.11 + Math.sin(t * 23.7 + a.phase * 2) * 0.05;
        a.obj.scale.set(s, s * (1 + Math.sin(t * 7.3 + a.phase) * 0.14), s);
      } else {
        const s = 1 + Math.sin(t * 5.3 + a.phase) * 0.09;
        a.obj.scale.setScalar(s);
      }
    }
    for (const l of this.lights) {
      l.light.intensity = l.base * (0.86 + Math.sin(t * 8.7 + l.phase) * 0.09
        + Math.sin(t * 19.3 + l.phase * 1.7) * 0.05);
    }
  }

  /** Distance-squared from a point to this region's bounds, for stream decisions. */
  distanceSqTo(x, z) {
    const [x0, x1] = this.space.bounds.x;
    const [z0, z1] = this.space.bounds.z;
    const dx = Math.max(x0 - x, 0, x - x1);
    const dz = Math.max(z0 - z, 0, z - z1);
    return dx * dx + dz * dz;
  }

  get withinCullDistance() { return true; }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const l of this.lights) l.light.dispose?.();
  }
}

/**
 * Light presets by the name the generator already uses.
 *
 * Kept here rather than in constants.js because these are rendering values with no
 * simulation counterpart - the AI's exposure model reads light levels from the
 * world data, not from these intensities.
 */
export const LIGHT_PRESETS = Object.freeze({
  torch: { color: 0xff9a3c, intensity: 9.0, distance: 13, decay: 2.0 },
  lamp: { color: 0xffcf8a, intensity: 4.5, distance: 8, decay: 2.0 },
  hearth: { color: 0xff7a2a, intensity: 14.0, distance: 17, decay: 2.0 },
});

/** What each prop kind is made of when the generator did not declare a material. */
export const DEFAULT_MATERIAL = Object.freeze({
  potsherd: 'terracotta',
  scrub: 'reed',
  pebbleScatter: 'silt',
  duneCrest: 'sand',
  tent: 'wool',
  reedBoat: 'reed',
  palmCanopy: 'reed',
  rug: 'wool',
  floorInlay: 'bakedBrick',
  stain: 'blood',
  chain: 'iron',
  doorRing: 'bronze',
  lockedDoor: 'poplarWood',
});

/**
 * Kinds merged into shared buffers.
 *
 * Static, unlit, non-interactive dressing. Everything else stays a real object:
 * a flame has to animate, a torch has to cast light, and a locked door has to be
 * pickable by the interact raycast.
 */
export const SCATTER_KINDS = Object.freeze(new Set(['potsherd', 'scrub', 'pebbleScatter']));

export { MAX_LIGHTS, TEXEL_M, GROUND_STEP };
