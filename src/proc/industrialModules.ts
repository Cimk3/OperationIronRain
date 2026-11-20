import * as THREE from 'three';
import { createChamferedBox, createLatheZ } from './modeling';
import { EnvironmentPBRAtlas, PBRMaterialPack } from './pbrGenerator';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

export type IndustrialMatKey =
  | 'concrete'
  | 'paintedMetal'
  | 'bareSteel'
  | 'rubber'
  | 'floor'
  | 'grating'
  | 'hazardYellow'
  | 'pipeRed'
  | 'pipeBlue'
  | 'pipeYellow'
  | 'emissiveWarm'
  | 'emissiveCool'
  | 'emissiveCyan'
  | 'emissiveGreen'
  | 'emissiveRed';

export type IndustrialMaterials = Record<IndustrialMatKey, THREE.Material>;

export type BatchPushFn = (
  matKey: IndustrialMatKey,
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx?: number,
  ry?: number,
  rz?: number
) => void;

function buildPackMat(
  pack: PBRMaterialPack,
  opts: {
    color?: number;
    roughness?: number;
    metalness?: number;
    normalScale?: number;
    side?: THREE.Side;
    alphaTest?: number;
    repeat?: number;
  } = {}
): THREE.MeshStandardMaterial {
  const rep = opts.repeat ?? 1;
  const cloneTex = (t: THREE.DataTexture) => {
    if (rep === 1) return t;
    const c = t.clone();
    c.needsUpdate = true;
    c.repeat.set(rep, rep);
    return c;
  };
  const m = new THREE.MeshStandardMaterial({
    map: cloneTex(pack.map),
    normalMap: cloneTex(pack.normalMap),
    normalScale: new THREE.Vector2(opts.normalScale ?? 1.4, opts.normalScale ?? 1.4),
    roughnessMap: cloneTex(pack.roughnessMap),
    aoMap: cloneTex(pack.aoMap),
    aoMapIntensity: 0.9,
    color: opts.color ?? 0xffffff,
    roughness: opts.roughness ?? 1.0,
    metalness: pack.metalnessMap ? (opts.metalness ?? 1.0) : (opts.metalness ?? 0.04),
    side: opts.side ?? THREE.FrontSide,
    alphaTest: opts.alphaTest ?? 0,
    envMapIntensity: 0.85,
  });
  if (pack.metalnessMap) {
    m.metalnessMap = cloneTex(pack.metalnessMap);
  }
  return m;
}

/**
 * Builds the unified set of 5 independent PBR industrial materials + grating + color-coded utilities + light emitters.
 */
export function createIndustrialMaterials(
  atlas: EnvironmentPBRAtlas,
  hazardMap: PBRMaterialPack | { map: THREE.DataTexture; normalMap: THREE.DataTexture; roughnessMap: THREE.DataTexture; aoMap: THREE.DataTexture },
  csm?: CSM
): IndustrialMaterials {
  const concrete = buildPackMat(atlas.industrialConcrete, { color: 0xd0d4d8, normalScale: 1.5, side: THREE.DoubleSide });
  const paintedMetal = buildPackMat(atlas.paintedMetal, { color: 0xe6ecea, normalScale: 1.35 });
  const bareSteel = buildPackMat(atlas.bareSteel, { color: 0xe4e8ee, normalScale: 1.3 });
  const rubber = buildPackMat(atlas.industrialRubber, { color: 0xffffff, normalScale: 1.4 });
  const floor = buildPackMat(atlas.industrialFloor, { color: 0xc8cdd2, normalScale: 1.35 });
  const grating = buildPackMat(atlas.industrialGrating, {
    color: 0xd6dce2,
    normalScale: 1.35,
    side: THREE.DoubleSide,
    alphaTest: 0.45,
    repeat: 2,
  });
  const hazardYellow = new THREE.MeshStandardMaterial({
    map: hazardMap.map,
    normalMap: hazardMap.normalMap,
    roughnessMap: hazardMap.roughnessMap,
    aoMap: hazardMap.aoMap,
    color: 0xd8c8a2,
    roughness: 0.72,
    metalness: 0.14,
  });

  // Painted industrial utility pipes inheriting worn paintedMetal normals & roughness (never flat solid plastic!)
  const pipeRed = buildPackMat(atlas.paintedMetal, { color: 0xb8463e, normalScale: 1.1 });
  const pipeBlue = buildPackMat(atlas.paintedMetal, { color: 0x4e7fa6, normalScale: 1.1 });
  const pipeYellow = buildPackMat(atlas.paintedMetal, { color: 0xc9a044, normalScale: 1.1 });

  const emissiveWarm = new THREE.MeshStandardMaterial({
    color: 0xffe4b8,
    emissive: new THREE.Color(0xffb45c),
    emissiveIntensity: 3.4,
    roughness: 0.22,
  });
  const emissiveCool = new THREE.MeshStandardMaterial({
    color: 0xe2f2ff,
    emissive: new THREE.Color(0xc4e4ff),
    emissiveIntensity: 3.2,
    roughness: 0.20,
  });
  const emissiveCyan = new THREE.MeshStandardMaterial({
    color: 0x3ecae8,
    emissive: new THREE.Color(0x169cc4),
    emissiveIntensity: 1.55,
    roughness: 0.22,
  });
  const emissiveGreen = new THREE.MeshStandardMaterial({
    color: 0x6cff96,
    emissive: new THREE.Color(0x22dd66),
    emissiveIntensity: 2.6,
    roughness: 0.20,
  });
  const emissiveRed = new THREE.MeshStandardMaterial({
    color: 0xff7060,
    emissive: new THREE.Color(0xff2820),
    emissiveIntensity: 3.0,
    roughness: 0.22,
  });

  const all: IndustrialMaterials = {
    concrete,
    paintedMetal,
    bareSteel,
    rubber,
    floor,
    grating,
    hazardYellow,
    pipeRed,
    pipeBlue,
    pipeYellow,
    emissiveWarm,
    emissiveCool,
    emissiveCyan,
    emissiveGreen,
    emissiveRed,
  };

  if (csm) {
    for (const k of ['concrete', 'paintedMetal', 'bareSteel', 'rubber', 'floor', 'grating', 'hazardYellow', 'pipeRed', 'pipeBlue', 'pipeYellow'] as IndustrialMatKey[]) {
      csm.setupMaterial(all[k]);
    }
  }
  return all;
}

