import * as THREE from 'three';
import {
  countTriangles,
  createBeveledShape,
  createChamferedBox,
  createLatheZ,
  createPicatinnyRail,
  createSlottedFlashHider,
  ellipseProfile,
  loftRings,
  mergeParts,
  roundedRectProfile,
  sweepProfileAlongCurve,
} from '../proc/modeling';
import { TextureLibrary } from '../proc/textures';
import { LevelId, WorldSurface } from '../types';
import { BoxCollider } from '../world/outpost';
import { CylinderCollider } from '../world/vegetation';

export type EnemyState = 'patrol' | 'alert' | 'combat' | 'cover' | 'reload' | 'dead';

export interface EnemyFireEvent {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  damage: number;
}

interface SoldierRigTemplate {
  bodyGeo: THREE.BufferGeometry;
  maskGeo: THREE.BufferGeometry;
  gearGeo: THREE.BufferGeometry;
  helmetGeo: THREE.BufferGeometry;
  gogglesGeo: THREE.BufferGeometry;
  rifleGeo: THREE.BufferGeometry;
  triangleCount: number;
}

interface SoldierSharedMats {
  camo: THREE.MeshStandardMaterial;
  balaclava: THREE.MeshStandardMaterial;
  gear: THREE.MeshStandardMaterial;
  helmetPaint: THREE.MeshStandardMaterial;
  goggleLens: THREE.MeshStandardMaterial;
  gunMetal: THREE.MeshStandardMaterial;
}

/**
 * Helper to append a rigid geometry part skinned across 1 or 2 bones into a combined skinned buffer.
 */
function appendSkinnedPart(
  geo: THREE.BufferGeometry,
  boneA: number,
  positions: number[],
  uvs: number[],
  skinIndices: number[],
  skinWeights: number[],
  indices: number[],
  boneB = 0,
  weightA = 1,
  weightB = 0
): void {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  const base = positions.length / 3;
  for (let i = 0; i < pos.count; i++) {
    positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (uv) {
      uvs.push(uv.getX(i), uv.getY(i));
    } else {
      uvs.push(0, 0);
    }
    skinIndices.push(boneA, boneB, 0, 0);
    skinWeights.push(weightA, weightB, 0, 0);
  }
  for (let i = 0; i < pos.count; i++) {
    indices.push(base + i);
  }
}

/**
 * Builds the 14,000-18,000 triangle SkinnedMesh soldier template.
 * Bone layout (17 bones):
 * 0: Pelvis (0, 0.94, 0)
 * 1: Spine (0, 0.16, 0) -> Chest (2) (0, 0.22, 0) -> Neck (3) (0, 0.24, 0) -> Head (4) (0, 0.11, 0)
 * 5: L_Shoulder (-0.21, 0.17, 0) -> L_UpperArm (6) -> L_Forearm (7) (0,-0.28,0) -> L_Hand (8) (0,-0.26,0)
 * 9: R_Shoulder (+0.21, 0.17, 0) -> R_UpperArm (10) -> R_Forearm (11) (0,-0.28,0) -> R_Hand (12) (0,-0.26,0)
 * 13: L_Thigh (-0.11, -0.02, 0) -> L_Shin (14) (0,-0.44,0) -> L_Foot (15) (0,-0.44,0)
 * 16: R_Thigh (+0.11, -0.02, 0) -> R_Shin (17) (0,-0.44,0) -> R_Foot (18) (0,-0.44,0)
 */
