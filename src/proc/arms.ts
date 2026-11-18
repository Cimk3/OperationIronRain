import * as THREE from 'three';
import { countTriangles } from './modeling';
import { TextureLibrary } from './textures';

export interface FingerRig {
  bones: [THREE.Bone, THREE.Bone, THREE.Bone]; // proximal, middle, distal
  basePos: THREE.Vector3;
  baseEuler: THREE.Euler;
}

export interface ArmRig {
  root: THREE.Group;
  skinnedMesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  shoulder: THREE.Bone;
  upperArm: THREE.Bone;
  forearm: THREE.Bone;
  palm: THREE.Bone;
  fingers: {
    thumb: FingerRig;
    index: FingerRig;
    middle: FingerRig;
    ring: FingerRig;
    pinky: FingerRig;
  };
  upperLen: number;
  foreLen: number;
  isLeft: boolean;
}

export interface FingerPose {
  thumb: [number, number, number, number]; // yaw, curl1, curl2, curl3
  index: [number, number, number, number];
  middle: [number, number, number, number];
  ring: [number, number, number, number];
  pinky: [number, number, number, number];
}

/**
 * Generates an organic lofted SkinnedMesh arm + combat sleeve + tactical glove + 5 articulated fingers.
 * Coordinate space of the arm in T-pose / rest:
 * - Shoulder at (0,0,0), arm extends along +Z? Let's extend along +Z for clean bone hierarchy!
 *   Shoulder -> (0,0,0)
 *   UpperArm -> (0,0,0) length upperLen along +Z
 *   Forearm  -> (0,0,upperLen) length foreLen along +Z
 *   Palm     -> (0,0,foreLen) length ~0.095 along +Z, palm normal pointing -Y (down) or inward!
 *   Let's make +Z distal (toward fingertips), +Y dorsal (back of hand), +X radial/ulnar (mirror for L/R).
 */
