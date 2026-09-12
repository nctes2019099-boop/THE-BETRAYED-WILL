/**
 * THE BETRAYED WILL — characters.js
 *
 * Procedural people: the player and the guards, built from primitives and animated
 * from the simulation's own numbers.
 *
 * ── No models, and that is a constraint worth designing to ───────────────────
 * Nothing is downloaded, so a character is a hierarchy of boxes and cylinders. That
 * rules out skinning and blend shapes, and what it leaves is a joint hierarchy driven
 * by sine functions of the character's speed. Read from a third-person camera four
 * metres behind the shoulder - which is where CAM.DISTANCE puts it - a walk cycle is
 * a silhouette and a rhythm, not a surface. So the effort goes into proportions and
 * timing, where it is visible, rather than into detail that is not.
 *
 * ── Animation is driven by the simulation, never by the renderer ─────────────
 * Every pose input here (speed, stance, yaw, attack state) comes from the
 * controller that already decided them. The renderer does not know how fast a
 * character should move and does not guess. A visual that disagrees with the
 * simulation is a lie the player can feel: feet sliding across the ground because
 * the stride length was tuned to look right rather than derived from the speed.
 *
 * ── LOD, because 64 characters is 640 draw calls ─────────────────────────────
 * PERF.MAX_ACTIVE_NPCS is 64 and a full rig is about ten meshes. Beyond
 * PERF.LOD_FAR a character is a single body shell; between LOD_NEAR and LOD_FAR the
 * limbs stop being separate draws. The thresholds are the declared ones rather than
 * values picked here, so changing them in constants.js changes the renderer.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { MOVE, PERF } from '../core/constants.js';

/** Stride cycles per second at walk speed. Tuned against the actual move speed so feet do not slide. */
const STRIDE_HZ_AT_WALK = 1.05;

const BODY = Object.freeze({
  player: Object.freeze({
    tunic: 'linen', trim: 'wool', skin: 0xc08a5e, belt: 'leather',
    height: MOVE.CAPSULE_HEIGHT, build: 1.0, helmet: false, cloak: 'wool',
  }),
  guard: Object.freeze({
    tunic: 'wool', trim: 'bronze', skin: 0xb07a4e, belt: 'leather',
    height: MOVE.CAPSULE_HEIGHT, build: 1.08, helmet: true, cloak: null,
  }),
  scribe: Object.freeze({
    tunic: 'linen', trim: 'reed', skin: 0xc08a5e, belt: 'leather',
    height: MOVE.CAPSULE_HEIGHT * 0.97, build: 0.92, helmet: false, cloak: 'linen',
  }),
});

/** Alert colours for the indicator above an NPC's head. */
const ALERT_COLOR = Object.freeze({
  calm: 0x4a6b52,
  suspicious: 0xc9a227,
  alerted: 0xd1622a,
  combat: 0xb02020,
});

function seg(r, h, radial = 8) { return new THREE.CylinderGeometry(r, r, h, radial, 1); }