/**
 * Helper: transforms local coordinates (lx, ly, lz) around an origin + rotY into world coordinates.
 */
function xformY(cx: number, cy: number, cz: number, rotY: number, lx: number, ly: number, lz: number): [number, number, number] {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c];
}

/**
 * 1. TRUE STRUCTURAL I-BEAM (Top flange + Bottom flange + Web — never a plain box!)
 * Oriented along local X (`length`), height `depth` along Y, flange width `flangeW` along Z.
 */
export function appendIBeam(
  push: BatchPushFn,
  cx: number,
  cy: number,
  cz: number,
  length: number,
  depth: number,
  flangeW: number,
  rotX = 0,
  rotY = 0,
  rotZ = 0,
  matKey: IndustrialMatKey = 'bareSteel'
): void {
  const fThick = Math.max(0.022, depth * 0.14);
  const webThick = Math.max(0.018, flangeW * 0.16);
  const webH = Math.max(0.04, depth - fThick * 2);

  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ));
  const place = (lx: number, ly: number, lz: number, w: number, h: number, d: number) => {
    const v = new THREE.Vector3(lx, ly, lz).applyQuaternion(q);
    push(matKey, new THREE.BoxGeometry(w, h, d), cx + v.x, cy + v.y, cz + v.z, rotX, rotY, rotZ);
  };

  place(0, depth * 0.5 - fThick * 0.5, 0, length, fThick, flangeW);
  place(0, -depth * 0.5 + fThick * 0.5, 0, length, fThick, flangeW);
  place(0, 0, 0, length, webH, webThick);
}

/**
 * 2. BOLTED GUSSET PLATE (Steel structural connection plate with visible 3D hex bolt heads!)
 */
export function appendBoltedGusset(
  push: BatchPushFn,
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  thickness: number,
  rotY = 0,
  boltCols = 2,
  boltRows = 2
): void {
  push('bareSteel', createChamferedBox(w, h, thickness, 0.008, 1, 1), cx, cy, cz, 0, rotY, 0);
  const boltGeo = new THREE.CylinderGeometry(0.014, 0.014, thickness + 0.028, 6);
  boltGeo.rotateX(Math.PI * 0.5);
  for (let r = 0; r < boltRows; r++) {
    const ly = boltRows > 1 ? THREE.MathUtils.lerp(-h * 0.32, h * 0.32, r / (boltRows - 1)) : 0;
    for (let c = 0; c < boltCols; c++) {
      const lx = boltCols > 1 ? THREE.MathUtils.lerp(-w * 0.32, w * 0.32, c / (boltCols - 1)) : 0;
      const [bx, by, bz] = xformY(cx, cy, cz, rotY, lx, ly, 0);
      push('bareSteel', boltGeo.clone(), bx, by, bz, 0, rotY, 0);
    }
  }
}

/**
 * 3. REINFORCED CONCRETE PILASTER + STEEL I-BEAM STRUCTURAL PORTAL ARCH
 * Features chamfered concrete base plinth, steel corner guards, corbel brackets, overhead I-beam,
 * bolted gusset connection plates & 45-degree diagonal knee braces!
 */
