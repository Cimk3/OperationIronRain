import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { fbm2D, mulberry32 } from '../proc/noise';
import { ellipseProfile, sweepProfileAlongCurve } from '../proc/modeling';
import { EnvironmentPBRAtlas } from '../proc/pbrGenerator';
import { buildRockLibrary, createRockMaterial } from '../proc/rockGenerator';
import { TextureLibrary } from '../proc/textures';
import {
  createTreeFoliageMaterial,
  generateProceduralTreeVariant,
  ProceduralTreeVariant,
} from '../proc/treeGenerator';
import {
  buildGrassClumpLibrary,
  buildMicroGroundAssets,
  createGrassMaterial,
} from '../proc/vegetationGenerator';
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
  vramExtraBytes: number;
  update(elapsed: number, camPos?: THREE.Vector3): void;
}

export function buildVegetationSystem(
  data: TerrainWorkerOutput,
  terrain: BattlefieldTerrain,
  textures: TextureLibrary,
  envAtlas: EnvironmentPBRAtlas,
  quality: QualityConfig,
  sunDir: THREE.Vector3,
  csm?: CSM
): VegetationSystem {
  const group = new THREE.Group();
  group.name = 'VegetationSystem';
  const colliders: CylinderCollider[] = [];
  const meshesForRaycast: THREE.Object3D[] = [];
  const timeUniform = { value: 0 };
  const camPosUniform = { value: new THREE.Vector3(0, 2, 92) };

  const grassLib = buildGrassClumpLibrary();
  const microAssets = buildMicroGroundAssets(textures.maxAnisotropy);
  const rockLib = buildRockLibrary();
  const treeVariants: ProceduralTreeVariant[] = [
    generateProceduralTreeVariant(101, 'broadleaf'),
    generateProceduralTreeVariant(202, 'alder'),
    generateProceduralTreeVariant(303, 'windswept'),
  ];

  // 1. SHARED MATERIALS (Overcast Realism + Wind + CSM)
  const barkMat = new THREE.MeshStandardMaterial({
    map: textures.bark.map,
    normalMap: textures.bark.normalMap,
    normalScale: new THREE.Vector2(1.5, 1.5),
    roughnessMap: textures.bark.roughnessMap,
    aoMap: textures.bark.aoMap,
    color: 0xc2bcb2,
    roughness: 0.88,
    metalness: 0.02,
    envMapIntensity: 0.65,
  });
  if (csm) csm.setupMaterial(barkMat);

  const treeFoliageMat = createTreeFoliageMaterial(
    microAssets.leafSprigAlpha,
    microAssets.leafSprigNormal,
    timeUniform,
    camPosUniform,
    sunDir,
    csm
  );

  const rockMat = createRockMaterial(envAtlas.groundRock, csm);

  const grassMat = createGrassMaterial(
    timeUniform,
    camPosUniform,
    sunDir,
    quality.preset === 'high' ? 68.0 : quality.preset === 'medium' ? 54.0 : 42.0,
    csm
  );

  const fallenLeafMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.01,
    side: THREE.DoubleSide,
  });
  if (csm) csm.setupMaterial(fallenLeafMat);

  const dummy = new THREE.Object3D();
  const upVec = new THREE.Vector3(0, 1, 0);
  const normalTmp = new THREE.Vector3();
  const alignQuat = new THREE.Quaternion();
  const yawQuat = new THREE.Quaternion();

  // 2. THREE L-SYSTEM 3-TIER RECURSIVE TREE VARIANTS WITH DISTANCE LOD0 / LOD1!
  const totalTrees = Math.min(quality.treeCount, Math.floor(data.treePlacements.length / 5));
  const treeBuckets: Array<Array<{ mat: THREE.Matrix4; pos: THREE.Vector3 }>> = [[], [], []];

  for (let i = 0; i < totalTrees; i++) {
    const pIdx = i * 5;
    const wx = data.treePlacements[pIdx];
    const wz = data.treePlacements[pIdx + 1];
    const sc = data.treePlacements[pIdx + 2];
    const ry = data.treePlacements[pIdx + 3];
    const wy = terrain.getHeightAt(wx, wz);

    dummy.position.set(wx, wy, wz);
    dummy.rotation.set(0, ry, 0);
    dummy.scale.setScalar(sc);
    dummy.updateMatrix();
    treeBuckets[i % 3].push({ mat: dummy.matrix.clone(), pos: new THREE.Vector3(wx, wy, wz) });

    colliders.push({
      x: wx,
      z: wz,
      bottomY: wy - 0.5,
      topY: wy + 5.2 * sc,
      radius: 0.36 * sc,
      material: MaterialId.WOOD,
    });
  }

  // Dynamic LOD0 (<= 58m) vs LOD1 (> 58m) InstancedMesh switcher per tree variant!
  interface TreeLODGroup {
    entries: Array<{ mat: THREE.Matrix4; pos: THREE.Vector3 }>;
    bark0: THREE.InstancedMesh;
    leaf0: THREE.InstancedMesh;
    bark1: THREE.InstancedMesh;
    leaf1: THREE.InstancedMesh;
  }
  const treeLODGroups: TreeLODGroup[] = [];
  const lastTreeLODCam = new THREE.Vector3(9999, 0, 9999);

  for (let v = 0; v < 3; v++) {
    const entries = treeBuckets[v];
    if (entries.length === 0) continue;
    const variant = treeVariants[v];

    const bark0 = new THREE.InstancedMesh(variant.barkLOD0, barkMat, entries.length);
    const leaf0 = new THREE.InstancedMesh(variant.leavesLOD0, treeFoliageMat, entries.length);
    const bark1 = new THREE.InstancedMesh(variant.barkLOD1, barkMat, entries.length);
    const leaf1 = new THREE.InstancedMesh(variant.leavesLOD1, treeFoliageMat, entries.length);

    bark0.castShadow = true;
    bark0.receiveShadow = true;
    leaf0.castShadow = true;
    leaf0.receiveShadow = true;
    bark1.castShadow = false;
    bark1.receiveShadow = true;
    leaf1.castShadow = false;
    leaf1.receiveShadow = true;
    bark0.frustumCulled = false;
    leaf0.frustumCulled = false;
    bark1.frustumCulled = false;
    leaf1.frustumCulled = false;

    for (let i = 0; i < entries.length; i++) {
      bark0.setMatrixAt(i, entries[i].mat);
      leaf0.setMatrixAt(i, entries[i].mat);
      bark1.setMatrixAt(i, entries[i].mat);
      leaf1.setMatrixAt(i, entries[i].mat);
    }
    bark0.count = entries.length;
    leaf0.count = entries.length;
    bark1.count = 0;
    leaf1.count = 0;
    bark0.instanceMatrix.needsUpdate = true;
    leaf0.instanceMatrix.needsUpdate = true;
    bark1.instanceMatrix.needsUpdate = true;
    leaf1.instanceMatrix.needsUpdate = true;

    group.add(bark0, leaf0, bark1, leaf1);
    meshesForRaycast.push(bark0);
    treeLODGroups.push({ entries, bark0, leaf0, bark1, leaf1 });
  }

  const updateTreeLODs = (camPos: THREE.Vector3) => {
    if (camPos.distanceToSquared(lastTreeLODCam) < 36) return; // Update every ~6m walked
    lastTreeLODCam.copy(camPos);
    const lodDistSq = 60 * 60;
    for (const grp of treeLODGroups) {
      let c0 = 0;
      let c1 = 0;
      for (let i = 0; i < grp.entries.length; i++) {
        const e = grp.entries[i];
        if (e.pos.distanceToSquared(camPos) <= lodDistSq) {
          grp.bark0.setMatrixAt(c0, e.mat);
          grp.leaf0.setMatrixAt(c0, e.mat);
          c0++;
        } else {
          grp.bark1.setMatrixAt(c1, e.mat);
          grp.leaf1.setMatrixAt(c1, e.mat);
          c1++;
        }
      }
      grp.bark0.count = c0;
      grp.leaf0.count = c0;
      grp.bark1.count = c1;
      grp.leaf1.count = c1;
      grp.bark0.instanceMatrix.needsUpdate = true;
      grp.leaf0.instanceMatrix.needsUpdate = true;
      grp.bark1.instanceMatrix.needsUpdate = true;
      grp.leaf1.instanceMatrix.needsUpdate = true;
    }
  };

  // 3. THREE MULTI-SCALE FRACTURED & MOSSY ROCK VARIANTS (GPU INSTANCED)
  const rockGeos = [rockLib.boulderFractured, rockLib.graniteCrag, rockLib.lowMossSlab];
  const rockBuckets: THREE.Matrix4[][] = [[], [], []];
  const rockTotal = Math.floor(data.rockPlacements.length / 7);
  for (let i = 0; i < rockTotal; i++) {
    const p = i * 7;
    const wx = data.rockPlacements[p];
    const wz = data.rockPlacements[p + 1];
    const sx = data.rockPlacements[p + 2];
    const sy = data.rockPlacements[p + 3];
    const sz = data.rockPlacements[p + 4];
    const ry = data.rockPlacements[p + 5];
    const wy = terrain.getHeightAt(wx, wz) - sy * 0.14;

    dummy.position.set(wx, wy, wz);
    dummy.rotation.set(0, ry, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    rockBuckets[i % 3].push(dummy.matrix.clone());

    colliders.push({
      x: wx,
      z: wz,
      bottomY: wy - 1.0,
      topY: wy + sy * 0.92,
      radius: Math.max(sx, sz) * 0.72,
      material: MaterialId.ROCK,
    });
  }
  for (let v = 0; v < 3; v++) {
    const arr = rockBuckets[v];
    if (arr.length === 0) continue;
    const inst = new THREE.InstancedMesh(rockGeos[v], rockMat, arr.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    for (let i = 0; i < arr.length; i++) inst.setMatrixAt(i, arr[i]);
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    meshesForRaycast.push(inst);
  }

  // 4. WOODY MULTI-BRANCH SHRUBS (True wooden branch skeleton + botanical leaf sprigs!)
  const bushCount = Math.floor(data.bushPlacements.length / 4);
  if (bushCount > 0) {
    const sbInst = new THREE.InstancedMesh(microAssets.woodyShrubBranches, barkMat, bushCount);
    const slInst = new THREE.InstancedMesh(microAssets.woodyShrubLeaves, treeFoliageMat, bushCount);
    sbInst.castShadow = true;
    sbInst.receiveShadow = true;
    slInst.castShadow = true;
    slInst.receiveShadow = true;
    for (let i = 0; i < bushCount; i++) {
      const p = i * 4;
      const wx = data.bushPlacements[p];
      const wz = data.bushPlacements[p + 1];
      const sc = data.bushPlacements[p + 2];
      const ry = data.bushPlacements[p + 3];
      const wy = terrain.getHeightAt(wx, wz);
      dummy.position.set(wx, wy - 0.03, wz);
      dummy.rotation.set(0, ry, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      sbInst.setMatrixAt(i, dummy.matrix);
      slInst.setMatrixAt(i, dummy.matrix);
    }
    sbInst.instanceMatrix.needsUpdate = true;
    slInst.instanceMatrix.needsUpdate = true;
    group.add(sbInst, slInst);
  }

  // 5. FALLEN MOSSY LOGS FOR NATURAL TACTICAL COVER
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

  // 6. CONTINUOUS ECOLOGICAL MEADOW GRASS (4 Multi-Segment Curved Blade Varieties, GPU Instanced!)
  const rng = mulberry32(909);
  // Dense continuous woodland meadows (4 GPU-instanced Draw Calls total!)
  const baseCount = Math.round(Math.max(24000, quality.grassCount * 2.4));
  const colTmp = new THREE.Color();
  let totalGroundInstances = 0;

  const grassSpecs: Array<{
    geo: THREE.BufferGeometry;
    target: number;
    sMin: number;
    sMax: number;
    preferDry?: boolean;
  }> = [
    { geo: grassLib.denseTurf, target: Math.round(baseCount * 0.48), sMin: 1.05, sMax: 1.68 },
    { geo: grassLib.tallMeadow, target: Math.round(baseCount * 0.26), sMin: 0.95, sMax: 1.55 },
    { geo: grassLib.dryOchre, target: Math.round(baseCount * 0.15), sMin: 0.96, sMax: 1.50, preferDry: true },
    { geo: grassLib.broadWeed, target: Math.round(baseCount * 0.11), sMin: 0.92, sMax: 1.42 },
  ];

  // Focus lush continuous meadow coverage across playable combat valley (-68..68, -95..104)
  for (const spec of grassSpecs) {
    const matrices: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    const maxAttempts = spec.target * 4;
    for (let i = 0; i < maxAttempts && matrices.length < spec.target; i++) {
      // Strong foreground & combat-corridor meadow density so hillsides read as unbroken turf carpets!
      const roll = rng();
      const wx = roll < 0.55 ? (rng() - 0.5) * 68 : roll < 0.86 ? (rng() - 0.5) * 112 : (rng() - 0.5) * 155;
      const wz = roll < 0.55 ? -40 + rng() * 144 : -98 + rng() * 202;

      const matId = terrain.getMaterialAt(wx, wz);
      if (matId !== MaterialId.GRASS && matId !== MaterialId.WET_MUD) continue;
      if (terrain.getWaterDepthAt(wx, wz) > 0.008) continue;

      // Continuous FBM meadow patch density field (lush carpets with organic edge thinning)
      const patchFbm = fbm2D(wx * 0.08, wz * 0.08, 3, 2.0, 0.5, 513) * 0.5 + 0.5;
      const bankMod = matId === MaterialId.WET_MUD ? 0.52 : 1.0;
      if (rng() > (0.28 + patchFbm * 1.15) * bankMod) continue;

      const wy = terrain.getHeightAt(wx, wz);
      terrain.getNormalAt(wx, wz, normalTmp);
      alignQuat.setFromUnitVectors(upVec, normalTmp);
      yawQuat.setFromAxisAngle(upVec, rng() * Math.PI * 2);
      dummy.position.set(wx, wy, wz);
      dummy.quaternion.copy(alignQuat).multiply(yawQuat);
      const s = spec.sMin + rng() * (spec.sMax - spec.sMin);
      const heightVar = (0.78 + patchFbm * 0.48) * (0.86 + rng() * 0.30);
      dummy.scale.set(s, s * heightVar, s);
      dummy.updateMatrix();
      matrices.push(dummy.matrix.clone());

      const vTint = 0.78 + rng() * 0.38;
      const warm = spec.preferDry ? 1.08 : 0.90 + rng() * 0.16;
      colTmp.setRGB(vTint * warm, vTint * (0.96 + rng() * 0.12), vTint * 0.86);
      colors.push(colTmp.clone());
    }

    if (matrices.length > 0) {
      const inst = new THREE.InstancedMesh(spec.geo, grassMat, matrices.length);
      inst.receiveShadow = true;
      inst.castShadow = false;
      for (let i = 0; i < matrices.length; i++) {
        inst.setMatrixAt(i, matrices[i]);
        inst.setColorAt(i, colors[i]);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      group.add(inst);
      totalGroundInstances += matrices.length;
    }
  }

  // 7. GROUND NATURAL MICRO-ASSETS: DEAD TWIGS, FALLEN LEAVES & ANGULAR GRAVEL CLUSTERS (terrain-normal aligned!)
  const scatterMicro = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    target: number,
    sMin: number,
    sMax: number,
    yBias: number,
    allowMud = true
  ) => {
    const mats: THREE.Matrix4[] = [];
    for (let i = 0; i < target * 3 && mats.length < target; i++) {
      const wx = (rng() - 0.5) * 115;
      const wz = -95 + rng() * 198;
      if (terrain.getWaterDepthAt(wx, wz) > 0.008) continue;
      const mId = terrain.getMaterialAt(wx, wz);
      if (!allowMud && mId === MaterialId.WET_MUD) continue;
      const wy = terrain.getHeightAt(wx, wz);
      terrain.getNormalAt(wx, wz, normalTmp);
      alignQuat.setFromUnitVectors(upVec, normalTmp);
      yawQuat.setFromAxisAngle(upVec, rng() * Math.PI * 2);
      dummy.position.set(wx, wy + yBias, wz);
      dummy.quaternion.copy(alignQuat).multiply(yawQuat);
      dummy.scale.setScalar(sMin + rng() * (sMax - sMin));
      dummy.updateMatrix();
      mats.push(dummy.matrix.clone());
    }
    if (mats.length > 0) {
      const inst = new THREE.InstancedMesh(geo, mat, mats.length);
      inst.receiveShadow = true;
      for (let i = 0; i < mats.length; i++) inst.setMatrixAt(i, mats[i]);
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
      totalGroundInstances += mats.length;
    }
  };

  scatterMicro(microAssets.deadTwig, barkMat, Math.round(baseCount * 0.045), 0.7, 1.35, 0.0, true);
  scatterMicro(microAssets.fallenLeaves, fallenLeafMat, Math.round(baseCount * 0.085), 0.75, 1.4, 0.005, false);
  scatterMicro(microAssets.gravelCluster, rockMat, Math.round(baseCount * 0.065), 0.65, 1.45, -0.015, true);

  const treeTrisAvg = Math.round(
    (treeVariants[0].trisLOD0 + treeVariants[1].trisLOD0 + treeVariants[2].trisLOD0) / 3
  );
  const vramExtraBytes = Math.round(1024 * 1024 * 4 * 1.3333 * 2); // Leaf sprig alpha + normal

  return {
    group,
    colliders,
    meshesForRaycast,
    treeTrisAvg,
    groundInstances: totalGroundInstances,
    vramExtraBytes,
    update(elapsed: number, camPos?: THREE.Vector3) {
      timeUniform.value = elapsed;
      if (camPos) {
        camPosUniform.value.copy(camPos);
        updateTreeLODs(camPos);
      }
    },
  };
}
