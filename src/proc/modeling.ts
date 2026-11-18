import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface ProfilePoint {
  x: number;
  y: number;
}

export interface LoftRing {
  points: THREE.Vector3[];
  uScale?: number;
}

/**
 * Computes triangle count of a BufferGeometry or entire Object3D hierarchy.
 */
export function countTriangles(obj: THREE.Object3D | THREE.BufferGeometry): number {
  if (obj instanceof THREE.BufferGeometry) {
    return obj.index ? obj.index.count / 3 : obj.attributes.position.count / 3;
  }
  let total = 0;
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const geo = (child as THREE.Mesh).geometry;
      if (geo) {
        total += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      }
    }
  });
  return Math.floor(total);
}

/**
 * Generates a rounded rectangle 2D profile with `cornerSegs` per corner.
 */
export function roundedRectProfile(
  width: number,
  height: number,
  radius: number,
  cornerSegs = 4
): ProfilePoint[] {
  const r = Math.min(radius, width * 0.48, height * 0.48);
  const hw = width * 0.5 - r;
  const hh = height * 0.5 - r;
  const pts: ProfilePoint[] = [];
  const corners = [
    { cx: hw, cy: hh, start: 0 },
    { cx: -hw, cy: hh, start: Math.PI * 0.5 },
    { cx: -hw, cy: -hh, start: Math.PI },
    { cx: hw, cy: -hh, start: Math.PI * 1.5 },
  ];
  for (const c of corners) {
    for (let i = 0; i <= cornerSegs; i++) {
      const a = c.start + (i / cornerSegs) * (Math.PI * 0.5);
      pts.push({ x: c.cx + Math.cos(a) * r, y: c.cy + Math.sin(a) * r });
    }
  }
  return pts;
}

/**
 * Generates an octagonal/chamfered octagon 2D profile.
 */
export function chamferRectProfile(
  width: number,
  height: number,
  chamfer: number,
  bevelSteps = 2
): ProfilePoint[] {
  return roundedRectProfile(width, height, chamfer, bevelSteps);
}

/**
 * Generates a circle/ellipse 2D profile.
 */
export function ellipseProfile(rx: number, ry: number, segments = 24): ProfilePoint[] {
  const pts: ProfilePoint[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
  }
  return pts;
}

/**
 * Normalizes geometry attributes so merging never fails due to missing uv/normal/color.
 */
export function normalizeGeometry(geo: THREE.BufferGeometry, wearBias = 0): THREE.BufferGeometry {
  const nonIndexed = geo.index ? geo.toNonIndexed() : geo;
  if (!nonIndexed.attributes.normal) {
    nonIndexed.computeVertexNormals();
  }
  const pos = nonIndexed.attributes.position;
  if (!nonIndexed.attributes.uv) {
    // Triplanar-like automatic box UV generation
    const norm = nonIndexed.attributes.normal;
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const nx = Math.abs(norm.getX(i));
      const ny = Math.abs(norm.getY(i));
      const nz = Math.abs(norm.getZ(i));
      if (nx >= ny && nx >= nz) {
        uvs[i * 2] = z * 4;
        uvs[i * 2 + 1] = y * 4;
      } else if (ny >= nx && ny >= nz) {
        uvs[i * 2] = x * 4;
        uvs[i * 2 + 1] = z * 4;
      } else {
        uvs[i * 2] = x * 4;
        uvs[i * 2 + 1] = y * 4;
      }
    }
    nonIndexed.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  if (!nonIndexed.attributes.color) {
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      colors[i * 3] = wearBias;
      colors[i * 3 + 1] = 1.0;
      colors[i * 3 + 2] = 0.0;
    }
    nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  // Remove tangent or extra attributes that might mismatch
  for (const key of Object.keys(nonIndexed.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv' && key !== 'color') {
      nonIndexed.deleteAttribute(key);
    }
  }
  return nonIndexed;
}

/**
 * Safely merges multiple geometries into one indexed/non-indexed BufferGeometry.
 */
export function mergeParts(parts: THREE.BufferGeometry[], computeWear = true): THREE.BufferGeometry {
  const normalized = parts.map((p) => normalizeGeometry(p));
  const merged = mergeGeometries(normalized, false);
  for (const p of normalized) p.dispose();
  if (!merged) {
    return new THREE.BufferGeometry();
  }
  if (computeWear) {
    bakeVertexCurvatureWear(merged);
  }
  return merged;
}