export function appendIndustrialArchPortal(
  push: BatchPushFn,
  cx: number,
  yFloor: number,
  z: number,
  spanWidth: number,
  clearH: number,
  leftCol = true,
  rightCol = true,
  tiltX = 0
): void {
  const half = spanWidth * 0.5;
  const cosX = Math.cos(tiltX);
  const sinX = Math.sin(tiltX);
  const place = (lx: number, ly: number, lz: number): [number, number, number] => [
    cx + lx,
    yFloor + ly * cosX - lz * sinX,
    z + ly * sinX + lz * cosX,
  ];

  const addColumn = (side: -1 | 1) => {
    const xOff = side * (half - 0.19);
    // Reinforced concrete main column shaft
    const [px, py, pz] = place(xOff, clearH * 0.5, 0);
    push('concrete', createChamferedBox(0.36, clearH, 0.44, 0.024, 2, 2), px, py, pz, tiltX);
    // Heavy steel bolted base shoe & impact bumper
    const [sx, sy, sz] = place(xOff, 0.20, 0);
    push('bareSteel', createChamferedBox(0.42, 0.40, 0.50, 0.02, 2, 2), sx, sy, sz, tiltX);
    // Rubber shock bumper along inner face
    const [rx, ry, rz] = place(xOff - side * 0.21, 0.55, 0);
    push('rubber', createChamferedBox(0.05, 0.72, 0.34, 0.01, 1, 1), rx, ry, rz, tiltX);
    // Concrete corbel bracket at top supporting steel I-beam
    const [cbx, cby, cbz] = place(xOff - side * 0.14, clearH - 0.42, 0);
    push('concrete', createChamferedBox(0.34, 0.26, 0.38, 0.02, 2, 2), cbx, cby, cbz, tiltX);
    // Steel Gusset plate with 4 bolts at column-beam joint
    const [gx, gy, gz] = place(xOff - side * 0.28, clearH - 0.24, 0);
    appendBoltedGusset(push, gx, gy, gz, 0.38, 0.34, 0.06, 0, 2, 2);
    // 45° Diagonal Steel Knee Brace
    const [kx, ky, kz] = place(xOff - side * 0.34, clearH - 0.48, 0);
    push('bareSteel', new THREE.BoxGeometry(0.09, 0.62, 0.11), kx, ky, kz, tiltX, 0, side * 0.78);
  };

  if (leftCol) addColumn(-1);
  if (rightCol) addColumn(1);

  // Overhead true structural I-beam spanning across corridor!
  const [bx, by, bz] = place(0, clearH - 0.14, 0);
  appendIBeam(push, bx, by, bz, spanWidth - 0.12, 0.26, 0.24, tiltX, 0, 0, 'bareSteel');
}

/**
 * Helper: builds an exact Euler(XYZ) aligning local +Z along arbitrary 3D vector (dx, dy, dz).
 */
function eulerAlignZ(dx: number, dy: number, dz: number): [number, number, number] {
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), dir.clone().negate(), new THREE.Vector3(0, 1, 0));
  const e = new THREE.Euler().setFromRotationMatrix(m, 'XYZ');
  return [e.x, e.y, e.z];
}

/**
 * 4. TRUE OPEN INDUSTRIAL GUARDRAIL (Tubular posts + bolted baseplates + top rail + mid rail + toe-board!)
 * Uses exact 3D vector alignment so sloped stair/ramp guardrails work flawlessly in any direction!
 */
export function appendIndustrialGuardrail(
  push: BatchPushFn,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  matKey: IndustrialMatKey = 'pipeYellow'
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.2) return;

  const [rx, ry, rz] = eulerAlignZ(dx, dy, dz);
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const mz = (z0 + z1) * 0.5;

  // Top & Mid tubular rails
  for (const h of [1.02, 0.56]) {
    const rail = new THREE.CylinderGeometry(0.022, 0.022, len, 8);
    rail.rotateX(Math.PI * 0.5);
    push(matKey, rail, mx, my + h, mz, rx, ry, rz);
  }
  // Low safety toe-board along bottom (12cm steel kickplate)
  push('bareSteel', new THREE.BoxGeometry(0.025, 0.12, len), mx, my + 0.07, mz, rx, ry, rz);

  // Vertical posts every ~1.6m with bolted square flange baseplates
  const posts = Math.max(2, Math.round(len / 1.6) + 1);
  for (let i = 0; i < posts; i++) {
    const t = i / (posts - 1);
    const px = THREE.MathUtils.lerp(x0, x1, t);
    const py = THREE.MathUtils.lerp(y0, y1, t);
    const pz = THREE.MathUtils.lerp(z0, z1, t);
    push(matKey, new THREE.CylinderGeometry(0.022, 0.022, 1.04, 8), px, py + 0.52, pz);
    // Bolted floor flange plate
    push('bareSteel', new THREE.BoxGeometry(0.14, 0.024, 0.14), px, py + 0.012, pz);
  }
}

