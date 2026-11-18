import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { fbm2D, mulberry32, ridged2D, valueNoise3D, voronoi2D } from '../proc/noise';
import { mergeParts, sweepProfileAlongCurve, ellipseProfile, countTriangles } from '../proc/modeling';
import { TextureLibrary } from '../proc/textures';
import { BattlefieldTerrain } from './terrain';
import { MaterialId, QualityConfig, TerrainWorkerOutput } from '../types';

export interface CylinderCollider {
  x: number;
  z: number;
  bottomY: number;
  topY: number;
  radius: number;
  material: MaterialId;
}

export interface VegetationSystem {
  group: THREE.Group;
  colliders: CylinderCollider[];
  meshesForRaycast: THREE.Object3D[];
  treeTrisAvg: number;
  groundInstances: number;
  update(elapsed: number, camPos?: THREE.Vector3): void;
}

/**
 * Generates an L-system recursive tree trunk + branch geometry + canopy card geometry.
 */
function generateLSystemTree(seed: number): {
  barkGeo: THREE.BufferGeometry;
  foliageGeo: THREE.BufferGeometry;
} {
  const rng = mulberry32(seed);
  const barkParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];

  interface BranchNode {
    start: THREE.Vector3;
    dir: THREE.Vector3;
    length: number;
    rStart: number;
    rEnd: number;
    depth: number;
  }

  const queue: BranchNode[] = [
    {
      start: new THREE.Vector3(0, -0.35, 0), // sink root flare 0.35m into terrain so no floating on slopes!
      dir: new THREE.Vector3((rng() - 0.5) * 0.08, 1, (rng() - 0.5) * 0.08).normalize(),
      length: 5.2 + rng() * 2.2,
      rStart: 0.34 + rng() * 0.08,
      rEnd: 0.14,
      depth: 0,
    },
  ];

  while (queue.length > 0) {
    const node = queue.shift()!;
    const mid = node.start
      .clone()
      .addScaledVector(node.dir, node.length * 0.52)
      .add(
        new THREE.Vector3(
          (rng() - 0.5) * node.length * 0.14,
          (rng() - 0.5) * node.length * 0.05,
          (rng() - 0.5) * node.length * 0.14
        )
      );
    const end = node.start.clone().addScaledVector(node.dir, node.length);

    const curve = new THREE.CatmullRomCurve3([node.start, mid, end]);
    const segs = node.depth === 0 ? 12 : node.depth === 1 ? 8 : 5;
    const radSegs = node.depth === 0 ? 12 : node.depth === 1 ? 8 : 6;
    const branchGeo = sweepProfileAlongCurve(
      curve,
      ellipseProfile(1.0, 1.0, radSegs),
      segs,
      (t, ang) => {
        // Root flare at bottom of trunk
        const flare = node.depth === 0 && t < 0.22 ? 1.0 + Math.pow((0.22 - t) / 0.22, 1.6) * (0.55 + 0.18 * Math.sin(ang * 5)) : 1.0;
        const r = THREE.MathUtils.lerp(node.rStart, node.rEnd, t) * flare;
        return { sx: r, sy: r };
      },
      true,
      1.5,
      node.depth === 0 ? 4.0 : 2.0
    );
    barkParts.push(branchGeo);

    // Spawn child branches & foliage clusters (depth 0 -> 1 -> 2 for ~2,200-2,700 tris/tree!)
    if (node.depth < 2) {
      const numChildren = node.depth === 0 ? 4 : 3;
      for (let c = 0; c < numChildren; c++) {
        const tAttach = node.depth === 0 ? 0.34 + (c / numChildren) * 0.62 : 0.38 + (c / numChildren) * 0.56;
        const attachPt = curve.getPoint(Math.min(0.98, tAttach));
        const az = (c / numChildren) * Math.PI * 2 + rng() * 0.85;
        const spread = node.depth === 0 ? 0.68 + rng() * 0.30 : 0.60 + rng() * 0.28;
        const cDir = new THREE.Vector3(
          Math.cos(az) * spread,
          0.38 + rng() * 0.36,
          Math.sin(az) * spread
        )
          .addScaledVector(node.dir, 0.35)
          .normalize();

        queue.push({
          start: attachPt,
          dir: cDir,
          length: node.length * (node.depth === 0 ? 0.52 : 0.54 + rng() * 0.14),
          rStart: THREE.MathUtils.lerp(node.rStart, node.rEnd, tAttach) * 0.72,
          rEnd: node.rEnd * 0.45,
          depth: node.depth + 1,
        });
      }
    }

    // Add fluffy 3D multi-angled foliage rosette clusters along depth >= 1 (zero comb/slat alignment!)
    if (node.depth >= 1) {
      const cards = node.depth === 1 ? 2 : 3;
      for (let k = 0; k < cards; k++) {
        const pt = curve.getPoint(0.22 + (k / cards) * 0.78);
        const cardScale = node.depth === 1 ? 1.65 + rng() * 0.45 : 1.40 + rng() * 0.45;
        // 3 crossed randomly-oriented domed foliage patches forming a soft volumetric crown puff
        for (let pair = 0; pair < 3; pair++) {
          const card = new THREE.PlaneGeometry(cardScale, cardScale, 2, 2);
          const pAttr = card.attributes.position as THREE.BufferAttribute;
          const colors = new Float32Array(pAttr.count * 3);
          for (let v = 0; v < pAttr.count; v++) {
            const vx = pAttr.getX(v);
            const vy = pAttr.getY(v);
            const distFromCenter = Math.hypot(vx, vy) / (cardScale * 0.7);
            pAttr.setZ(v, -distFromCenter * distFromCenter * 0.24);
            // Deep interior canopy AO (0.34) -> bright outer tips (1.12)
            const ao = 0.34 + Math.min(1, distFromCenter) * 0.78;
            colors[v * 3] = ao;
            colors[v * 3 + 1] = ao;
            colors[v * 3 + 2] = ao;
          }
          card.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          card.computeVertexNormals();
          card.rotateX((rng() - 0.5) * 1.4);
          card.rotateY(rng() * Math.PI * 2 + (pair / 3) * Math.PI);
          card.rotateZ((rng() - 0.5) * 1.1);
          card.translate(
            pt.x + (rng() - 0.5) * 0.35,
            pt.y + (rng() - 0.5) * 0.25,
            pt.z + (rng() - 0.5) * 0.35
          );
          leafParts.push(card);
        }
      }
    }
  }

  return {
    barkGeo: mergeParts(barkParts, false),
    foliageGeo: mergeParts(leafParts, false),
  };
}