/**
 * Computes pseudo-curvature / exposed-edge wear & cavity AO into vertex colors.
 * R = edge exposure (0..1), G = cavity occlusion (0.35..1), B = directional grime.
 */
export function bakeVertexCurvatureWear(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  let color = geo.attributes.color as THREE.BufferAttribute | undefined;
  if (!color) {
    color = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    geo.setAttribute('color', color);
  }
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const size = new THREE.Vector3();
  bb.getSize(size);
  const center = new THREE.Vector3();
  bb.getCenter(center);

  // Spatial hash to accumulate average normal of nearby vertices (smooth vs sharp edge detection)
  const cellInv = 220;
  const map = new Map<string, { nx: number; ny: number; nz: number; count: number }>();

  for (let i = 0; i < pos.count; i++) {
    const kx = Math.round(pos.getX(i) * cellInv);
    const ky = Math.round(pos.getY(i) * cellInv);
    const kz = Math.round(pos.getZ(i) * cellInv);
    const key = `${kx},${ky},${kz}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { nx: 0, ny: 0, nz: 0, count: 0 };
      map.set(key, entry);
    }
    entry.nx += norm.getX(i);
    entry.ny += norm.getY(i);
    entry.nz += norm.getZ(i);
    entry.count++;
  }

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = norm.getX(i);
    const ny = norm.getY(i);
    const nz = norm.getZ(i);
    const key = `${Math.round(x * cellInv)},${Math.round(y * cellInv)},${Math.round(z * cellInv)}`;
    const entry = map.get(key)!;
    const len = Math.hypot(entry.nx, entry.ny, entry.nz) || 1;
    const avgX = entry.nx / len;
    const avgY = entry.ny / len;
    const avgZ = entry.nz / len;

    // Dot between vertex normal and local welded normal: lower dot = sharper ridge/corner!
    const dot = Math.max(-1, Math.min(1, nx * avgX + ny * avgY + nz * avgZ));
    const sharpness = Math.min(1, Math.max(0, (1 - dot) * 3.5));

    // Radial exposure from bounding box center
    const dx = (x - center.x) / Math.max(0.001, size.x * 0.5);
    const dy = (y - center.y) / Math.max(0.001, size.y * 0.5);
    const dz = (z - center.z) / Math.max(0.001, size.z * 0.5);
    const radial = Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.65);

    const existingWear = color.getX(i);
    const edgeWear = Math.min(1, Math.max(existingWear, sharpness * 0.85 + radial * 0.25));
    const cavityAO = Math.max(0.42, 0.55 + radial * 0.45 - sharpness * 0.15);
    const topLight = Math.max(0, Math.min(1, ny * 0.5 + 0.5));

    color.setXYZ(i, edgeWear, cavityAO, topLight);
  }
  color.needsUpdate = true;
}

/**
 * Creates a high-detail chamfered/beveled box using ExtrudeGeometry with multi-segment bevels.
 * Never a crude 12-tri BoxGeometry!
 */
export function createChamferedBox(
  w: number,
  h: number,
  d: number,
  bevel = 0.003,
  bevelSegments = 3,
  curveSegments = 3
): THREE.BufferGeometry {
  const bw = Math.max(0.0005, w - bevel * 2);
  const bh = Math.max(0.0005, h - bevel * 2);
  const bd = Math.max(0.0005, d - bevel * 2);
  const r = Math.min(bevel, bw * 0.4, bh * 0.4);

  const shape = new THREE.Shape();
  const hw = bw * 0.5;
  const hh = bh * 0.5;
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: bd,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments,
    steps: 1,
  });
  geo.translate(0, 0, -bd * 0.5);
  return geo;
}

/**
 * Extrudes an arbitrary 2D Shape with multi-step rounded bevels, centered on Z.
 */
export function createBeveledShape(
  shape: THREE.Shape,
  depth: number,
  bevel = 0.002,
  bevelSegments = 3,
  curveSegments = 12,
  steps = 1
): THREE.BufferGeometry {
  const d = Math.max(0.0005, depth - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments,
    steps,
  });
  geo.translate(0, 0, -d * 0.5);
  return geo;
}

/**
 * Lofts a sequence of 2D profiles placed at 3D transforms along Z or arbitrary frames.
 * Uses Rotation-Minimizing Frames along a Curve3!
 */
export function sweepProfileAlongCurve(
  curve: THREE.Curve<THREE.Vector3>,
  profile: ProfilePoint[],
  pathSegments: number,
  scaleFn?: (t: number, angle: number) => { sx: number; sy: number },
  capEnds = true,
  uvTileU = 2.0,
  uvTileV = 4.0
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(pathSegments, false);
  const points = curve.getPoints(pathSegments);
  const pCount = profile.length;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Build ring vertices
  const ringVerts: THREE.Vector3[][] = [];
  for (let i = 0; i <= pathSegments; i++) {
    const t = i / pathSegments;
    const center = points[i];
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j <= pCount; j++) {
      const pt = profile[j % pCount];
      const ang = Math.atan2(pt.y, pt.x);
      const sc = scaleFn ? scaleFn(t, ang) : { sx: 1, sy: 1 };
      const px = pt.x * sc.sx;
      const py = pt.y * sc.sy;
      const v = new THREE.Vector3()
        .copy(center)
        .addScaledVector(N, px)
        .addScaledVector(B, py);
      ring.push(v);
      positions.push(v.x, v.y, v.z);
      uvs.push((j / pCount) * uvTileU, t * uvTileV);
    }
    ringVerts.push(ring);
  }

  const stride = pCount + 1;
  for (let i = 0; i < pathSegments; i++) {
    for (let j = 0; j < pCount; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + (j + 1);
      const d = i * stride + (j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  if (capEnds) {
    // Start cap
    const startCenter = points[0];
    const startIdx = positions.length / 3;
    positions.push(startCenter.x, startCenter.y, startCenter.z);
    uvs.push(0.5, 0);
    for (let j = 0; j < pCount; j++) {
      const v = ringVerts[0][j];
      const vNext = ringVerts[0][j + 1];
      const idx0 = positions.length / 3;
      positions.push(v.x, v.y, v.z, vNext.x, vNext.y, vNext.z);
      uvs.push(0.5 + profile[j].x * 5, 0.5 + profile[j].y * 5);
      uvs.push(0.5 + profile[(j + 1) % pCount].x * 5, 0.5 + profile[(j + 1) % pCount].y * 5);
      indices.push(startIdx, idx0 + 1, idx0);
    }

    // End cap
    const endCenter = points[pathSegments];
    const endIdx = positions.length / 3;
    positions.push(endCenter.x, endCenter.y, endCenter.z);
    uvs.push(0.5, 1);
    for (let j = 0; j < pCount; j++) {
      const v = ringVerts[pathSegments][j];
      const vNext = ringVerts[pathSegments][j + 1];
      const idx0 = positions.length / 3;
      positions.push(v.x, v.y, v.z, vNext.x, vNext.y, vNext.z);
      uvs.push(0.5 + profile[j].x * 5, 0.5 + profile[j].y * 5);
      uvs.push(0.5 + profile[(j + 1) % pCount].x * 5, 0.5 + profile[(j + 1) % pCount].y * 5);
      indices.push(endIdx, idx0, idx0 + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Lofts between explicit 3D rings (each ring must have the same number of points).
 * Ideal for organic arms, fingers, gun stocks, ergonomic grips, and sandbags!
 */
export function loftRings(rings: THREE.Vector3[][], closedLoop = true, capEnds = true): THREE.BufferGeometry {
  const numRings = rings.length;
  const pCount = rings[0].length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < numRings; i++) {
    const t = i / Math.max(1, numRings - 1);
    const ring = rings[i];
    const count = closedLoop ? pCount + 1 : pCount;
    for (let j = 0; j < count; j++) {
      const v = ring[j % pCount];
      positions.push(v.x, v.y, v.z);
      uvs.push(j / pCount, t);
    }
  }

  const stride = closedLoop ? pCount + 1 : pCount;
  const maxJ = closedLoop ? pCount : pCount - 1;
  for (let i = 0; i < numRings - 1; i++) {
    for (let j = 0; j < maxJ; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + (j + 1);
      const d = i * stride + (j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  if (capEnds && closedLoop) {
    // Cap start
    const c0 = new THREE.Vector3();
    for (const p of rings[0]) c0.add(p);
    c0.divideScalar(pCount);
    const idx0 = positions.length / 3;
    positions.push(c0.x, c0.y, c0.z);
    uvs.push(0.5, 0);
    for (let j = 0; j < pCount; j++) {
      const a = rings[0][j];
      const b = rings[0][(j + 1) % pCount];
      const base = positions.length / 3;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      uvs.push(0, 0, 1, 0);
      indices.push(idx0, base + 1, base);
    }

    // Cap end
    const c1 = new THREE.Vector3();
    for (const p of rings[numRings - 1]) c1.add(p);
    c1.divideScalar(pCount);
    const idx1 = positions.length / 3;
    positions.push(c1.x, c1.y, c1.z);
    uvs.push(0.5, 1);
    for (let j = 0; j < pCount; j++) {
      const a = rings[numRings - 1][j];
      const b = rings[numRings - 1][(j + 1) % pCount];
      const base = positions.length / 3;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      uvs.push(0, 1, 1, 1);
      indices.push(idx1, base, base + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Creates a revolved lathe geometry along Z axis (for gun barrels, muzzle devices, flash hiders).
 */
export function createLatheZ(
  profileRZ: Array<[number, number]>,
  radialSegments = 32
): THREE.BufferGeometry {
  const pts = profileRZ.map(([r, z]) => new THREE.Vector2(Math.max(0.0001, r), z));
  const geo = new THREE.LatheGeometry(pts, radialSegments);
  // LatheGeometry revolves around Y; rotate X +90deg so Y -> Z
  geo.rotateX(Math.PI * 0.5);
  return geo;
}

/**
 * Builds a MIL-STD-1913 Picatinny rail along the Z axis with tooth-by-tooth beveled notches!
 * Centered at X=0, bottom at Y=0, spanning length along Z centered at 0.
 */
export function createPicatinnyRail(
  length: number,
  width = 0.0212,
  height = 0.0075,
  toothPitch = 0.010
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const numTeeth = Math.max(2, Math.floor(length / toothPitch));
  const actualLength = numTeeth * toothPitch;

  // Dovetail base spline running full length
  const dovetailShape = new THREE.Shape();
  const hw = width * 0.5;
  const neckW = width * 0.34;
  const dovetailH = height * 0.45;
  dovetailShape.moveTo(-neckW, 0);
  dovetailShape.lineTo(neckW, 0);
  dovetailShape.lineTo(hw, dovetailH * 0.55);
  dovetailShape.lineTo(hw * 0.92, dovetailH);
  dovetailShape.lineTo(-hw * 0.92, dovetailH);
  dovetailShape.lineTo(-hw, dovetailH * 0.55);
  dovetailShape.closePath();

  const baseBar = createBeveledShape(dovetailShape, actualLength, 0.0007, 2, 4);
  baseBar.translate(0, 0, 0);
  parts.push(baseBar);

  // Individual beveled cross-teeth with groove spacing
  const toothLen = toothPitch * 0.53;
  const toothH = height * 0.58;
  const toothShape = new THREE.Shape();
  toothShape.moveTo(-hw * 0.94, dovetailH * 0.9);
  toothShape.lineTo(hw * 0.94, dovetailH * 0.9);
  toothShape.lineTo(hw, dovetailH + toothH * 0.45);
  toothShape.lineTo(hw * 0.88, dovetailH + toothH);
  toothShape.lineTo(-hw * 0.88, dovetailH + toothH);
  toothShape.lineTo(-hw, dovetailH + toothH * 0.45);
  toothShape.closePath();

  const toothTemplate = createBeveledShape(toothShape, toothLen, 0.0006, 2, 2);
  const startZ = -actualLength * 0.5 + toothPitch * 0.5;
  for (let i = 0; i < numTeeth; i++) {
    const t = toothTemplate.clone();
    t.translate(0, 0, startZ + i * toothPitch);
    parts.push(t);
  }
  toothTemplate.dispose();

  return mergeParts(parts, true);
}

/**
 * Builds a slotted cylindrical tube (e.g. A2 Birdcage flash hider or ventilated shroud)
 * with actual solid radial struts and beveled rings (zero flat holes).
 */
export function createSlottedFlashHider(
  outerR: number,
  innerR: number,
  length: number,
  slots = 5,
  radialSegsPerStrut = 6
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const collarLen = length * 0.28;
  const tipLen = length * 0.16;
  const slotLen = length - collarLen - tipLen;

  // Rear threaded collar + crush washer ring
  const collarPts: Array<[number, number]> = [
    [innerR, 0],
    [outerR * 1.06, 0],
    [outerR * 1.08, collarLen * 0.3],
    [outerR * 0.96, collarLen * 0.35],
    [outerR * 0.96, collarLen * 0.72],
    [outerR, collarLen * 0.8],
    [outerR, collarLen],
    [innerR, collarLen],
  ];
  parts.push(createLatheZ(collarPts, 32));

  // Front muzzle crown ring
  const crownPts: Array<[number, number]> = [
    [innerR, length - tipLen],
    [outerR, length - tipLen],
    [outerR, length - 0.002],
    [outerR * 0.92, length],
    [innerR * 1.04, length],
    [innerR, length - 0.002],
  ];
  parts.push(createLatheZ(crownPts, 32));

  // Individual radial struts between slots (A2 style: solid bottom + 5 top/side vents or 6 radial struts)
  const totalSlots = slots;
  const pitchAngle = (Math.PI * 2) / totalSlots;
  const strutAngle = pitchAngle * 0.44;
  for (let s = 0; s < totalSlots; s++) {
    const startA = s * pitchAngle - strutAngle * 0.5;
    const endA = s * pitchAngle + strutAngle * 0.5;
    const shape = new THREE.Shape();
    for (let i = 0; i <= radialSegsPerStrut; i++) {
      const a = startA + (i / radialSegsPerStrut) * (endA - startA);
      const x = Math.cos(a) * outerR;
      const y = Math.sin(a) * outerR;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    for (let i = radialSegsPerStrut; i >= 0; i--) {
      const a = startA + (i / radialSegsPerStrut) * (endA - startA);
      shape.lineTo(Math.cos(a) * innerR, Math.sin(a) * innerR);
    }
    shape.closePath();
    const strut = createBeveledShape(shape, slotLen + 0.002, 0.0005, 2, 4);
    strut.translate(0, 0, collarLen + slotLen * 0.5);
    parts.push(strut);
  }

  return mergeParts(parts, true);
}

/**
 * Creates a diamond-checkered grip panel (for M1911 walnut grips or polymer stippling)
 * with actual 3D pyramid checkering + smooth curved border.
 */
export function createCheckeredGripPanel(
  width: number,
  height: number,
  thickness: number,
  cols = 14,
  rows = 24
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Curved base slab (rounded oval top/bottom)
  const shape = new THREE.Shape();
  const hw = width * 0.5;
  const hh = height * 0.5;
  const r = width * 0.28;
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);

  const slab = createBeveledShape(shape, thickness, thickness * 0.28, 3, 8);
  parts.push(slab);

  // Diamond pyramid checkering mesh on +Z face
  const cw = (width * 0.72) / cols;
  const ch = (height * 0.78) / rows;
  const startX = -width * 0.36;
  const startY = -height * 0.39;
  const zBase = thickness * 0.45;
  const peakH = thickness * 0.26;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let rIdx = 0; rIdx < rows; rIdx++) {
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      // Leave screw holes around top & bottom center
      const nx = (cIdx + 0.5) / cols - 0.5;
      const ny = (rIdx + 0.5) / rows - 0.5;
      if (Math.abs(nx) < 0.16 && (Math.abs(ny - 0.34) < 0.1 || Math.abs(ny + 0.34) < 0.1)) {
        continue;
      }
      const cx = startX + (cIdx + 0.5) * cw;
      const cy = startY + (rIdx + 0.5) * ch;
      const dx = cw * 0.48;
      const dy = ch * 0.48;

      const baseIdx = positions.length / 3;
      // 4 corners + 1 peak
      positions.push(
        cx, cy - dy, zBase,
        cx + dx, cy, zBase,
        cx, cy + dy, zBase,
        cx - dx, cy, zBase,
        cx, cy, zBase + peakH
      );
      uvs.push(
        0.5, 0,
        1, 0.5,
        0.5, 1,
        0, 0.5,
        0.5, 0.5
      );
      indices.push(
        baseIdx, baseIdx + 1, baseIdx + 4,
        baseIdx + 1, baseIdx + 2, baseIdx + 4,
        baseIdx + 2, baseIdx + 3, baseIdx + 4,
        baseIdx + 3, baseIdx, baseIdx + 4
      );
    }
  }

  const checkGeo = new THREE.BufferGeometry();
  checkGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  checkGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  checkGeo.setIndex(indices);
  checkGeo.computeVertexNormals();
  parts.push(checkGeo);

  // Two slotted brass/steel grip screws
  for (const sy of [height * 0.27, -height * 0.27]) {
    const screw = createLatheZ(
      [
        [0.0001, 0],
        [0.0032, 0],
        [0.0032, thickness * 0.55],
        [0.0026, thickness * 0.68],
        [0.0001, thickness * 0.68],
      ],
      16
    );
    screw.translate(0, sy, 0);
    parts.push(screw);
  }

  return mergeParts(parts, true);
}
