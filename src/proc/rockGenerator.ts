import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { fbm2D, mulberry32, ridged2D, voronoi2D } from './noise';
import { PBRMaterialPack } from './pbrGenerator';

export interface RockLibrary {
  boulderFractured: THREE.BufferGeometry;
  graniteCrag: THREE.BufferGeometry;
  lowMossSlab: THREE.BufferGeometry;
}

/**
 * Generates multi-scale displaced & fractured natural rock with sharp cleavage planes,
 * stratified erosion grooves, micro-grit, and baked vertex colors for top moss & base mud stain.
 */
function buildErodedRockGeometry(
  seed: number,
  detail: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  planeCuts: number
): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(1.0, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;

  // Generate random geological cleavage fracture planes
  const planes: Array<{ n: THREE.Vector3; d: number; sharpness: number }> = [];
  for (let p = 0; p < planeCuts; p++) {
    const n = new THREE.Vector3(rng() - 0.5, (rng() - 0.35) * 0.9, rng() - 0.5).normalize();
    planes.push({
      n,
      d: 0.46 + rng() * 0.32,
      sharpness: 0.55 + rng() * 0.35,
    });
  }

  const v = new THREE.Vector3();
  const rawPos = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);

    // 1. Planar cleavage cuts (creates realistic angular broken rock faces!)
    for (const pl of planes) {
      const proj = v.dot(pl.n);
      if (proj > pl.d) {
        const excess = proj - pl.d;
        v.addScaledVector(pl.n, -excess * pl.sharpness);
      }
    }

    // 2. Macro shape anisotropy & sedimentary erosion layers
    const strata = Math.sin(v.y * 8.5 + fbm2D(v.x * 1.4, v.z * 1.4, 3, 2.0, 0.5, seed) * 3.2) * 0.065;
    const erosion = ridged2D(v.x * 2.1 + v.y * 0.9, v.z * 2.1 - v.y * 0.7, 4, 2.1, 0.5, seed + 33) * 0.19;
    const vor = voronoi2D(v.x * 2.6 + v.y * 1.1, v.z * 2.6 - v.y * 0.8, seed + 71);
    const chipEdge = Math.min(1, (vor.f2 - vor.f1) * 3.8);
    const micro = fbm2D(v.x * 7.5, v.z * 7.5 + v.y * 5.0, 2, 2.0, 0.5, seed + 109) * 0.045;

    const disp = 0.84 + erosion + strata - (1 - chipEdge) * 0.11 + micro;
    v.multiplyScalar(disp);

    // Non-uniform natural proportions + flat embedded base so rocks seat firmly on slopes
    v.x *= scaleX;
    v.y *= scaleY;
    v.z *= scaleZ;
    if (v.y < -scaleY * 0.32) {
      v.y = THREE.MathUtils.lerp(v.y, -scaleY * 0.38, 0.65);
    }

    pos.setXYZ(i, v.x, v.y, v.z);
    rawPos[i * 3] = v.x;
    rawPos[i * 3 + 1] = v.y;
    rawPos[i * 3 + 2] = v.z;
  }

  geo.computeVertexNormals();
  const norm = geo.attributes.normal as THREE.BufferAttribute;

  // Bake vertex colors encoding: R=MossMask (top damp ledges), G=CavityAO, B=BaseMudStain
  // Using actual RGB rock tint variation + moss mask in standard vertex color for crisp material depth!
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const vx = rawPos[i * 3];
    const vy = rawPos[i * 3 + 1];
    const vz = rawPos[i * 3 + 2];
    const ny = norm.getY(i);

    const mossNoise = fbm2D(vx * 1.9 + seed, vz * 1.9 - seed, 3, 2.0, 0.5, seed + 201) * 0.5 + 0.5;
    const mossMask = THREE.MathUtils.clamp((ny - 0.42) * 2.4 * (mossNoise > 0.38 ? 1.0 : 0.25), 0, 1);
    const mudBase = THREE.MathUtils.clamp((-vy / Math.max(0.2, scaleY) - 0.05) * 1.8, 0, 0.72);
    const heightLight = THREE.MathUtils.clamp(0.76 + (vy / Math.max(0.3, scaleY)) * 0.22, 0.55, 1.08);

    // Base mineral grey -> top olive-moss -> base damp brown earth stain
    let r = 0.96 * heightLight;
    let g = 0.98 * heightLight;
    let b = 1.00 * heightLight;

    r = THREE.MathUtils.lerp(r, 0.46, mossMask * 0.82);
    g = THREE.MathUtils.lerp(g, 0.62, mossMask * 0.82);
    b = THREE.MathUtils.lerp(b, 0.32, mossMask * 0.82);

    r = THREE.MathUtils.lerp(r, 0.42, mudBase * 0.68);
    g = THREE.MathUtils.lerp(g, 0.35, mudBase * 0.68);
    b = THREE.MathUtils.lerp(b, 0.26, mudBase * 0.68);

    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv2', geo.attributes.uv);

  return geo;
}

export function buildRockLibrary(): RockLibrary {
  return {
    boulderFractured: buildErodedRockGeometry(411, 4, 1.28, 0.88, 1.12, 7),
    graniteCrag: buildErodedRockGeometry(522, 4, 1.15, 0.98, 1.02, 8),
    lowMossSlab: buildErodedRockGeometry(633, 3, 1.48, 0.56, 1.18, 6),
  };
}

/**
 * Creates weathered rain-damp Rock PBR material with world-space moss roughness contrast & micro-detail.
 */
export function createRockMaterial(rockPack: PBRMaterialPack, csm?: CSM): THREE.MeshStandardMaterial {
  const map = rockPack.map.clone();
  map.needsUpdate = true;
  map.repeat.set(2.2, 2.2);
  const normalMap = rockPack.normalMap.clone();
  normalMap.needsUpdate = true;
  normalMap.repeat.set(2.2, 2.2);
  const roughnessMap = rockPack.roughnessMap.clone();
  roughnessMap.needsUpdate = true;
  roughnessMap.repeat.set(2.2, 2.2);
  const aoMap = rockPack.aoMap.clone();
  aoMap.needsUpdate = true;
  aoMap.repeat.set(2.2, 2.2);

  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    normalScale: new THREE.Vector2(1.6, 1.6),
    roughnessMap,
    aoMap,
    aoMapIntensity: 0.95,
    color: 0xffffff,
    roughness: 0.84,
    metalness: 0.04,
    vertexColors: true,
    envMapIntensity: 0.72,
  });
  if (csm) csm.setupMaterial(mat);
  return mat;
}