/**
 * Generates Voronoi-displaced stratified rock geometry (no low-poly spheres/cubes!).
 */
function generateVoronoiRock(seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1.0, 3);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n1 = fbm2D(v.x * 1.8 + seed, v.z * 1.8 - seed, 4, 2.0, 0.5, seed);
    const n2 = ridged2D(v.y * 2.2, v.x * 1.6 + v.z * 1.6, 3, 2.1, 0.5, seed + 41);
    const vor = voronoi2D(v.x * 2.4 + v.y * 1.2, v.z * 2.4 - v.y * 0.9, seed + 88);
    const strata = Math.sin(v.y * 9.0 + n1 * 3.0) * 0.08;
    const flatBottom = v.y < -0.35 ? 0.72 : 1.0;

    const disp = (0.78 + n1 * 0.28 + n2 * 0.24 - (vor.f2 - vor.f1) * 0.18 + strata) * flatBottom;
    v.multiplyScalar(disp);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Generates a fine curved multi-blade grass tuft geometry (for GPU Instancing).
 */
function generateGrassTuft(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blades = 8;
  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI * 2 + b * 0.55;
    const h = 0.20 + (b % 3) * 0.08;
    const w = 0.015;
    const lean = 0.11 + (b % 2) * 0.08;
    const segs = 3;
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const bw = w * (1 - t * 0.9);
      const y = t * h;
      const z = t * t * lean;
      const rCol = THREE.MathUtils.lerp(0.22, 0.42, t);
      const gCol = THREE.MathUtils.lerp(0.28, 0.52, t);
      const bCol = THREE.MathUtils.lerp(0.14, 0.24, t);
      positions.push(-bw, y, z, bw, y, z);
      uvs.push(0, t, 1, t);
      colors.push(rCol, gCol, bCol, rCol, gCol, bCol);
      if (i < segs) {
        const row = i * 2;
        indices.push(row, row + 1, row + 2, row + 1, row + 3, row + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    g.rotateY(ang);
    g.translate(Math.cos(ang) * 0.12, -0.02, Math.sin(ang) * 0.12);
    parts.push(g);
  }
  return mergeParts(parts, false);
}

/**
 * Generates an organic shrub/bush cluster from crossed foliage cards.
 */
function generateBushGeometry(seed: number): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const s = 0.85 + rng() * 0.55;
    const card = new THREE.PlaneGeometry(s, s * 0.9, 2, 2);
    const pAttr = card.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < pAttr.count; v++) {
      pAttr.setZ(v, -Math.pow(pAttr.getX(v) / s, 2) * 0.25);
    }
    card.computeVertexNormals();
    card.rotateX((rng() - 0.5) * 0.8 - 0.2);
    card.rotateY((i / 8) * Math.PI * 2 + rng() * 0.5);
    card.translate((rng() - 0.5) * 0.35, s * 0.36, (rng() - 0.5) * 0.35);
    parts.push(card);
  }
  return mergeParts(parts, false);
}