function buildSoldierTemplate(): SoldierRigTemplate {
  // --- 1. CONTINUOUS SKINNED CAMO UNIFORM BODY (Torso + Balaclava Neck/Head + 4 Articulated Limbs) ---
  const bPos: number[] = [];
  const bUv: number[] = [];
  const bSkinI: number[] = [];
  const bSkinW: number[] = [];
  const bIdx: number[] = [];

  const pushLoftTube = (
    rings: Array<{
      center: THREE.Vector3;
      rx: number;
      rz: number;
      rotX?: number;
      si: [number, number, number, number];
      sw: [number, number, number, number];
    }>,
    radialSegs: number,
    capStart = true,
    capEnd = true
  ) => {
    const startV = bPos.length / 3;
    const stride = radialSegs + 1;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const t = i / Math.max(1, rings.length - 1);
      for (let j = 0; j <= radialSegs; j++) {
        const a = (j / radialSegs) * Math.PI * 2;
        const px = Math.cos(a) * r.rx;
        const pz = Math.sin(a) * r.rz;
        // Subtle cloth wrinkle ripple
        const wrinkle = 1.0 + Math.sin(a * 4 + t * 18) * 0.028;
        bPos.push(r.center.x + px * wrinkle, r.center.y, r.center.z + pz * wrinkle);
        bUv.push((j / radialSegs) * 2.0, t * 2.5);
        bSkinI.push(...r.si);
        bSkinW.push(...r.sw);
      }
    }
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < radialSegs; j++) {
        const a = startV + i * stride + j;
        const b = startV + (i + 1) * stride + j;
        const c = startV + (i + 1) * stride + (j + 1);
        const d = startV + i * stride + (j + 1);
        bIdx.push(a, b, d, b, c, d);
      }
    }
    if (capStart) {
      const cIdx = bPos.length / 3;
      const r0 = rings[0];
      bPos.push(r0.center.x, r0.center.y, r0.center.z);
      bUv.push(0.5, 0);
      bSkinI.push(...r0.si);
      bSkinW.push(...r0.sw);
      for (let j = 0; j < radialSegs; j++) bIdx.push(cIdx, startV + j + 1, startV + j);
    }
    if (capEnd) {
      const cIdx = bPos.length / 3;
      const r1 = rings[rings.length - 1];
      const last = startV + (rings.length - 1) * stride;
      bPos.push(r1.center.x, r1.center.y, r1.center.z);
      bUv.push(0.5, 1);
      bSkinI.push(...r1.si);
      bSkinW.push(...r1.sw);
      for (let j = 0; j < radialSegs; j++) bIdx.push(cIdx, last + j, last + j + 1);
    }
  };

  // Torso (from Pelvis y=0.84 up to Collar y=1.50 — continuous with limbs; Balaclava Mask/Head is separate matte charcoal cloth)
  const torsoSpecs: Array<[number, number, number, [number, number, number, number], [number, number, number, number]]> = [
    [0.84, 0.145, 0.115, [0, 0, 0, 0], [1, 0, 0, 0]],
    [0.92, 0.165, 0.125, [0, 0, 0, 0], [1, 0, 0, 0]],
    [1.00, 0.155, 0.120, [0, 1, 0, 0], [0.5, 0.5, 0, 0]],
    [1.08, 0.160, 0.122, [1, 0, 0, 0], [1, 0, 0, 0]],
    [1.16, 0.172, 0.128, [1, 2, 0, 0], [0.5, 0.5, 0, 0]],
    [1.24, 0.188, 0.136, [2, 0, 0, 0], [1, 0, 0, 0]],
    [1.34, 0.195, 0.138, [2, 0, 0, 0], [1, 0, 0, 0]],
    [1.43, 0.182, 0.126, [2, 0, 0, 0], [1, 0, 0, 0]],
    [1.48, 0.115, 0.095, [2, 3, 0, 0], [0.65, 0.35, 0, 0]], // Traps / BDU Collar
    [1.51, 0.082, 0.080, [2, 3, 0, 0], [0.35, 0.65, 0, 0]],
  ];
  pushLoftTube(
    torsoSpecs.map(([y, rx, rz, si, sw]) => ({
      center: new THREE.Vector3(0, y, 0),
      rx,
      rz,
      si,
      sw,
    })),
    28
  );

  // Articulated Arms (tucked smoothly into deltoid chest pocket + dense 6-loop elbow smoothing, zero shoulder separation!)
  for (const side of [-1, 1]) {
    const bUp = side < 0 ? 6 : 10;
    const bFo = side < 0 ? 7 : 11;
    const bHa = side < 0 ? 8 : 12;
    const armRings: Parameters<typeof pushLoftTube>[0] = [];
    const totalRings = 28;
    for (let i = 0; i <= totalRings; i++) {
      const t = i / totalRings;
      let cx = side * 0.21;
      let y = 1.38 - ((t - 0.10) / 0.90) * 0.60;
      let r = 0.068;

      if (i === 0) {
        cx = side * 0.140;
        y = 1.385;
        r = 0.076;
      } else if (i === 1) {
        cx = side * 0.174;
        y = 1.382;
        r = 0.075;
      } else if (i === 2) {
        cx = side * 0.200;
        y = 1.374;
        r = 0.073;
      } else if (t < 0.46) {
        r = THREE.MathUtils.lerp(0.070, 0.056, (t - 0.08) / 0.38);
      } else if (t < 0.86) {
        r = THREE.MathUtils.lerp(0.057, 0.042, (t - 0.46) / 0.40);
      } else {
        r = 0.038; // Slim cuff transitioning into glove hand
      }

      let si: [number, number, number, number] = [bUp, bFo, bHa, 2];
      let sw: [number, number, number, number] = [0, 0, 0, 0];
      if (i === 0) {
        si = [2, bUp, 0, 0];
        sw = [0.78, 0.22, 0, 0]; // Blended into chest socket
      } else if (i === 1) {
        si = [2, bUp, 0, 0];
        sw = [0.48, 0.52, 0, 0];
      } else if (i === 2) {
        si = [2, bUp, 0, 0];
        sw = [0.18, 0.82, 0, 0];
      } else if (t < 0.36) {
        sw = [1, 0, 0, 0];
      } else if (t < 0.54) {
        const u = THREE.MathUtils.smoothstep(t, 0.36, 0.54);
        sw = [1 - u, u, 0, 0]; // 5+ edge loops smoothed across elbow!
      } else if (t < 0.82) {
        sw = [0, 1, 0, 0];
      } else if (t < 0.91) {
        const u = THREE.MathUtils.smoothstep(t, 0.82, 0.91);
        sw = [0, 1 - u, u, 0];
      } else {
        sw = [0, 0, 1, 0];
      }
      armRings.push({ center: new THREE.Vector3(cx, y, 0), rx: r, rz: r * 0.94, si, sw });
    }
    pushLoftTube(armRings, 24, false, true);
  }

  // Articulated Legs (tucked cleanly into pelvis + 6-loop knee smoothing!)
  for (const side of [-1, 1]) {
    const bTh = side < 0 ? 13 : 16;
    const bSh = side < 0 ? 14 : 17;
    const bFt = side < 0 ? 15 : 18;
    const xPos = side * 0.11;
    const legRings: Parameters<typeof pushLoftTube>[0] = [];
    const totalRings = 28;
    for (let i = 0; i <= totalRings; i++) {
      const t = i / totalRings;
      const y = 0.94 - t * 0.88; // Pelvis Hip 0.94 -> Knee 0.48 -> Ankle 0.06
      let rx = 0.095;
      let rz = 0.098;
      if (t < 0.48) {
        const u = t / 0.48;
        rx = THREE.MathUtils.lerp(0.106, 0.072, u);
        rz = THREE.MathUtils.lerp(0.108, 0.074, u);
      } else {
        const u = (t - 0.48) / 0.52;
        rx = THREE.MathUtils.lerp(0.074, 0.052, u);
        rz = THREE.MathUtils.lerp(0.076, 0.054, u);
      }
      if (t > 0.16 && t < 0.36) {
        rx += Math.sin(((t - 0.16) / 0.20) * Math.PI) * 0.016;
      }

      let si: [number, number, number, number] = [bTh, bSh, bFt, 0];
      let sw: [number, number, number, number] = [0, 0, 0, 0];
      if (t < 0.10) {
        const w = t / 0.10;
        sw = [w, 0, 0, 1 - w];
      } else if (t < 0.40) {
        sw = [1, 0, 0, 0];
      } else if (t < 0.58) {
        const u = THREE.MathUtils.smoothstep(t, 0.40, 0.58);
        sw = [1 - u, u, 0, 0];
      } else if (t < 0.90) {
        sw = [0, 1, 0, 0];
      } else {
        const w = (t - 0.90) / 0.10;
        sw = [0, 1 - w, w, 0];
      }
      legRings.push({ center: new THREE.Vector3(xPos, y, 0), rx, rz, si, sw });
    }
    pushLoftTube(legRings, 24, false, true);
  }

  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
  bodyGeo.setAttribute('uv', new THREE.Float32BufferAttribute(bUv, 2));
  bodyGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(bSkinI, 4));
  bodyGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(bSkinW, 4));
  bodyGeo.setIndex(bIdx);
  bodyGeo.computeVertexNormals();

  // --- 1B. BALACLAVA MASK & TACTICAL GLOVED HANDS (Deep Slate Matte Cloth) ---
  const mPos: number[] = [];
  const mUv: number[] = [];
  const mSkinI: number[] = [];
  const mSkinW: number[] = [];
  const mIdx: number[] = [];
  const maskRings: Array<[number, number, number, [number, number, number, number], [number, number, number, number]]> = [
    [1.47, 0.088, 0.088, [2, 3, 0, 0], [0.5, 0.5, 0, 0]],
    [1.52, 0.075, 0.075, [3, 0, 0, 0], [1, 0, 0, 0]],
    [1.56, 0.077, 0.080, [3, 4, 0, 0], [0.4, 0.6, 0, 0]],
    [1.60, 0.088, 0.098, [4, 0, 0, 0], [1, 0, 0, 0]],
    [1.66, 0.094, 0.106, [4, 0, 0, 0], [1, 0, 0, 0]],
    [1.72, 0.092, 0.102, [4, 0, 0, 0], [1, 0, 0, 0]],
    [1.77, 0.076, 0.084, [4, 0, 0, 0], [1, 0, 0, 0]],
    [1.80, 0.034, 0.038, [4, 0, 0, 0], [1, 0, 0, 0]],
  ];
  {
    const startV = 0;
    const rad = 24;
    const stride = rad + 1;
    for (let i = 0; i < maskRings.length; i++) {
      const [y, rx, rz, si, sw] = maskRings[i];
      const t = i / (maskRings.length - 1);
      for (let j = 0; j <= rad; j++) {
        const a = (j / rad) * Math.PI * 2;
        mPos.push(Math.cos(a) * rx, y, Math.sin(a) * rz);
        mUv.push(j / rad, t);
        mSkinI.push(...si);
        mSkinW.push(...sw);
      }
    }
    for (let i = 0; i < maskRings.length - 1; i++) {
      for (let j = 0; j < rad; j++) {
        const a = startV + i * stride + j;
        const b = startV + (i + 1) * stride + j;
        const c = startV + (i + 1) * stride + (j + 1);
        const d = startV + i * stride + (j + 1);
        mIdx.push(a, b, d, b, c, d);
      }
    }
  }
  for (const [side, bHa] of [[-1, 8], [1, 12]] as Array<[number, number]>) {
    const palm = createChamferedBox(0.048, 0.092, 0.068, 0.014, 3, 3);
    palm.translate(side * 0.21, 0.80, 0.008);
    appendSkinnedPart(palm, bHa, mPos, mUv, mSkinI, mSkinW, mIdx);
  }
  const maskGeo = new THREE.BufferGeometry();
  maskGeo.setAttribute('position', new THREE.Float32BufferAttribute(mPos, 3));
  maskGeo.setAttribute('uv', new THREE.Float32BufferAttribute(mUv, 2));
  maskGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mSkinI, 4));
  maskGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(mSkinW, 4));
  maskGeo.setIndex(mIdx);
  maskGeo.computeVertexNormals();

  // --- 2. LAYERED COYOTE TAN TACTICAL GEAR (Plate Carrier + MOLLE + Mag Pouches + Fitted Joint Pads + Laced Boots) ---
  const gPos: number[] = [];
  const gUv: number[] = [];
  const gSkinI: number[] = [];
  const gSkinW: number[] = [];
  const gIdx: number[] = [];

  // Contoured Plate Carrier Vest (Bone 2 = Chest) — tight chest straps without protruding shoulder boxes!
  const vestParts: THREE.BufferGeometry[] = [];
  const chestPlate = createChamferedBox(0.31, 0.34, 0.27, 0.026, 3, 3);
  chestPlate.translate(0, 1.27, 0.01);
  vestParts.push(chestPlate);

  // Fitted plate carrier shoulder straps resting cleanly atop collarbone
  for (const sx of [-0.105, 0.105]) {
    const strap = createChamferedBox(0.068, 0.09, 0.20, 0.014, 2, 2);
    strap.translate(sx, 1.44, 0.0);
    vestParts.push(strap);
  }

  // Raised 3D MOLLE horizontal webbing rows (front & back)
  for (let r = 0; r < 5; r++) {
    const ry = 1.15 + r * 0.052;
    const frontRow = createChamferedBox(0.26, 0.022, 0.016, 0.004, 2, 2);
    frontRow.translate(0, ry, 0.144);
    vestParts.push(frontRow);
    const backRow = createChamferedBox(0.26, 0.022, 0.016, 0.004, 2, 2);
    backRow.translate(0, ry, -0.130);
    vestParts.push(backRow);
  }

  // 3 Dimensional Front Magazine Pouches with curved flaps + radio pack
  for (const px of [-0.082, 0, 0.082]) {
    const pouch = createChamferedBox(0.070, 0.142, 0.048, 0.012, 3, 3);
    pouch.translate(px, 1.18, 0.166);
    vestParts.push(pouch);
    const flap = createChamferedBox(0.074, 0.052, 0.054, 0.010, 2, 2);
    flap.translate(px, 1.23, 0.168);
    vestParts.push(flap);
  }
  const backPack = createChamferedBox(0.22, 0.27, 0.09, 0.022, 3, 3);
  backPack.translate(0, 1.26, -0.175);
  vestParts.push(backPack);
  const antenna = createLatheZ([[0.005, 0], [0.003, 0.24]], 8);
  antenna.rotateX(-Math.PI * 0.5);
  antenna.translate(-0.11, 1.40, -0.145);
  vestParts.push(antenna);

  // Tactical Belt (Bone 0 = Pelvis)
  const belt = createChamferedBox(0.34, 0.058, 0.25, 0.014, 2, 2);
  belt.translate(0, 0.96, 0.01);
  appendSkinnedPart(belt, 0, gPos, gUv, gSkinI, gSkinW, gIdx);

  const vestMerged = mergeParts(vestParts, false);
  appendSkinnedPart(vestMerged, 2, gPos, gUv, gSkinI, gSkinW, gIdx);

  // Contoured Elbow Pads seated cleanly at joint center (50% UpperArm + 50% Forearm so pad never floats!)
  for (const [side, bUp, bFo] of [[-1, 6, 7], [1, 10, 11]] as Array<[number, number, number]>) {
    const ep = createChamferedBox(0.088, 0.10, 0.055, 0.022, 3, 3);
    ep.translate(side * 0.21, 1.10, -0.042);
    appendSkinnedPart(ep, bUp, gPos, gUv, gSkinI, gSkinW, gIdx, bFo, 0.5, 0.5);
  }

  // Contoured Knee Pads seated cleanly at knee hinge (45% Thigh + 55% Shin)
  for (const [side, bTh, bSh] of [[-1, 13, 14], [1, 16, 17]] as Array<[number, number, number]>) {
    const kp = createChamferedBox(0.11, 0.125, 0.065, 0.025, 3, 3);
    kp.translate(side * 0.11, 0.48, 0.062);
    appendSkinnedPart(kp, bTh, gPos, gUv, gSkinI, gSkinW, gIdx, bSh, 0.45, 0.55);
  }

  // High-Top Laced Combat Boots with Lugged Tread Soles (skinned to Feet 15 & 18)
  for (const [side, bIdxIdx] of [[-1, 15], [1, 18]] as Array<[number, number]>) {
    const bootParts: THREE.BufferGeometry[] = [];
    const upper = createChamferedBox(0.105, 0.14, 0.15, 0.024, 3, 3);
    upper.translate(side * 0.11, 0.09, 0.01);
    bootParts.push(upper);
    const toeBox = createChamferedBox(0.108, 0.078, 0.17, 0.026, 3, 3);
    toeBox.translate(side * 0.11, 0.048, 0.09);
    bootParts.push(toeBox);
    for (let t = 0; t < 5; t++) {
      const tread = createChamferedBox(0.112, 0.022, 0.032, 0.005, 2, 2);
      tread.translate(side * 0.11, 0.011, -0.04 + t * 0.052);
      bootParts.push(tread);
    }
    appendSkinnedPart(mergeParts(bootParts, false), bIdxIdx, gPos, gUv, gSkinI, gSkinW, gIdx);
  }

  const gearGeo = new THREE.BufferGeometry();
  gearGeo.setAttribute('position', new THREE.Float32BufferAttribute(gPos, 3));
  gearGeo.setAttribute('uv', new THREE.Float32BufferAttribute(gUv, 2));
  gearGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(gSkinI, 4));
  gearGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(gSkinW, 4));
  gearGeo.setIndex(gIdx);
  gearGeo.computeVertexNormals();

  // --- 3. TACTICAL HELMET (ARC Side Rails + NVG Shroud + Goggles Strap) -> Attached to Bone 4 (Head) ---
  const hParts: THREE.BufferGeometry[] = [];
  // Sculpted high-cut FAST helmet shell
  const domePts: Array<[number, number]> = [
    [0.108, -0.01],
    [0.115, 0.03],
    [0.112, 0.085],
    [0.088, 0.135],
    [0.042, 0.156],
    [0.001, 0.160],
  ];
  const shell = new THREE.LatheGeometry(
    domePts.map(([r, y]) => new THREE.Vector2(r, y)),
    28
  );
  shell.scale(0.95, 1.0, 1.12);
  hParts.push(shell);

  // Front NVG Shroud Mount
  const nvg = createChamferedBox(0.046, 0.052, 0.022, 0.005, 2, 2);
  nvg.rotateX(-0.25);
  nvg.translate(0, 0.068, 0.118);
  hParts.push(nvg);

  // Left & Right Tactical ARC Accessory Rails (with miniature Picatinny slots!)
  for (const sx of [-0.104, 0.104]) {
    const arcRail = createPicatinnyRail(0.095, 0.018, 0.007, 0.012);
    arcRail.rotateY(sx > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
    arcRail.rotateZ(sx > 0 ? -0.15 : 0.15);
    arcRail.translate(sx, 0.026, 0.015);
    hParts.push(arcRail);
  }
  // Goggle retention strap around helmet
  const strapCurve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-0.07, 0.01, 0.11),
      new THREE.Vector3(-0.112, 0.015, 0.0),
      new THREE.Vector3(0.0, 0.015, -0.125),
      new THREE.Vector3(0.112, 0.015, 0.0),
      new THREE.Vector3(0.07, 0.01, 0.11),
    ],
    false
  );
  hParts.push(sweepProfileAlongCurve(strapCurve, roundedRectProfile(0.022, 0.008, 0.002, 2), 20, undefined, true));

  const helmetGeo = mergeParts(hParts, true);

  // Tinted Ballistic Goggles resting cleanly over upper face / brow
  const gogParts: THREE.BufferGeometry[] = [];
  const gogFrame = createChamferedBox(0.138, 0.046, 0.036, 0.008, 3, 3);
  gogFrame.translate(0, 0.005, 0.102);
  gogParts.push(gogFrame);
  const gogglesGeo = mergeParts(gogParts, false);

  // --- 4. HIGH-DETAIL ENEMY CARBINE RIFLE (>= 2,200 tris) ---
  const rParts: THREE.BufferGeometry[] = [];
  rParts.push(createChamferedBox(0.038, 0.056, 0.22, 0.004, 3, 3));
  const rRail = createPicatinnyRail(0.32, 0.020, 0.008, 0.011);
  rRail.translate(0, 0.032, 0.08);
  rParts.push(rRail);
  const rHg = createChamferedBox(0.042, 0.046, 0.22, 0.008, 3, 3);
  rHg.translate(0, 0.01, 0.21);
  rParts.push(rHg);
  const rBrl = createLatheZ([[0.010, 0.12], [0.010, 0.44]], 16);
  rBrl.translate(0, 0.012, 0);
  rParts.push(rBrl);
  const rFh = createSlottedFlashHider(0.012, 0.006, 0.045, 5, 4);
  rFh.translate(0, 0.012, 0.44);
  rParts.push(rFh);
  const rStock = createChamferedBox(0.032, 0.090, 0.15, 0.008, 3, 3);
  rStock.translate(0, -0.01, -0.17);
  rParts.push(rStock);
  const rGrip = createChamferedBox(0.028, 0.095, 0.038, 0.006, 2, 2);
  rGrip.rotateX(0.32);
  rGrip.translate(0, -0.065, -0.05);
  rParts.push(rGrip);
  const rMagCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.02, 0.06),
    new THREE.Vector3(0, -0.10, 0.068),
    new THREE.Vector3(0, -0.17, 0.088),
  ]);
  rParts.push(sweepProfileAlongCurve(rMagCurve, roundedRectProfile(0.024, 0.058, 0.004, 2), 10, undefined, true));
  const rifleGeo = mergeParts(rParts, true);

  const triangleCount =
    countTriangles(bodyGeo) +
    countTriangles(maskGeo) +
    countTriangles(gearGeo) +
    countTriangles(helmetGeo) +
    countTriangles(gogglesGeo) +
    countTriangles(rifleGeo);

  return { bodyGeo, maskGeo, gearGeo, helmetGeo, gogglesGeo, rifleGeo, triangleCount };
}