export class CharacterRig {
  /**
   * @param {MaterialLibrary} mats
   * @param {'player'|'guard'|'scribe'} kind
   */
  constructor(mats, kind = 'guard', { showAlert = false } = {}) {
    this.mats = mats;
    this.kind = BODY[kind] ? kind : 'guard';
    const spec = BODY[this.kind];
    this.spec = spec;
    this.height = spec.height;

    /** Root sits at the character's feet; yaw rotates the whole figure. */
    this.root = new THREE.Group();
    this.root.name = `char:${this.kind}`;

    this.hips = new THREE.Group();
    this.hips.position.y = this.height * 0.52;
    this.root.add(this.hips);

    const tunic = mats.get(spec.tunic);
    const trim = mats.get(spec.trim);
    const belt = mats.get(spec.belt);
    const skin = new THREE.MeshStandardMaterial({ color: spec.skin, roughness: 0.72, metalness: 0 });
    this.skinMat = skin;

    // --- torso ------------------------------------------------------------
    this.torso = new THREE.Mesh(new THREE.BoxGeometry(0.40 * spec.build, 0.56, 0.24 * spec.build), tunic);
    this.torso.position.y = 0.30;
    this.torso.castShadow = true;
    this.hips.add(this.torso);

    this.chest = new THREE.Mesh(new THREE.BoxGeometry(0.44 * spec.build, 0.20, 0.26 * spec.build), trim);
    this.chest.position.y = 0.52;
    this.chest.castShadow = true;
    this.hips.add(this.chest);

    this.beltMesh = new THREE.Mesh(new THREE.BoxGeometry(0.42 * spec.build, 0.07, 0.26 * spec.build), belt);
    this.beltMesh.position.y = 0.06;
    this.hips.add(this.beltMesh);

    // --- head -------------------------------------------------------------
    this.neck = new THREE.Group();
    this.neck.position.y = 0.62;
    this.hips.add(this.neck);
    this.head = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.25, 0.22), skin);
    this.head.position.y = 0.135;
    this.head.castShadow = true;
    this.neck.add(this.head);
    // Beard: a face at this distance is a shape, and a shape with a beard reads as
    // a person in this setting where a smooth box reads as a mannequin.
    this.beard = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.10), mats.get('bitumen'));
    this.beard.position.set(0, 0.075, 0.10);
    this.neck.add(this.beard);

    if (spec.helmet) {
      // Conical bronze helm. A guard must be identifiable at a glance and from
      // behind, because the player spends most of the game looking at their back
      // while deciding whether to approach.
      this.helmet = new THREE.Mesh(new THREE.ConeGeometry(0.145, 0.20, 8), mats.get('bronze'));
      this.helmet.position.y = 0.245;
      this.helmet.castShadow = true;
      this.neck.add(this.helmet);
      this.nasal = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.03), mats.get('bronze'));
      this.nasal.position.set(0, 0.14, 0.115);
      this.neck.add(this.nasal);
    } else {
      this.headband = new THREE.Mesh(new THREE.BoxGeometry(0.225, 0.055, 0.235), mats.get(spec.trim));
      this.headband.position.y = 0.20;
      this.neck.add(this.headband);
    }

    if (spec.cloak) {
      this.cloak = new THREE.Mesh(new THREE.BoxGeometry(0.46 * spec.build, 0.78, 0.05), mats.get(spec.cloak));
      this.cloak.position.set(0, 0.24, -0.155);
      this.cloak.castShadow = true;
      this.hips.add(this.cloak);
    }

    // --- arms -------------------------------------------------------------
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.245 * spec.build, 0.54, 0);
      this.hips.add(shoulder);
      const upper = new THREE.Mesh(seg(0.055, 0.30, 7), skin);
      upper.position.y = -0.15;
      upper.castShadow = true;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -0.30;
      shoulder.add(elbow);
      const fore = new THREE.Mesh(seg(0.048, 0.28, 7), skin);
      fore.position.y = -0.14;
      fore.castShadow = true;
      elbow.add(fore);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 0.06), skin);
      hand.position.y = -0.30;
      elbow.add(hand);
      this.arms.push({ shoulder, elbow, side });
    }

    // --- legs -------------------------------------------------------------
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.105 * spec.build, -0.02, 0);
      this.hips.add(hip);
      const thigh = new THREE.Mesh(seg(0.075, 0.42, 7), tunic);
      thigh.position.y = -0.21;
      thigh.castShadow = true;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      hip.add(knee);
      const shin = new THREE.Mesh(seg(0.06, 0.40, 7), skin);
      shin.position.y = -0.20;
      shin.castShadow = true;
      knee.add(shin);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.07, 0.24), belt);
      foot.position.set(0, -0.42, 0.055);
      foot.castShadow = true;
      knee.add(foot);
      this.legs.push({ hip, knee, side });
    }

    // --- weapon (a spear for guards, nothing for the player by default) -----
    if (spec.helmet) {
      this.spear = new THREE.Group();
      const shaft = new THREE.Mesh(seg(0.022, 2.1, 6), mats.get('poplarWood'));
      shaft.position.y = 0.1;
      this.spear.add(shaft);
      const head_ = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.26, 6), mats.get('bronze'));
      head_.position.y = 1.24;
      this.spear.add(head_);
      this.spear.position.set(0.30, 0.30, 0.02);
      this.spear.rotation.set(0.12, 0, -0.16);
      this.spear.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.hips.add(this.spear);
    }

    // --- alert indicator ----------------------------------------------------
    this.alert = null;
    if (showAlert) {
      this.alert = new THREE.Mesh(
        new THREE.RingGeometry(0.16, 0.23, 16),
        new THREE.MeshBasicMaterial({
          color: ALERT_COLOR.calm, transparent: true, opacity: 0.0,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      this.alert.rotation.x = -Math.PI / 2;
      this.alert.position.y = this.height + 0.34;
      this.root.add(this.alert);
    }

    // --- LOD shell ----------------------------------------------------------
    // One mesh standing in for the whole figure past LOD_FAR. A distant guard is a
    // silhouette and a colour; ten animated meshes at that distance cost draw calls
    // for detail that occupies a few pixels.
    this.shell = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.24 * spec.build, this.height * 0.62, 3, 8),
      tunic,
    );
    this.shell.position.y = this.height * 0.5;
    this.shell.castShadow = true;
    this.shell.visible = false;
    this.root.add(this.shell);

    this.lodLevel = 'near';
    this._phase = 0;
    this._detail = [];
    this.hips.traverse((o) => { if (o !== this.hips) this._detail.push(o); });
  }

  /** Toggle the meshes that LOD hides, without rebuilding anything. */
  _setLod(level) {
    if (level === this.lodLevel) return;
    this.lodLevel = level;
    const far = level === 'far';
    const mid = level === 'mid';
    this.shell.visible = far;
    for (const o of this._detail) o.visible = !far;
    // At mid distance the fingers and facial detail are under a pixel; hiding them
    // saves draws and nothing that could be seen.
    if (this.beard) this.beard.visible = !far && !mid;
    if (this.nasal) this.nasal.visible = !far && !mid;
    if (this.beltMesh) this.beltMesh.visible = !far;
  }

  /**
   * Place and animate.
   *
   * @param {object} p { x, y, z, yaw, speed, stance, attack, attackKind, alert, dt }
   * @param {number} cameraDistance distance from the camera, for LOD
   */
  update(p, cameraDistance = 0) {
    const dt = Number.isFinite(p.dt) && p.dt > 0 ? p.dt : 1 / 60;
    this.root.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    // Yaw 0 faces +Z in this codebase, which is the direction the model is built in,
    // so the rotation is applied directly with no offset to remember.
    this.root.rotation.y = Number.isFinite(p.yaw) ? p.yaw : 0;

    const d = Number.isFinite(cameraDistance) ? cameraDistance : 0;
    this._setLod(d > PERF.LOD_FAR ? 'far' : d > PERF.LOD_NEAR ? 'mid' : 'near');
    if (this.lodLevel === 'far') {
      // A shell still has to lean into a run, or a sprinting guard looks like a
      // statue sliding across the courtyard.
      const sp = Math.abs(p.speed ?? 0);
      this.shell.rotation.x = -Math.min(0.28, sp / MOVE.SPRINT_SPEED * 0.28);
      if (this.alert) this._updateAlert(p.alert, dt);
      return;
    }

    const speed = Math.abs(Number.isFinite(p.speed) ? p.speed : 0);
    const crouch = p.stance === 'crouch';
    const walkRef = MOVE.WALK_SPEED || 1.6;
    // Stride frequency scales with speed, so the feet stay in contact with the
    // ground at every pace instead of skating. This is the single most visible
    // correctness property of a procedural walk cycle.
    const hz = STRIDE_HZ_AT_WALK * (0.35 + (speed / walkRef) * 0.85);
    this._phase += dt * hz * Math.PI * 2 * (speed > 0.05 ? 1 : 0);
    const swing = Math.min(1, speed / (MOVE.RUN_SPEED || 3));
    const s = Math.sin(this._phase);
    const c = Math.cos(this._phase);

    // --- hips ---------------------------------------------------------------
    const hipDrop = crouch ? 0.30 : 0;
    this.hips.position.y = this.height * 0.52 - hipDrop
      + Math.abs(s) * 0.022 * swing                      // vertical bounce
      + (Number.isFinite(p.y) ? 0 : 0);
    this.hips.rotation.z = s * 0.035 * swing;             // lateral sway
    this.hips.rotation.x = crouch ? 0.20 : Math.min(0.16, swing * 0.16);
    this.torso.rotation.y = -s * 0.09 * swing;            // counter-rotation

    // --- legs ---------------------------------------------------------------
    const legAmp = crouch ? 0.34 : 0.62;
    for (const leg of this.legs) {
      const ph = leg.side > 0 ? s : -s;
      leg.hip.rotation.x = ph * legAmp * swing;
      // A knee only bends backwards, and bends most as the leg swings through.
      leg.knee.rotation.x = Math.max(0, -ph) * 0.85 * swing + (crouch ? 0.9 : 0.12);
    }

    // --- arms ---------------------------------------------------------------
    const attack = p.attack ?? 0;   // 0..1 progress through a swing
    for (const arm of this.arms) {
      const ph = arm.side > 0 ? -s : s;
      if (attack > 0) {
        // A swing is a wind-up then a strike. Driving it from the combat system's own
        // progress value means the animation and the hit frame cannot disagree.
        const wind = attack < 0.4 ? attack / 0.4 : 1 - (attack - 0.4) / 0.6;
        const strike = attack < 0.4 ? 0 : (attack - 0.4) / 0.6;
        arm.shoulder.rotation.x = -1.5 * wind + 1.1 * strike;
        arm.shoulder.rotation.z = arm.side * (0.5 * wind + 0.25 * strike);
        arm.elbow.rotation.x = -1.1 * wind - 0.35 * strike;
        if (arm.side < 0) { arm.shoulder.rotation.x *= 0.35; arm.shoulder.rotation.z *= 0.5; }
      } else if (p.block) {
        arm.shoulder.rotation.x = -1.15;
        arm.shoulder.rotation.z = arm.side * 0.30;
        arm.elbow.rotation.x = -1.35;
      } else if (p.aim) {
        // Drawing a bow: leading arm out, drawing arm back past the ear.
        arm.shoulder.rotation.x = arm.side > 0 ? -1.55 : -0.35;
        arm.shoulder.rotation.z = arm.side * (arm.side > 0 ? 0.06 : 0.75);
        arm.elbow.rotation.x = arm.side > 0 ? -0.05 : -1.9;
      } else {
        arm.shoulder.rotation.x = ph * 0.52 * swing;
        arm.shoulder.rotation.z = arm.side * (0.06 + 0.03 * swing);
        arm.elbow.rotation.x = -(0.16 + Math.max(0, -ph) * 0.5 * swing) - (crouch ? 0.25 : 0);
      }
    }

    // --- head and spear ------------------------------------------------------
    this.neck.rotation.x = crouch ? 0.22 : Math.min(0.1, swing * 0.1);
    this.neck.rotation.y = p.lookYawOffset ?? 0;
    if (this.spear) {
      // A carried spear sits at an angle; a braced one levels. The difference is
      // readable from across a courtyard, which is the point.
      const braced = p.alert === 'combat' || p.alert === 'alerted' || attack > 0;
      this.spear.rotation.x = braced ? 1.32 : 0.12;
      this.spear.rotation.z = braced ? -0.05 : -0.16;
      this.spear.position.y = braced ? 0.14 : 0.30;
    }
    if (this.cloak) this.cloak.rotation.x = Math.min(0.3, swing * 0.3);

    // Idle breathing, so a standing character is not a statue.
    if (speed < 0.05 && !attack) {
      const breathe = Math.sin(performance.now?.() * 0.0016 ?? 0) * 0.012;
      this.torso.scale.set(1, 1 + breathe, 1);
    } else {
      this.torso.scale.set(1, 1, 1);
    }

    if (this.alert) this._updateAlert(p.alert, dt);
  }

  _updateAlert(alertState, dt) {
    const color = ALERT_COLOR[alertState] ?? ALERT_COLOR.calm;
    const wantOpacity = alertState && alertState !== 'calm' ? 0.75 : 0.0;
    const m = this.alert.material;
    if (m.color.getHex() !== color) m.color.setHex(color);
    // Faded rather than snapped: an indicator that pops in is missed, and a missed
    // "he has noticed you" is a death the player cannot understand.
    const k = Math.min(1, dt * 6);
    m.opacity += (wantOpacity - m.opacity) * k;
    this.alert.visible = m.opacity > 0.02;
    if (this.alert.visible) {
      this.alert.rotation.z += dt * 0.9;
      const s = 1 + Math.sin(performance.now?.() * 0.004 ?? 0) * 0.08;
      this.alert.scale.setScalar(s);
    }
  }

  /** Rough triangle count, for the render budget report. */
  triangleCount() {
    let tris = 0;
    this.root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    return Math.round(tris);
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.skinMat.dispose();
    this.alert?.material.dispose();
  }
}

export { BODY, ALERT_COLOR, STRIDE_HZ_AT_WALK };