function buildSkinnedArm(isLeft: boolean, textures: TextureLibrary): ArmRig {
  const upperLen = 0.34;
  const foreLen = 0.32;
  // In right-handed coords (+Z fingers, +Y dorsal/back of hand):
  // looking along +Z with +Y up, +X is to the LEFT.
  // Right hand palm-down has thumb on the LEFT (+X); Left hand palm-down has thumb on the RIGHT (-X).
  const sideSign = isLeft ? -1 : 1;

  const root = new THREE.Group();
  root.name = isLeft ? 'Arm_Left_Root' : 'Arm_Right_Root';

  const bones: THREE.Bone[] = [];
  const shoulder = new THREE.Bone();
  shoulder.name = isLeft ? 'Clavicle_L' : 'Clavicle_R';
  bones.push(shoulder); // idx 0

  const upperArm = new THREE.Bone();
  upperArm.name = isLeft ? 'UpperArm_L' : 'UpperArm_R';
  shoulder.add(upperArm);
  bones.push(upperArm); // idx 1

  const forearm = new THREE.Bone();
  forearm.name = isLeft ? 'Forearm_L' : 'Forearm_R';
  forearm.position.set(0, 0, upperLen);
  upperArm.add(forearm);
  bones.push(forearm); // idx 2

  const palm = new THREE.Bone();
  palm.name = isLeft ? 'Palm_L' : 'Palm_R';
  palm.position.set(0, 0, foreLen);
  forearm.add(palm);
  bones.push(palm); // idx 3

  // Finger specs in Palm local space
  const fingerDefs: Array<{
    key: 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
    origin: THREE.Vector3;
    baseRot: THREE.Euler;
    lengths: [number, number, number];
    radii: [number, number, number, number];
  }> = [
    {
      key: 'thumb',
      origin: new THREE.Vector3(sideSign * 0.025, -0.008, 0.028),
      baseRot: new THREE.Euler(0.28, sideSign * 0.52, sideSign * -0.45),
      lengths: [0.028, 0.025, 0.022],
      radii: [0.0125, 0.011, 0.0095, 0.0072],
    },
    {
      key: 'index',
      origin: new THREE.Vector3(sideSign * 0.026, 0.001, 0.088),
      baseRot: new THREE.Euler(0, sideSign * 0.04, 0),
      lengths: [0.036, 0.024, 0.019],
      radii: [0.0102, 0.0092, 0.0082, 0.0064],
    },
    {
      key: 'middle',
      origin: new THREE.Vector3(sideSign * 0.007, 0.002, 0.091),
      baseRot: new THREE.Euler(0, 0, 0),
      lengths: [0.040, 0.027, 0.020],
      radii: [0.0105, 0.0094, 0.0084, 0.0065],
    },
    {
      key: 'ring',
      origin: new THREE.Vector3(-sideSign * 0.012, 0.001, 0.088),
      baseRot: new THREE.Euler(0, -sideSign * 0.04, 0),
      lengths: [0.037, 0.025, 0.019],
      radii: [0.0098, 0.0088, 0.0078, 0.0061],
    },
    {
      key: 'pinky',
      origin: new THREE.Vector3(-sideSign * 0.029, -0.002, 0.081),
      baseRot: new THREE.Euler(0, -sideSign * 0.09, 0),
      lengths: [0.029, 0.020, 0.016],
      radii: [0.0086, 0.0077, 0.0068, 0.0054],
    },
  ];

  const fingerRigs: Partial<ArmRig['fingers']> = {};
  const fingerBoneIndices: Record<string, [number, number, number]> = {};

  for (const def of fingerDefs) {
    const b0 = new THREE.Bone();
    b0.position.copy(def.origin);
    b0.rotation.copy(def.baseRot);
    palm.add(b0);
    const i0 = bones.length;
    bones.push(b0);

    const b1 = new THREE.Bone();
    b1.position.set(0, 0, def.lengths[0]);
    b0.add(b1);
    const i1 = bones.length;
    bones.push(b1);

    const b2 = new THREE.Bone();
    b2.position.set(0, 0, def.lengths[1]);
    b1.add(b2);
    const i2 = bones.length;
    bones.push(b2);

    fingerBoneIndices[def.key] = [i0, i1, i2];
    fingerRigs[def.key] = {
      bones: [b0, b1, b2],
      basePos: def.origin.clone(),
      baseEuler: def.baseRot.clone(),
    };
  }

  root.add(shoulder);
  root.updateMatrixWorld(true);

  // Build unified Skinned Geometry in bind pose!
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = []; // R=material zone (0=sleeve, 0.5=glove, 1.0=knuckle armor), G=AO, B=detail
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const indices: number[] = [];

  function pushVertex(
    pos: THREE.Vector3,
    u: number,
    v: number,
    col: [number, number, number],
    si: [number, number, number, number],
    sw: [number, number, number, number]
  ) {
    positions.push(pos.x, pos.y, pos.z);
    uvs.push(u, v);
    colors.push(col[0], col[1], col[2]);
    skinIndices.push(si[0], si[1], si[2], si[3]);
    skinWeights.push(sw[0], sw[1], sw[2], sw[3]);
  }

  // 1. SLEEVE + WRIST + GLOVE PALM (continuous lofted tube from z=0.05 to z=upperLen+foreLen+0.092)
  const armRings = 44;
  const armRadial = 28;
  const zStart = 0.04;
  const zEnd = upperLen + foreLen + 0.091;
  const sleeveStartVert = positions.length / 3;

  for (let i = 0; i <= armRings; i++) {
    const t = i / armRings;
    const z = zStart + t * (zEnd - zStart);

    // Cross-section shape transitions smoothly from bicep -> elbow -> rolled cuff -> wrist -> palm!
    let rx = 0.046;
    let ry = 0.044;
    let yOffset = 0;
    let zone = 0.0; // 0 = combat sleeve, 0.5 = tactical glove, 1.0 = knuckle shell
    let ao = 0.92;

    if (z < upperLen) {
      // Upper arm sleeve with cloth fold ripples
      const u = z / upperLen;
      rx = 0.056 - u * 0.008 + Math.sin(u * 14) * 0.0025;
      ry = 0.054 - u * 0.008;
    } else if (z < upperLen + foreLen - 0.035) {
      // Forearm sleeve with tactical cuff fold near wrist
      const u = (z - upperLen) / (foreLen - 0.035);
      const cuffStep = u > 0.88 ? 0.005 * Math.sin(((u - 0.88) / 0.12) * Math.PI) : 0;
      rx = 0.049 - u * 0.013 + cuffStep + Math.sin(u * 18) * 0.002;
      ry = 0.045 - u * 0.015 + cuffStep;
      if (u > 0.94) ao = 0.65; // Cuff crease shadow
    } else if (z < upperLen + foreLen + 0.008) {
      // Wrist strap / glove cuff
      const u = (z - (upperLen + foreLen - 0.035)) / 0.043;
      zone = 0.55;
      rx = 0.034 + u * 0.003;
      ry = 0.025 + Math.sin(u * Math.PI) * 0.0025;
      ao = 0.82;
    } else {
      // Palm / Metacarpal box (flattens & widens toward knuckles!)
      const u = Math.min(1, (z - (upperLen + foreLen + 0.008)) / 0.083);
      zone = u > 0.68 && u < 0.92 ? 0.92 : 0.55;
      rx = 0.037 + Math.sin(u * Math.PI * 0.75) * 0.009;
      ry = 0.023 - u * 0.0085;
      yOffset = -u * 0.002;
    }

    // Compute smooth skinning weights between UpperArm(1), Forearm(2), Palm(3)
    let w1 = 0, w2 = 0, w3 = 0;
    if (z <= upperLen - 0.03) {
      w1 = 1;
    } else if (z < upperLen + 0.03) {
      const blend = (z - (upperLen - 0.03)) / 0.06;
      w1 = 1 - blend;
      w2 = blend;
    } else if (z <= upperLen + foreLen - 0.025) {
      w2 = 1;
    } else if (z < upperLen + foreLen + 0.025) {
      const blend = (z - (upperLen + foreLen - 0.025)) / 0.05;
      w2 = 1 - blend;
      w3 = blend;
    } else {
      w3 = 1;
    }

    for (let j = 0; j <= armRadial; j++) {
      const a = (j / armRadial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Cloth folds on sleeve, knuckle ridge on back of palm (+Y -> sa > 0)
      const clothFold =
        zone < 0.25 ? Math.sin(a * 5 + z * 28) * 0.0022 : 0;
      const knuckleBump =
        zone > 0.8 && sa > 0.2 ? Math.pow(sa, 1.5) * 0.0045 * (0.7 + 0.3 * Math.cos(a * 4)) : 0;
      const px = ca * (rx + clothFold);
      const py = sa * (ry + clothFold) + yOffset + knuckleBump;

      const vZone = zone > 0.8 && sa > 0.2 ? 0.95 : zone > 0.25 ? 0.55 : 0.0;
      pushVertex(
        new THREE.Vector3(px, py, z),
        (j / armRadial) * 2.0,
        t * 4.5,
        [vZone, ao, 1.0],
        [1, 2, 3, 0],
        [w1, w2, w3, 0]
      );
    }
  }

  const armStride = armRadial + 1;
  for (let i = 0; i < armRings; i++) {
    for (let j = 0; j < armRadial; j++) {
      const a = sleeveStartVert + i * armStride + j;
      const b = sleeveStartVert + (i + 1) * armStride + j;
      const c = sleeveStartVert + (i + 1) * armStride + (j + 1);
      const d = sleeveStartVert + i * armStride + (j + 1);
      indices.push(a, d, b);
      indices.push(b, d, c);
    }
  }

  // Cap palm end cleanly
  const palmCapCenterIdx = positions.length / 3;
  pushVertex(
    new THREE.Vector3(0, -0.002, zEnd),
    0.5,
    1.0,
    [0.55, 0.8, 1.0],
    [3, 0, 0, 0],
    [1, 0, 0, 0]
  );
  const lastRingStart = sleeveStartVert + armRings * armStride;
  for (let j = 0; j < armRadial; j++) {
    indices.push(palmCapCenterIdx, lastRingStart + j, lastRingStart + j + 1);
  }

  // 2. FIVE ARTICULATED FINGERS WITH DENSE JOINT BENDING EDGE LOOPS
  // Each finger: 28 axial rings x 20 radial segments = 1,120 tris/finger x 5 = 5,600 tris!
  // Plus 44*28*2 = 2,464 tris for sleeve/palm => ~8,100 tris per arm => ~16,200 tris for both arms!
  for (const def of fingerDefs) {
    const [b0Idx, b1Idx, b2Idx] = fingerBoneIndices[def.key];
    const [l0, l1, l2] = def.lengths;
    const [r0, r1, r2, r3] = def.radii;
    const totalLen = l0 + l1 + l2;
    const fRings = 28;
    const fRadial = 20;

    // Transform matrix from finger b0 local space to arm root space
    const b0Mat = new THREE.Matrix4().compose(
      new THREE.Vector3().copy(def.origin).add(new THREE.Vector3(0, 0, upperLen + foreLen)),
      new THREE.Quaternion().setFromEuler(def.baseRot),
      new THREE.Vector3(1, 1, 1)
    );

    const fStartVert = positions.length / 3;
    const j1 = l0;
    const j2 = l0 + l1;

    for (let i = 0; i <= fRings; i++) {
      const t = i / fRings;
      // Rounded fingertip dome on final 3 rings
      const tipBlend = t > 0.88 ? (t - 0.88) / 0.12 : 0;
      const dist = t * totalLen;

      // Radius interpolation with slight knuckle swell at joints
      let r: number;
      if (dist < j1) {
        r = THREE.MathUtils.lerp(r0, r1, dist / j1);
      } else if (dist < j2) {
        r = THREE.MathUtils.lerp(r1, r2, (dist - j1) / l1);
      } else {
        r = THREE.MathUtils.lerp(r2, r3, (dist - j2) / l2);
      }
      // Subtle knuckle swell & rounded hemisphere tip
      const knuckle1 = Math.exp(-Math.pow((dist - j1) / 0.005, 2)) * 0.0008;
      const knuckle2 = Math.exp(-Math.pow((dist - j2) / 0.0045, 2)) * 0.0007;
      r = (r + knuckle1 + knuckle2) * (tipBlend > 0 ? Math.cos(tipBlend * Math.PI * 0.48) : 1.0);

      // Smooth skinning weights across Palm(3) -> b0 -> b1 -> b2
      let sIdx: [number, number, number, number] = [b0Idx, b1Idx, b2Idx, 3];
      let sW: [number, number, number, number] = [0, 0, 0, 0];

      const blendZone = 0.007;
      if (dist < blendZone) {
        const w = 0.5 + (dist / blendZone) * 0.5;
        sW = [w, 0, 0, 1 - w];
      } else if (dist < j1 - blendZone) {
        sW = [1, 0, 0, 0];
      } else if (dist < j1 + blendZone) {
        const b = (dist - (j1 - blendZone)) / (blendZone * 2);
        sW = [1 - b, b, 0, 0];
      } else if (dist < j2 - blendZone) {
        sW = [0, 1, 0, 0];
      } else if (dist < j2 + blendZone) {
        const b = (dist - (j2 - blendZone)) / (blendZone * 2);
        sW = [0, 1 - b, b, 0];
      } else {
        sW = [0, 0, 1, 0];
      }

      for (let j = 0; j <= fRadial; j++) {
        const a = (j / fRadial) * Math.PI * 2;
        const px = Math.cos(a) * r * 1.04;
        const py = Math.sin(a) * r * 0.92;
        const localPos = new THREE.Vector3(px, py, dist).applyMatrix4(b0Mat);

        // Tactical glove dorsal pad on proximal segment
        const isKnucklePad = dist < l0 * 0.65 && Math.sin(a) > 0.25 ? 0.88 : 0.55;
        const creaseAO =
          1.0 -
          0.2 *
            (Math.exp(-Math.pow((dist - j1) / 0.003, 2)) +
              Math.exp(-Math.pow((dist - j2) / 0.003, 2)));

        pushVertex(localPos, j / fRadial, t * 2.0, [isKnucklePad, creaseAO, 1.0], sIdx, sW);
      }
    }

    const fStride = fRadial + 1;
    for (let i = 0; i < fRings; i++) {
      for (let j = 0; j < fRadial; j++) {
        const a = fStartVert + i * fStride + j;
        const b = fStartVert + (i + 1) * fStride + j;
        const c = fStartVert + (i + 1) * fStride + (j + 1);
        const d = fStartVert + i * fStride + (j + 1);
        indices.push(a, d, b);
        indices.push(b, d, c);
      }
    }

    // Cap fingertip cleanly
    const tipCenter = new THREE.Vector3(0, 0, totalLen + 0.001).applyMatrix4(b0Mat);
    const tipIdx = positions.length / 3;
    pushVertex(tipCenter, 0.5, 1.0, [0.55, 0.95, 1.0], [b2Idx, 0, 0, 0], [1, 0, 0, 0]);
    const fLastRing = fStartVert + fRings * fStride;
    for (let j = 0; j < fRadial; j++) {
      indices.push(tipIdx, fLastRing + j, fLastRing + j + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  // Tactical Fabric + Glove Carbon-Knuckle PBR Material (high-readability albedo + crisp normal creases)
  const mat = new THREE.MeshStandardMaterial({
    map: textures.tacticalFabric.map,
    normalMap: textures.tacticalFabric.normalMap,
    normalScale: new THREE.Vector2(1.55, 1.55),
    roughnessMap: textures.tacticalFabric.roughnessMap,
    aoMap: textures.tacticalFabric.aoMap,
    aoMapIntensity: 0.85,
    roughness: 1.0,
    metalness: 0.08,
    vertexColors: true,
  });

  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      float zone = vColor.r;
      float jointAO = vColor.g;
      // High value contrast: Dark Olive Combat Sleeve -> Light Sand/Tan Tactical Gloves -> Tan Knuckle Armor!
      vec3 sleeveTint = vec3(0.56, 0.60, 0.50);
      vec3 gloveTint = vec3(1.22, 1.08, 0.86);
      vec3 knuckleTint = vec3(0.92, 0.80, 0.62);
      vec3 zoneCol = mix(sleeveTint, gloveTint, smoothstep(0.2, 0.5, zone));
      zoneCol = mix(zoneCol, knuckleTint, smoothstep(0.75, 0.92, zone));
      diffuseColor.rgb *= zoneCol * mix(0.68, 1.12, jointAO);
      `
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `
      #include <roughnessmap_fragment>
      float zR = vColor.r;
      roughnessFactor = mix(roughnessFactor, 0.58, smoothstep(0.2, 0.55, zR));
      roughnessFactor = mix(roughnessFactor, 0.34, smoothstep(0.75, 0.92, zR));
      `
    );
  };
  mat.customProgramCacheKey = () => 'tactical-arm-glove';

  const skinnedMesh = new THREE.SkinnedMesh(geo, mat);
  skinnedMesh.frustumCulled = false;
  skinnedMesh.castShadow = true;
  skinnedMesh.receiveShadow = true;

  const skeleton = new THREE.Skeleton(bones);
  skinnedMesh.bind(skeleton);
  root.add(skinnedMesh);

  return {
    root,
    skinnedMesh,
    skeleton,
    shoulder,
    upperArm,
    forearm,
    palm,
    fingers: fingerRigs as ArmRig['fingers'],
    upperLen,
    foreLen,
    isLeft,
  };
}

/**
 * Analytical 2-Bone IK Solver placing Forearm tip (Wrist/Palm base) at `palmTargetPosView`
 * (in FirstPersonArmsSystem / ViewmodelRoot local space!) with elbow pushed toward `poleHintView`.
 */
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _targetLocal = new THREE.Vector3();
const _poleLocal = new THREE.Vector3();

export function solveArmIK(
  arm: ArmRig,
  palmTargetPosView: THREE.Vector3,
  palmTargetQuatView: THREE.Quaternion,
  poleHintView: THREE.Vector3
): void {
  // Convert from ViewmodelRoot space to Shoulder local space (exact local subtraction; avoids world-space offset!)
  _targetLocal.copy(palmTargetPosView).sub(arm.shoulder.position);
  _poleLocal.copy(poleHintView).sub(arm.shoulder.position);

  const l1 = arm.upperLen;
  const l2 = arm.foreLen;
  let dist = _targetLocal.length();
  const maxReach = (l1 + l2) * 0.992;
  const minReach = Math.abs(l1 - l2) + 0.02;
  if (dist > maxReach) {
    _targetLocal.multiplyScalar(maxReach / dist);
    dist = maxReach;
  } else if (dist < minReach && dist > 1e-5) {
    _targetLocal.multiplyScalar(minReach / dist);
    dist = minReach;
  }

  const dir = _vA.copy(_targetLocal).normalize();

  // Law of cosines for shoulder angle & elbow bend
  const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const angleA = Math.acos(cosA);

  // Orthonormal basis around `dir` and `poleLocal`
  const poleProj = _vB.copy(_poleLocal).addScaledVector(dir, -_poleLocal.dot(dir));
  if (poleProj.lengthSq() < 1e-6) poleProj.set(0, -1, 0);
  poleProj.normalize();

  // Upper arm points along dir rotated by angleA toward poleProj
  const upperDir = _vC
    .copy(dir)
    .multiplyScalar(Math.cos(angleA))
    .addScaledVector(poleProj, Math.sin(angleA))
    .normalize();

  // Orient UpperArm (+Z axis along upperDir, +Y aligned cleanly)
  const sideHint = _axis.crossVectors(poleProj, upperDir).normalize();
  const upHint = new THREE.Vector3().crossVectors(upperDir, sideHint).normalize();
  const upperMat = new THREE.Matrix4().makeBasis(sideHint, upHint, upperDir);
  arm.upperArm.quaternion.setFromRotationMatrix(upperMat);

  // Elbow position in shoulder space -> forearm direction to clamped target
  const elbowPos = upperDir.clone().multiplyScalar(l1);
  const foreDir = _targetLocal.clone().sub(elbowPos).normalize();
  const foreSide = new THREE.Vector3().crossVectors(poleProj, foreDir).normalize();
  const foreUp = new THREE.Vector3().crossVectors(foreDir, foreSide).normalize();
  const foreWorldMat = new THREE.Matrix4().makeBasis(foreSide, foreUp, foreDir);

  // Convert foreWorldMat into UpperArm local space
  const upperInv = new THREE.Matrix4().copy(upperMat).invert();
  const foreLocalMat = upperInv.multiply(foreWorldMat);
  arm.forearm.quaternion.setFromRotationMatrix(foreLocalMat);

  // Set Palm orientation in Forearm local space so Palm matches `palmTargetQuatView` in ViewmodelRoot space!
  _q1.setFromRotationMatrix(foreWorldMat).invert();
  arm.palm.quaternion.copy(_q1).multiply(palmTargetQuatView);
}

/**
 * Applies smooth curl angles to all 5 fingers.
 */
export function applyFingerPose(arm: ArmRig, pose: FingerPose, lerpAlpha = 1.0): void {
  const keys: Array<keyof FingerPose> = ['thumb', 'index', 'middle', 'ring', 'pinky'];
  for (const k of keys) {
    const rig = arm.fingers[k];
    const [yaw, c1, c2, c3] = pose[k];
    // Curl is negative X rotation in finger local space (curling fingers down toward -Y palm!)
    const targetQ0 = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rig.baseEuler.x - c1, rig.baseEuler.y + yaw, rig.baseEuler.z)
    );
    const targetQ1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-c2, 0, 0));
    const targetQ2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-c3, 0, 0));

    if (lerpAlpha >= 1.0) {
      rig.bones[0].quaternion.copy(targetQ0);
      rig.bones[1].quaternion.copy(targetQ1);
      rig.bones[2].quaternion.copy(targetQ2);
    } else {
      rig.bones[0].quaternion.slerp(targetQ0, lerpAlpha);
      rig.bones[1].quaternion.slerp(targetQ1, lerpAlpha);
      rig.bones[2].quaternion.slerp(targetQ2, lerpAlpha);
    }
  }
}

// Trigger discipline: index extended cleanly along receiver/guard when idle; curled onto trigger when firing
export const M4_RIGHT_POSE: FingerPose = {
  thumb: [-0.25, 0.32, 0.55, 0.35],
  index: [-0.04, 0.08, 0.14, 0.10],
  middle: [0.0, 0.92, 1.08, 0.72],
  ring: [0.0, 0.96, 1.12, 0.75],
  pinky: [0.0, 0.98, 1.10, 0.72],
};

export const M4_RIGHT_FIRE_POSE: FingerPose = {
  thumb: [-0.25, 0.32, 0.55, 0.35],
  index: [0.05, 0.50, 0.68, 0.42],
  middle: [0.0, 0.92, 1.08, 0.72],
  ring: [0.0, 0.96, 1.12, 0.75],
  pinky: [0.0, 0.98, 1.10, 0.72],
};

export const M4_LEFT_POSE: FingerPose = {
  thumb: [0.18, 0.25, 0.35, 0.2], // C-clamp thumb forward along handguard rail cover
  index: [0.0, 0.65, 0.78, 0.52],
  middle: [0.0, 0.75, 0.88, 0.60],
  ring: [0.0, 0.78, 0.90, 0.62],
  pinky: [0.0, 0.76, 0.85, 0.58],
};

export const VERT_GRIP_LEFT_POSE: FingerPose = {
  thumb: [0.02, 0.28, 0.38, 0.24], // High thumb wrap resting atop vertical grip collar
  index: [0.0, 0.86, 1.05, 0.72],  // Wrapped tightly around vertical grip post
  middle: [0.0, 0.90, 1.08, 0.76],
  ring: [0.0, 0.92, 1.08, 0.76],
  pinky: [0.0, 0.88, 1.02, 0.72],
};

export const ANGLED_GRIP_LEFT_POSE: FingerPose = {
  thumb: [0.16, 0.20, 0.28, 0.16], // High thumb resting cleanly along upper handguard
  index: [0.0, 0.48, 0.62, 0.42],  // Fingers cradling 32-deg angled foregrip ramp
  middle: [0.0, 0.56, 0.72, 0.48],
  ring: [0.0, 0.60, 0.76, 0.52],
  pinky: [0.0, 0.62, 0.74, 0.50],
};

export const PISTOL_RIGHT_POSE: FingerPose = {
  thumb: [-0.15, 0.28, 0.45, 0.25],
  index: [-0.04, 0.08, 0.12, 0.08],
  middle: [0.0, 0.95, 1.12, 0.75],
  ring: [0.0, 0.98, 1.15, 0.78],
  pinky: [0.0, 1.0, 1.12, 0.75],
};

export const PISTOL_RIGHT_FIRE_POSE: FingerPose = {
  thumb: [-0.15, 0.28, 0.45, 0.25],
  index: [0.04, 0.46, 0.64, 0.40],
  middle: [0.0, 0.95, 1.12, 0.75],
  ring: [0.0, 0.98, 1.15, 0.78],
  pinky: [0.0, 1.0, 1.12, 0.75],
};

export const PISTOL_LEFT_POSE: FingerPose = {
  thumb: [0.12, 0.18, 0.22, 0.15], // Thumbs-forward tactical support grip
  index: [0.0, 0.85, 0.95, 0.68],
  middle: [0.0, 0.88, 0.98, 0.70],
  ring: [0.0, 0.90, 1.0, 0.72],
  pinky: [0.0, 0.90, 0.98, 0.70],
};

export const MAG_HOLD_POSE: FingerPose = {
  thumb: [-0.2, 0.48, 0.55, 0.35],
  index: [0.0, 0.72, 0.85, 0.55],
  middle: [0.0, 0.76, 0.88, 0.58],
  ring: [0.0, 0.76, 0.88, 0.58],
  pinky: [0.0, 0.72, 0.82, 0.55],
};

export class FirstPersonArmsSystem {
  public group = new THREE.Group();
  public leftArm: ArmRig;
  public rightArm: ArmRig;
  public triangleCount: number;

  constructor(textures: TextureLibrary) {
    this.group.name = 'FirstPersonArms';
    this.leftArm = buildSkinnedArm(true, textures);
    this.rightArm = buildSkinnedArm(false, textures);

    // Shoulder base positions in camera/viewmodel space (camera at 0,0,0, looking -Z, +X right, +Y up)
    this.leftArm.shoulder.position.set(-0.21, -0.24, -0.02);
    this.rightArm.shoulder.position.set(0.21, -0.24, -0.02);

    this.group.add(this.leftArm.root);
    this.group.add(this.rightArm.root);
    this.triangleCount = countTriangles(this.group);
  }
}