export class EnemySoldier {
  public id: number;
  public root = new THREE.Group();
  public bones: THREE.Bone[] = [];
  public pelvisBone!: THREE.Bone;
  public spineBone!: THREE.Bone;
  public chestBone!: THREE.Bone;
  public headBone!: THREE.Bone;
  public lUpperArm!: THREE.Bone;
  public lForearm!: THREE.Bone;
  public rUpperArm!: THREE.Bone;
  public rForearm!: THREE.Bone;
  public lThigh!: THREE.Bone;
  public lShin!: THREE.Bone;
  public rThigh!: THREE.Bone;
  public rShin!: THREE.Bone;

  public muzzlePoint = new THREE.Object3D();
  public muzzleFlash: THREE.Mesh;
  public hitboxMeshes: THREE.Object3D[] = [];
  private rifleGroup = new THREE.Group();
  private rifleRightGrip = new THREE.Object3D();
  private rifleLeftGrip = new THREE.Object3D();

  public hp = 100;
  public maxHp = 100;
  public state: EnemyState = 'patrol';
  public position = new THREE.Vector3();
  public yaw = 0;

  private patrolPoints: THREE.Vector3[];
  private patrolIdx = 0;
  private coverPos: THREE.Vector3 | null = null;
  private stateTimer = 0;
  private fireCooldown = 0;
  private burstRemaining = 0;
  private ammo = 30;
  private flinchTimer = 0;
  private flinchYaw = 0;
  private exposureTime = 0;
  private muzzleTimer = 0;
  private deathTimer = 0;
  private walkPhase = Math.random() * 6;
  private lastKnownPlayerPos = new THREE.Vector3();
  private hasSeenPlayer = false;
  private lastValidPos = new THREE.Vector3();
  private wallStuckTime = 0;
  private rifleDropped = false;
  private rifleResting = false;
  private rifleVel = new THREE.Vector3();
  private rifleSpin = new THREE.Vector3();