/**
 * 5. PERFORATED METAL GRATING CATWALK PLATFORM WITH C-CHANNEL RIM & UNDER-SUPPORT I-BEAMS
 */
export function appendGratingPlatform(
  push: BatchPushFn,
  cx: number,
  yTop: number,
  cz: number,
  width: number,
  depth: number
): void {
  // Perforated metal grating deck (alpha-tested see-through steel mesh!)
  const deckGeo = new THREE.PlaneGeometry(width, depth);
  deckGeo.rotateX(-Math.PI * 0.5);
  const uv = deckGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (width / 1.4), uv.getY(i) * (depth / 1.4));
  }
  push('grating', deckGeo, cx, yTop, cz);

  // Structural C-channel perimeter steel rim
  const rimH = 0.16;
  const rimT = 0.07;
  push('bareSteel', new THREE.BoxGeometry(width + rimT, rimH, rimT), cx, yTop - rimH * 0.5, cz - depth * 0.5);
  push('bareSteel', new THREE.BoxGeometry(width + rimT, rimH, rimT), cx, yTop - rimH * 0.5, cz + depth * 0.5);
  push('bareSteel', new THREE.BoxGeometry(rimT, rimH, depth), cx - width * 0.5, yTop - rimH * 0.5, cz);
  push('bareSteel', new THREE.BoxGeometry(rimT, rimH, depth), cx + width * 0.5, yTop - rimH * 0.5, cz);

  // Underside cross I-beam joists every 2.5m
  const joists = Math.max(2, Math.floor(depth / 2.6));
  for (let j = 0; j < joists; j++) {
    const lz = THREE.MathUtils.lerp(-depth * 0.42, depth * 0.42, joists > 1 ? j / (joists - 1) : 0.5);
    appendIBeam(push, cx, yTop - 0.19, cz + lz, width - 0.1, 0.18, 0.14, 0, 0, 0, 'bareSteel');
  }
}

/**
 * 6. INDUSTRIAL STEEL STAIRCASE (Dual stringer beams + serrated anti-slip grating treads + handrails)
 */
export function appendIndustrialStaircase(
  push: BatchPushFn,
  cx: number,
  yBot: number,
  zBot: number,
  yTop: number,
  zTop: number,
  width: number
): void {
  const dz = zTop - zBot;
  const dy = yTop - yBot;
  const len = Math.hypot(dz, dy);
  const [rx, ry, rz] = eulerAlignZ(0, dy, dz);
  const my = (yBot + yTop) * 0.5;
  const mz = (zBot + zTop) * 0.5;

  // Dual steel C-channel stringers flanking treads
  for (const sx of [-width * 0.5, width * 0.5]) {
    push('bareSteel', new THREE.BoxGeometry(0.06, 0.24, len), cx + sx, my - 0.04, mz, rx, ry, rz);
  }
  // Individual anti-slip grating treads
  const steps = Math.max(4, Math.round(Math.abs(dy) / 0.22));
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const sy = THREE.MathUtils.lerp(yBot, yTop, t);
    const sz = THREE.MathUtils.lerp(zBot, zTop, t);
    push('bareSteel', createChamferedBox(width - 0.06, 0.036, 0.28, 0.006, 1, 1), cx, sy, sz);
    push('hazardYellow', new THREE.BoxGeometry(width - 0.08, 0.012, 0.04), cx, sy + 0.02, sz - Math.sign(dz) * 0.11);
  }
  // Side guardrails
  appendIndustrialGuardrail(push, cx - width * 0.5, yBot, zBot, cx - width * 0.5, yTop, zTop);
  appendIndustrialGuardrail(push, cx + width * 0.5, yBot, zBot, cx + width * 0.5, yTop, zTop);
}

/**
 * 7. RECTANGULAR INDUSTRIAL VENTILATION DUCTWORK (Segmented flanged sections + ceiling suspension rods + louver grille)
 */
export function appendVentilationDuct(
  push: BatchPushFn,
  x: number,
  y: number,
  z0: number,
  z1: number,
  ductW = 0.58,
  ductH = 0.34,
  ceilingY?: number
): void {
  const len = Math.abs(z1 - z0);
  const mz = (z0 + z1) * 0.5;
  push('paintedMetal', createChamferedBox(ductW, ductH, len, 0.016, 1, 1), x, y, mz);

  const joints = Math.max(2, Math.floor(len / 2.4) + 1);
  for (let i = 0; i < joints; i++) {
    const lz = THREE.MathUtils.lerp(z0, z1, joints > 1 ? i / (joints - 1) : 0.5);
    // Flanged steel collar ring around duct joint
    push('bareSteel', createChamferedBox(ductW + 0.07, ductH + 0.07, 0.055, 0.008, 1, 1), x, y, lz);
    // Vertical threaded suspension rods anchoring duct to ceiling
    if (ceilingY !== undefined && ceilingY > y + ductH * 0.5 + 0.05) {
      const rodH = ceilingY - (y + ductH * 0.5);
      for (const sx of [-ductW * 0.45, ductW * 0.45]) {
        push('bareSteel', new THREE.CylinderGeometry(0.012, 0.012, rodH, 6), x + sx, y + ductH * 0.5 + rodH * 0.5, lz);
      }
      // Underside trapeze bar
      push('bareSteel', new THREE.BoxGeometry(ductW + 0.14, 0.03, 0.04), x, y - ductH * 0.5 - 0.02, lz);
    }
  }
}

