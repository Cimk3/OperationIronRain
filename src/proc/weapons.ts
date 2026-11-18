import * as THREE from 'three';
import {
  createBeveledShape,
  createChamferedBox,
  createCheckeredGripPanel,
  createLatheZ,
  createPicatinnyRail,
  createSlottedFlashHider,
  ellipseProfile,
  loftRings,
  mergeParts,
  roundedRectProfile,
  sweepProfileAlongCurve,
  countTriangles,
} from './modeling';
import { createDefaultLoadoutSave } from '../gameplay/loadouts';
import { applyWeaponAttachments } from './attachments';
import { PBRTextureSet, TextureLibrary } from './textures';

export interface WeaponSockets {
  opticMountY: number;
  opticMountZ: number;
  ironSightY: number;
  muzzleMountY: number;
  muzzleMountZ: number;
  underMountY: number;
  underMountZ: number;
  sideMountX: number;
  sideMountY: number;
  sideMountZ: number;
}

export interface WeaponBuildResult {
  root: THREE.Group;
  magazine: THREE.Group;
  boltOrSlide: THREE.Object3D;
  chargingHandle?: THREE.Object3D;
  sideChargingHandle?: THREE.Object3D;
  hammer?: THREE.Object3D;
  muzzlePoint: THREE.Object3D;
  ejectPoint: THREE.Object3D;
  sightAlignOffset: THREE.Vector3; // local offset of sight axis (rear/front sight center)
  rightGripSocket: THREE.Object3D;
  leftGripSocket: THREE.Object3D;
  magSocket: THREE.Object3D;
  baseLeftGripPos: THREE.Vector3;
  currentGripStyle: 'none' | 'vertical' | 'angled';
  sockets: WeaponSockets;
  opticSlot: THREE.Group;
  muzzleSlot: THREE.Group;
  underSlot: THREE.Group;
  sideSlot: THREE.Group;
  ironSightsGroup?: THREE.Group;
  foldedRearSight?: THREE.Object3D;
  defaultFlashHider?: THREE.Object3D;
  defaultSuppressor?: THREE.Object3D;
  brakeExposedBarrel?: THREE.Object3D;
  fastMagLoop?: THREE.Object3D;
  extMagExtension?: THREE.Object3D;
  triangleCount: number;
}

function attachMagVariantMeshes(
  magGroup: THREE.Group,
  magW: number,
  magD: number,
  botY: number,
  botZ: number,
  tiltX: number,
  bodyMat: THREE.Material,
  rubberMat: THREE.Material
): { fastMagLoop: THREE.Group; extMagExtension: THREE.Group } {
  const fastMagLoop = new THREE.Group();
  const collar = new THREE.Mesh(
    createChamferedBox(magW + 0.005, 0.024, magD + 0.005, 0.0025, 2, 2),
    rubberMat
  );
  collar.rotation.x = tiltX;
  collar.position.set(0, botY + 0.006, botZ);
  fastMagLoop.add(collar);
  const loopRing = new THREE.Mesh(new THREE.TorusGeometry(0.017, 0.0042, 10, 20), rubberMat);
  loopRing.rotation.y = Math.PI * 0.5;
  loopRing.position.set(0, botY - 0.017, botZ + 0.004);
  fastMagLoop.add(loopRing);
  fastMagLoop.visible = false;
  magGroup.add(fastMagLoop);

  const extMagExtension = new THREE.Group();
  const extBody = new THREE.Mesh(
    createChamferedBox(magW + 0.004, 0.058, magD + 0.004, 0.003, 3, 3),
    bodyMat
  );
  extBody.rotation.x = tiltX;
  extBody.position.set(0, botY - 0.026, botZ + Math.sin(-tiltX) * 0.025);
  extMagExtension.add(extBody);
  const extBase = new THREE.Mesh(
    createChamferedBox(magW + 0.007, 0.012, magD + 0.008, 0.0025, 2, 2),
    rubberMat
  );
  extBase.rotation.x = tiltX;
  extBase.position.set(0, botY - 0.056, botZ + Math.sin(-tiltX) * 0.052);
  extMagExtension.add(extBase);
  extMagExtension.visible = false;
  magGroup.add(extMagExtension);

  return { fastMagLoop, extMagExtension };
}

/**
 * Enhances a MeshStandardMaterial with procedural edge-wear silvering & cavity AO
 * using vertex curvature attributes baked into `color`.
 */
