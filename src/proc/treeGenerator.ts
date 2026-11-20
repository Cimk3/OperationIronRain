import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { mulberry32, ridged2D } from './noise';
import { countTriangles, ellipseProfile, mergeParts, sweepProfileAlongCurve } from './modeling';

export interface ProceduralTreeVariant {
  barkLOD0: THREE.BufferGeometry;
  leavesLOD0: THREE.BufferGeometry;
  barkLOD1: THREE.BufferGeometry;
  leavesLOD1: THREE.BufferGeometry;
  trisLOD0: number;
  trisLOD1: number;
}

interface BranchSegment {
  start: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
  rStart: number;
  rEnd: number;
  depth: number;
}

/**
 * Generates a realistic multi-tier recursive branching tree (Trunk + Exposed Roots + Primary/Secondary/Tertiary Branches)
 * with curved botanical leaf-sprig clusters distributed organically along outer twigs, plus a lightweight LOD1.
 * Strictly zero spheres, cones, or blob volumes!
 */
export function generateProceduralTreeVariant(seed: number, style: 'broadleaf' | 'alder' | 'windswept' = 'broadleaf'): ProceduralTreeVariant {
  const rng = mulberry32(seed);
  const barkParts0: THREE.BufferGeometry[] = [];
  const leafParts0: THREE.BufferGeometry[] = [];
  const barkParts1: THREE.BufferGeometry[] = [];
  const leafParts1: THREE.BufferGeometry[] = [];

  const trunkHeight = style === 'windswept' ? 4.4 + rng() * 1.1 : 5.0 + rng() * 1.6;
  const trunkBaseR = 0.28 + rng() * 0.08;
  const windLeanX = style === 'windswept' ? 0.22 : (rng() - 0.5) * 0.08;
  const windLeanZ = style === 'windswept' ? 0.14 : (rng() - 0.5) * 0.08;

  // 1. EXPOSED SURFACE ROOT BUTTRESSES (5-6 low organic roots emerging smoothly out of lower trunk into soil!)
  const rootCount = 5 + ((rng() * 2) | 0);
  for (let r = 0; r < rootCount; r++) {
    const az = (r / rootCount) * Math.PI * 2 + (rng() - 0.5) * 0.48;
    const reach = 0.72 + rng() * 0.38;
    const rCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(az) * trunkBaseR * 0.12, 0.34 + rng() * 0.14, Math.sin(az) * trunkBaseR * 0.12),
      new THREE.Vector3(Math.cos(az) * reach * 0.52, 0.09 + rng() * 0.06, Math.sin(az) * reach * 0.52),
      new THREE.Vector3(Math.cos(az) * reach, -0.26, Math.sin(az) * reach),
    ]);
    const rootGeo = sweepProfileAlongCurve(
      rCurve,
      ellipseProfile(1.0, 0.78, 7),
      6,
      (t) => {
        const rad = THREE.MathUtils.lerp(trunkBaseR * 0.44, 0.04, t);
        return { sx: rad, sy: rad * 0.92 };
      },
      true,
      1.2,
      2.0
    );
    barkParts0.push(rootGeo);
  }

  // Track foliage anchor points to compute volumetric canopy center for realistic inner-canopy AO
  const leafAnchors: Array<{ pos: THREE.Vector3; dir: THREE.Vector3; depth: number; scale: number }> = [];

  // 2. RECURSIVE L-SYSTEM BRANCHING QUEUE (Depth 0 -> 1 -> 2 -> 3 terminal twigs!)
  const queue: BranchSegment[] = [
    {
      start: new THREE.Vector3(0, -0.42, 0),
      dir: new THREE.Vector3(windLeanX, 1.0, windLeanZ).normalize(),
      length: trunkHeight,
      rStart: trunkBaseR,
      rEnd: trunkBaseR * 0.38,
      depth: 0,
    },
  ];

  while (queue.length > 0) {
    const seg = queue.shift()!;
    const wobble = seg.depth === 0 ? 0.10 : seg.depth === 1 ? 0.16 : 0.20;
    const mid1 = seg.start
      .clone()
      .addScaledVector(seg.dir, seg.length * 0.36)
      .add(new THREE.Vector3((rng() - 0.5) * seg.length * wobble, (rng() - 0.5) * seg.length * 0.06, (rng() - 0.5) * seg.length * wobble));
    const mid2 = seg.start
      .clone()
      .addScaledVector(seg.dir, seg.length * 0.72)
      .add(new THREE.Vector3((rng() - 0.5) * seg.length * wobble, seg.depth >= 2 ? -seg.length * 0.05 : seg.length * 0.04, (rng() - 0.5) * seg.length * wobble));
    const end = seg.start
      .clone()
      .addScaledVector(seg.dir, seg.length)
      .add(new THREE.Vector3(windLeanX * seg.length * 0.22, seg.depth >= 2 ? -seg.length * 0.08 : 0, windLeanZ * seg.length * 0.22));

    const curve = new THREE.CatmullRomCurve3([seg.start, mid1, mid2, end]);

    // High-detail LOD0 branch mesh with bark fissure displacement on trunk & primary limbs
    const lenSegs0 = seg.depth === 0 ? 14 : seg.depth === 1 ? 9 : seg.depth === 2 ? 5 : 3;
    const radSegs0 = seg.depth === 0 ? 12 : seg.depth === 1 ? 8 : seg.depth === 2 ? 6 : 4;
    const geo0 = sweepProfileAlongCurve(
      curve,
      ellipseProfile(1, 1, radSegs0),
      lenSegs0,
      (t, ang) => {
        // Natural trunk root flare + organic bark ridge furrows!
        const rootFlare =
          seg.depth === 0 && t < 0.25
            ? 1.0 + Math.pow((0.25 - t) / 0.25, 1.55) * (0.58 + 0.22 * Math.sin(ang * rootCount))
            : 1.0;
        const barkFurrow =
          seg.depth <= 1
            ? 1.0 + (ridged2D(ang * 1.4 + seed * 0.1, t * 5.0, 2, 2.0, 0.5, seed) - 0.5) * (seg.depth === 0 ? 0.13 : 0.08)
            : 1.0;
        const r = THREE.MathUtils.lerp(seg.rStart, seg.rEnd, Math.pow(t, 0.88)) * rootFlare * barkFurrow;
        return { sx: r, sy: r };
      },
      true,
      seg.depth === 0 ? 2.2 : 1.2,
      seg.depth === 0 ? 5.0 : 2.2
    );
    barkParts0.push(geo0);

    // Lightweight LOD1 keeps trunk & primary limbs only
    if (seg.depth <= 1) {
      const geo1 = sweepProfileAlongCurve(
        curve,
        ellipseProfile(1, 1, seg.depth === 0 ? 7 : 5),
        seg.depth === 0 ? 6 : 4,
        (t) => {
          const r = THREE.MathUtils.lerp(seg.rStart, seg.rEnd, t);
          return { sx: r, sy: r };
        },
        true
      );
      barkParts1.push(geo1);
    }

    // Spawn child branches down to Depth 3 (terminal twigs!)
    if (seg.depth === 0) {
      // 5-6 Primary Limbs spiraling up the upper 62% of the trunk
      const numPrimary = 5 + ((rng() * 2) | 0);
      const baseAz = rng() * Math.PI * 2;
      for (let c = 0; c < numPrimary; c++) {
        const tAttach = 0.38 + (c / (numPrimary - 1)) * 0.58;
        const attachPt = curve.getPoint(Math.min(0.98, tAttach));
        const az = baseAz + c * 2.39996 + (rng() - 0.5) * 0.45;
        const spread = THREE.MathUtils.lerp(0.84, 0.42, (tAttach - 0.38) / 0.58) + (rng() - 0.5) * 0.14;
        const upBias = THREE.MathUtils.lerp(0.36, 0.78, (tAttach - 0.38) / 0.58);
        const cDir = new THREE.Vector3(Math.cos(az) * spread, upBias, Math.sin(az) * spread).normalize();
        // Tuck branch root slightly inside trunk centerline so zero flat stump cap ever pokes out!
        const tuckedStart = attachPt.clone().addScaledVector(cDir, -0.06);

        queue.push({
          start: tuckedStart,
          dir: cDir,
          length: seg.length * THREE.MathUtils.lerp(0.58, 0.36, (tAttach - 0.38) / 0.58) * (0.85 + rng() * 0.3),
          rStart: THREE.MathUtils.lerp(seg.rStart, seg.rEnd, tAttach) * 0.62,
          rEnd: 0.045,
          depth: 1,
        });
      }
      // Central crown leader continuing upward from trunk apex
      queue.push({
        start: curve.getPoint(0.96),
        dir: new THREE.Vector3((rng() - 0.5) * 0.25 + windLeanX, 0.94, (rng() - 0.5) * 0.25 + windLeanZ).normalize(),
        length: seg.length * 0.40,
        rStart: seg.rEnd * 0.92,
        rEnd: 0.036,
        depth: 1,
      });
    } else if (seg.depth === 1) {
      // 3 Secondary branches per primary limb
      const numSec = 3;
      for (let c = 0; c < numSec; c++) {
        const tAttach = 0.34 + (c / (numSec - 1)) * 0.60;
        const attachPt = curve.getPoint(Math.min(0.98, tAttach));
        const sideSign = c % 2 === 0 ? 1 : -1;
        const perp = new THREE.Vector3(-seg.dir.z * sideSign, 0.22 + rng() * 0.35, seg.dir.x * sideSign).normalize();
        const cDir = seg.dir
          .clone()
          .multiplyScalar(0.55 + rng() * 0.2)
          .addScaledVector(perp, 0.58 + rng() * 0.22)
          .normalize();

        queue.push({
          start: attachPt,
          dir: cDir,
          length: seg.length * (0.52 + rng() * 0.16),
          rStart: THREE.MathUtils.lerp(seg.rStart, seg.rEnd, tAttach) * 0.68,
          rEnd: 0.020,
          depth: 2,
        });
      }
    } else if (seg.depth === 2) {
      // 2-3 Tertiary terminal twigs branching off each secondary limb
      const numTwigs = 2 + ((rng() * 2) | 0);
      for (let c = 0; c < numTwigs; c++) {
        const tAttach = 0.42 + (c / Math.max(1, numTwigs - 1)) * 0.54;
        const attachPt = curve.getPoint(Math.min(0.98, tAttach));
        const sideSign = c % 2 === 0 ? 1 : -1;
        const perp = new THREE.Vector3(-seg.dir.z * sideSign, (rng() - 0.35) * 0.55, seg.dir.x * sideSign).normalize();
        const cDir = seg.dir.clone().multiplyScalar(0.62).addScaledVector(perp, 0.58).normalize();
        queue.push({
          start: attachPt,
          dir: cDir,
          length: seg.length * (0.48 + rng() * 0.18),
          rStart: Math.max(0.014, THREE.MathUtils.lerp(seg.rStart, seg.rEnd, tAttach) * 0.68),
          rEnd: 0.006,
          depth: 3,
        });
      }
      // Mid-twig leaf anchor on secondary limb
      leafAnchors.push({
        pos: curve.getPoint(0.76),
        dir: curve.getTangent(0.76).normalize(),
        depth: 2,
        scale: 0.92 + rng() * 0.28,
      });
    } else if (seg.depth === 3) {
      // Terminal twig foliage sprays at mid and tip!
      leafAnchors.push({
        pos: curve.getPoint(0.55),
        dir: curve.getTangent(0.55).normalize(),
        depth: 3,
        scale: 0.85 + rng() * 0.28,
      });
      leafAnchors.push({
        pos: curve.getPoint(0.98),
        dir: curve.getTangent(0.98).normalize(),
        depth: 3,
        scale: 0.96 + rng() * 0.32,
      });
    }
  }

  // Compute canopy centroid for true volumetric inner-to-outer Ambient Occlusion baking
  const canopyCenter = new THREE.Vector3();
  for (const a of leafAnchors) canopyCenter.add(a.pos);
  if (leafAnchors.length > 0) canopyCenter.divideScalar(leafAnchors.length);
  let maxCanopyR = 1.0;
  for (const a of leafAnchors) maxCanopyR = Math.max(maxCanopyR, a.pos.distanceTo(canopyCenter));

  // Build bent multi-plane botanical leaf-sprig clusters following each terminal twig's natural growth vector
  const addLeafCluster = (
    targetList: THREE.BufferGeometry[],
    anchor: { pos: THREE.Vector3; dir: THREE.Vector3; scale: number },
    cardsPerCluster: number,
    scaleMult: number
  ) => {
    const s = anchor.scale * scaleMult;
    const baseYaw = Math.atan2(anchor.dir.x, anchor.dir.z);
    for (let k = 0; k < cardsPerCluster; k++) {
      const card = new THREE.PlaneGeometry(s, s, 2, 2);
      const pa = card.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < pa.count; v++) {
        const vx = pa.getX(v);
        const vy = pa.getY(v);
        // Gentle cup/arch mimicking real leaf branchlet droop
        const r2 = (vx * vx + vy * vy) / (s * s * 0.5);
        pa.setZ(v, -r2 * s * 0.14);
      }
      card.computeVertexNormals();
      card.rotateX((rng() - 0.5) * 1.15 - 0.15);
      card.rotateY(baseYaw + (k / cardsPerCluster) * Math.PI * 1.85 + (rng() - 0.5) * 0.45);
      card.rotateZ((rng() - 0.5) * 0.85);
      card.translate(
        anchor.pos.x + (rng() - 0.5) * 0.24,
        anchor.pos.y + (rng() - 0.5) * 0.18,
        anchor.pos.z + (rng() - 0.5) * 0.24
      );

      // Bake volumetric canopy AO + subtle height sunlight gradient into vertex colors
      const posWorld = card.attributes.position as THREE.BufferAttribute;
      const cols = new Float32Array(posWorld.count * 3);
      const tmp = new THREE.Vector3();
      const tintShift = 0.88 + rng() * 0.24;
      for (let v = 0; v < posWorld.count; v++) {
        tmp.set(posWorld.getX(v), posWorld.getY(v), posWorld.getZ(v));
        const radialNorm = Math.min(1, tmp.distanceTo(canopyCenter) / maxCanopyR);
        const heightNorm = THREE.MathUtils.clamp((tmp.y - (canopyCenter.y - maxCanopyR * 0.7)) / (maxCanopyR * 1.4), 0, 1);
        const ao = (0.32 + radialNorm * 0.52 + heightNorm * 0.30) * tintShift;
        cols[v * 3] = ao * 0.98;
        cols[v * 3 + 1] = ao * 1.02;
        cols[v * 3 + 2] = ao * 0.94;
      }
      card.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      targetList.push(card);
    }
  };

  for (let i = 0; i < leafAnchors.length; i++) {
    const a = leafAnchors[i];
    // LOD0: 3 rich curved sprig planes per terminal node for lush layered crown while keeping visible branch structure
    addLeafCluster(leafParts0, a, 3, 1.05);
    // LOD1: Every 3rd anchor gets 1 slightly larger sprig plane for crisp silhouette at >55m distance
    if (i % 3 === 0) {
      addLeafCluster(leafParts1, a, 1, 1.55);
    }
  }

  const barkLOD0 = mergeParts(barkParts0, false);
  const leavesLOD0 = mergeParts(leafParts0, false);
  const barkLOD1 = mergeParts(barkParts1, false);
  const leavesLOD1 = mergeParts(leafParts1, false);

  return {
    barkLOD0,
    leavesLOD0,
    barkLOD1,
    leavesLOD1,
    trisLOD0: countTriangles(barkLOD0) + countTriangles(leavesLOD0),
    trisLOD1: countTriangles(barkLOD1) + countTriangles(leavesLOD1),
  };
}