  constructor(
    id: number,
    spawnPos: THREE.Vector3,
    patrolPoints: THREE.Vector3[],
    coverPos: THREE.Vector3 | null,
    template: SoldierRigTemplate,
    mats: SoldierSharedMats
  ) {
    this.id = id;
    this.position.copy(spawnPos);
    this.lastValidPos.copy(spawnPos);
    this.patrolPoints = patrolPoints;
    this.coverPos = coverPos;
    // IMPORTANT: Keep root at (0,0,0) during skeleton bind so bindMatrix == Identity matches boneInverses!
    this.root.position.set(0, 0, 0);

    // Construct 19-bone Humanoid Skeleton matching exact bind-pose world positions!
    const makeBone = (name: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x, y, z);
      parent.add(b);
      this.bones.push(b);
      return b;
    };

    const skelRoot = new THREE.Group();
    this.root.add(skelRoot);

    this.pelvisBone = makeBone('Pelvis', skelRoot, 0, 0.94, 0); // 0
    this.spineBone = makeBone('Spine', this.pelvisBone, 0, 0.16, 0); // 1 (y=1.10)
    this.chestBone = makeBone('Chest', this.spineBone, 0, 0.22, 0); // 2 (y=1.32)
    const neck = makeBone('Neck', this.chestBone, 0, 0.20, 0); // 3 (y=1.52)
    this.headBone = makeBone('Head', neck, 0, 0.14, 0); // 4 (y=1.66)

    const lSh = makeBone('L_Sh', this.chestBone, -0.21, 0.06, 0); // 5 (y=1.38)
    this.lUpperArm = makeBone('L_UpArm', lSh, 0, 0, 0); // 6
    this.lForearm = makeBone('L_Fore', this.lUpperArm, 0, -0.28, 0); // 7 (y=1.10)
    makeBone('L_Hand', this.lForearm, 0, -0.26, 0); // 8 (y=0.84)

    const rSh = makeBone('R_Sh', this.chestBone, 0.21, 0.06, 0); // 9 (y=1.38)
    this.rUpperArm = makeBone('R_UpArm', rSh, 0, 0, 0); // 10
    this.rForearm = makeBone('R_Fore', this.rUpperArm, 0, -0.28, 0); // 11
    makeBone('R_Hand', this.rForearm, 0, -0.26, 0); // 12

    this.lThigh = makeBone('L_Thigh', this.pelvisBone, -0.11, -0.02, 0); // 13 (y=0.92)
    this.lShin = makeBone('L_Shin', this.lThigh, 0, -0.44, 0); // 14 (y=0.48)
    makeBone('L_Foot', this.lShin, 0, -0.42, 0); // 15 (y=0.06)

    this.rThigh = makeBone('R_Thigh', this.pelvisBone, 0.11, -0.02, 0); // 16
    this.rShin = makeBone('R_Shin', this.rThigh, 0, -0.44, 0); // 17
    makeBone('R_Foot', this.rShin, 0, -0.42, 0); // 18

    const bodySkinned = new THREE.SkinnedMesh(template.bodyGeo, mats.camo);
    bodySkinned.castShadow = true;
    bodySkinned.receiveShadow = true;
    bodySkinned.frustumCulled = false;
    this.root.add(bodySkinned);

    const gearSkinned = new THREE.SkinnedMesh(template.gearGeo, mats.gear);
    gearSkinned.castShadow = true;
    gearSkinned.receiveShadow = true;
    gearSkinned.frustumCulled = false;
    this.root.add(gearSkinned);

    const maskSkinned = new THREE.SkinnedMesh(template.maskGeo, mats.balaclava);
    maskSkinned.castShadow = true;
    maskSkinned.receiveShadow = true;
    maskSkinned.frustumCulled = false;
    this.root.add(maskSkinned);

    this.root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(this.bones);
    bodySkinned.bind(skeleton);
    gearSkinned.bind(skeleton);
    maskSkinned.bind(skeleton);

    // Move soldier to world spawn position AFTER binding!
    this.root.position.copy(spawnPos);

    // Rigidly parented Helmet & Goggles on Head Bone (4)
    const helmetMesh = new THREE.Mesh(template.helmetGeo, mats.helmetPaint);
    helmetMesh.castShadow = true;
    helmetMesh.receiveShadow = true;
    this.headBone.add(helmetMesh);

    const gogglesMesh = new THREE.Mesh(template.gogglesGeo, mats.goggleLens);
    gogglesMesh.castShadow = true;
    this.headBone.add(gogglesMesh);

    // Carbine Rifle attached to Chest Bone cleanly ahead of vest pouches, with grip sockets for 2-Bone IK!
    const rifleMesh = new THREE.Mesh(template.rifleGeo, mats.gunMetal);
    rifleMesh.castShadow = true;
    this.rifleGroup.position.set(0.17, 0.02, 0.34);
    this.rifleGroup.add(rifleMesh);
    this.chestBone.add(this.rifleGroup);

    this.rifleRightGrip.position.set(0.0, -0.045, -0.05);
    this.rifleGroup.add(this.rifleRightGrip);

    this.rifleLeftGrip.position.set(-0.015, -0.012, 0.21);
    this.rifleGroup.add(this.rifleLeftGrip);

    this.muzzlePoint.position.set(0.0, 0.012, 0.48);
    this.rifleGroup.add(this.muzzlePoint);