/**
 * 8. DETAILED INDUSTRIAL PIPE RUN WITH BOLTED FLANGES, PIPE CLAMPS & HANDWHEEL GATE VALVE
 */
export function appendDetailedPipeRun(
  push: BatchPushFn,
  x: number,
  y0: number,
  z0: number,
  y1: number,
  z1: number,
  radius: number,
  matKey: IndustrialMatKey,
  addValve = false
): void {
  const dz = z1 - z0;
  const dy = y1 - y0;
  const len = Math.hypot(dz, dy);
  const tilt = Math.atan2(dy, dz);
  const my = (y0 + y1) * 0.5;
  const mz = (z0 + z1) * 0.5;

  const pipeGeo = createLatheZ([[radius, -len * 0.5], [radius, len * 0.5]], 12);
  push(matKey, pipeGeo, x, my, mz, -tilt);

  const flCount = Math.max(2, Math.floor(len / 3.8));
  for (let i = 0; i < flCount; i++) {
    const t = (i + 0.5) / flCount;
    const py = THREE.MathUtils.lerp(y0, y1, t);
    const pz = THREE.MathUtils.lerp(z0, z1, t);
    // Double bolted flange collar
    const fl = new THREE.CylinderGeometry(radius * 1.65, radius * 1.65, 0.075, 12);
    fl.rotateX(Math.PI * 0.5);
    push('bareSteel', fl, x, py, pz, -tilt);
    // Wall/ceiling bracket clamp
    push('bareSteel', new THREE.BoxGeometry(radius * 2.4, 0.04, 0.05), x, py + radius * 1.15, pz, -tilt);
  }

  if (addValve) {
    // Heavy cast valve bonnet + spoked handwheel at midpoint!
    push('bareSteel', createChamferedBox(radius * 2.4, radius * 2.6, 0.24, 0.015, 1, 1), x, my, mz);
    const stem = new THREE.CylinderGeometry(0.018, 0.018, 0.20, 8);
    stem.rotateZ(Math.PI * 0.5);
    push('bareSteel', stem, x + radius + 0.10, my, mz);
    const wheel = new THREE.TorusGeometry(0.14, 0.016, 8, 16);
    wheel.rotateY(Math.PI * 0.5);
    push('pipeRed', wheel, x + radius + 0.19, my, mz);
  }
}

/**
 * 9. INDUSTRIAL LADDER CABLE TRAY WITH MULTI-GAUGE RUBBER HIGH-VOLTAGE CABLES
 */
export function appendDetailedCableTray(
  push: BatchPushFn,
  x: number,
  y0: number,
  z0: number,
  y1: number,
  z1: number,
  trayW = 0.44
): void {
  const dz = z1 - z0;
  const dy = y1 - y0;
  const len = Math.hypot(dz, dy);
  const tilt = Math.atan2(dy, dz);
  const my = (y0 + y1) * 0.5;
  const mz = (z0 + z1) * 0.5;

  // Dual side rails
  for (const sx of [-trayW * 0.5, trayW * 0.5]) {
    push('bareSteel', new THREE.BoxGeometry(0.032, 0.075, len), x + sx, my, mz, -tilt);
  }
  // Ladder rungs every 0.65m
  const rungs = Math.max(3, Math.floor(len / 0.65));
  for (let i = 0; i < rungs; i++) {
    const t = (i + 0.5) / rungs;
    push('bareSteel', new THREE.BoxGeometry(trayW, 0.02, 0.032), x, THREE.MathUtils.lerp(y0, y1, t) - 0.025, THREE.MathUtils.lerp(z0, z1, t), -tilt);
  }
  // 3 heavy rubber-sheathed cables resting inside tray
  for (const [cxOff, r] of [[-0.12, 0.030], [0.0, 0.036], [0.13, 0.024]]) {
    push('rubber', createLatheZ([[r, -len * 0.5], [r, len * 0.5]], 8), x + cxOff, my + 0.015, mz, -tilt);
  }
}

/**
 * 10. EXPLOSION-PROOF INDUSTRIAL LIGHT FIXTURE (Cast housing + conduit + cooling fins + glowing glass + steel wire cage!)
 * Ensures every underground light has a realistic, visible physical fixture.
 */