/**
 * Creates the wind-animated, alpha-tested, backlit-translucent tree foliage material.
 */
export function createTreeFoliageMaterial(
  leafAlpha: THREE.DataTexture,
  leafNormal: THREE.DataTexture,
  timeUniform: { value: number },
  camPosUniform: { value: THREE.Vector3 },
  sunDir: THREE.Vector3,
  csm?: CSM
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: leafAlpha,
    normalMap: leafNormal,
    normalScale: new THREE.Vector2(1.15, 1.15),
    alphaTest: 0.36,
    side: THREE.DoubleSide,
    roughness: 0.64,
    metalness: 0.01,
    color: 0xaab49e,
    vertexColors: true,
    envMapIntensity: 0.65,
  });

  if (csm) csm.setupMaterial(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.uniforms.uTime = timeUniform;
    shader.uniforms.uCamPos = camPosUniform;
    shader.uniforms.uSunDir = { value: sunDir.clone().normalize() };

    shader.vertexShader =
      `
      uniform float uTime;
      varying vec3 vLeafWorldPos;
      ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 tOrg = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 tOrg = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
      #endif
      float crownH = max(0.0, position.y - 1.5);
      float branchSway = sin(uTime * 1.45 + tOrg.x * 0.22 + tOrg.z * 0.19) * crownH * 0.028;
      float leafFlutter = sin(uTime * 4.8 + position.x * 3.2 + position.z * 2.9 + tOrg.x) * 0.022 * min(1.0, crownH * 0.3);
      transformed.x += branchSway + leafFlutter;
      transformed.z += (branchSway + leafFlutter) * 0.65;
      vLeafWorldPos = tOrg + transformed;
      `
    );

    shader.fragmentShader =
      `
      uniform vec3 uCamPos;
      uniform vec3 uSunDir;
      varying vec3 vLeafWorldPos;
      ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
      #include <emissivemap_fragment>
      vec3 lView = normalize(vLeafWorldPos - uCamPos);
      float backLight = pow(max(0.0, dot(lView, uSunDir)), 2.6);
      // Soft overcast sky transmission through thin foliage clusters
      totalEmissiveRadiance += diffuseColor.rgb * vec3(0.95, 1.04, 0.72) * (0.08 + backLight * 0.36);
      `
    );
  };
  mat.customProgramCacheKey = () => 'tree-foliage-l-system-v2';
  return mat;
}