    this.muzzleFlash = new THREE.Mesh(
      new THREE.SphereGeometry(0.085, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffbb44, transparent: true, opacity: 0.9 })
    );
    this.muzzleFlash.visible = false;
    this.muzzlePoint.add(this.muzzleFlash);

    // Invisible bone-parented hitbox proxies for exact moving Head / Torso / Limb hit detection!
    const hbMat = new THREE.MeshBasicMaterial({ visible: false });
    const addHitbox = (parent: THREE.Object3D, w: number, h: number, d: number, oy: number, zone: 'head' | 'torso' | 'limb') => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), hbMat);
      m.position.set(0, oy, 0);
      m.userData.enemyId = id;
      m.userData.hitZone = zone;
      parent.add(m);
      this.hitboxMeshes.push(m);
    };
    addHitbox(this.headBone, 0.24, 0.26, 0.26, 0.04, 'head');
    addHitbox(this.chestBone, 0.36, 0.44, 0.28, -0.06, 'torso');
    addHitbox(this.pelvisBone, 0.32, 0.22, 0.24, 0.02, 'torso');
    addHitbox(this.lThigh, 0.18, 0.44, 0.18, -0.22, 'limb');
    addHitbox(this.rThigh, 0.18, 0.44, 0.18, -0.22, 'limb');
    addHitbox(this.lShin, 0.14, 0.42, 0.14, -0.21, 'limb');
    addHitbox(this.rShin, 0.14, 0.42, 0.14, -0.21, 'limb');
    addHitbox(this.lUpperArm, 0.14, 0.30, 0.14, -0.15, 'limb');
    addHitbox(this.rUpperArm, 0.14, 0.30, 0.14, -0.15, 'limb');
  }

  public getHeadWorldPos(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + 1.60, this.position.z);
  }

  public takeDamage(dmg: number, shooterPos: THREE.Vector3): boolean {
    if (this.state === 'dead') return false;
    this.hp -= dmg;
    this.flinchTimer = 0.22;
    this.flinchYaw = (Math.random() - 0.5) * 0.75;
    this.lastKnownPlayerPos.copy(shooterPos);
    this.hasSeenPlayer = true;
    if (this.state === 'patrol' || this.state === 'alert') {
      this.state = 'combat';
      this.stateTimer = 2.0;
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dead';
      this.deathTimer = 0;
      this.muzzleFlash.visible = false;
      if (!this.rifleDropped) {
        // Physically unbind rifle from chest/hands so it drops beside corpse via gravity (zero chest clipping!)
        this.root.updateMatrixWorld(true);
        this.root.attach(this.rifleGroup);
        this.rifleDropped = true;
        this.rifleResting = false;
        const sideSign = Math.random() > 0.4 ? 1 : -1;
        this.rifleVel.set(sideSign * (1.25 + Math.random() * 0.6), 1.15 + Math.random() * 0.45, 0.65 + Math.random() * 0.45);
        this.rifleSpin.set((Math.random() - 0.5) * 3.5, (Math.random() - 0.5) * 3.0, sideSign * (2.6 + Math.random() * 2.0));
      }
      return true;
    }
    return false;
  }

  public forceAlert(duration = 20): void {
    if (this.state === 'dead') return;
    this.state = 'alert';
    this.stateTimer = duration;
  }

  public hearGunshot(pos: THREE.Vector3, hearingRadius = 58): void {
    if (this.state === 'dead') return;
    if (this.position.distanceTo(pos) < hearingRadius) {
      this.lastKnownPlayerPos.copy(pos);
      if (this.state === 'patrol') {
        this.state = 'alert';
        this.stateTimer = 4.5;
      }
    }
  }

  /**
   * 2-Bone IK for enemy arms oriented along -Y bind axis toward target in `chestBone` local space.
   */
  private solveChestArmIK(
    upperArm: THREE.Bone,
    forearm: THREE.Bone,
    shoulderOffset: THREE.Vector3,
    targetChestSpace: THREE.Vector3,
    poleDir: THREE.Vector3
  ): void {
    const l1 = 0.28;
    const l2 = 0.26;
    const rel = targetChestSpace.clone().sub(shoulderOffset);
    let dist = rel.length();
    const maxR = (l1 + l2) * 0.985;
    if (dist > maxR) {
      rel.multiplyScalar(maxR / dist);
      dist = maxR;
    }
    dist = Math.max(0.08, dist);
    const dir = rel.clone().normalize();
    const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
    const angA = Math.acos(cosA);

    const poleProj = poleDir.clone().addScaledVector(dir, -poleDir.dot(dir));
    if (poleProj.lengthSq() < 1e-6) {
      poleProj.set(1, 0, 0).addScaledVector(dir, -dir.x);
    }
    poleProj.normalize();
    const upperDir = dir.clone().multiplyScalar(Math.cos(angA)).addScaledVector(poleProj, Math.sin(angA)).normalize();

    const elbow = upperDir.clone().multiplyScalar(l1);
    const foreRel = rel.clone().sub(elbow);
    const foreDir = foreRel.lengthSq() > 1e-6 ? foreRel.normalize() : dir.clone();

    // Shared anatomical hinge axis perpendicular to arm bend plane guarantees zero elbow twist/pinch!
    const hingeRaw = new THREE.Vector3().crossVectors(upperDir, foreDir);
    if (hingeRaw.lengthSq() < 1e-5) {
      hingeRaw.crossVectors(poleProj, upperDir);
    }
    if (hingeRaw.lengthSq() < 1e-5) {
      hingeRaw.set(1, 0, 0);
    }
    const sideAxis = hingeRaw.normalize();

    const negUpper = upperDir.clone().negate();
    const uFwd = new THREE.Vector3().crossVectors(sideAxis, negUpper);
    if (uFwd.lengthSq() < 1e-6) uFwd.set(0, 0, 1);
    uFwd.normalize();
    const uSide = new THREE.Vector3().crossVectors(negUpper, uFwd).normalize();
    const uMat = new THREE.Matrix4().makeBasis(uSide, negUpper, uFwd);
    upperArm.quaternion.setFromRotationMatrix(uMat);

    const negFore = foreDir.clone().negate();
    const fFwd = new THREE.Vector3().crossVectors(sideAxis, negFore);
    if (fFwd.lengthSq() < 1e-6) fFwd.copy(uFwd);
    fFwd.normalize();
    const fSide = new THREE.Vector3().crossVectors(negFore, fFwd).normalize();
    const fWorldMat = new THREE.Matrix4().makeBasis(fSide, negFore, fFwd);
    const uInv = new THREE.Matrix4().copy(uMat).invert();
    forearm.quaternion.setFromRotationMatrix(uInv.multiply(fWorldMat));
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    canSeePlayer: boolean,
    terrain: WorldSurface,
    boxColliders: BoxCollider[],
    cylColliders: CylinderCollider[],
    onFire: (ev: EnemyFireEvent) => void
  ): void {
    if (this.muzzleTimer > 0) {
      this.muzzleTimer -= dt;
      if (this.muzzleTimer <= 0) this.muzzleFlash.visible = false;
    }
    if (this.flinchTimer > 0) this.flinchTimer = Math.max(0, this.flinchTimer - dt);

    if (this.state === 'dead') {
      this.deathTimer = Math.min(1, this.deathTimer + dt * 2.5);
      const t = THREE.MathUtils.smoothstep(this.deathTimer, 0, 1);
      // Sample terrain slope so fallen soldier lies flush on hillside (no half-floating / buried!)
      const gNormal = terrain.getNormalAt(this.position.x, this.position.z);
      const slopePitch = Math.atan2(gNormal.z, gNormal.y) * Math.cos(this.yaw) + Math.atan2(gNormal.x, gNormal.y) * Math.sin(this.yaw);
      this.pelvisBone.position.y = THREE.MathUtils.lerp(0.94, 0.14, t);
      this.pelvisBone.rotation.x = THREE.MathUtils.lerp(0, -Math.PI * 0.48 + slopePitch * 0.65, t);
      this.spineBone.rotation.set(0.14 * t, 0, 0);
      this.lUpperArm.rotation.set(-0.35 * t, 0, 0.34 * t);
      this.lForearm.rotation.set(-0.22 * t, 0, 0);
      this.rUpperArm.rotation.set(-0.32 * t, 0, -0.36 * t);
      this.rForearm.rotation.set(-0.20 * t, 0, 0);
      this.lThigh.rotation.x = 0.12 * t;
      this.rThigh.rotation.x = -0.10 * t;
      this.lShin.rotation.x = 0.22 * t;
      this.rShin.rotation.x = 0.18 * t;

      // Physically simulate unlinked dropped rifle falling & resting flat beside the corpse
      if (this.rifleDropped && !this.rifleResting) {
        const subDt = Math.min(dt, 0.04);
        this.rifleVel.y -= 11.5 * subDt;
        this.rifleGroup.position.addScaledVector(this.rifleVel, subDt);
        this.rifleGroup.rotation.x += this.rifleSpin.x * subDt;
        this.rifleGroup.rotation.y += this.rifleSpin.y * subDt;
        this.rifleGroup.rotation.z += this.rifleSpin.z * subDt;

        const rifleWorld = this.rifleGroup.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).add(this.position);
        const groundY = terrain.getHeightAt(rifleWorld.x, rifleWorld.z, this.position.y + 0.5);
        const localGroundY = groundY - this.position.y;
        if (this.rifleGroup.position.y <= localGroundY + 0.045) {
          this.rifleGroup.position.y = localGroundY + 0.036;
          this.rifleVel.set(0, 0, 0);
          this.rifleResting = true;
          // Settle carbine flat on its side aligned with terrain normal
          const surfN = terrain.getNormalAt(rifleWorld.x, rifleWorld.z);
          const localN = surfN.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw).normalize();
          const alignQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), localN);
          const flatSideQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.45 + (this.id % 3) * 0.22, Math.PI * 0.5));
          this.rifleGroup.quaternion.copy(alignQ).multiply(flatSideQ);
        }
      }
      return;
    }

    const distToPlayer = this.position.distanceTo(playerPos);
    if (canSeePlayer) {
      this.hasSeenPlayer = true;
      this.exposureTime = Math.min(3.5, this.exposureTime + dt);
      this.lastKnownPlayerPos.copy(playerPos);
      if (this.state === 'patrol' || this.state === 'alert') {
        this.state = 'combat';
        this.stateTimer = 2.4 + Math.random() * 1.4;
        // Human reaction window before first shot on spotting player
        this.fireCooldown = Math.max(this.fireCooldown, 0.50 + Math.random() * 0.35);
      }
    } else {
      this.exposureTime = Math.max(0, this.exposureTime - dt * 1.4);
    }

    let moveTarget: THREE.Vector3 | null = null;
    let moveSpeed = 0;
    let aimAtPlayer = false;
    let crouching = false;

    switch (this.state) {
      case 'patrol': {
        const wp = this.patrolPoints[this.patrolIdx];
        if (this.position.distanceTo(wp) < 1.2) {
          this.patrolIdx = (this.patrolIdx + 1) % this.patrolPoints.length;
        } else {
          moveTarget = wp;
          moveSpeed = 1.9;
        }
        break;
      }
      case 'alert': {
        this.stateTimer -= dt;
        moveTarget = this.lastKnownPlayerPos;
        moveSpeed = 2.8;
        if (this.stateTimer <= 0 || this.position.distanceTo(this.lastKnownPlayerPos) < 4) {
          this.state = 'patrol';
        }
        break;
      }
      case 'combat': {
        this.stateTimer -= dt;
        aimAtPlayer = canSeePlayer;

        if (!canSeePlayer && this.hasSeenPlayer && distToPlayer > 14) {
          moveTarget = this.lastKnownPlayerPos;
          moveSpeed = 3.2;
        } else if (this.coverPos && this.stateTimer <= 0) {
          this.state = 'cover';
          this.stateTimer = 1.6 + Math.random() * 1.4;
        }

        if (canSeePlayer) {
          this.fireCooldown -= dt;
          if (this.ammo <= 0) {
            this.state = 'reload';
            this.stateTimer = 2.1;
          } else if (this.fireCooldown <= 0) {
            if (this.burstRemaining <= 0) {
              this.burstRemaining = 2 + Math.floor(Math.random() * 2);
            }
            const mPos = new THREE.Vector3();
            this.muzzlePoint.getWorldPosition(mPos);
            const aimTarget = playerPos.clone().add(new THREE.Vector3(0, 1.35, 0));
            const chestWorld = this.position.clone().add(new THREE.Vector3(0, 1.35, 0));

            // Strict Anti-Wall-Hack Check: never shoot if muzzle is inside a wall or gun barrel pokes through cover!
            let muzzleClear = true;
            const segRay = new THREE.Ray();
            const tmpHit = new THREE.Vector3();
            const cToM = mPos.clone().sub(chestWorld);
            const cToMLen = cToM.length();
            if (cToMLen > 0.01) cToM.divideScalar(cToMLen);
            const mToP = aimTarget.clone().sub(mPos);
            const mToPLen = mToP.length();
            if (mToPLen > 0.01) mToP.divideScalar(mToPLen);

            for (const c of boxColliders) {
              if (!c.blocksSight) continue;
              if (c.box.containsPoint(mPos)) {
                muzzleClear = false;
                break;
              }
              if (cToMLen > 0.05) {
                segRay.set(chestWorld, cToM);
                if (segRay.intersectBox(c.box, tmpHit) && tmpHit.distanceTo(chestWorld) <= cToMLen + 0.04) {
                  muzzleClear = false;
                  break;
                }
              }
              if (mToPLen > 0.2) {
                segRay.set(mPos, mToP);
                if (segRay.intersectBox(c.box, tmpHit) && tmpHit.distanceTo(mPos) < mToPLen - 0.35) {
                  muzzleClear = false;
                  break;
                }
              }
            }

            if (muzzleClear) {
              const dir = aimTarget.sub(mPos).normalize();
              const expFactor = Math.min(1, this.exposureTime / 3.0);
              const spread = THREE.MathUtils.lerp(0.135, 0.058, expFactor) + Math.min(0.045, distToPlayer * 0.0008);
              dir.x += (Math.random() - 0.5) * spread;
              dir.y += (Math.random() - 0.5) * spread;
              dir.z += (Math.random() - 0.5) * spread;
              dir.normalize();

              onFire({ origin: mPos, dir, damage: 7 });
              this.muzzleFlash.visible = true;
              this.muzzleTimer = 0.045;
              this.ammo--;
              this.burstRemaining--;
              this.fireCooldown = this.burstRemaining > 0 ? 0.16 : 1.25 + Math.random() * 0.80;
            } else {
              // Muzzle obstructed by wall -> reposition toward patrol/cover rather than shooting wall!
              this.fireCooldown = 0.25;
              if (this.coverPos) this.state = 'cover';
            }
          }
        }
        break;
      }
      case 'cover': {
        this.stateTimer -= dt;
        if (this.coverPos) {
          const dCov = this.position.distanceTo(this.coverPos);
          if (dCov > 0.9) {
            moveTarget = this.coverPos;
            moveSpeed = 3.7;
          } else {
            crouching = true;
          }
        }
        if (this.stateTimer <= 0) {
          this.state = 'combat';
          this.stateTimer = 2.6 + Math.random() * 1.6;
        }
        break;
      }
      case 'reload': {
        crouching = true;
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          this.ammo = 30;
          this.state = 'combat';
          this.stateTimer = 2.2;
        }
        break;
      }
    }

    let isMoving = false;
    const prevX = this.position.x;
    const prevZ = this.position.z;
    let intendedStep = 0;

    if (moveTarget && moveSpeed > 0) {
      const dx = moveTarget.x - this.position.x;
      const dz = moveTarget.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.35) {
        isMoving = true;
        intendedStep = Math.min(d, moveSpeed * dt);
        this.position.x += (dx / d) * intendedStep;
        this.position.z += (dz / d) * intendedStep;
        const targetYaw = Math.atan2(dx, dz);
        this.yaw = lerpAngle(this.yaw, targetYaw, Math.min(1, dt * 8));
      }
    }

    // Horizontal Capsule/Cylinder Wall & Cover Collision + Slide Push-Out (2 passes for crisp corners!)
    const colRadius = 0.58;
    const pBot = this.position.y + 0.32;
    const pTop = this.position.y + 1.78;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of boxColliders) {
        if (pTop < c.box.min.y || pBot > c.box.max.y) continue;
        const closestX = THREE.MathUtils.clamp(this.position.x, c.box.min.x, c.box.max.x);
        const closestZ = THREE.MathUtils.clamp(this.position.z, c.box.min.z, c.box.max.z);
        const dx = this.position.x - closestX;
        const dz = this.position.z - closestZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < colRadius * colRadius) {
          const dist = Math.sqrt(distSq);
          if (dist > 1e-5) {
            const push = colRadius - dist;
            this.position.x += (dx / dist) * push;
            this.position.z += (dz / dist) * push;
          } else {
            const penX = Math.min(Math.abs(this.position.x - c.box.min.x), Math.abs(c.box.max.x - this.position.x));
            const penZ = Math.min(Math.abs(this.position.z - c.box.min.z), Math.abs(c.box.max.z - this.position.z));
            if (penX < penZ) {
              this.position.x = this.position.x < (c.box.min.x + c.box.max.x) * 0.5 ? c.box.min.x - colRadius : c.box.max.x + colRadius;
            } else {
              this.position.z = this.position.z < (c.box.min.z + c.box.max.z) * 0.5 ? c.box.min.z - colRadius : c.box.max.z + colRadius;
            }
          }
        }
      }
      for (const cyl of cylColliders) {
        if (pTop < cyl.bottomY || pBot > cyl.topY) continue;
        const dx = this.position.x - cyl.x;
        const dz = this.position.z - cyl.z;
        const minR = colRadius + cyl.radius;
        const dSq = dx * dx + dz * dz;
        if (dSq < minR * minR && dSq > 1e-6) {
          const d = Math.sqrt(dSq);
          const push = minR - d;
          this.position.x += (dx / d) * push;
          this.position.z += (dz / d) * push;
        }
      }
    }

    // Inside-Wall Emergency Recovery: if core point ever clips inside a solid collider, restore last valid safe node!
    const corePt = new THREE.Vector3(this.position.x, this.position.y + 0.95, this.position.z);
    let insideSolid = false;
    for (const c of boxColliders) {
      if (c.blocksSight && c.box.containsPoint(corePt)) {
        insideSolid = true;
        break;
      }
    }
    if (insideSolid) {
      this.position.copy(this.lastValidPos);
    } else {
      this.lastValidPos.copy(this.position);
    }

    // If pinned trying to walk straight through a solid wall, smoothly disengage to patrol/cover
    if (intendedStep > 0.005) {
      const movedXZ = Math.hypot(this.position.x - prevX, this.position.z - prevZ);
      if (movedXZ < intendedStep * 0.15) {
        this.wallStuckTime += dt;
        if (this.wallStuckTime > 0.45) {
          this.wallStuckTime = 0;
          if (this.state === 'alert') {
            this.state = 'patrol';
            this.patrolIdx = (this.patrolIdx + 1) % this.patrolPoints.length;
          } else if (this.state === 'combat' && this.coverPos) {
            this.state = 'cover';
            this.stateTimer = 1.8;
          }
        }
      } else {
        this.wallStuckTime = 0;
      }
    }

    if (aimAtPlayer || (this.state === 'combat' && this.hasSeenPlayer)) {
      const lookPos = canSeePlayer ? playerPos : this.lastKnownPlayerPos;
      const targetYaw = Math.atan2(lookPos.x - this.position.x, lookPos.z - this.position.z);
      this.yaw = lerpAngle(this.yaw, targetYaw, Math.min(1, dt * 10));
    }

    this.position.y = terrain.getHeightAt(this.position.x, this.position.z, this.position.y + 0.5);
    this.root.position.copy(this.position);
    this.root.rotation.y = this.yaw;

    if (isMoving) {
      this.walkPhase += dt * moveSpeed * 2.4;
    } else {
      this.walkPhase = THREE.MathUtils.lerp(this.walkPhase, Math.round(this.walkPhase / Math.PI) * Math.PI, dt * 6);
    }

    const stride = isMoving ? Math.sin(this.walkPhase) * 0.48 : 0;
    const kneeBendL = isMoving ? Math.max(0, -Math.cos(this.walkPhase)) * 0.55 : crouching ? 0.92 : 0.06;
    const kneeBendR = isMoving ? Math.max(0, Math.cos(this.walkPhase)) * 0.55 : crouching ? 0.92 : 0.06;

    const targetPelvisY = crouching ? 0.62 : 0.94 + (isMoving ? Math.abs(Math.sin(this.walkPhase)) * 0.028 : 0);
    this.pelvisBone.position.y = THREE.MathUtils.lerp(this.pelvisBone.position.y, targetPelvisY, Math.min(1, dt * 12));

    this.lThigh.rotation.x = stride - (crouching ? 0.72 : 0);
    this.lShin.rotation.x = kneeBendL;
    this.rThigh.rotation.x = -stride - (crouching ? 0.72 : 0);
    this.rShin.rotation.x = kneeBendR;

    const flinchEnv = this.flinchTimer > 0 ? Math.sin((this.flinchTimer / 0.22) * Math.PI) : 0;
    this.spineBone.rotation.x = (crouching ? 0.22 : aimAtPlayer ? 0.08 : 0.02) + flinchEnv * -0.28;
    this.spineBone.rotation.y = flinchEnv * this.flinchYaw;
    this.headBone.rotation.x = crouching ? -0.14 : 0;

    // Orient Rifle cleanly in front of plate carrier pouches (zero chest/arm penetration) & solve 2-Bone IK!
    const isCombatPose = aimAtPlayer || this.state === 'combat';
    this.rifleGroup.position.lerp(
      isCombatPose ? new THREE.Vector3(0.17, 0.02, 0.34) : new THREE.Vector3(0.15, -0.06, 0.35),
      Math.min(1, dt * 10)
    );
    const targetRifleRotX = isCombatPose ? 0.0 : 0.32;
    const targetRifleRotY = isCombatPose ? -0.04 : -0.30;
    this.rifleGroup.rotation.x = THREE.MathUtils.lerp(this.rifleGroup.rotation.x, targetRifleRotX, Math.min(1, dt * 10));
    this.rifleGroup.rotation.y = THREE.MathUtils.lerp(this.rifleGroup.rotation.y, targetRifleRotY, Math.min(1, dt * 10));
    this.rifleGroup.updateMatrix();

    const rGripChest = this.rifleRightGrip.position.clone().applyMatrix4(this.rifleGroup.matrix);
    const lGripChest = this.rifleLeftGrip.position.clone().applyMatrix4(this.rifleGroup.matrix);

    // Note: in Soldier skeleton, L_Sh is at (-0.21, 0.06, 0) [viewer right when facing +Z], R_Sh is at (+0.21, 0.06, 0)
    this.solveChestArmIK(
      this.rUpperArm,
      this.rForearm,
      new THREE.Vector3(0.21, 0.06, 0),
      rGripChest,
      new THREE.Vector3(0.45, -0.5, -0.4)
    );
    this.solveChestArmIK(
      this.lUpperArm,
      this.lForearm,
      new THREE.Vector3(-0.21, 0.06, 0),
      lGripChest,
      new THREE.Vector3(-0.45, -0.5, -0.3)
    );
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export interface EnemySpawnSpec {
  pos: [number, number];
  patrol: Array<[number, number]>;
  cover?: [number, number];
  refY?: number;
}