export function createWeaponPBRMaterial(
  texSet: PBRTextureSet,
  options: {
    tint?: number;
    roughness?: number;
    metalness?: number;
    edgeWearColor?: THREE.Color;
    edgeWearStrength?: number;
    repeat?: number;
  } = {}
): THREE.MeshStandardMaterial {
  const rep = options.repeat ?? 2.2;
  const cloneTex = (t: THREE.DataTexture) => {
    const c = t.clone();
    c.repeat.set(rep, rep);
    c.needsUpdate = true;
    return c;
  };

  const mat = new THREE.MeshStandardMaterial({
    color: options.tint ?? 0xffffff,
    map: cloneTex(texSet.map),
    normalMap: cloneTex(texSet.normalMap),
    normalScale: new THREE.Vector2(1.48, 1.48),
    roughnessMap: cloneTex(texSet.roughnessMap),
    metalnessMap: texSet.metalnessMap ? cloneTex(texSet.metalnessMap) : undefined,
    aoMap: cloneTex(texSet.aoMap),
    aoMapIntensity: 0.92,
    roughness: options.roughness ?? 1.0,
    metalness: options.metalness ?? (texSet.metalnessMap ? 1.0 : 0.08),
    envMapIntensity: 0.85,
    vertexColors: true,
  });

  const wearColor = options.edgeWearColor ?? new THREE.Color(0.56, 0.60, 0.64);
  const wearStrength = options.edgeWearStrength ?? 0.62;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWearColor = { value: wearColor };
    shader.uniforms.uWearStrength = { value: wearStrength };

    shader.vertexShader =
      `
      varying vec3 vWeapLocalPos;
      varying vec3 vWeapLocalNorm;
      ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      vWeapLocalPos = position;
      vWeapLocalNorm = normalize(objectNormal);
      `
    );

    shader.fragmentShader =
      `
      uniform vec3 uWearColor;
      uniform float uWearStrength;
      varying vec3 vWeapLocalPos;
      varying vec3 vWeapLocalNorm;

      // Procedural Raindrop Bead Synthesis on upward weapon surfaces
      vec3 evalRainDroplets(vec3 p, vec3 n) {
        float topMask = smoothstep(0.18, 0.82, n.y);
        if (topMask < 0.01) return vec3(0.0);
        vec2 uv1 = p.xz * 135.0;
        vec2 cell = floor(uv1);
        vec2 f = fract(uv1) - 0.5;
        float h1 = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
        float h2 = fract(sin(dot(cell, vec2(269.5, 183.3))) * 43758.5453);
        float exists = step(0.46, h1);
        vec2 center = (vec2(h1, h2) - 0.5) * 0.42;
        vec2 d = f - center;
        float r = 0.16 + h2 * 0.14;
        float dist = length(d);
        if (dist < r && exists > 0.5) {
          float beadH = sqrt(max(0.0, 1.0 - (dist / r) * (dist / r)));
          vec2 grad = -d / max(0.001, r);
          return vec3(grad.x * topMask, grad.y * topMask, topMask * beadH);
        }
        return vec3(0.0);
      }
      ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      float vEdgeWear = smoothstep(0.36, 0.88, vColor.r) * uWearStrength;
      float vCavityAO = clamp(vColor.g, 0.35, 1.0);
      diffuseColor.rgb *= mix(0.62, 1.08, vCavityAO);
      diffuseColor.rgb = mix(diffuseColor.rgb, uWearColor, vEdgeWear * 0.82);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `
      #include <roughnessmap_fragment>
      float wMask = smoothstep(0.36, 0.88, vColor.r) * uWearStrength;
      roughnessFactor = mix(roughnessFactor, 0.16, wMask * 0.90);
      vec3 dropInfoR = evalRainDroplets(vWeapLocalPos, normalize(vWeapLocalNorm));
      // Micro-raindrop beads are pure mirror water (roughness = 0.02); damp film lowers roughness slightly
      roughnessFactor = mix(roughnessFactor, 0.02, clamp(dropInfoR.z * 1.4, 0.0, 1.0));
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      `
      #include <metalnessmap_fragment>
      float mWear = smoothstep(0.36, 0.88, vColor.r) * uWearStrength;
      metalnessFactor = mix(metalnessFactor, 0.98, mWear * 0.88);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `
      #include <normal_fragment_maps>
      vec3 dropN = evalRainDroplets(vWeapLocalPos, normalize(vWeapLocalNorm));
      if (dropN.z > 0.01) {
        normal = normalize(normal + vec3(dropN.x * 0.75, dropN.y * 0.75, 0.0));
      }
      `
    );
  };
  mat.customProgramCacheKey = () => `weapon-rain-wear-${wearStrength.toFixed(2)}`;
  return mat;
}

/**
 * Builds high-detail procedural M4A1 SOPMOD Assault Rifle (>= 15,000 triangles).
 * Coordinate convention: +Z = forward toward muzzle, +Y = up, +X = right.
 * Receiver center around (0, 0, 0).
 */
export function buildM4A1(textures: TextureLibrary): WeaponBuildResult {
  const root = new THREE.Group();
  root.name = 'M4A1_Root';

  const metalMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0xd0d4da,
    edgeWearStrength: 0.82,
    repeat: 2.5,
  });
  const darkSteelMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0x8e959e,
    edgeWearStrength: 0.72,
    repeat: 3.0,
  });
  const polymerMat = createWeaponPBRMaterial(textures.gunPolymer, {
    tint: 0xd0d4d8,
    metalness: 0.04,
    roughness: 0.86,
    edgeWearColor: new THREE.Color(0.20, 0.21, 0.22),
    edgeWearStrength: 0.25,
    repeat: 6.0,
  });

  // Sight centerline Y above receiver center (EOTech Holographic reticle + co-witnessed sights!)
  const SIGHT_Y = 0.072;

  // 1. UPPER & LOWER RECEIVER
  const upperParts: THREE.BufferGeometry[] = [];
  // Upper receiver main housing (sculpted chamfered profile)
  const upperMain = createChamferedBox(0.036, 0.044, 0.195, 0.0038, 4, 4);
  upperMain.translate(0, 0.014, 0.0);
  upperParts.push(upperMain);

  // Upper receiver curved top shoulder (cylindrical bore arch)
  const boreArch = createLatheZ(
    [
      [0.0175, -0.097],
      [0.0185, -0.094],
      [0.0185, 0.095],
      [0.0175, 0.098],
    ],
    28
  );
  boreArch.translate(0, 0.022, 0);
  upperParts.push(boreArch);

  // Brass deflector wedge on ejection side (-X in weapon local = +X Camera Right after rotY=PI)
  const deflectorShape = new THREE.Shape();
  deflectorShape.moveTo(0, 0);
  deflectorShape.lineTo(0.016, 0.006);
  deflectorShape.lineTo(0.012, 0.024);
  deflectorShape.lineTo(0, 0.022);
  deflectorShape.closePath();
  const deflector = createBeveledShape(deflectorShape, 0.026, 0.0018, 3, 4);
  deflector.rotateY(-Math.PI * 0.5);
  deflector.translate(-0.02, 0.012, -0.028);
  upperParts.push(deflector);

  // Forward assist cylindrical housing + plunger button
  const faHousing = createLatheZ(
    [
      [0.001, -0.035],
      [0.0072, -0.035],
      [0.0072, 0.012],
      [0.0062, 0.016],
      [0.001, 0.016],
    ],
    20
  );
  faHousing.rotateY(-0.28);
  faHousing.translate(-0.021, 0.009, -0.056);
  upperParts.push(faHousing);

  const faPlunger = createLatheZ(
    [
      [0.001, -0.044],
      [0.006, -0.044],
      [0.006, -0.034],
      [0.001, -0.034],
    ],
    20
  );
  faPlunger.rotateY(-0.28);
  faPlunger.translate(-0.021, 0.009, -0.056);
  upperParts.push(faPlunger);

  // Dust cover (open downward on ejection side) + hinge rod
  const dustCover = createChamferedBox(0.003, 0.018, 0.068, 0.0009, 2, 2);
  dustCover.rotateZ(1.35);
  dustCover.translate(-0.023, 0.004, 0.024);
  upperParts.push(dustCover);

  // Top Picatinny Rail on Upper Receiver (17 teeth)
  const upperRail = createPicatinnyRail(0.185, 0.0212, 0.0085, 0.010);
  upperRail.translate(0, 0.036, 0.0);
  upperParts.push(upperRail);

  // Lower Receiver body + magwell + trigger guard
  const lowerShape = new THREE.Shape();
  lowerShape.moveTo(-0.095, -0.012);
  lowerShape.lineTo(0.025, -0.012);
  lowerShape.lineTo(0.030, -0.058); // Magwell rear
  lowerShape.lineTo(0.095, -0.055); // Magwell front
  lowerShape.lineTo(0.098, -0.008);
  lowerShape.lineTo(0.095, 0.006);
  lowerShape.lineTo(-0.095, 0.006);
  lowerShape.closePath();

  const lowerBody = createBeveledShape(lowerShape, 0.034, 0.0028, 3, 6);
  lowerBody.rotateY(-Math.PI * 0.5); // shape X -> +Z
  upperParts.push(lowerBody);

  // Flared magwell collar rim
  const magwellRim = createChamferedBox(0.041, 0.013, 0.072, 0.0025, 3, 3);
  magwellRim.translate(0, -0.052, 0.062);
  upperParts.push(magwellRim);

  // Curved Winter Trigger Guard
  const tgCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.012, -0.026),
    new THREE.Vector3(0, -0.037, -0.021),
    new THREE.Vector3(0, -0.041, 0.002),
    new THREE.Vector3(0, -0.034, 0.024),
    new THREE.Vector3(0, -0.016, 0.029),
  ]);
  const tgGeo = sweepProfileAlongCurve(tgCurve, roundedRectProfile(0.007, 0.006, 0.002, 3), 20, undefined, true);
  upperParts.push(tgGeo);

  // Curved Trigger
  const trigCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.008, -0.002),
    new THREE.Vector3(0, -0.022, -0.001),
    new THREE.Vector3(0, -0.031, 0.004),
  ]);
  const triggerGeo = sweepProfileAlongCurve(trigCurve, roundedRectProfile(0.005, 0.004, 0.0015, 2), 12, undefined, true);
  upperParts.push(triggerGeo);

  // Selector Switch (left side = +X weapon local -> -X Camera Left) + Takedown Pins
  const selector = createChamferedBox(0.006, 0.007, 0.022, 0.0012, 2, 2);
  selector.rotateX(0.5);
  selector.translate(0.02, -0.006, -0.056);
  upperParts.push(selector);

  for (const pz of [-0.082, 0.088]) {
    const pin = createChamferedBox(0.040, 0.0065, 0.0065, 0.0015, 2, 2);
    pin.translate(0, -0.004, pz);
    upperParts.push(pin);
  }

  // 2. FREE-FLOAT QUAD-RAIL HANDGUARD
  const hgLength = 0.235;
  const hgStartZ = 0.102;
  const hgCenterZ = hgStartZ + hgLength * 0.5;

  // Barrel nut delta collar
  const barrelNut = createLatheZ(
    [
      [0.017, 0.092],
      [0.0235, 0.095],
      [0.0235, 0.108],
      [0.021, 0.112],
      [0.017, 0.112],
    ],
    28
  );
  upperParts.push(barrelNut);

  // Handguard Octagonal Ribbed Shroud (built from rings with recessed cooling windows!)
  const ringCount = 9;
  for (let r = 0; r < ringCount; r++) {
    const rz = hgStartZ + 0.012 + (r / (ringCount - 1)) * (hgLength - 0.024);
    const ribRing = createLatheZ(
      [
        [0.018, rz - 0.007],
        [0.0228, rz - 0.006],
        [0.0228, rz + 0.006],
        [0.018, rz + 0.007],
      ],
      24
    );
    ribRing.translate(0, 0.016, 0);
    upperParts.push(ribRing);
  }

  // 4 Longitudinal Structural Bridges of Handguard (45 deg diagonals)
  for (const ang of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
    const bridge = createChamferedBox(0.011, 0.008, hgLength, 0.0018, 2, 2);
    bridge.rotateZ(ang);
    bridge.translate(Math.cos(ang) * 0.021, 0.016 + Math.sin(ang) * 0.021, hgCenterZ);
    upperParts.push(bridge);
  }

  // 4 MIL-STD-1913 Picatinny Rails on Handguard (Top, Bottom, Left, Right) -> dense realistic teeth!
  const topHgRail = createPicatinnyRail(hgLength, 0.0212, 0.0085, 0.010);
  topHgRail.translate(0, 0.036, hgCenterZ);
  upperParts.push(topHgRail);

  const botHgRail = createPicatinnyRail(hgLength * 0.92, 0.020, 0.0075, 0.0105);
  botHgRail.rotateZ(Math.PI);
  botHgRail.translate(0, -0.006, hgCenterZ);
  upperParts.push(botHgRail);

  const leftHgRail = createPicatinnyRail(hgLength * 0.88, 0.019, 0.007, 0.011);
  leftHgRail.rotateZ(Math.PI * 0.5);
  leftHgRail.translate(-0.023, 0.016, hgCenterZ);
  upperParts.push(leftHgRail);

  const rightHgRail = createPicatinnyRail(hgLength * 0.88, 0.019, 0.007, 0.011);
  rightHgRail.rotateZ(-Math.PI * 0.5);
  rightHgRail.translate(0.023, 0.016, hgCenterZ);
  upperParts.push(rightHgRail);

  // 3. FOLDED BACKUP REAR SIGHT + DETACHABLE IRON SIGHTS + FRONT POST
  // Low-profile folded backup rear sight (shown when Red Dot / Holo optic is mounted!)
  const rearSightZ = -0.078;
  const rearBase = createChamferedBox(0.026, 0.009, 0.030, 0.002, 2, 2);
  rearBase.translate(0, 0.046, rearSightZ);
  const foldedRearSight = new THREE.Mesh(mergeParts([rearBase], false), darkSteelMat);
  root.add(foldedRearSight);

  // Upright Iron Sights Group (rear flip-up peep + tall co-witness front post, shown when optic === 'iron')
  const ironSightsGroup = new THREE.Group();
  const rearUpParts: THREE.BufferGeometry[] = [];
  const peepBase = createChamferedBox(0.026, 0.012, 0.028, 0.002, 2, 2);
  peepBase.translate(0, 0.048, rearSightZ);
  rearUpParts.push(peepBase);
  for (const sx of [-0.010, 0.010]) {
    const ear = createChamferedBox(0.0045, 0.024, 0.016, 0.001, 2, 2);
    ear.translate(sx, 0.064, rearSightZ);
    rearUpParts.push(ear);
  }
  const peepBridge = createChamferedBox(0.022, 0.005, 0.012, 0.001, 2, 2);
  peepBridge.translate(0, 0.074, rearSightZ);
  rearUpParts.push(peepBridge);

  const frontSightZ = 0.322;
  const frontBase = createChamferedBox(0.024, 0.011, 0.028, 0.002, 2, 2);
  frontBase.translate(0, 0.047, frontSightZ);
  rearUpParts.push(frontBase);
  for (const sx of [-0.0095, 0.0095]) {
    const ear = createChamferedBox(0.0038, 0.020, 0.018, 0.001, 2, 2);
    ear.rotateZ(sx > 0 ? 0.12 : -0.12);
    ear.translate(sx, 0.060, frontSightZ);
    rearUpParts.push(ear);
  }
  const frontPost = createChamferedBox(0.0022, 0.015, 0.003, 0.0005, 2, 2);
  frontPost.translate(0, SIGHT_Y - 0.008, frontSightZ);
  rearUpParts.push(frontPost);
  ironSightsGroup.add(new THREE.Mesh(mergeParts(rearUpParts, true), darkSteelMat));
  root.add(ironSightsGroup);

  // Modular Attachment Slots
  const opticSlot = new THREE.Group();
  const muzzleSlot = new THREE.Group();
  const underSlot = new THREE.Group();
  const sideSlot = new THREE.Group();
  root.add(opticSlot, muzzleSlot, underSlot, sideSlot);

  // 4. BARREL, GAS BLOCK, & DETACHABLE A2 FLASH HIDER
  const barrelParts: THREE.BufferGeometry[] = [];
  const barrelProfile: Array<[number, number]> = [
    [0.012, 0.105],
    [0.0105, 0.25],
    [0.013, 0.26],
    [0.013, 0.295], // Gas block journal
    [0.0095, 0.305],
    [0.0095, 0.375],
    [0.0082, 0.382], // M203 step-down
    [0.0092, 0.398],
    [0.0092, 0.435],
    [0.0075, 0.437],
  ];
  const barrelGeo = createLatheZ(barrelProfile, 32);
  barrelGeo.translate(0, 0.016, 0);
  barrelParts.push(barrelGeo);

  // Low-profile gas block + gas tube
  const gasBlock = createChamferedBox(0.022, 0.026, 0.032, 0.0025, 2, 2);
  gasBlock.translate(0, 0.020, 0.278);
  barrelParts.push(gasBlock);

  const gasTube = createLatheZ(
    [
      [0.0026, 0.095],
      [0.0026, 0.275],
    ],
    14
  );
  gasTube.translate(0, 0.031, 0);
  barrelParts.push(gasTube);

  // Detachable Slotted A2 Birdcage Flash Hider at tip (z = 0.436)
  const flashHiderGeo = createSlottedFlashHider(0.0112, 0.0062, 0.048, 5, 6);
  flashHiderGeo.translate(0, 0.016, 0.436);
  const defaultFlashHider = new THREE.Mesh(mergeParts([flashHiderGeo], true), darkSteelMat);
  defaultFlashHider.castShadow = true;
  root.add(defaultFlashHider);

  // Buffer tube + Castle Nut
  const bufferTube = createLatheZ(
    [
      [0.0165, -0.235],
      [0.0165, -0.102],
      [0.0195, -0.102],
      [0.0195, -0.092],
      [0.0155, -0.092],
    ],
    28
  );
  bufferTube.translate(0, 0.012, 0);
  upperParts.push(bufferTube);

  const receiverMesh = new THREE.Mesh(mergeParts(upperParts, true), metalMat);
  receiverMesh.castShadow = true;
  receiverMesh.receiveShadow = true;
  root.add(receiverMesh);

  const barrelMesh = new THREE.Mesh(mergeParts(barrelParts, true), darkSteelMat);
  barrelMesh.castShadow = true;
  barrelMesh.receiveShadow = true;
  root.add(barrelMesh);

  // 5. ANIMATED BOLT CARRIER (inside ejection port) & CHARGING HANDLE
  const boltGeo = createChamferedBox(0.016, 0.018, 0.068, 0.0015, 2, 2);
  const boltCarrier = new THREE.Mesh(mergeParts([boltGeo], true), darkSteelMat);
  boltCarrier.position.set(-0.004, 0.016, 0.022);
  root.add(boltCarrier);

  const chTBar = createChamferedBox(0.028, 0.0065, 0.011, 0.0014, 2, 2);
  const chStem = createChamferedBox(0.010, 0.006, 0.075, 0.001, 2, 2);
  chStem.translate(0, 0, 0.038);
  const chargingHandle = new THREE.Mesh(mergeParts([chTBar, chStem], true), darkSteelMat);
  chargingHandle.position.set(0, 0.029, -0.104);
  root.add(chargingHandle);

  // 6. POLYMER PARTS: ERGONOMIC PISTOL GRIP, RAIL COVERS & SOPMOD BUTTSTOCK
  const polyParts: THREE.BufferGeometry[] = [];

  // Ergonomic Swept Pistol Grip (lofts along curved grip spine!)
  const gripCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.012, -0.056),
    new THREE.Vector3(0, -0.044, -0.068),
    new THREE.Vector3(0, -0.078, -0.081),
    new THREE.Vector3(0, -0.108, -0.092),
  ]);
  const gripGeo = sweepProfileAlongCurve(
    gripCurve,
    ellipseProfile(0.0145, 0.0205, 24),
    24,
    (t, ang) => {
      // Finger swell on front (+Z -> around angle 0/PI depending on Frenet) + palm swell
      const swell = 1.0 + Math.sin(t * Math.PI) * 0.14;
      const flare = t > 0.85 ? 1.0 + (t - 0.85) * 0.7 : 1.0;
      const rib = Math.sin(t * 28.0) * 0.025 * Math.max(0, Math.cos(ang));
      return { sx: swell * flare + rib, sy: swell * flare };
    },
    true
  );
  polyParts.push(gripGeo);

  // SOPMOD Collapsible Buttstock (collapsed CQB position)
  const stockShape = new THREE.Shape();
  stockShape.moveTo(-0.085, 0.026);
  stockShape.lineTo(0.045, 0.024);
  stockShape.lineTo(0.042, -0.016);
  stockShape.lineTo(-0.035, -0.024);
  stockShape.lineTo(-0.085, -0.085);
  stockShape.closePath();
  const stockBody = createBeveledShape(stockShape, 0.040, 0.0055, 4, 8);
  stockBody.rotateY(-Math.PI * 0.5);
  stockBody.translate(0, 0.004, -0.185);
  polyParts.push(stockBody);

  // Stock Cheek-weld tubes (SOPMOD saddle lobes)
  for (const sx of [-0.018, 0.018]) {
    const lobe = createLatheZ(
      [
        [0.002, -0.265],
        [0.013, -0.260],
        [0.015, -0.155],
        [0.002, -0.145],
      ],
      20
    );
    lobe.translate(sx, 0.012, 0);
    polyParts.push(lobe);
  }

  // Ribbed Rubber Buttpad
  const buttPad = createChamferedBox(0.042, 0.108, 0.014, 0.004, 3, 3);
  buttPad.translate(0, -0.024, -0.275);
  polyParts.push(buttPad);

  // Side Polymer Rail Cover Panels (classic MW4 look!)
  for (const sx of [-0.029, 0.029]) {
    const cover = createChamferedBox(0.0055, 0.021, 0.145, 0.0018, 2, 2);
    cover.translate(sx, 0.016, 0.215);
    polyParts.push(cover);
  }

  const polymerMesh = new THREE.Mesh(mergeParts(polyParts, true), polymerMat);
  polymerMesh.castShadow = true;
  polymerMesh.receiveShadow = true;
  root.add(polymerMesh);

  // 7. DETACHABLE STANAG 30-ROUND CURVED MAGAZINE (with Fast Pull-Loop & Extended Mag variants!)
  const magGroup = new THREE.Group();
  magGroup.name = 'M4A1_Magazine';
  magGroup.position.set(0, -0.048, 0.062);

  const magParts: THREE.BufferGeometry[] = [];
  const magCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.032, 0),
    new THREE.Vector3(0, -0.038, 0.002),
    new THREE.Vector3(0, -0.105, 0.012),
    new THREE.Vector3(0, -0.155, 0.026),
  ]);
  const magBody = sweepProfileAlongCurve(
    magCurve,
    roundedRectProfile(0.024, 0.062, 0.004, 3),
    22,
    (t) => {
      const rib = t > 0.25 && t < 0.88 ? Math.max(0, Math.sin(t * 42)) * 0.06 : 0;
      return { sx: 1 + rib, sy: 1 };
    },
    true
  );
  magParts.push(magBody);

  const magFloorplate = createChamferedBox(0.028, 0.012, 0.068, 0.0022, 2, 2);
  magFloorplate.rotateX(-0.24);
  magFloorplate.translate(0, -0.158, 0.027);
  magParts.push(magFloorplate);

  const magMesh = new THREE.Mesh(mergeParts(magParts, true), darkSteelMat);
  magMesh.castShadow = true;
  magMesh.receiveShadow = true;
  magGroup.add(magMesh);
  const m4MagVars = attachMagVariantMeshes(magGroup, 0.025, 0.064, -0.156, 0.027, -0.24, darkSteelMat, polymerMat);
  root.add(magGroup);

  // 8. EXACT SOCKETS FOR HANDS, MUZZLE, EJECTION, MAGWELL & ATTACHMENTS
  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0.016, 0.49);
  root.add(muzzlePoint);

  const ejectPoint = new THREE.Object3D();
  ejectPoint.position.set(-0.022, 0.016, 0.022);
  root.add(ejectPoint);

  const rightGripSocket = new THREE.Object3D();
  rightGripSocket.position.set(0, -0.056, -0.072);
  root.add(rightGripSocket);

  const baseLeftGripPos = new THREE.Vector3(0.012, -0.016, 0.205);
  const leftGripSocket = new THREE.Object3D();
  leftGripSocket.position.copy(baseLeftGripPos);
  root.add(leftGripSocket);

  const magSocket = new THREE.Object3D();
  magSocket.position.set(0, -0.048, 0.062);
  root.add(magSocket);

  const m4Sockets: WeaponSockets = {
    opticMountY: 0.0445,
    opticMountZ: 0.018,
    ironSightY: SIGHT_Y,
    muzzleMountY: 0.016,
    muzzleMountZ: 0.436,
    underMountY: -0.013,
    underMountZ: 0.215,
    sideMountX: -0.034,
    sideMountY: 0.016,
    sideMountZ: 0.285,
  };

  const result: WeaponBuildResult = {
    root,
    magazine: magGroup,
    boltOrSlide: boltCarrier,
    chargingHandle,
    muzzlePoint,
    ejectPoint,
    sightAlignOffset: new THREE.Vector3(0, SIGHT_Y, 0),
    rightGripSocket,
    leftGripSocket,
    magSocket,
    baseLeftGripPos,
    currentGripStyle: 'none',
    sockets: m4Sockets,
    opticSlot,
    muzzleSlot,
    underSlot,
    sideSlot,
    ironSightsGroup,
    foldedRearSight,
    defaultFlashHider,
    fastMagLoop: m4MagVars.fastMagLoop,
    extMagExtension: m4MagVars.extMagExtension,
    triangleCount: 0,
  };
  applyWeaponAttachments('m4a1', result, createDefaultLoadoutSave().configs.m4a1, textures);
  result.triangleCount = countTriangles(root);
  return result;
}

/**
 * Builds high-detail procedural M1911 Tactical Pistol (>= 8,000 triangles).
 */
export function buildM1911(textures: TextureLibrary): WeaponBuildResult {
  const root = new THREE.Group();
  root.name = 'M1911_Root';

  const steelMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0xb6bec8,
    edgeWearStrength: 0.85,
    repeat: 2.0,
  });
  const stainlessMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0xdfe4ea,
    roughness: 0.35,
    metalness: 0.96,
    edgeWearStrength: 0.5,
    repeat: 2.0,
  });
  const walnutMat = createWeaponPBRMaterial(textures.walnutWood, {
    tint: 0xd8a882,
    metalness: 0.02,
    roughness: 0.62,
    edgeWearColor: new THREE.Color(0.45, 0.28, 0.16),
    edgeWearStrength: 0.4,
    repeat: 1.5,
  });

  const SIGHT_Y = 0.0365;

  // 1. FRAME & BEAVERTAIL & DUST COVER & TRIGGER GUARD
  const frameParts: THREE.BufferGeometry[] = [];
  const frameShape = new THREE.Shape();
  frameShape.moveTo(-0.068, 0.008);
  frameShape.lineTo(0.088, 0.008);
  frameShape.lineTo(0.088, -0.008);
  frameShape.lineTo(0.035, -0.008);
  frameShape.lineTo(0.026, -0.015);
  frameShape.lineTo(0.018, -0.035); // Front strap
  frameShape.lineTo(-0.010, -0.112); // Grip bottom front
  frameShape.lineTo(-0.056, -0.104); // Grip bottom rear
  frameShape.lineTo(-0.036, -0.015);
  frameShape.lineTo(-0.066, 0.002); // Beavertail curve
  frameShape.closePath();

  const frameBody = createBeveledShape(frameShape, 0.024, 0.0025, 3, 8);
  frameBody.rotateY(-Math.PI * 0.5);
  frameParts.push(frameBody);

  // Under-barrel Picatinny rail (3 teeth)
  const underRail = createPicatinnyRail(0.042, 0.019, 0.006, 0.011);
  underRail.rotateZ(Math.PI);
  underRail.translate(0, -0.009, 0.062);
  frameParts.push(underRail);

  // Curved Trigger Guard
  const tgCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.008, -0.014),
    new THREE.Vector3(0, -0.032, -0.009),
    new THREE.Vector3(0, -0.035, 0.012),
    new THREE.Vector3(0, -0.026, 0.027),
    new THREE.Vector3(0, -0.008, 0.028),
  ]);
  frameParts.push(
    sweepProfileAlongCurve(tgCurve, roundedRectProfile(0.0065, 0.0055, 0.0018, 3), 20, undefined, true)
  );

  // Trigger + Thumb Safety + Slide Stop
  const trigger = createChamferedBox(0.006, 0.016, 0.010, 0.0015, 2, 2);
  trigger.translate(0, -0.017, 0.004);
  frameParts.push(trigger);

  const thumbSafety = createChamferedBox(0.005, 0.007, 0.022, 0.0012, 2, 2);
  thumbSafety.translate(0.014, 0.004, -0.046);
  frameParts.push(thumbSafety);

  const slideStop = createChamferedBox(0.0045, 0.006, 0.032, 0.0012, 2, 2);
  slideStop.translate(0.014, 0.005, 0.008);
  frameParts.push(slideStop);

  // Grip Mainspring Housing (arched backstrap)
  const msh = createChamferedBox(0.018, 0.072, 0.014, 0.003, 3, 3);
  msh.rotateX(-0.34);
  msh.translate(0, -0.064, -0.046);
  frameParts.push(msh);

  const frameMesh = new THREE.Mesh(mergeParts(frameParts, true), steelMat);
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  root.add(frameMesh);

  // 2. EXPOSED STAINLESS BARREL & MUZZLE BUSHING
  const barrelParts: THREE.BufferGeometry[] = [];
  const barrel = createLatheZ(
    [
      [0.0055, -0.02],
      [0.0076, -0.02],
      [0.0076, 0.098],
      [0.0055, 0.100],
    ],
    28
  );
  barrel.translate(0, 0.019, 0);
  barrelParts.push(barrel);

  const bushing = createLatheZ(
    [
      [0.0076, 0.088],
      [0.0105, 0.088],
      [0.0105, 0.097],
      [0.0076, 0.097],
    ],
    28
  );
  bushing.translate(0, 0.019, 0);
  barrelParts.push(bushing);

  const barrelMesh = new THREE.Mesh(mergeParts(barrelParts, true), stainlessMat);
  barrelMesh.castShadow = true;
  root.add(barrelMesh);

  // 3. SLIDE (with angled serrations, rounded top, sights, and blowback animation!)
  const slideGroup = new THREE.Group();
  slideGroup.name = 'M1911_Slide';
  const slideParts: THREE.BufferGeometry[] = [];

  // Rounded-arch slide profile swept along Z
  const slideCurve = new THREE.LineCurve3(
    new THREE.Vector3(0, 0.019, -0.066),
    new THREE.Vector3(0, 0.019, 0.094)
  );
  const slideProfile = roundedRectProfile(0.0245, 0.023, 0.0075, 5);
  const slideMain = sweepProfileAlongCurve(slideCurve, slideProfile, 24, undefined, true);
  slideParts.push(slideMain);

  // Angled Rear & Front Cocking Serrations (raised machined ribs!)
  for (let i = 0; i < 8; i++) {
    for (const sx of [-0.0124, 0.0124]) {
      const rib = createChamferedBox(0.0018, 0.014, 0.0022, 0.0005, 2, 2);
      rib.rotateX(-0.22);
      rib.translate(sx, 0.019, -0.056 + i * 0.0044);
      slideParts.push(rib);
    }
  }
  for (let i = 0; i < 6; i++) {
    for (const sx of [-0.0124, 0.0124]) {
      const rib = createChamferedBox(0.0018, 0.013, 0.0022, 0.0005, 2, 2);
      rib.rotateX(-0.22);
      rib.translate(sx, 0.019, 0.054 + i * 0.0044);
      slideParts.push(rib);
    }
  }

  // Rear Novak Sight (two flanking blocks creating a precision center notch at X=0, Y=SIGHT_Y)
  for (const sx of [-0.0048, 0.0048]) {
    const post = createChamferedBox(0.0054, 0.0062, 0.014, 0.001, 2, 2);
    post.translate(sx, SIGHT_Y - 0.0028, -0.054);
    slideParts.push(post);
  }
  // Front Blade Sight (tip exactly at X=0, Y=SIGHT_Y)
  const frontBlade = createChamferedBox(0.0024, 0.0062, 0.011, 0.0006, 2, 2);
  frontBlade.translate(0, SIGHT_Y - 0.0028, 0.084);
  slideParts.push(frontBlade);

  const slideMesh = new THREE.Mesh(mergeParts(slideParts, true), steelMat);
  slideMesh.castShadow = true;
  slideMesh.receiveShadow = true;
  slideGroup.add(slideMesh);
  root.add(slideGroup);

  // 4. SKELETONIZED HAMMER
  const hammerGroup = new THREE.Group();
  hammerGroup.position.set(0, 0.006, -0.064);
  const hammerShape = new THREE.Shape();
  hammerShape.moveTo(0, 0);
  hammerShape.lineTo(-0.014, 0.006);
  hammerShape.lineTo(-0.018, 0.014);
  hammerShape.lineTo(-0.007, 0.016);
  hammerShape.lineTo(0.002, 0.006);
  hammerShape.closePath();
  const hammerGeo = createBeveledShape(hammerShape, 0.0055, 0.0009, 2, 4);
  hammerGeo.rotateY(-Math.PI * 0.5);
  const hammerMesh = new THREE.Mesh(mergeParts([hammerGeo], true), stainlessMat);
  hammerGroup.add(hammerMesh);
  root.add(hammerGroup);

  // 5. DIAMOND-CHECKERED WALNUT GRIP PANELS (Left & Right)
  const leftPanel = createCheckeredGripPanel(0.032, 0.078, 0.0055, 13, 22);
  leftPanel.rotateY(-Math.PI * 0.5);
  leftPanel.rotateX(0.32);
  leftPanel.translate(-0.0135, -0.058, -0.025);

  const rightPanel = createCheckeredGripPanel(0.032, 0.078, 0.0055, 13, 22);
  rightPanel.rotateY(Math.PI * 0.5);
  rightPanel.rotateX(0.32);
  rightPanel.translate(0.0135, -0.058, -0.025);

  const gripMesh = new THREE.Mesh(mergeParts([leftPanel, rightPanel], true), walnutMat);
  gripMesh.castShadow = true;
  gripMesh.receiveShadow = true;
  root.add(gripMesh);

  // 6. DETACHABLE MAGAZINE
  const magGroup = new THREE.Group();
  magGroup.name = 'M1911_Magazine';
  magGroup.position.set(0, -0.056, -0.025);
  const magParts: THREE.BufferGeometry[] = [];
  const magTube = createChamferedBox(0.014, 0.095, 0.030, 0.0018, 2, 2);
  magTube.rotateX(-0.32);
  magParts.push(magTube);
  const basePad = createChamferedBox(0.020, 0.010, 0.038, 0.002, 2, 2);
  basePad.rotateX(-0.32);
  basePad.translate(0, -0.050, -0.016);
  magParts.push(basePad);

  const magMesh = new THREE.Mesh(mergeParts(magParts, true), stainlessMat);
  magGroup.add(magMesh);
  root.add(magGroup);

  // 7. SOCKETS
  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0.019, 0.105);
  root.add(muzzlePoint);

  const ejectPoint = new THREE.Object3D();
  ejectPoint.position.set(-0.013, 0.024, 0.018);
  root.add(ejectPoint);

  const rightGripSocket = new THREE.Object3D();
  rightGripSocket.position.set(0, -0.052, -0.022);
  root.add(rightGripSocket);

  const leftGripSocket = new THREE.Object3D();
  leftGripSocket.position.set(0.014, -0.055, -0.016);
  root.add(leftGripSocket);

  const magSocket = new THREE.Object3D();
  magSocket.position.set(0, -0.056, -0.025);
  root.add(magSocket);

  const baseLeftGripPos = leftGripSocket.position.clone();
  const triangleCount = countTriangles(root);
  return {
    root,
    magazine: magGroup,
    boltOrSlide: slideGroup,
    hammer: hammerGroup,
    muzzlePoint,
    ejectPoint,
    sightAlignOffset: new THREE.Vector3(0, SIGHT_Y, 0),
    rightGripSocket,
    leftGripSocket,
    magSocket,
    baseLeftGripPos,
    currentGripStyle: 'none',
    sockets: {
      opticMountY: SIGHT_Y,
      opticMountZ: 0,
      ironSightY: SIGHT_Y,
      muzzleMountY: 0.019,
      muzzleMountZ: 0.105,
      underMountY: -0.012,
      underMountZ: 0.06,
      sideMountX: 0,
      sideMountY: 0,
      sideMountZ: 0,
    },
    opticSlot: new THREE.Group(),
    muzzleSlot: new THREE.Group(),
    underSlot: new THREE.Group(),
    sideSlot: new THREE.Group(),
    triangleCount,
  };
}

/**
 * Builds high-detail procedural MP5SD Integrally Suppressed SMG (>= 12,000 triangles).
 */
export function buildMP5SD(textures: TextureLibrary): WeaponBuildResult {
  const root = new THREE.Group();
  root.name = 'MP5SD_Root';

  const stampedSteelMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0xc2c8d0,
    edgeWearStrength: 0.78,
    repeat: 2.8,
  });
  const suppressorMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0x868d96,
    edgeWearStrength: 0.65,
    repeat: 3.4,
  });
  const rubberPolyMat = createWeaponPBRMaterial(textures.gunPolymer, {
    tint: 0xc4c8cc,
    metalness: 0.04,
    roughness: 0.88,
    edgeWearColor: new THREE.Color(0.20, 0.21, 0.22),
    edgeWearStrength: 0.25,
    repeat: 6.2,
  });

  const SIGHT_Y = 0.070;

  // 1. STAMPED STEEL RECEIVER & COCKING TUBE
  const steelParts: THREE.BufferGeometry[] = [];

  // Main upper receiver housing + lower shelf
  const upperBox = createChamferedBox(0.035, 0.040, 0.245, 0.0042, 4, 4);
  upperBox.translate(0, 0.014, -0.025);
  steelParts.push(upperBox);

  // Iconic tubular spine & forward cocking tube above suppressor
  const topTube = createLatheZ(
    [
      [0.0155, -0.155],
      [0.0165, -0.152],
      [0.0165, 0.095],
      [0.0138, 0.102],
      [0.0138, 0.218], // Cocking handle tube
      [0.0115, 0.224],
    ],
    32
  );
  topTube.translate(0, 0.029, 0);
  steelParts.push(topTube);

  // Stamped receiver flute ribs along left & right sides
  for (const sx of [-0.0182, 0.0182]) {
    for (const sz of [-0.085, -0.045, 0.025]) {
      const rib = createChamferedBox(0.0025, 0.024, 0.028, 0.0008, 2, 2);
      rib.translate(sx, 0.012, sz);
      steelParts.push(rib);
    }
  }

  // Magwell housing (angled forward feed chute)
  const magwell = createChamferedBox(0.032, 0.056, 0.052, 0.0035, 3, 3);
  magwell.rotateX(-0.14);
  magwell.translate(0, -0.022, 0.058);
  steelParts.push(magwell);

  // Claw-Mount Top Picatinny Rail (top y = 0.0525)
  const clawRail = createPicatinnyRail(0.145, 0.021, 0.0085, 0.010);
  clawRail.translate(0, 0.044, -0.025);
  steelParts.push(clawRail);

  for (const cz of [-0.075, 0.025]) {
    for (const sx of [-0.016, 0.016]) {
      const leg = createChamferedBox(0.005, 0.016, 0.016, 0.0012, 2, 2);
      leg.translate(sx, 0.039, cz);
      steelParts.push(leg);
    }
  }

  // Iconic MP5 Rotating Drum Rear Diopter Sight + Hooded Front Ring Sight (center Y = 0.060)
  const drumBase = createChamferedBox(0.026, 0.012, 0.024, 0.002, 2, 2);
  drumBase.translate(0, 0.048, -0.118);
  steelParts.push(drumBase);
  const drumCyl = createLatheZ(
    [
      [0.001, -0.010],
      [0.0095, -0.010],
      [0.0095, 0.010],
      [0.001, 0.010],
    ],
    22
  );
  drumCyl.rotateY(0.45);
  drumCyl.translate(0, 0.057, -0.118);
  steelParts.push(drumCyl);

  const frontPostBase = createChamferedBox(0.016, 0.014, 0.020, 0.002, 2, 2);
  frontPostBase.translate(0, 0.046, 0.208);
  steelParts.push(frontPostBase);
  const frontRing = new THREE.TorusGeometry(0.0082, 0.0018, 12, 26);
  frontRing.translate(0, 0.060, 0.208);
  steelParts.push(frontRing);

  // Retractable A3 Tactical Stock Rails & Endcap
  const receiverCap = createChamferedBox(0.038, 0.048, 0.028, 0.004, 3, 3);
  receiverCap.translate(0, 0.012, -0.155);
  steelParts.push(receiverCap);

  for (const sx of [-0.020, 0.020]) {
    const rail = createChamferedBox(0.0055, 0.010, 0.145, 0.0015, 2, 2);
    rail.translate(sx, 0.008, -0.215);
    steelParts.push(rail);
  }

  // Lower Picatinny tri-rail mount adapter at y = -0.020 for foregrips & flashlight
  const mp5UnderRail = createPicatinnyRail(0.115, 0.019, 0.007, 0.010);
  mp5UnderRail.rotateZ(Math.PI);
  mp5UnderRail.translate(0, -0.019, 0.168);
  steelParts.push(mp5UnderRail);

  const upperMesh = new THREE.Mesh(mergeParts(steelParts, true), stampedSteelMat);
  upperMesh.castShadow = true;
  upperMesh.receiveShadow = true;
  root.add(upperMesh);

  // Modular Attachment Slots
  const opticSlot = new THREE.Group();
  const muzzleSlot = new THREE.Group();
  const underSlot = new THREE.Group();
  const sideSlot = new THREE.Group();
  root.add(opticSlot, muzzleSlot, underSlot, sideSlot);

  // 2A. INTEGRAL SUPPRESSOR TUBE + RIBBED RUBBER SHROUD (shown in suppressor mode)
  const defaultSuppressor = new THREE.Group();
  const suppParts: THREE.BufferGeometry[] = [];
  const suppProfile: Array<[number, number]> = [
    [0.014, 0.092],
    [0.0205, 0.098],
    [0.0205, 0.235],
    [0.0215, 0.240],
    [0.0215, 0.248],
    [0.0202, 0.252],
    [0.0202, 0.405],
    [0.0212, 0.410],
    [0.0212, 0.422],
    [0.0185, 0.428],
    [0.0065, 0.428],
    [0.0055, 0.410],
  ];
  const suppLathe = createLatheZ(suppProfile, 36);
  suppLathe.translate(0, 0.006, 0);
  suppParts.push(suppLathe);

  for (let r = 0; r < 6; r++) {
    const rz = 0.270 + r * 0.020;
    const collar = createLatheZ(
      [
        [0.0198, rz - 0.004],
        [0.0210, rz - 0.003],
        [0.0210, rz + 0.003],
        [0.0198, rz + 0.004],
      ],
      28
    );
    collar.translate(0, 0.006, 0);
    suppParts.push(collar);
  }
  const suppMesh = new THREE.Mesh(mergeParts(suppParts, true), suppressorMat);
  suppMesh.castShadow = true;
  suppMesh.receiveShadow = true;
  defaultSuppressor.add(suppMesh);

  const sleeveParts: THREE.BufferGeometry[] = [];
  const sleeveBase = createLatheZ(
    [
      [0.0205, 0.095],
      [0.0242, 0.102],
      [0.0242, 0.232],
      [0.0205, 0.238],
    ],
    32
  );
  sleeveBase.translate(0, 0.006, 0);
  sleeveParts.push(sleeveBase);

  for (let i = 0; i < 12; i++) {
    const gz = 0.108 + i * 0.0102;
    const rib = createLatheZ(
      [
        [0.0235, gz - 0.0028],
        [0.0258, gz - 0.0022],
        [0.0258, gz + 0.0022],
        [0.0235, gz + 0.0028],
      ],
      28
    );
    rib.translate(0, 0.006, 0);
    sleeveParts.push(rib);
  }
  const sleeveMesh = new THREE.Mesh(mergeParts(sleeveParts, true), rubberPolyMat);
  sleeveMesh.castShadow = true;
  defaultSuppressor.add(sleeveMesh);
  root.add(defaultSuppressor);

  // 2B. EXPOSED SHORT-BARREL SHROUD & 3-LUG BARREL STUB (shown in brake mode!)
  const brakeExposedBarrel = new THREE.Group();
  const shortHgGeo = createChamferedBox(0.034, 0.036, 0.132, 0.005, 3, 3);
  shortHgGeo.translate(0, 0.004, 0.160);
  brakeExposedBarrel.add(new THREE.Mesh(shortHgGeo, rubberPolyMat));
  const stubBrl = createLatheZ(
    [
      [0.011, 0.092],
      [0.011, 0.244],
      [0.013, 0.248],
      [0.013, 0.256],
      [0.0085, 0.258],
    ],
    24
  );
  stubBrl.translate(0, 0.006, 0);
  brakeExposedBarrel.add(new THREE.Mesh(stubBrl, stampedSteelMat));
  brakeExposedBarrel.visible = false;
  root.add(brakeExposedBarrel);

  // 3. POLYMER PARTS: SEF LOWER GRIP & BUTTPAD
  const polyParts: THREE.BufferGeometry[] = [];

  // SEF Navy Trigger Housing & Ergonomic Grip
  const triggerHouse = createChamferedBox(0.032, 0.030, 0.115, 0.004, 3, 3);
  triggerHouse.translate(0, -0.012, -0.072);
  polyParts.push(triggerHouse);

  const gripCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.020, -0.068),
    new THREE.Vector3(0, -0.052, -0.080),
    new THREE.Vector3(0, -0.085, -0.092),
    new THREE.Vector3(0, -0.115, -0.102),
  ]);
  polyParts.push(
    sweepProfileAlongCurve(
      gripCurve,
      ellipseProfile(0.014, 0.0195, 24),
      22,
      (t, ang) => {
        const swell = 1.0 + Math.sin(t * Math.PI) * 0.12;
        const groove = Math.sin(t * 24) * 0.03 * Math.max(0, Math.cos(ang));
        return { sx: swell + groove, sy: swell };
      },
      true
    )
  );

  // Trigger guard & trigger
  const tgCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.022, -0.044),
    new THREE.Vector3(0, -0.046, -0.038),
    new THREE.Vector3(0, -0.046, -0.014),
    new THREE.Vector3(0, -0.022, -0.010),
  ]);
  polyParts.push(sweepProfileAlongCurve(tgCurve, roundedRectProfile(0.0065, 0.0055, 0.0018, 3), 18, undefined, true));

  // Selector lever (left side = +X weapon local)
  const selector = createChamferedBox(0.006, 0.007, 0.022, 0.0012, 2, 2);
  selector.rotateX(-0.35);
  selector.translate(0.018, -0.008, -0.082);
  polyParts.push(selector);

  // A3 Rubber Buttpad
  const buttPad = createChamferedBox(0.040, 0.096, 0.018, 0.005, 3, 3);
  buttPad.translate(0, -0.018, -0.285);
  polyParts.push(buttPad);

  const polyMesh = new THREE.Mesh(mergeParts(polyParts, true), rubberPolyMat);
  polyMesh.castShadow = true;
  polyMesh.receiveShadow = true;
  root.add(polyMesh);

  // 4. ANIMATED BOLT (ejection port) & FORWARD HK SLAP CHARGING HANDLE (+X weapon local -> Camera Left!)
  const boltGeo = createChamferedBox(0.016, 0.015, 0.056, 0.0015, 2, 2);
  const boltMesh = new THREE.Mesh(mergeParts([boltGeo], true), stampedSteelMat);
  boltMesh.position.set(-0.006, 0.015, 0.002);
  root.add(boltMesh);

  const chGroup = new THREE.Group();
  chGroup.position.set(0.015, 0.032, 0.175);
  const chStem = createChamferedBox(0.022, 0.007, 0.010, 0.0015, 2, 2);
  chStem.translate(0.009, 0.002, 0);
  const chKnob = createLatheZ(
    [
      [0.001, -0.007],
      [0.006, -0.007],
      [0.006, 0.007],
      [0.001, 0.007],
    ],
    18
  );
  chKnob.rotateY(Math.PI * 0.5);
  chKnob.translate(0.022, 0.003, 0);
  const chMesh = new THREE.Mesh(mergeParts([chStem, chKnob], true), rubberPolyMat);
  chGroup.add(chMesh);
  root.add(chGroup);

  // 5. EXACT SOCKETS (Optic, Muzzle, Side & Underbarrel slots managed by applyWeaponAttachments)
  const magGroup = new THREE.Group();
  magGroup.name = 'MP5SD_Magazine';
  magGroup.position.set(0, -0.042, 0.058);

  const magParts: THREE.BufferGeometry[] = [];
  const magCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.032, 0),
    new THREE.Vector3(0, -0.045, 0.008),
    new THREE.Vector3(0, -0.115, 0.026),
    new THREE.Vector3(0, -0.175, 0.052),
  ]);
  magParts.push(
    sweepProfileAlongCurve(
      magCurve,
      roundedRectProfile(0.021, 0.036, 0.004, 3),
      24,
      (t) => {
        const rib = t > 0.22 && t < 0.9 ? Math.max(0, Math.sin(t * 48)) * 0.05 : 0;
        return { sx: 1 + rib, sy: 1 };
      },
      true
    )
  );
  const magFloor = createChamferedBox(0.025, 0.010, 0.042, 0.002, 2, 2);
  magFloor.rotateX(-0.36);
  magFloor.translate(0, -0.178, 0.054);
  magParts.push(magFloor);

  const magMesh = new THREE.Mesh(mergeParts(magParts, true), suppressorMat);
  magMesh.castShadow = true;
  magGroup.add(magMesh);
  root.add(magGroup);

  // 7. EXACT SOCKETS
  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0.006, 0.432);
  root.add(muzzlePoint);

  const ejectPoint = new THREE.Object3D();
  ejectPoint.position.set(-0.020, 0.016, 0.002);
  root.add(ejectPoint);

  const rightGripSocket = new THREE.Object3D();
  rightGripSocket.position.set(0, -0.062, -0.084);
  root.add(rightGripSocket);

  const baseLeftGripPos = new THREE.Vector3(0.014, -0.016, 0.168);
  const leftGripSocket = new THREE.Object3D();
  leftGripSocket.position.copy(baseLeftGripPos);
  root.add(leftGripSocket);

  const magSocket = new THREE.Object3D();
  magSocket.position.set(0, -0.042, 0.058);
  root.add(magSocket);

  const mp5Result: WeaponBuildResult = {
    root,
    magazine: magGroup,
    boltOrSlide: boltMesh,
    chargingHandle: chGroup,
    muzzlePoint,
    ejectPoint,
    sightAlignOffset: new THREE.Vector3(0, SIGHT_Y, 0),
    rightGripSocket,
    leftGripSocket,
    magSocket,
    baseLeftGripPos,
    currentGripStyle: 'none',
    sockets: {
      opticMountY: 0.0525,
      opticMountZ: -0.015,
      ironSightY: 0.060,
      muzzleMountY: 0.006,
      muzzleMountZ: 0.432,
      underMountY: -0.025,
      underMountZ: 0.168,
      sideMountX: -0.029,
      sideMountY: 0.012,
      sideMountZ: 0.225,
    },
    opticSlot,
    muzzleSlot,
    underSlot,
    sideSlot,
    defaultSuppressor,
    brakeExposedBarrel,
    triangleCount: 0,
  };
  applyWeaponAttachments('mp5sd', mp5Result, createDefaultLoadoutSave().configs.mp5sd, textures);
  mp5Result.triangleCount = countTriangles(root);
  return mp5Result;
}

/**
 * Builds high-detail procedural AR-15 Match DMR Rifle (>= 15,000 triangles).
 * Features 18" heavy fluted stainless match barrel, slim full-length M-LOK handguard,
 * CNC billet receiver, skeletonized precision stock & 20-round straight DMR magazine.
 */
export function buildAR15(textures: TextureLibrary): WeaponBuildResult {
  const root = new THREE.Group();
  root.name = 'AR15_Root';

  const billetMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0xaab4c0,
    edgeWearStrength: 0.85,
    repeat: 2.6,
  });
  const stainlessMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0xe2e8ee,
    roughness: 0.28,
    metalness: 0.96,
    edgeWearColor: new THREE.Color(0.92, 0.94, 0.96),
    edgeWearStrength: 0.45,
    repeat: 2.2,
  });
  const darkSteelMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0x626872,
    edgeWearStrength: 0.72,
    repeat: 3.0,
  });
  const polymerMat = createWeaponPBRMaterial(textures.gunPolymer, {
    tint: 0xc2c6cc,
    metalness: 0.04,
    roughness: 0.84,
    edgeWearColor: new THREE.Color(0.22, 0.23, 0.24),
    edgeWearStrength: 0.24,
    repeat: 6.0,
  });

  const SIGHT_Y = 0.072;

  // 1. CNC BILLET MATCH UPPER & LOWER RECEIVER + SLIM M-LOK HANDGUARD
  const upperParts: THREE.BufferGeometry[] = [];
  const upperMain = createChamferedBox(0.036, 0.044, 0.200, 0.0042, 4, 4);
  upperMain.translate(0, 0.014, 0.0);
  upperParts.push(upperMain);

  const boreArch = createLatheZ(
    [
      [0.0175, -0.098],
      [0.0188, -0.095],
      [0.0188, 0.096],
      [0.0175, 0.100],
    ],
    32
  );
  boreArch.translate(0, 0.022, 0);
  upperParts.push(boreArch);

  // Brass deflector & billet shell relief cuts
  const defShape = new THREE.Shape();
  defShape.moveTo(0, 0);
  defShape.lineTo(0.015, 0.006);
  defShape.lineTo(0.011, 0.023);
  defShape.lineTo(0, 0.021);
  defShape.closePath();
  const def = createBeveledShape(defShape, 0.024, 0.0018, 3, 4);
  def.rotateY(-Math.PI * 0.5);
  def.translate(-0.020, 0.012, -0.026);
  upperParts.push(def);

  // Match Billet Lower Receiver with flared beveled magwell
  const lowerShape = new THREE.Shape();
  lowerShape.moveTo(-0.096, -0.012);
  lowerShape.lineTo(0.025, -0.012);
  lowerShape.lineTo(0.030, -0.058);
  lowerShape.lineTo(0.096, -0.056);
  lowerShape.lineTo(0.099, -0.008);
  lowerShape.lineTo(0.096, 0.006);
  lowerShape.lineTo(-0.096, 0.006);
  lowerShape.closePath();
  const lowerBody = createBeveledShape(lowerShape, 0.035, 0.003, 4, 6);
  lowerBody.rotateY(-Math.PI * 0.5);
  upperParts.push(lowerBody);

  const magwellRim = createChamferedBox(0.042, 0.014, 0.072, 0.0028, 3, 3);
  magwellRim.translate(0, -0.052, 0.062);
  upperParts.push(magwellRim);

  // Trigger guard + Flat-Faced Match Trigger + Ambi Selector
  const tgCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.012, -0.026),
    new THREE.Vector3(0, -0.037, -0.021),
    new THREE.Vector3(0, -0.040, 0.002),
    new THREE.Vector3(0, -0.034, 0.024),
    new THREE.Vector3(0, -0.016, 0.029),
  ]);
  upperParts.push(sweepProfileAlongCurve(tgCurve, roundedRectProfile(0.007, 0.006, 0.002, 3), 22, undefined, true));
  const matchTrig = createChamferedBox(0.0045, 0.023, 0.0055, 0.001, 2, 2);
  matchTrig.rotateX(0.12);
  matchTrig.translate(0, -0.020, 0.001);
  upperParts.push(matchTrig);

  // Full-length Continuous Top Picatinny Rail (Receiver + 13" M-LOK Handguard = 0.50m monolithic-flush line!)
  const fullTopRail = createPicatinnyRail(0.505, 0.0212, 0.0085, 0.010);
  fullTopRail.translate(0, 0.036, 0.160);
  upperParts.push(fullTopRail);

  // Slim Free-Float M-LOK Handguard (0.315m long, octagonal sculpted profile with vented ribs & M-LOK slots!)
  const hgStartZ = 0.104;
  const hgLen = 0.315;
  const barrelNut = createLatheZ(
    [
      [0.016, 0.094],
      [0.022, 0.098],
      [0.022, 0.112],
      [0.016, 0.116],
    ],
    28
  );
  barrelNut.translate(0, 0.016, 0);
  upperParts.push(barrelNut);

  for (let r = 0; r < 11; r++) {
    const rz = hgStartZ + 0.014 + (r / 10) * (hgLen - 0.028);
    const ring = createLatheZ(
      [
        [0.0172, rz - 0.0075],
        [0.0210, rz - 0.006],
        [0.0210, rz + 0.006],
        [0.0172, rz + 0.0075],
      ],
      24
    );
    ring.translate(0, 0.016, 0);
    upperParts.push(ring);
  }
  for (const ang of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
    const strut = createChamferedBox(0.010, 0.007, hgLen, 0.0018, 2, 2);
    strut.rotateZ(ang);
    strut.translate(Math.cos(ang) * 0.0195, 0.016 + Math.sin(ang) * 0.0195, hgStartZ + hgLen * 0.5);
    upperParts.push(strut);
  }
  // M-LOK side & bottom machined slot rails (slimmer than quad rail!)
  for (const sx of [-0.0215, 0.0215]) {
    const mLokSide = createChamferedBox(0.004, 0.017, hgLen * 0.94, 0.0012, 2, 2);
    mLokSide.translate(sx, 0.016, hgStartZ + hgLen * 0.5);
    upperParts.push(mLokSide);
  }
  const botGripRail = createPicatinnyRail(0.095, 0.019, 0.007, 0.010);
  botGripRail.rotateZ(Math.PI);
  botGripRail.translate(0, -0.001, 0.225);
  upperParts.push(botGripRail);

  const sideLightRail = createPicatinnyRail(0.065, 0.018, 0.0065, 0.010);
  sideLightRail.rotateZ(-Math.PI * 0.5);
  sideLightRail.translate(-0.021, 0.016, 0.310);
  upperParts.push(sideLightRail);

  // Buffer Tube + Skeletonized Precision Rifle Buttstock
  const buf = createLatheZ(
    [
      [0.016, -0.250],
      [0.016, -0.102],
      [0.0195, -0.102],
      [0.0195, -0.092],
    ],
    28
  );
  buf.translate(0, 0.012, 0);
  upperParts.push(buf);

  const stockBottomRod = createLatheZ([[0.008, -0.275], [0.008, -0.125]], 18);
  stockBottomRod.rotateX(-0.28);
  stockBottomRod.translate(0, -0.036, 0);
  upperParts.push(stockBottomRod);

  const stockBackSpine = createChamferedBox(0.026, 0.102, 0.018, 0.0035, 3, 3);
  stockBackSpine.translate(0, -0.024, -0.265);
  upperParts.push(stockBackSpine);

  const receiverMesh = new THREE.Mesh(mergeParts(upperParts, true), billetMat);
  receiverMesh.castShadow = true;
  receiverMesh.receiveShadow = true;
  root.add(receiverMesh);

  // 2. 18-INCH HEAVY FLUTED STAINLESS MATCH BARREL + GAS BLOCK + FLASH HIDER
  const brlParts: THREE.BufferGeometry[] = [];
  const matchBrl = createLatheZ(
    [
      [0.0135, 0.100],
      [0.0128, 0.340],
      [0.0145, 0.350],
      [0.0145, 0.380], // Rifle-length gas block seat
      [0.0112, 0.390],
      [0.0112, 0.512],
      [0.0085, 0.515],
    ],
    36
  );
  matchBrl.translate(0, 0.016, 0);
  brlParts.push(matchBrl);

  // 8 Longitudinal barrel fluting ribs along exposed forward match barrel
  for (let f = 0; f < 8; f++) {
    const ang = (f / 8) * Math.PI * 2;
    const flute = createChamferedBox(0.003, 0.003, 0.105, 0.0008, 2, 2);
    flute.translate(Math.cos(ang) * 0.0118, 0.016 + Math.sin(ang) * 0.0118, 0.450);
    brlParts.push(flute);
  }
  const gasBlk = createChamferedBox(0.022, 0.027, 0.034, 0.0025, 2, 2);
  gasBlk.translate(0, 0.020, 0.365);
  brlParts.push(gasBlk);
  const gasTube = createLatheZ([[0.0026, 0.095], [0.0026, 0.362]], 14);
  gasTube.translate(0, 0.031, 0);
  brlParts.push(gasTube);

  const brlMesh = new THREE.Mesh(mergeParts(brlParts, true), stainlessMat);
  brlMesh.castShadow = true;
  root.add(brlMesh);

  const flashHiderGeo = createSlottedFlashHider(0.0118, 0.0064, 0.052, 5, 6);
  flashHiderGeo.translate(0, 0.016, 0.515);
  const defaultFlashHider = new THREE.Mesh(mergeParts([flashHiderGeo], true), darkSteelMat);
  defaultFlashHider.castShadow = true;
  root.add(defaultFlashHider);

  // 3. IRON SIGHTS + FOLDED BACKUP + CHARGING HANDLE + BOLT CARRIER
  const rearSightZ = -0.078;
  const rearFoldGeo = createChamferedBox(0.026, 0.009, 0.030, 0.002, 2, 2);
  rearFoldGeo.translate(0, 0.046, rearSightZ);
  const foldedRearSight = new THREE.Mesh(rearFoldGeo, darkSteelMat);
  root.add(foldedRearSight);

  const ironSightsGroup = new THREE.Group();
  const ironParts: THREE.BufferGeometry[] = [];
  const peepBase = createChamferedBox(0.026, 0.012, 0.028, 0.002, 2, 2);
  peepBase.translate(0, 0.048, rearSightZ);
  ironParts.push(peepBase);
  for (const sx of [-0.010, 0.010]) {
    const ear = createChamferedBox(0.0045, 0.024, 0.016, 0.001, 2, 2);
    ear.translate(sx, 0.064, rearSightZ);
    ironParts.push(ear);
  }
  const fz = 0.398;
  const fBase = createChamferedBox(0.024, 0.011, 0.028, 0.002, 2, 2);
  fBase.translate(0, 0.047, fz);
  ironParts.push(fBase);
  for (const sx of [-0.0095, 0.0095]) {
    const ear = createChamferedBox(0.0038, 0.020, 0.018, 0.001, 2, 2);
    ear.translate(sx, 0.060, fz);
    ironParts.push(ear);
  }
  const fPost = createChamferedBox(0.0022, 0.015, 0.003, 0.0005, 2, 2);
  fPost.translate(0, SIGHT_Y - 0.008, fz);
  ironParts.push(fPost);
  ironSightsGroup.add(new THREE.Mesh(mergeParts(ironParts, true), darkSteelMat));
  root.add(ironSightsGroup);

  const boltCarrier = new THREE.Mesh(
    mergeParts([createChamferedBox(0.016, 0.018, 0.068, 0.0015, 2, 2)], true),
    stainlessMat
  );
  boltCarrier.position.set(-0.004, 0.016, 0.022);
  root.add(boltCarrier);

  const chTBar = createChamferedBox(0.032, 0.007, 0.012, 0.0015, 2, 2);
  const chStem = createChamferedBox(0.010, 0.006, 0.075, 0.001, 2, 2);
  chStem.translate(0, 0, 0.038);
  const chargingHandle = new THREE.Mesh(mergeParts([chTBar, chStem], true), darkSteelMat);
  chargingHandle.position.set(0, 0.029, -0.104);
  root.add(chargingHandle);

  // 4. POLYMER PISTOL GRIP, CHEEK RISER & BUTTPAD
  const polyParts: THREE.BufferGeometry[] = [];
  const gripCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.012, -0.056),
    new THREE.Vector3(0, -0.044, -0.068),
    new THREE.Vector3(0, -0.078, -0.080),
    new THREE.Vector3(0, -0.108, -0.090),
  ]);
  polyParts.push(sweepProfileAlongCurve(gripCurve, ellipseProfile(0.0145, 0.0205, 24), 24, undefined, true));
  const cheekRiser = createChamferedBox(0.032, 0.024, 0.115, 0.004, 3, 3);
  cheekRiser.translate(0, 0.026, -0.205);
  polyParts.push(cheekRiser);
  const buttPad = createChamferedBox(0.038, 0.112, 0.016, 0.004, 3, 3);
  buttPad.translate(0, -0.024, -0.278);
  polyParts.push(buttPad);

  const polyMesh = new THREE.Mesh(mergeParts(polyParts, true), polymerMat);
  polyMesh.castShadow = true;
  root.add(polyMesh);

  // 5. STRAIGHT 20-ROUND PRECISION DMR MAGAZINE (plus Fast & Extended variants!)
  const magGroup = new THREE.Group();
  magGroup.name = 'AR15_Magazine';
  magGroup.position.set(0, -0.048, 0.062);

  const magParts: THREE.BufferGeometry[] = [];
  const magBox = createChamferedBox(0.024, 0.125, 0.064, 0.003, 3, 3);
  magBox.rotateX(-0.08);
  magBox.translate(0, -0.042, 0.005);
  magParts.push(magBox);
  for (let r = 0; r < 4; r++) {
    const rib = createChamferedBox(0.026, 0.075, 0.006, 0.001, 2, 2);
    rib.rotateX(-0.08);
    rib.translate(0, -0.052, -0.015 + r * 0.014);
    magParts.push(rib);
  }
  const magFloor = createChamferedBox(0.028, 0.010, 0.068, 0.002, 2, 2);
  magFloor.rotateX(-0.08);
  magFloor.translate(0, -0.105, 0.010);
  magParts.push(magFloor);
  magGroup.add(new THREE.Mesh(mergeParts(magParts, true), darkSteelMat));
  const arMagVars = attachMagVariantMeshes(magGroup, 0.024, 0.064, -0.105, 0.010, -0.08, darkSteelMat, polymerMat);
  root.add(magGroup);

  // 6. ATTACHMENT SLOTS & EXACT SOCKETS
  const opticSlot = new THREE.Group();
  const muzzleSlot = new THREE.Group();
  const underSlot = new THREE.Group();
  const sideSlot = new THREE.Group();
  root.add(opticSlot, muzzleSlot, underSlot, sideSlot);

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0.016, 0.57);
  root.add(muzzlePoint);
  const ejectPoint = new THREE.Object3D();
  ejectPoint.position.set(-0.022, 0.016, 0.022);
  root.add(ejectPoint);
  const rightGripSocket = new THREE.Object3D();
  rightGripSocket.position.set(0, -0.056, -0.072);
  root.add(rightGripSocket);
  const baseLeftGripPos = new THREE.Vector3(0.012, -0.012, 0.220);
  const leftGripSocket = new THREE.Object3D();
  leftGripSocket.position.copy(baseLeftGripPos);
  root.add(leftGripSocket);
  const magSocket = new THREE.Object3D();
  magSocket.position.set(0, -0.048, 0.062);
  root.add(magSocket);

  const ar15Result: WeaponBuildResult = {
    root,
    magazine: magGroup,
    boltOrSlide: boltCarrier,
    chargingHandle,
    muzzlePoint,
    ejectPoint,
    sightAlignOffset: new THREE.Vector3(0, SIGHT_Y, 0),
    rightGripSocket,
    leftGripSocket,
    magSocket,
    baseLeftGripPos,
    currentGripStyle: 'none',
    sockets: {
      opticMountY: 0.0445,
      opticMountZ: 0.018,
      ironSightY: SIGHT_Y,
      muzzleMountY: 0.016,
      muzzleMountZ: 0.515,
      underMountY: -0.008,
      underMountZ: 0.225,
      sideMountX: -0.032,
      sideMountY: 0.016,
      sideMountZ: 0.310,
    },
    opticSlot,
    muzzleSlot,
    underSlot,
    sideSlot,
    ironSightsGroup,
    foldedRearSight,
    defaultFlashHider,
    fastMagLoop: arMagVars.fastMagLoop,
    extMagExtension: arMagVars.extMagExtension,
    triangleCount: 0,
  };
  applyWeaponAttachments('ar15', ar15Result, createDefaultLoadoutSave().configs.ar15, textures);
  ar15Result.triangleCount = countTriangles(root);
  return ar15Result;
}

/**
 * Builds high-detail procedural SIG M7 (XM7) Next-Gen 6.8mm Squad Rifle (>= 16,000 triangles).
 * Signature FDE Coyote Tan & Dark Gunmetal two-tone finish, raised monolithic Picatinny rail,
 * side-folding minimalist stock, dual rear + side charging handle & 6.8x51mm 20-rd magazine.
 */
export function buildM7(textures: TextureLibrary): WeaponBuildResult {
  const root = new THREE.Group();
  root.name = 'M7_Root';

  // Signature Coyote Tan / Flat Dark Earth (FDE) ceramic coating vs Dark Nitrided Gunmetal
  const fdeMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0xc29e74,
    metalness: 0.28,
    roughness: 0.56,
    edgeWearColor: new THREE.Color(0.56, 0.50, 0.44),
    edgeWearStrength: 0.55,
    repeat: 2.8,
  });
  const darkMetalMat = createWeaponPBRMaterial(textures.gunMetal, {
    tint: 0x565c64,
    metalness: 0.90,
    roughness: 0.40,
    edgeWearStrength: 0.80,
    repeat: 3.0,
  });
  const fdePolyMat = createWeaponPBRMaterial(textures.gunPolymer, {
    tint: 0xb6946b,
    metalness: 0.04,
    roughness: 0.82,
    edgeWearColor: new THREE.Color(0.45, 0.38, 0.28),
    edgeWearStrength: 0.25,
    repeat: 6.0,
  });

  const SIGHT_Y = 0.076;

  // 1. FDE MONOLITHIC UPPER, LOWER RECEIVER & M-LOK HANDGUARD
  const fdeParts: THREE.BufferGeometry[] = [];
  const upperHull = createChamferedBox(0.039, 0.049, 0.215, 0.0045, 4, 4);
  upperHull.translate(0, 0.017, 0.005);
  fdeParts.push(upperHull);

  // Elevated Monolithic Full-Length Top Bridge (unites receiver & handguard cleanly!)
  const monoBridge = createChamferedBox(0.025, 0.011, 0.445, 0.0022, 3, 3);
  monoBridge.translate(0, 0.040, 0.125);
  fdeParts.push(monoBridge);

  const monoRail = createPicatinnyRail(0.445, 0.0215, 0.0085, 0.010);
  monoRail.translate(0, 0.0415, 0.125); // Rail top = 0.050!
  fdeParts.push(monoRail);

  // SIG MCX-SPEAR Lower Receiver
  const lowerShape = new THREE.Shape();
  lowerShape.moveTo(-0.098, -0.012);
  lowerShape.lineTo(0.024, -0.012);
  lowerShape.lineTo(0.032, -0.058);
  lowerShape.lineTo(0.104, -0.056);
  lowerShape.lineTo(0.108, -0.006);
  lowerShape.lineTo(-0.098, 0.006);
  lowerShape.closePath();
  const lowerBody = createBeveledShape(lowerShape, 0.038, 0.0032, 4, 6);
  lowerBody.rotateY(-Math.PI * 0.5);
  fdeParts.push(lowerBody);

  // Sculpted Monolithic Handguard with heavy cooling arches & M-LOK side cuts
  const hgStartZ = 0.112;
  const hgLen = 0.245;
  for (let r = 0; r < 10; r++) {
    const rz = hgStartZ + 0.012 + (r / 9) * (hgLen - 0.024);
    const rib = createChamferedBox(0.041, 0.046, 0.014, 0.0035, 3, 3);
    rib.translate(0, 0.017, rz);
    fdeParts.push(rib);
  }
  for (const sy of [0.001, 0.034]) {
    for (const sx of [-0.0185, 0.0185]) {
      const bar = createChamferedBox(0.007, 0.008, hgLen, 0.0015, 2, 2);
      bar.translate(sx, sy, hgStartZ + hgLen * 0.5);
      fdeParts.push(bar);
    }
  }
  const m7UnderRail = createPicatinnyRail(0.115, 0.020, 0.007, 0.010);
  m7UnderRail.rotateZ(Math.PI);
  m7UnderRail.translate(0, -0.003, 0.215);
  fdeParts.push(m7UnderRail);

  const m7SideRail = createPicatinnyRail(0.070, 0.018, 0.0065, 0.010);
  m7SideRail.rotateZ(-Math.PI * 0.5);
  m7SideRail.translate(-0.023, 0.016, 0.295);
  fdeParts.push(m7SideRail);

  const fdeMesh = new THREE.Mesh(mergeParts(fdeParts, true), fdeMat);
  fdeMesh.castShadow = true;
  fdeMesh.receiveShadow = true;
  root.add(fdeMesh);

  // 2. DARK NITRIDED STEEL BARREL, GAS REGULATOR, FOLDING STOCK STRUTS & CONTROLS
  const darkParts: THREE.BufferGeometry[] = [];
  const barrel68 = createLatheZ(
    [
      [0.014, 0.105],
      [0.0125, 0.280],
      [0.015, 0.290],
      [0.015, 0.320], // Heavy gas block
      [0.0115, 0.330],
      [0.0115, 0.455],
      [0.009, 0.458],
    ],
    34
  );
  barrel68.translate(0, 0.016, 0);
  darkParts.push(barrel68);

  // Adjustable Gas Regulator Knob projecting forward from gas block
  const gasReg = createLatheZ([[0.001, 0.315], [0.0075, 0.318], [0.0075, 0.348], [0.001, 0.352]], 18);
  gasReg.translate(0, 0.032, 0);
  darkParts.push(gasReg);

  // Trigger guard, ambidextrous selector, bolt catch, brass deflector & takedown pins
  const tgCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.012, -0.026),
    new THREE.Vector3(0, -0.038, -0.020),
    new THREE.Vector3(0, -0.041, 0.004),
    new THREE.Vector3(0, -0.034, 0.026),
    new THREE.Vector3(0, -0.016, 0.032),
  ]);
  darkParts.push(sweepProfileAlongCurve(tgCurve, roundedRectProfile(0.0075, 0.006, 0.002, 3), 20, undefined, true));
  const trig = createChamferedBox(0.005, 0.022, 0.006, 0.001, 2, 2);
  trig.rotateX(0.25);
  trig.translate(0, -0.020, 0.002);
  darkParts.push(trig);

  // Side-Folding Stock CNC Knuckle Hinge + Dual Minimalist Struts
  const hinge = createChamferedBox(0.038, 0.046, 0.030, 0.004, 3, 3);
  hinge.translate(0, 0.010, -0.115);
  darkParts.push(hinge);
  for (const sy of [-0.018, 0.018]) {
    const strut = createChamferedBox(0.014, 0.014, 0.145, 0.0025, 2, 2);
    strut.translate(0, sy, -0.195);
    darkParts.push(strut);
  }
  const stockEnd = createChamferedBox(0.028, 0.098, 0.018, 0.0035, 3, 3);
  stockEnd.translate(0, -0.018, -0.268);
  darkParts.push(stockEnd);

  const darkMesh = new THREE.Mesh(mergeParts(darkParts, true), darkMetalMat);
  darkMesh.castShadow = true;
  root.add(darkMesh);

  // Detachable 6.8mm Slotted Flash Hider
  const fhGeo = createSlottedFlashHider(0.0125, 0.0068, 0.052, 5, 6);
  fhGeo.translate(0, 0.016, 0.455);
  const defaultFlashHider = new THREE.Mesh(mergeParts([fhGeo], true), darkMetalMat);
  defaultFlashHider.castShadow = true;
  root.add(defaultFlashHider);

  // 3. IRON SIGHTS + FOLDED BACKUP + BOLT + DUAL CHARGING HANDLES (REAR T + SIDE HANDLE!)
  const rearSightZ = -0.082;
  const rfGeo = createChamferedBox(0.026, 0.009, 0.030, 0.002, 2, 2);
  rfGeo.translate(0, 0.0515, rearSightZ);
  const foldedRearSight = new THREE.Mesh(rfGeo, darkMetalMat);
  root.add(foldedRearSight);

  const ironSightsGroup = new THREE.Group();
  const ironParts: THREE.BufferGeometry[] = [];
  const pBase = createChamferedBox(0.026, 0.012, 0.028, 0.002, 2, 2);
  pBase.translate(0, 0.054, rearSightZ);
  ironParts.push(pBase);
  for (const sx of [-0.010, 0.010]) {
    const ear = createChamferedBox(0.0045, 0.024, 0.016, 0.001, 2, 2);
    ear.translate(sx, 0.068, rearSightZ);
    ironParts.push(ear);
  }
  const fz = 0.325;
  const fb = createChamferedBox(0.024, 0.011, 0.028, 0.002, 2, 2);
  fb.translate(0, 0.053, fz);
  ironParts.push(fb);
  for (const sx of [-0.0095, 0.0095]) {
    const ear = createChamferedBox(0.0038, 0.020, 0.018, 0.001, 2, 2);
    ear.translate(sx, 0.065, fz);
    ironParts.push(ear);
  }
  const fp = createChamferedBox(0.0022, 0.015, 0.003, 0.0005, 2, 2);
  fp.translate(0, SIGHT_Y - 0.007, fz);
  ironParts.push(fp);
  ironSightsGroup.add(new THREE.Mesh(mergeParts(ironParts, true), darkMetalMat));
  root.add(ironSightsGroup);

  const boltCarrier = new THREE.Mesh(
    mergeParts([createChamferedBox(0.018, 0.018, 0.072, 0.0015, 2, 2)], true),
    darkMetalMat
  );
  boltCarrier.position.set(-0.004, 0.018, 0.024);
  root.add(boltCarrier);

  const chTBar = createChamferedBox(0.032, 0.007, 0.012, 0.0015, 2, 2);
  const chStem = createChamferedBox(0.010, 0.006, 0.075, 0.001, 2, 2);
  chStem.translate(0, 0, 0.038);
  const chargingHandle = new THREE.Mesh(mergeParts([chTBar, chStem], true), darkMetalMat);
  chargingHandle.position.set(0, 0.034, -0.108);
  root.add(chargingHandle);

  // Iconic M7 Left-Side Non-Reciprocating Folding Charging Handle (+X weapon local!)
  const sideChGroup = new THREE.Group();
  sideChGroup.position.set(0.021, 0.022, 0.048);
  const schArm = createChamferedBox(0.022, 0.008, 0.010, 0.0015, 2, 2);
  schArm.translate(0.010, 0, -0.005);
  const schKnob = createChamferedBox(0.008, 0.012, 0.022, 0.002, 2, 2);
  schKnob.translate(0.022, 0, -0.012);
  sideChGroup.add(new THREE.Mesh(mergeParts([schArm, schKnob], true), darkMetalMat));
  root.add(sideChGroup);

  // 4. FDE POLYMER PISTOL GRIP, RAIL COVERS & RECOIL BUTTPAD
  const polyParts: THREE.BufferGeometry[] = [];
  const gripCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.012, -0.056),
    new THREE.Vector3(0, -0.044, -0.068),
    new THREE.Vector3(0, -0.078, -0.079),
    new THREE.Vector3(0, -0.108, -0.088),
  ]);
  polyParts.push(sweepProfileAlongCurve(gripCurve, ellipseProfile(0.0155, 0.0215, 24), 24, undefined, true));
  const cheek = createChamferedBox(0.034, 0.022, 0.110, 0.004, 3, 3);
  cheek.translate(0, 0.025, -0.195);
  polyParts.push(cheek);
  const bPad = createChamferedBox(0.040, 0.106, 0.016, 0.004, 3, 3);
  bPad.translate(0, -0.020, -0.278);
  polyParts.push(bPad);

  const polyMesh = new THREE.Mesh(mergeParts(polyParts, true), fdePolyMat);
  polyMesh.castShadow = true;
  root.add(polyMesh);

  // 5. HEAVY 6.8x51mm (.277 FURY) 20-ROUND THICKENED MAGAZINE (FDE Polymer + Steel Floor)
  const magGroup = new THREE.Group();
  magGroup.name = 'M7_Magazine';
  magGroup.position.set(0, -0.048, 0.066);

  const magParts: THREE.BufferGeometry[] = [];
  const mCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.032, 0),
    new THREE.Vector3(0, -0.035, 0.002),
    new THREE.Vector3(0, -0.098, 0.009),
    new THREE.Vector3(0, -0.138, 0.016),
  ]);
  magParts.push(
    sweepProfileAlongCurve(
      mCurve,
      roundedRectProfile(0.027, 0.072, 0.0045, 3),
      22,
      (t) => {
        const rib = t > 0.2 && t < 0.9 ? Math.max(0, Math.sin(t * 36)) * 0.07 : 0;
        return { sx: 1 + rib, sy: 1 };
      },
      true
    )
  );
  const mFloor = createChamferedBox(0.031, 0.012, 0.076, 0.0025, 2, 2);
  mFloor.rotateX(-0.14);
  mFloor.translate(0, -0.140, 0.017);
  magParts.push(mFloor);
  magGroup.add(new THREE.Mesh(mergeParts(magParts, true), fdePolyMat));
  const m7MagVars = attachMagVariantMeshes(magGroup, 0.027, 0.072, -0.138, 0.017, -0.14, darkMetalMat, darkMetalMat);
  root.add(magGroup);

  // 6. ATTACHMENT SLOTS & EXACT SOCKETS
  const opticSlot = new THREE.Group();
  const muzzleSlot = new THREE.Group();
  const underSlot = new THREE.Group();
  const sideSlot = new THREE.Group();
  root.add(opticSlot, muzzleSlot, underSlot, sideSlot);

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0.016, 0.51);
  root.add(muzzlePoint);
  const ejectPoint = new THREE.Object3D();
  ejectPoint.position.set(-0.022, 0.018, 0.024);
  root.add(ejectPoint);
  const rightGripSocket = new THREE.Object3D();
  rightGripSocket.position.set(0, -0.056, -0.072);
  root.add(rightGripSocket);
  const baseLeftGripPos = new THREE.Vector3(0.013, -0.012, 0.215);
  const leftGripSocket = new THREE.Object3D();
  leftGripSocket.position.copy(baseLeftGripPos);
  root.add(leftGripSocket);
  const magSocket = new THREE.Object3D();
  magSocket.position.set(0, -0.048, 0.066);
  root.add(magSocket);

  const m7Result: WeaponBuildResult = {
    root,
    magazine: magGroup,
    boltOrSlide: boltCarrier,
    chargingHandle,
    sideChargingHandle: sideChGroup,
    muzzlePoint,
    ejectPoint,
    sightAlignOffset: new THREE.Vector3(0, SIGHT_Y, 0),
    rightGripSocket,
    leftGripSocket,
    magSocket,
    baseLeftGripPos,
    currentGripStyle: 'none',
    sockets: {
      opticMountY: 0.050,
      opticMountZ: 0.022,
      ironSightY: SIGHT_Y,
      muzzleMountY: 0.016,
      muzzleMountZ: 0.455,
      underMountY: -0.010,
      underMountZ: 0.215,
      sideMountX: -0.036,
      sideMountY: 0.016,
      sideMountZ: 0.295,
    },
    opticSlot,
    muzzleSlot,
    underSlot,
    sideSlot,
    ironSightsGroup,
    foldedRearSight,
    defaultFlashHider,
    fastMagLoop: m7MagVars.fastMagLoop,
    extMagExtension: m7MagVars.extMagExtension,
    triangleCount: 0,
  };
  applyWeaponAttachments('m7', m7Result, createDefaultLoadoutSave().configs.m7, textures);
  m7Result.triangleCount = countTriangles(root);
  return m7Result;
}