export function appendIndustrialLightFixture(
  push: BatchPushFn,
  x: number,
  y: number,
  z: number,
  rotY = 0,
  type: 'wallSconce' | 'ceilingLinear' | 'highBay',
  emissiveKey: IndustrialMatKey = 'emissiveWarm'
): void {
  if (type === 'wallSconce') {
    const p = (lx: number, ly: number, lz: number) => xformY(x, y, z, rotY, lx, ly, lz);
    // Cast junction box & backplate
    const [bx, by, bz] = p(0, 0, 0.03);
    push('bareSteel', createChamferedBox(0.20, 0.34, 0.06, 0.012, 1, 1), bx, by, bz, 0, rotY, 0);
    // Top hood visor directing light downward
    const [hx, hy, hz] = p(0, 0.14, 0.11);
    push('paintedMetal', createChamferedBox(0.22, 0.05, 0.18, 0.01, 1, 1), hx, hy, hz, 0.18, rotY, 0);
    // Glowing frosted glass bulb capsule
    const [gx, gy, gz] = p(0, -0.01, 0.11);
    push(emissiveKey, new THREE.CylinderGeometry(0.052, 0.048, 0.22, 12), gx, gy, gz);
    // Protective steel cage rings
    for (const cy of [-0.08, 0.0, 0.08]) {
      const [cx, cyw, cz] = p(0, cy, 0.11);
      const ring = new THREE.TorusGeometry(0.068, 0.008, 6, 12);
      ring.rotateX(Math.PI * 0.5);
      push('bareSteel', ring, cx, cyw, cz);
    }
    // Vertical power conduit stub
    const [px, py, pz] = p(0, 0.34, 0.02);
    push('bareSteel', new THREE.CylinderGeometry(0.016, 0.016, 0.38, 8), px, py, pz);
  } else if (type === 'ceilingLinear') {
    const p = (lx: number, ly: number, lz: number) => xformY(x, y, z, rotY, lx, ly, lz);
    // Twin-tube industrial reflector housing
    const [bx, by, bz] = p(0, 0.06, 0);
    push('paintedMetal', createChamferedBox(0.34, 0.08, 1.56, 0.014, 1, 1), bx, by, bz, 0, rotY, 0);
    // End ballast caps
    for (const ez of [-0.76, 0.76]) {
      const [cx, cy, cz] = p(0, 0.01, ez);
      push('bareSteel', createChamferedBox(0.32, 0.11, 0.08, 0.01, 1, 1), cx, cy, cz, 0, rotY, 0);
    }
    // Twin glowing glass tubes
    for (const tx of [-0.075, 0.075]) {
      const [gx, gy, gz] = p(tx, -0.01, 0);
      const tube = new THREE.CylinderGeometry(0.024, 0.024, 1.44, 10);
      tube.rotateX(Math.PI * 0.5);
      push(emissiveKey, tube, gx, gy, gz, 0, rotY, 0);
    }
  } else {
    // High-Bay Silo Pendant Floodlight (heatsink bell + glowing diffuser + safety chain)
    push('bareSteel', new THREE.CylinderGeometry(0.02, 0.02, 1.2, 8), x, y + 0.85, z);
    push('bareSteel', new THREE.CylinderGeometry(0.14, 0.18, 0.22, 14), x, y + 0.18, z);
    push('paintedMetal', new THREE.CylinderGeometry(0.18, 0.42, 0.28, 16), x, y - 0.05, z);
    push(emissiveKey, new THREE.CylinderGeometry(0.36, 0.36, 0.04, 16), x, y - 0.19, z);
  }
}

/**
 * 11. INDUSTRIAL ELECTRICAL SWITCHGEAR / EQUIPMENT CABINET
 * Main chamfered enclosure + rubber leveling feet + recessed double door seams + hinges + lock latch +
 * cooling louver slats + analog meter bezels + LED status lamps + top armored cable conduit!
 */