function sanitizeSafePoint(
  pt: THREE.Vector3,
  boxColliders: BoxCollider[],
  margin = 0.85
): THREE.Vector3 {
  const pBot = pt.y + 0.32;
  const pTop = pt.y + 1.78;
  for (let pass = 0; pass < 3; pass++) {
    for (const c of boxColliders) {
      if (pTop < c.box.min.y || pBot > c.box.max.y) continue;
      const closestX = THREE.MathUtils.clamp(pt.x, c.box.min.x, c.box.max.x);
      const closestZ = THREE.MathUtils.clamp(pt.z, c.box.min.z, c.box.max.z);
      const dx = pt.x - closestX;
      const dz = pt.z - closestZ;
      const dSq = dx * dx + dz * dz;
      if (dSq < margin * margin) {
        const d = Math.sqrt(dSq);
        if (d > 1e-5) {
          const push = margin - d;
          pt.x += (dx / d) * push;
          pt.z += (dz / d) * push;
        } else {
          const penX = Math.min(Math.abs(pt.x - c.box.min.x), Math.abs(c.box.max.x - pt.x));
          const penZ = Math.min(Math.abs(pt.z - c.box.min.z), Math.abs(c.box.max.z - pt.z));
          if (penX < penZ) {
            pt.x = pt.x < (c.box.min.x + c.box.max.x) * 0.5 ? c.box.min.x - margin : c.box.max.x + margin;
          } else {
            pt.z = pt.z < (c.box.min.z + c.box.max.z) * 0.5 ? c.box.min.z - margin : c.box.max.z + margin;
          }
        }
      }
    }
  }
  return pt;
}