/**
 * Generates a natural outward-arching radial woodland fern rosette (7 staggered fronds).
 */
function generateFernClusterGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const fronds = 7;
  for (let i = 0; i < fronds; i++) {
    const ang = (i / fronds) * Math.PI * 2 + (i % 2) * 0.22;
    const len = 0.62 + (i % 3) * 0.10;
    const plane = new THREE.PlaneGeometry(0.38, len, 2, 5);
    const pAttr = plane.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < pAttr.count; v++) {
      const yRaw = pAttr.getY(v) + len * 0.5; // 0..len
      const t = yRaw / len;
      // Graceful arching fern parabola: rises near center crown, droops outward near tip!
      const lift = (i % 2 === 0 ? 0.32 : 0.22);
      pAttr.setY(v, Math.sin(t * Math.PI * 0.88) * lift + 0.02);
      pAttr.setZ(v, 0.03 + t * len * 0.92);
      // Slight lateral cup along midrib
      const px = pAttr.getX(v);
      pAttr.setY(v, pAttr.getY(v) + Math.abs(px) * 0.14);
    }
    plane.computeVertexNormals();
    plane.rotateY(ang);
    parts.push(plane);
  }
  return mergeParts(parts, false);
}

/**
 * Generates a low-profile jagged pebble geometry for ground scatter.
 */