export function appendPowerCabinet(
  push: BatchPushFn,
  cx: number,
  yFloor: number,
  cz: number,
  rotY = 0,
  width = 1.15,
  height = 2.05,
  depth = 0.72
): void {
  const p = (lx: number, ly: number, lz: number) => xformY(cx, yFloor, cz, rotY, lx, ly, lz);

  // Heavy rubber isolation plinth base
  const [bpx, bpy, bpz] = p(0, 0.06, 0);
  push('rubber', createChamferedBox(width + 0.06, 0.12, depth + 0.06, 0.014, 1, 1), bpx, bpy, bpz, 0, rotY, 0);

  // Main painted steel cabinet body
  const bodyH = height - 0.12;
  const [mx, my, mz] = p(0, 0.12 + bodyH * 0.5, 0);
  push('paintedMetal', createChamferedBox(width, bodyH, depth, 0.022, 2, 2), mx, my, mz, 0, rotY, 0);

  // Double maintenance door panels slightly proud of cabinet face
  const fz = depth * 0.5 + 0.016;
  const doorW = width * 0.44;
  for (const side of [-1, 1]) {
    const [dx, dy, dz] = p(side * (doorW * 0.52), 0.16 + bodyH * 0.47, fz);
    push('paintedMetal', createChamferedBox(doorW, bodyH * 0.88, 0.032, 0.008, 1, 1), dx, dy, dz, 0, rotY, 0);
    // Hinges on outer door edges
    for (const hy of [0.55, 1.45]) {
      const [hx, hyw, hz] = p(side * (width * 0.48), hy, fz + 0.01);
      push('bareSteel', new THREE.CylinderGeometry(0.014, 0.014, 0.09, 6), hx, hyw, hz);
    }
    // Cooling louver slats on lower door half
    for (let s = 0; s < 5; s++) {
      const [lx, ly, lz] = p(side * (doorW * 0.52), 0.36 + s * 0.065, fz + 0.022);
      push('bareSteel', new THREE.BoxGeometry(doorW * 0.72, 0.018, 0.016), lx, ly, lz, 0.35, rotY, 0);
    }
  }
  // Center vertical lock bar & chrome T-handle
  const [lhx, lhy, lhz] = p(0.06, 1.12, fz + 0.032);
  push('bareSteel', createChamferedBox(0.032, 0.18, 0.038, 0.006, 1, 1), lhx, lhy, lhz, 0, rotY, 0);

  // Top instrument cluster: 2 recessed voltmeter dials + 3 glowing indicator lamps
  for (const gx of [-0.26, 0.0]) {
    const [gxw, gyw, gzw] = p(gx, height - 0.36, fz + 0.022);
    push('bareSteel', createChamferedBox(0.18, 0.16, 0.026, 0.006, 1, 1), gxw, gyw, gzw, 0, rotY, 0);
    const [sxw, syw, szw] = p(gx, height - 0.36, fz + 0.036);
    push('emissiveWarm', new THREE.BoxGeometry(0.13, 0.10, 0.008), sxw, syw, szw, 0, rotY, 0);
  }
  const leds: Array<[number, IndustrialMatKey]> = [
    [0.22, 'emissiveGreen'],
    [0.30, 'emissiveCyan'],
    [0.38, 'emissiveRed'],
  ];
  for (const [lxOff, key] of leds) {
    const [lx, ly, lz] = p(lxOff, height - 0.36, fz + 0.028);
    push(key, new THREE.CylinderGeometry(0.018, 0.018, 0.024, 8), lx, ly, lz, Math.PI * 0.5, rotY, 0);
  }

  // Top armored electrical conduits rising upward
  for (const cxOff of [-width * 0.28, width * 0.28]) {
    const [px, py, pz] = p(cxOff, height + 0.38, -0.08);
    push('bareSteel', new THREE.CylinderGeometry(0.032, 0.032, 0.78, 8), px, py, pz);
  }
}

/**
 * 12. SILO MAIN COMMAND CONSOLE (Sloped dual-monitor terminal, tactile switchbank, side crash rails & cabling)
 */
export function appendCommandConsole(
  push: BatchPushFn,
  cx: number,
  yFloor: number,
  cz: number,
  rotY = 0
): void {
  const p = (lx: number, ly: number, lz: number) => xformY(cx, yFloor, cz, rotY, lx, ly, lz);

  // Lower steel pedestal base & rubber floor mat
  const [rmx, rmy, rmz] = p(0, 0.015, 0.52);
  push('rubber', new THREE.BoxGeometry(2.1, 0.03, 1.1), rmx, rmy, rmz, 0, rotY, 0);

  const [bx, by, bz] = p(0, 0.52, 0);
  push('paintedMetal', createChamferedBox(1.85, 1.04, 0.86, 0.022, 2, 2), bx, by, bz, 0, rotY, 0);

  // Angled tactile control deck (keyboards, switches & hazard edge trim)
  const [dkx, dky, dkz] = p(0, 1.08, 0.20);
  push('bareSteel', createChamferedBox(1.88, 0.10, 0.62, 0.016, 1, 1), dkx, dky, dkz, 0.24, rotY, 0);
  const [hzx, hzy, hzz] = p(0, 1.01, 0.48);
  push('hazardYellow', new THREE.BoxGeometry(1.84, 0.06, 0.04), hzx, hzy, hzz, 0, rotY, 0);

  // Illuminated tactical switches on deck
  for (let i = -3; i <= 3; i++) {
    const [kx, ky, kz] = p(i * 0.20, 1.13, 0.22);
    push(i === 0 ? 'emissiveRed' : i % 2 === 0 ? 'emissiveGreen' : 'emissiveWarm', new THREE.BoxGeometry(0.06, 0.028, 0.05), kx, ky, kz, 0.24, rotY, 0);
  }

  // Upper monitor hood housing twin angled tactical displays
  const [uhx, uhy, uhz] = p(0, 1.54, -0.14);
  push('paintedMetal', createChamferedBox(1.78, 0.82, 0.52, 0.022, 2, 2), uhx, uhy, uhz, -0.14, rotY, 0);
  for (const sx of [-0.42, 0.42]) {
    const [scrx, scry, scrz] = p(sx, 1.54, 0.125);
    push('bareSteel', createChamferedBox(0.72, 0.50, 0.04, 0.01, 1, 1), scrx, scry, scrz, -0.14, rotY, 0);
    const [glx, gly, glz] = p(sx, 1.54, 0.148);
    push('emissiveCyan', new THREE.BoxGeometry(0.62, 0.40, 0.012), glx, gly, glz, -0.14, rotY, 0);
  }

  // Side protective tubular steel bumper frames
  for (const side of [-1, 1]) {
    const [gx, gy, gz] = p(side * 1.02, 0.62, 0.34);
    push('pipeYellow', new THREE.CylinderGeometry(0.028, 0.028, 1.24, 8), gx, gy, gz);
  }
}