export class EnemyManager {
  public group = new THREE.Group();
  public enemies: EnemySoldier[] = [];
  public soldierTriangleCount = 0;
  private raycaster = new THREE.Raycaster();
  private template: SoldierRigTemplate;
  private mats: SoldierSharedMats;
  private levelId: LevelId;
  private boxColliders: BoxCollider[];

  constructor(
    terrain: WorldSurface,
    textures: TextureLibrary,
    levelId: LevelId = 'level1',
    boxColliders: BoxCollider[] = []
  ) {
    this.levelId = levelId;
    this.boxColliders = boxColliders;
    this.group.name = 'EnemySquad';
    const template = buildSoldierTemplate();
    this.template = template;
    this.soldierTriangleCount = template.triangleCount;

    const camoMat = new THREE.MeshStandardMaterial({
      map: textures.soldierCamo.map,
      normalMap: textures.soldierCamo.normalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughnessMap: textures.soldierCamo.roughnessMap,
      aoMap: textures.soldierCamo.aoMap,
      color: 0xffffff,
      roughness: 0.90, // Pure matte woven cloth (zero plastic oil gloss)
      metalness: 0.0,
      envMapIntensity: 0.42,
    });

    const balaclavaMat = new THREE.MeshStandardMaterial({
      map: textures.tacticalFabric.map,
      normalMap: textures.tacticalFabric.normalMap,
      roughnessMap: textures.tacticalFabric.roughnessMap,
      color: 0x5c6268, // Matte slate charcoal full-face balaclava & gloves
      roughness: 0.92,
      metalness: 0.0,
      envMapIntensity: 0.32,
    });

    const gearMat = new THREE.MeshStandardMaterial({
      map: textures.soldierGear.map,
      normalMap: textures.soldierGear.normalMap,
      roughnessMap: textures.soldierGear.roughnessMap,
      aoMap: textures.soldierGear.aoMap,
      color: 0xffffff, // Two-tone Coyote Tan / Sand vest, pouches & joint pads
      roughness: 0.89,
      metalness: 0.02,
      envMapIntensity: 0.45,
    });

    const helmetMat = new THREE.MeshStandardMaterial({
      map: textures.soldierGear.map,
      normalMap: textures.soldierGear.normalMap,
      roughnessMap: textures.soldierGear.roughnessMap,
      color: 0xf4e4c8, // Matte Coyote Tan ballistic FAST helmet
      roughness: 0.78,
      metalness: 0.05,
      envMapIntensity: 0.55,
    });

    const goggleMat = new THREE.MeshStandardMaterial({
      color: 0x3b769e,
      emissive: new THREE.Color(0x132c3f),
      emissiveIntensity: 0.45,
      roughness: 0.14, // Coated optical tactical lens reflection
      metalness: 0.82,
    });

    const gunMat = new THREE.MeshStandardMaterial({
      map: textures.gunMetal.map,
      normalMap: textures.gunMetal.normalMap,
      roughnessMap: textures.gunMetal.roughnessMap,
      metalnessMap: textures.gunMetal.metalnessMap,
      color: 0xb0b6be,
      metalness: 0.9,
      roughness: 0.42,
    });

    const mats: SoldierSharedMats = {
      camo: camoMat,
      balaclava: balaclavaMat,
      gear: gearMat,
      helmetPaint: helmetMat,
      goggleLens: goggleMat,
      gunMetal: gunMat,
    };
    this.mats = mats;

    const level1Spawns: EnemySpawnSpec[] = [
      // Outer Checkpoint Sentries (z ~ 30..45)
      { pos: [2.5, 42], patrol: [[2.5, 42], [9.5, 38], [5.5, 30]], cover: [6.0, 29.5] },
      { pos: [-5.5, 33], patrol: [[-5.5, 33], [1.5, 29]], cover: [2.5, 32.0] },
      // Mid-field flanker
      { pos: [6.5, 11], patrol: [[6.5, 11], [-3.0, 12], [2.0, 4]], cover: [5.0, 8.5] },
      // Outpost Perimeter Defenders (z ~ -16..-28)
      { pos: [-5.0, -19], patrol: [[-7.0, -18], [-1.0, -21]], cover: [-4.5, -17.5] },
      { pos: [5.0, -19], patrol: [[7.5, -18], [2.0, -22]], cover: [4.8, -17.5] },
      { pos: [-11.0, -28], patrol: [[-13.0, -24], [-9.0, -34]], cover: [-9.5, -28.8] },
      { pos: [10.0, -29], patrol: [[12.0, -25], [8.5, -35]], cover: [10.5, -30.5] },
      // Outpost Courtyard & Bunkers
      { pos: [-1.5, -33], patrol: [[-2.0, -32], [3.5, -35]], cover: [1.5, -33.6] },
      { pos: [-6.5, -39], patrol: [[-7.5, -39], [-5.5, -39]], cover: [-6.5, -39.5] },
      { pos: [8.5, -41], patrol: [[7.5, -41], [9.5, -41]], cover: [8.5, -41.5] },
      // Extraction Ridge Guards (near LZ)
      { pos: [-36, -74], patrol: [[-36, -74], [-44, -80]], cover: [-42, -83] },
      { pos: [-49, -87], patrol: [[-49, -87], [-41, -90]], cover: [-48, -89.5] },
    ];

    const level2Spawns: EnemySpawnSpec[] = [
      // Surface Blast Door Sentry (positioned off-axis behind bunker barrier for fair tactical engagement)
      { pos: [5.5, 67.0], patrol: [[5.5, 67.0], [8.5, 70.0]], cover: [6.0, 67.0], refY: 0.5 },
      // Main Wide Corridor & Generator Room
      { pos: [0.5, 22.0], patrol: [[0.5, 22.0], [-0.5, 15.0]], cover: [-1.4, 21.3], refY: -7.5 },
      { pos: [7.8, 14.0], patrol: [[5.2, 14.2], [9.5, 14.2], [9.5, 6.0]], cover: [5.6, 10.0], refY: -7.5 },
      { pos: [-0.8, 2.5], patrol: [[-0.8, 2.5], [0.8, -4.5]], cover: [1.2, 1.2], refY: -7.5 },
      { pos: [1.0, -12.0], patrol: [[1.0, -12.0], [-0.8, -16.5]], cover: [-1.2, -11.3], refY: -7.5 },
      // Dark Flank Cable/Vent Tunnel
      { pos: [-9.3, 18.0], patrol: [[-9.3, 18.0], [-9.3, 9.0]], cover: [-9.3, 14.0], refY: -7.5 },
      { pos: [-9.3, -6.0], patrol: [[-9.3, -6.0], [-9.3, -15.0]], cover: [-9.3, -12.0], refY: -7.5 },
      // 3-Story Missile Silo Hall Floor 1
      { pos: [-8.5, -26.0], patrol: [[-10.5, -26.0], [-6.5, -34.0]], cover: [-8.5, -29.8], refY: -7.5 },
      { pos: [9.5, -28.0], patrol: [[9.5, -28.0], [6.5, -32.0]], cover: [7.8, -33.5], refY: -7.5 },
      { pos: [10.0, -47.0], patrol: [[10.0, -47.0], [10.0, -40.0]], cover: [9.8, -45.0], refY: -7.5 },
      // 2nd-Floor Catwalk Guards (Y = -3.8)
      { pos: [-15.2, -48.0], patrol: [[-15.2, -48.0], [-15.2, -58.0]], cover: [-15.2, -52.0], refY: -3.5 },
      { pos: [0.0, -61.5], patrol: [[-7.0, -61.5], [7.0, -61.5]], cover: [0.0, -61.5], refY: -3.5 },
    ];

    this.spawnBatch(terrain, levelId === 'level2' ? level2Spawns : level1Spawns);
  }