function generatePebbleGeometry(): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.11, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i) * 0.55;
    const z = pos.getZ(i);
    const n = 0.8 + 0.35 * Math.sin(x * 19 + z * 23);
    pos.setXYZ(i, x * n, y * n + 0.03, z * n);
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildVegetationSystem(
  data: TerrainWorkerOutput,
  terrain: BattlefieldTerrain,
  textures: TextureLibrary,
  quality: QualityConfig,
  csm?: CSM
): VegetationSystem {
  const group = new THREE.Group();
  group.name = 'VegetationSystem';
  const colliders: CylinderCollider[] = [];
  const meshesForRaycast: THREE.Object3D[] = [];
  const timeUniform = { value: 0 };
  const camPosUniform = { value: new THREE.Vector3(0, 2, 92) };

  const applyWindAndCSM = (
    mat: THREE.MeshStandardMaterial,
    windAmp: number,
    heightAnchor: number,
    fadeEndDist = 0,
    backlight = false
  ) => {
    if (csm) csm.setupMaterial(mat);
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      if (prev) prev.call(mat, shader, renderer);
      shader.uniforms.uTime = timeUniform;
      shader.uniforms.uWindAmp = { value: windAmp };
      shader.uniforms.uHeightAnchor = { value: heightAnchor };
      shader.uniforms.uCamPos = camPosUniform;
      shader.uniforms.uFadeDist = { value: fadeEndDist };

      shader.vertexShader =
        `
        uniform float uTime;
        uniform float uWindAmp;
        uniform float uHeightAnchor;
        uniform vec3 uCamPos;
        uniform float uFadeDist;
        varying vec3 vVegWorldPos;
        ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 wOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 wOrigin = vec3(0.0);
        #endif
        if (uFadeDist > 1.0) {
          float distCam = length(wOrigin - uCamPos);
          float distFade = 1.0 - smoothstep(uFadeDist * 0.62, uFadeDist, distCam);
          transformed *= distFade;
        }
        float swayWeight = max(0.0, (position.y - uHeightAnchor)) * uWindAmp;
        float gust = sin(uTime * 1.9 + wOrigin.x * 0.27 + wOrigin.z * 0.19)
                   + 0.45 * sin(uTime * 4.3 + wOrigin.x * 0.71 - wOrigin.z * 0.53 + position.y * 1.4);
        transformed.x += gust * swayWeight;
        transformed.z += gust * 0.55 * swayWeight;
        vVegWorldPos = wOrigin;
        `
      );

      if (backlight) {
        shader.fragmentShader =
          `
          uniform vec3 uCamPos;
          varying vec3 vVegWorldPos;
          ` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `
          #include <emissivemap_fragment>
          vec3 vToSun = normalize(vec3(-0.30, 0.22, -0.93));
          vec3 vViewD = normalize(vVegWorldPos - uCamPos);
          float sss = pow(max(0.0, dot(vViewD, vToSun)), 3.2);
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.15, 0.92, 0.48) * sss * 0.85;
          `
        );
      }
    };
    mat.customProgramCacheKey = () => `wind-${windAmp}-${heightAnchor}-${fadeEndDist}-${backlight}`;
  };

  // Materials
  const barkMat = new THREE.MeshStandardMaterial({
    map: textures.bark.map,
    normalMap: textures.bark.normalMap,
    normalScale: new THREE.Vector2(1.4, 1.4),
    roughnessMap: textures.bark.roughnessMap,
    aoMap: textures.bark.aoMap,
    color: 0xb8b2a8,
    roughness: 0.85,
  });
  applyWindAndCSM(barkMat, 0.012, 0.5, 0, false);

  const foliageMat = new THREE.MeshStandardMaterial({
    map: textures.foliageAlpha,
    normalMap: textures.foliageNormal,
    alphaTest: 0.25,
    side: THREE.DoubleSide,
    roughness: 0.58,
    metalness: 0.01,
    color: 0x90a884,
    emissive: 0x0b1109,
    vertexColors: true,
  });
  applyWindAndCSM(foliageMat, 0.032, 0.8, 0, true);

  const fernMat = new THREE.MeshStandardMaterial({
    map: textures.fernAlpha,
    normalMap: textures.fernNormal,
    alphaTest: 0.28,
    side: THREE.DoubleSide,
    roughness: 0.52,
    metalness: 0.01,
    color: 0x8ba678,
    emissive: 0x0a1008,
  });
  applyWindAndCSM(fernMat, 0.045, 0.0, 65.0, true);

  const rockMat = new THREE.MeshStandardMaterial({
    map: textures.terrainRock.map,
    normalMap: textures.terrainRock.normalMap,
    normalScale: new THREE.Vector2(1.4, 1.4),
    roughnessMap: textures.terrainRock.roughnessMap,
    aoMap: textures.terrainRock.aoMap,
    color: 0x9aa2a8,
    roughness: 0.42, // Wet rain-darkened stone!
    metalness: 0.05,
  });
  if (csm) csm.setupMaterial(rockMat);

  // 1. TWO L-SYSTEM TREE VARIANTS (GPU INSTANCED)
  const treeVariants = [generateLSystemTree(101), generateLSystemTree(202)];
  const totalTrees = Math.min(quality.treeCount, data.treePlacements.length / 5);
  const split = Math.ceil(totalTrees / 2);
  const dummy = new THREE.Object3D();

  for (let v = 0; v < 2; v++) {
    const startIdx = v === 0 ? 0 : split;
    const count = v === 0 ? split : totalTrees - split;
    if (count <= 0) continue;

    const barkInst = new THREE.InstancedMesh(treeVariants[v].barkGeo, barkMat, count);
    barkInst.castShadow = true;
    barkInst.receiveShadow = true;

    const leafInst = new THREE.InstancedMesh(treeVariants[v].foliageGeo, foliageMat, count);
    leafInst.castShadow = true;
    leafInst.receiveShadow = true;

    for (let i = 0; i < count; i++) {
      const pIdx = (startIdx + i) * 5;
      const wx = data.treePlacements[pIdx];
      const wz = data.treePlacements[pIdx + 1];
      const sc = data.treePlacements[pIdx + 2];
      const ry = data.treePlacements[pIdx + 3];
      const wy = terrain.getHeightAt(wx, wz);

      dummy.position.set(wx, wy, wz);
      dummy.rotation.set(0, ry, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();

      barkInst.setMatrixAt(i, dummy.matrix);
      leafInst.setMatrixAt(i, dummy.matrix);

      // Trunk collider
      colliders.push({
        x: wx,
        z: wz,
        bottomY: wy - 0.5,
        topY: wy + 5.0 * sc,
        radius: 0.36 * sc,
        material: MaterialId.WOOD,
      });
    }
    barkInst.instanceMatrix.needsUpdate = true;
    leafInst.instanceMatrix.needsUpdate = true;
    group.add(barkInst);
    group.add(leafInst);
    meshesForRaycast.push(barkInst);
  }

  // 2. VORONOI LAYERED ROCKS (GPU INSTANCED)
  const rockGeo = generateVoronoiRock(404);
  const rockCount = data.rockPlacements.length / 7;
  if (rockCount > 0) {
    const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    rockInst.castShadow = true;
    rockInst.receiveShadow = true;
    for (let i = 0; i < rockCount; i++) {
      const p = i * 7;
      const wx = data.rockPlacements[p];
      const wz = data.rockPlacements[p + 1];
      const sx = data.rockPlacements[p + 2];
      const sy = data.rockPlacements[p + 3];
      const sz = data.rockPlacements[p + 4];
      const ry = data.rockPlacements[p + 5];
      const wy = terrain.getHeightAt(wx, wz) - sy * 0.22;

      dummy.position.set(wx, wy, wz);
      dummy.rotation.set(0, ry, 0);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      rockInst.setMatrixAt(i, dummy.matrix);

      colliders.push({
        x: wx,
        z: wz,
        bottomY: wy - 1.0,
        topY: wy + sy * 0.95,
        radius: Math.max(sx, sz) * 0.72,
        material: MaterialId.ROCK,
      });
    }
    rockInst.instanceMatrix.needsUpdate = true;
    group.add(rockInst);
    meshesForRaycast.push(rockInst);
  }

  // 3. FOREST BUSHES (GPU INSTANCED)
  const bushGeo = generateBushGeometry(505);
  const bushCount = data.bushPlacements.length / 4;
  if (bushCount > 0) {
    const bushInst = new THREE.InstancedMesh(bushGeo, foliageMat, bushCount);
    bushInst.castShadow = true;
    bushInst.receiveShadow = true;
    for (let i = 0; i < bushCount; i++) {
      const p = i * 4;
      const wx = data.bushPlacements[p];
      const wz = data.bushPlacements[p + 1];
      const sc = data.bushPlacements[p + 2];
      const ry = data.bushPlacements[p + 3];
      const wy = terrain.getHeightAt(wx, wz);
      dummy.position.set(wx, wy - 0.05, wz);
      dummy.rotation.set(0, ry, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      bushInst.setMatrixAt(i, dummy.matrix);
    }
    bushInst.instanceMatrix.needsUpdate = true;
    group.add(bushInst);
  }

  // 4. FALLEN MOSSY LOGS ALONG APPROACH FOR NATURAL COVER
  const logCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.3, 0.18, 0),
    new THREE.Vector3(-0.7, 0.24, 0.12),
    new THREE.Vector3(1.0, 0.20, -0.08),
    new THREE.Vector3(2.4, 0.14, 0.04),
  ]);
  const logGeo = sweepProfileAlongCurve(
    logCurve,
    ellipseProfile(0.24, 0.22, 12),
    14,
    (t) => ({ sx: 1 - t * 0.35, sy: 1 - t * 0.35 }),
    true,
    1.5,
    3.0
  );
  const logSpots: Array<[number, number, number]> = [
    [-7.5, 74, 0.45],
    [7.2, 60, -0.55],
    [-8.5, 44, 0.25],
    [-9.0, 18, -0.35],
    [9.2, 12, 0.55],
  ];
  const logInst = new THREE.InstancedMesh(logGeo, barkMat, logSpots.length);
  logInst.castShadow = true;
  logInst.receiveShadow = true;
  logSpots.forEach(([lx, lz, lrot], idx) => {
    const ly = terrain.getHeightAt(lx, lz) - 0.08;
    dummy.position.set(lx, ly, lz);
    dummy.rotation.set(0, lrot, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    logInst.setMatrixAt(idx, dummy.matrix);
    // Split log into 3 cylinder colliders along its length
    for (const offset of [-1.6, 0, 1.6]) {
      colliders.push({
        x: lx + Math.cos(lrot) * offset,
        z: lz - Math.sin(lrot) * offset,
        bottomY: ly - 0.5,
        topY: ly + 0.65,
        radius: 0.42,
        material: MaterialId.WOOD,
      });
    }
  });
  logInst.instanceMatrix.needsUpdate = true;
  group.add(logInst);
  meshesForRaycast.push(logInst);

  // 5. INSTANCED RAIN-SWEPT GRASS BLADES, WOODLAND FERNS & SCATTERED GRAVEL PEBBLES (>= 15,000 instances!)
  const grassGeo = generateGrassTuft();
  const grassMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.56,
    metalness: 0.01,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  applyWindAndCSM(grassMat, 0.065, 0.0, 68.0, true);

  const grassRng = mulberry32(909);
  const targetGrass = quality.grassCount;
  const grassMatrices: THREE.Matrix4[] = [];
  for (let i = 0; i < targetGrass * 2 && grassMatrices.length < targetGrass; i++) {
    const wx = (grassRng() - 0.5) * 145;
    const wz = (grassRng() - 0.5) * 205;
    const matId = terrain.getMaterialAt(wx, wz);
    if (matId !== MaterialId.GRASS && matId !== MaterialId.WET_MUD) continue;
    if (terrain.getWaterDepthAt(wx, wz) > 0.004) continue;
    const wy = terrain.getHeightAt(wx, wz);
    dummy.position.set(wx, wy, wz);
    dummy.rotation.set(0, grassRng() * Math.PI * 2, 0);
    const sc = 0.78 + grassRng() * 0.78;
    dummy.scale.set(sc, sc * (0.8 + grassRng() * 0.5), sc);
    dummy.updateMatrix();
    grassMatrices.push(dummy.matrix.clone());
  }

  if (grassMatrices.length > 0) {
    const grassInst = new THREE.InstancedMesh(grassGeo, grassMat, grassMatrices.length);
    grassInst.receiveShadow = true;
    for (let i = 0; i < grassMatrices.length; i++) {
      grassInst.setMatrixAt(i, grassMatrices[i]);
    }
    grassInst.instanceMatrix.needsUpdate = true;
    group.add(grassInst);
  }

  // 6. HIGH-DENSITY 3D WOODLAND FERNS (3,200 instances)
  const fernGeo = generateFernClusterGeometry();
  const targetFerns = Math.floor(targetGrass * 0.16);
  const fernMatrices: THREE.Matrix4[] = [];
  for (let i = 0; i < targetFerns * 2 && fernMatrices.length < targetFerns; i++) {
    const wx = (grassRng() - 0.5) * 145;
    const wz = (grassRng() - 0.5) * 205;
    if (terrain.getWaterDepthAt(wx, wz) > 0.005) continue;
    const matId = terrain.getMaterialAt(wx, wz);
    if (matId !== MaterialId.GRASS) continue;
    const wy = terrain.getHeightAt(wx, wz);
    dummy.position.set(wx, wy - 0.03, wz);
    dummy.rotation.set(0, grassRng() * Math.PI * 2, 0);
    const sc = 0.65 + grassRng() * 0.65;
    dummy.scale.setScalar(sc);
    dummy.updateMatrix();
    fernMatrices.push(dummy.matrix.clone());
  }
  if (fernMatrices.length > 0) {
    const fernInst = new THREE.InstancedMesh(fernGeo, fernMat, fernMatrices.length);
    fernInst.receiveShadow = true;
    for (let i = 0; i < fernMatrices.length; i++) fernInst.setMatrixAt(i, fernMatrices[i]);
    fernInst.instanceMatrix.needsUpdate = true;
    group.add(fernInst);
  }

  // 7. SCATTERED PEBBLES / GRAVEL CHUNKS (3,600 instances)
  const pebbleGeo = generatePebbleGeometry();
  const targetPebbles = Math.floor(targetGrass * 0.18);
  const pebbleMatrices: THREE.Matrix4[] = [];
  for (let i = 0; i < targetPebbles * 2 && pebbleMatrices.length < targetPebbles; i++) {
    const wx = (grassRng() - 0.5) * 130;
    const wz = (grassRng() - 0.5) * 205;
    const wy = terrain.getHeightAt(wx, wz);
    dummy.position.set(wx, wy - 0.015, wz);
    dummy.rotation.set(grassRng() * 0.4, grassRng() * Math.PI * 2, grassRng() * 0.4);
    const sc = 0.6 + grassRng() * 1.1;
    dummy.scale.setScalar(sc);
    dummy.updateMatrix();
    pebbleMatrices.push(dummy.matrix.clone());
  }
  if (pebbleMatrices.length > 0) {
    const pebbleInst = new THREE.InstancedMesh(pebbleGeo, rockMat, pebbleMatrices.length);
    pebbleInst.receiveShadow = true;
    for (let i = 0; i < pebbleMatrices.length; i++) pebbleInst.setMatrixAt(i, pebbleMatrices[i]);
    pebbleInst.instanceMatrix.needsUpdate = true;
    group.add(pebbleInst);
  }

  const treeTrisAvg = Math.round(
    (countTriangles(treeVariants[0].barkGeo) +
      countTriangles(treeVariants[0].foliageGeo) +
      countTriangles(treeVariants[1].barkGeo) +
      countTriangles(treeVariants[1].foliageGeo)) *
      0.5
  );
  const groundInstances = grassMatrices.length + fernMatrices.length + pebbleMatrices.length;

  return {
    group,
    colliders,
    meshesForRaycast,
    treeTrisAvg,
    groundInstances,
    update(elapsed: number, camPos?: THREE.Vector3) {
      timeUniform.value = elapsed;
      if (camPos) camPosUniform.value.copy(camPos);
    },
  };
}