/**
 * 13. HEAVY INDUSTRIAL TURBINE GENERATOR ASSEMBLY (Bolted concrete plinth, finned stator drum, intake housing,
 * flanged exhaust stacks, side gauge manifold & access maintenance step!)
 */
export function appendTurbineGenerator(
  push: BatchPushFn,
  cx: number,
  yFloor: number,
  cz: number,
  rotY = 0
): void {
  const p = (lx: number, ly: number, lz: number) => xformY(cx, yFloor, cz, rotY, lx, ly, lz);

  // Heavy concrete isolation pad + hazard curb + rubber vibration pads
  const [px, py, pz] = p(0, 0.16, 0);
  push('concrete', createChamferedBox(2.7, 0.32, 5.8, 0.03, 2, 2), px, py, pz, 0, rotY, 0);
  const [hx, hy, hz] = p(-1.36, 0.16, 0);
  push('hazardYellow', new THREE.BoxGeometry(0.05, 0.24, 5.6), hx, hy, hz, 0, rotY, 0);

  // Steel skid frame with I-beam rails
  for (const sx of [-0.92, 0.92]) {
    const [rx, ry, rz] = p(sx, 0.42, 0);
    appendIBeam(push, rx, ry, rz, 5.2, 0.20, 0.16, 0, rotY + Math.PI * 0.5, 0, 'bareSteel');
  }

  // Lower gearbox / sump block
  const [gx, gy, gz] = p(0, 1.02, 0);
  push('paintedMetal', createChamferedBox(1.85, 1.05, 4.8, 0.04, 2, 2), gx, gy, gz, 0, rotY, 0);

  // Ribbed cylindrical turbine stator drum atop sump
  const drum = createLatheZ(
    [
      [0.01, -2.25],
      [0.64, -2.25],
      [0.78, -2.0],
      [0.78, 2.0],
      [0.64, 2.25],
      [0.01, 2.25],
    ],
    20
  );
  const [dx, dy, dz] = p(0, 2.05, 0);
  push('bareSteel', drum, dx, dy, dz, 0, rotY, 0);

  // 7 Radial cooling fin rings wrapping stator barrel
  for (let i = -3; i <= 3; i++) {
    const [fx, fy, fz] = p(0, 2.05, i * 0.56);
    const fin = new THREE.CylinderGeometry(0.86, 0.86, 0.06, 20);
    fin.rotateX(Math.PI * 0.5);
    push('paintedMetal', fin, fx, fy, fz, 0, rotY, 0);
  }

  // Twin vertical flanged exhaust manifold stacks rising toward ceiling
  for (const ez of [-1.45, 1.45]) {
    const [ex, ey, ezw] = p(0, 3.05, ez);
    push('pipeYellow', new THREE.CylinderGeometry(0.18, 0.22, 1.45, 12), ex, ey, ezw);
    const [flx, fly, flz] = p(0, 2.65, ez);
    push('bareSteel', new THREE.CylinderGeometry(0.28, 0.28, 0.08, 12), flx, fly, flz);
  }

  // Side maintenance gauge box & pressure valves facing corridor
  const [bx, by, bz] = p(-1.05, 1.38, 0.4);
  push('bareSteel', createChamferedBox(0.32, 0.65, 0.95, 0.016, 1, 1), bx, by, bz, 0, rotY, 0);
  const [slx, sly, slz] = p(-1.22, 1.52, 0.4);
  push('emissiveGreen', new THREE.BoxGeometry(0.02, 0.14, 0.34), slx, sly, slz, 0, rotY, 0);
}