  public spawnBatch(terrain: WorldSurface, specs: EnemySpawnSpec[], startAlerted = false): void {
    for (const spec of specs) {
      const idx = this.enemies.length;
      const ry = spec.refY ?? 5;
      const sp = sanitizeSafePoint(
        new THREE.Vector3(spec.pos[0], terrain.getHeightAt(spec.pos[0], spec.pos[1], ry), spec.pos[1]),
        this.boxColliders,
        0.85
      );
      const pts = spec.patrol.map(([px, pz]) =>
        sanitizeSafePoint(new THREE.Vector3(px, terrain.getHeightAt(px, pz, ry), pz), this.boxColliders, 0.85)
      );
      const cov = spec.cover
        ? sanitizeSafePoint(
            new THREE.Vector3(spec.cover[0], terrain.getHeightAt(spec.cover[0], spec.cover[1], ry), spec.cover[1]),
            this.boxColliders,
            0.85
          )
        : null;

      const soldier = new EnemySoldier(idx, sp, pts, cov, this.template, this.mats);
      if (startAlerted) {
        soldier.forceAlert(20);
      }
      this.enemies.push(soldier);
      this.group.add(soldier.root);
    }
  }

  public getAllHitboxes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const e of this.enemies) {
      if (e.state !== 'dead') {
        out.push(...e.hitboxMeshes);
      }
    }
    return out;
  }

  public getAliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.state !== 'dead') n++;
    return n;
  }

  public notifyPlayerGunshot(playerPos: THREE.Vector3, radius = 58): void {
    for (const e of this.enemies) {
      e.hearGunshot(playerPos, radius);
    }
  }

  private hasLineOfSight(
    enemy: EnemySoldier,
    playerPos: THREE.Vector3,
    terrain: WorldSurface,
    boxColliders: BoxCollider[],
    cylColliders: CylinderCollider[],
    maxSightDist = 78
  ): boolean {
    const eye = enemy.getHeadWorldPos();
    const target = new THREE.Vector3(playerPos.x, playerPos.y + 1.4, playerPos.z);
    const dir = target.clone().sub(eye);
    const dist = dir.length();
    if (dist > maxSightDist) return false;

    if (enemy.state === 'patrol') {
      const fwd = new THREE.Vector3(Math.sin(enemy.yaw), 0, Math.cos(enemy.yaw));
      const toPlayerXZ = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      if (fwd.dot(toPlayerXZ) < 0.25) return false;
    }

    dir.divideScalar(dist);

    if (this.levelId === 'level1') {
      const steps = Math.min(20, Math.max(4, Math.floor(dist / 3.5)));
      for (let i = 1; i < steps; i++) {
        const t = (i / steps) * dist;
        const sx = eye.x + dir.x * t;
        const sy = eye.y + dir.y * t;
        const sz = eye.z + dir.z * t;
        if (sy < terrain.getHeightAt(sx, sz) + 0.12) return false;
      }
    }

    this.raycaster.set(eye, dir);
    this.raycaster.far = dist;
    const hitPt = new THREE.Vector3();
    for (const c of boxColliders) {
      if (this.raycaster.ray.intersectBox(c.box, hitPt)) {
        if (hitPt.distanceTo(eye) < dist - 0.35) return false;
      }
    }

    for (const cyl of cylColliders) {
      const ox = cyl.x - eye.x;
      const oz = cyl.z - eye.z;
      const proj = ox * dir.x + oz * dir.z;
      if (proj > 0 && proj < dist - 0.3) {
        const cx = eye.x + dir.x * proj - cyl.x;
        const cz = eye.z + dir.z * proj - cyl.z;
        if (cx * cx + cz * cz < cyl.radius * cyl.radius) {
          const hy = eye.y + dir.y * proj;
          if (hy >= cyl.bottomY && hy <= cyl.topY) return false;
        }
      }
    }

    return true;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    terrain: WorldSurface,
    boxColliders: BoxCollider[],
    cylColliders: CylinderCollider[],
    onFire: (ev: EnemyFireEvent) => void,
    maxSightDist = 78
  ): void {
    for (const e of this.enemies) {
      const canSee = e.state !== 'dead' && this.hasLineOfSight(e, playerPos, terrain, boxColliders, cylColliders, maxSightDist);
      if (canSee) {
        // Radio alert nearby squadmates within 34m!
        for (const ally of this.enemies) {
          if (ally !== e && ally.state === 'patrol' && ally.position.distanceTo(e.position) < 34) {
            ally.hearGunshot(playerPos, 38);
          }
        }
      }
      e.update(dt, playerPos, canSee, terrain, boxColliders, cylColliders, onFire);
    }
  }
}
