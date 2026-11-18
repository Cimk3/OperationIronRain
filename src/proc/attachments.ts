import * as THREE from 'three';
import { WeaponId, WeaponLoadoutConfig } from '../types';
import { createBeveledShape, createChamferedBox, createLatheZ, mergeParts } from './modeling';
import { TextureLibrary } from './textures';
import type { WeaponBuildResult } from './weapons';

function makeOpticLensMaterial(isHolo: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vViewPos;
      varying vec3 vViewNorm;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vViewNorm = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 vViewPos;
      varying vec3 vViewNorm;
      void main() {
        vec3 V = normalize(-vViewPos);
        vec3 N = normalize(vViewNorm);
        float fresnel = pow(1.0 - abs(dot(V, N)), 2.2);

        ${
          isHolo
            ? `
        vec3 coatA = vec3(0.12, 0.42, 0.95);
        vec3 coatB = vec3(0.95, 0.18, 0.36);
        vec3 coat = mix(coatA, coatB, smoothstep(0.18, 0.85, fresnel + vUv.x * 0.25));
        vec2 p = (vUv - 0.5) * 2.0;
        p += V.xy * 0.14;
        float r = length(p);
        float dotCore = smoothstep(0.055, 0.022, r);
        float ring = smoothstep(0.032, 0.010, abs(r - 0.36));
        float ticks = (smoothstep(0.022, 0.008, abs(p.x)) * step(0.28, abs(p.y)) * step(abs(p.y), 0.44))
                    + (smoothstep(0.022, 0.008, abs(p.y)) * step(0.28, abs(p.x)) * step(abs(p.x), 0.44));
        float reticle = clamp(dotCore + ring * 0.85 + ticks * 0.85, 0.0, 1.0);
        `
            : `
        vec3 coatA = vec3(0.10, 0.65, 0.72);
        vec3 coatB = vec3(0.16, 0.32, 0.88);
        vec3 coat = mix(coatA, coatB, smoothstep(0.15, 0.88, fresnel + vUv.y * 0.2));
        vec2 p = (vUv - 0.5) * 2.0;
        p += V.xy * 0.12;
        float r = length(p);
        float reticle = smoothstep(0.068, 0.022, r);
        `
        }

        vec3 retCol = vec3(3.4, 0.35, 0.20) * reticle;
        vec3 lensCol = coat * (0.16 + fresnel * 0.52) + retCol;
        float alpha = clamp(0.12 + fresnel * 0.45 + reticle * 0.94, 0.0, 1.0);
        gl_FragColor = vec4(lensCol, alpha);
      }
    `,
  });
}

function simpleAttachmentMat(texSet: TextureLibrary['gunMetal'], tint: number, metalness = 0.86, roughness = 0.44): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: tint,
    map: texSet.map,
    normalMap: texSet.normalMap,
    roughnessMap: texSet.roughnessMap,
    metalnessMap: texSet.metalnessMap,
    metalness,
    roughness,
  });
}

export function buildHoloOpticGroup(textures: TextureLibrary): { group: THREE.Group; opticalOffsetY: number } {
  const g = new THREE.Group();
  const bodyMat = simpleAttachmentMat(textures.gunMetal, 0x727880, 0.82, 0.48);
  const parts: THREE.BufferGeometry[] = [];

  // Clamping base seated cleanly on rail top (y = 0)
  const base = createChamferedBox(0.030, 0.012, 0.074, 0.0022, 3, 3);
  base.translate(0, 0.006, 0);
  parts.push(base);

  // Side battery housing (+X)
  const batt = createChamferedBox(0.015, 0.021, 0.042, 0.0028, 3, 3);
  batt.translate(0.020, 0.015, 0.015);
  parts.push(batt);

  // Quick-Release throw lever (-X)
  const qr = createChamferedBox(0.006, 0.009, 0.028, 0.0015, 2, 2);
  qr.translate(-0.017, 0.006, -0.004);
  parts.push(qr);

  // Protective arched aluminum hood around center optical window y = 0.0245
  const centerY = 0.0245;
  for (const sx of [-0.0155, 0.0155]) {
    const wall = createChamferedBox(0.0045, 0.030, 0.050, 0.0012, 2, 2);
    wall.translate(sx, centerY, 0);
    parts.push(wall);
  }
  const hoodTop = createChamferedBox(0.0355, 0.0048, 0.050, 0.0014, 2, 2);
  hoodTop.translate(0, centerY + 0.015, 0);
  parts.push(hoodTop);

  // Elevation/Windage adjustment turrets
  for (const tz of [-0.012, 0.008]) {
    const knob = createLatheZ([[0.001, -0.003], [0.0042, -0.003], [0.0042, 0.003], [0.001, 0.003]], 12);
    knob.rotateY(Math.PI * 0.5);
    knob.translate(-0.018, 0.018, tz);
    parts.push(knob);
  }

  const mesh = new THREE.Mesh(mergeParts(parts, false), bodyMat);
  mesh.castShadow = true;
  g.add(mesh);

  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.025, 0.022), makeOpticLensMaterial(true));
  lens.position.set(0, centerY, 0);
  g.add(lens);

  return { group: g, opticalOffsetY: centerY };
}

export function buildRedDotOpticGroup(textures: TextureLibrary): { group: THREE.Group; opticalOffsetY: number } {
  const g = new THREE.Group();
  const bodyMat = simpleAttachmentMat(textures.gunMetal, 0x565c64, 0.88, 0.40);
  const parts: THREE.BufferGeometry[] = [];

  // Sleek low-riser mount (y = 0..0.012)
  const base = createChamferedBox(0.026, 0.012, 0.052, 0.002, 3, 3);
  base.translate(0, 0.006, 0);
  parts.push(base);

  // Open-frame arched reflex bezel centered at y = 0.0235
  const centerY = 0.0235;
  const archCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.014, 0.011, 0.012),
    new THREE.Vector3(-0.015, 0.027, 0.012),
    new THREE.Vector3(-0.009, 0.036, 0.012),
    new THREE.Vector3(0.0, 0.0375, 0.012),
    new THREE.Vector3(0.009, 0.036, 0.012),
    new THREE.Vector3(0.015, 0.027, 0.012),
    new THREE.Vector3(0.014, 0.011, 0.012),
  ]);
  for (let i = 0; i < 16; i++) {
    const t0 = i / 16;
    const t1 = (i + 1) / 16;
    const p0 = archCurve.getPoint(t0);
    const p1 = archCurve.getPoint(t1);
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const segLen = p0.distanceTo(p1) * 1.15;
    const seg = createChamferedBox(0.0038, segLen, 0.012, 0.0008, 2, 2);
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) - Math.PI * 0.5;
    seg.rotateZ(ang);
    seg.translate(mid.x, mid.y, mid.z);
    parts.push(seg);
  }

  // Rear emitter diode housing & clamping bolts
  const emitter = createChamferedBox(0.016, 0.007, 0.020, 0.0015, 2, 2);
  emitter.translate(0, 0.0135, -0.012);
  parts.push(emitter);
  for (const bz of [-0.014, 0.014]) {
    const bolt = createLatheZ([[0.001, -0.004], [0.0036, -0.004], [0.0036, 0.004], [0.001, 0.004]], 10);
    bolt.rotateY(Math.PI * 0.5);
    bolt.translate(0.014, 0.006, bz);
    parts.push(bolt);
  }

  const mesh = new THREE.Mesh(mergeParts(parts, false), bodyMat);
  mesh.castShadow = true;
  g.add(mesh);

  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.024, 0.020), makeOpticLensMaterial(false));
  lens.position.set(0, centerY, 0.012);
  g.add(lens);

  return { group: g, opticalOffsetY: centerY };
}

export function buildTacticalSuppressorGroup(textures: TextureLibrary, scaleR = 1.0): THREE.Group {
  const g = new THREE.Group();
  const mat = simpleAttachmentMat(textures.gunMetal, 0x626870, 0.85, 0.46);
  const parts: THREE.BufferGeometry[] = [];

  const r = 0.0175 * scaleR;
  const tube = createLatheZ(
    [
      [0.009, -0.012],
      [r * 1.12, -0.008],
      [r * 1.12, 0.018], // QD locking collar
      [r, 0.022],
      [r, 0.148],
      [r * 0.94, 0.156],
      [0.0055, 0.156],
      [0.0048, 0.140],
    ],
    32
  );
  parts.push(tube);

  // Fluted heat-dissipation rings along body
  for (let i = 0; i < 6; i++) {
    const rz = 0.042 + i * 0.017;
    const rib = createLatheZ(
      [
        [r * 0.98, rz - 0.003],
        [r * 1.06, rz - 0.002],
        [r * 1.06, rz + 0.002],
        [r * 0.98, rz + 0.003],
      ],
      24
    );
    parts.push(rib);
  }

  const mesh = new THREE.Mesh(mergeParts(parts, false), mat);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

export function buildMuzzleBrakeGroup(textures: TextureLibrary): THREE.Group {
  const g = new THREE.Group();
  const mat = simpleAttachmentMat(textures.gunMetal, 0x525860, 0.9, 0.36);
  const parts: THREE.BufferGeometry[] = [];

  // Rear thread collar
  const collar = createLatheZ(
    [
      [0.008, -0.006],
      [0.0125, -0.004],
      [0.0125, 0.012],
      [0.007, 0.014],
    ],
    22
  );
  parts.push(collar);

  // Dual-chamber open-port CNC compensator baffles
  for (const bz of [0.016, 0.036, 0.054]) {
    const baffle = createChamferedBox(0.024, 0.021, 0.008, 0.0018, 2, 2);
    baffle.translate(0, 0, bz);
    parts.push(baffle);
  }
  for (const sy of [-0.0085, 0.0085]) {
    const rail = createChamferedBox(0.017, 0.004, 0.046, 0.001, 2, 2);
    rail.translate(0, sy, 0.035);
    parts.push(rail);
  }

  const mesh = new THREE.Mesh(mergeParts(parts, false), mat);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

export function buildVerticalForegripGroup(textures: TextureLibrary): THREE.Group {
  const g = new THREE.Group();
  const polyMat = new THREE.MeshStandardMaterial({
    color: 0x26292d,
    map: textures.gunPolymer.map,
    normalMap: textures.gunPolymer.normalMap,
    roughnessMap: textures.gunPolymer.roughnessMap,
    roughness: 0.85,
    metalness: 0.06,
  });
  const clampMat = simpleAttachmentMat(textures.gunMetal, 0x585e66, 0.88, 0.40);

  // Rail mounting clamp bracket (top flush with rail at y=0)
  const clamp = createChamferedBox(0.027, 0.014, 0.042, 0.0022, 2, 2);
  clamp.translate(0, -0.004, 0);
  const clampMesh = new THREE.Mesh(clamp, clampMat);
  g.add(clampMesh);

  // Vertical ribbed polymer handle shaft (+Z rotated +90 deg around X -> hangs straight DOWN along -Y!)
  const postParts: THREE.BufferGeometry[] = [];
  const lathe = createLatheZ(
    [
      [0.0155, 0.008],
      [0.0165, 0.015],
      [0.0142, 0.030],
      [0.0142, 0.086],
      [0.0155, 0.094],
      [0.001, 0.096],
    ],
    24
  );
  lathe.rotateX(Math.PI * 0.5);
  postParts.push(lathe);

  for (let i = 0; i < 6; i++) {
    const gy = -0.036 - i * 0.0085;
    const rib = createLatheZ([[0.014, -0.002], [0.0154, -0.001], [0.0154, 0.001], [0.014, 0.002]], 20);
    rib.rotateX(Math.PI * 0.5);
    rib.translate(0, gy, 0);
    postParts.push(rib);
  }

  const postMesh = new THREE.Mesh(mergeParts(postParts, false), polyMat);
  postMesh.castShadow = true;
  g.add(postMesh);
  return g;
}

export function buildAngledForegripGroup(textures: TextureLibrary): THREE.Group {
  const g = new THREE.Group();
  const polyMat = new THREE.MeshStandardMaterial({
    color: 0x26292d,
    map: textures.gunPolymer.map,
    normalMap: textures.gunPolymer.normalMap,
    roughnessMap: textures.gunPolymer.roughnessMap,
    roughness: 0.84,
    metalness: 0.06,
  });

  // Sculpted 32-deg AFG ramp profile flush up against bottom rail y=0
  const afgShape = new THREE.Shape();
  afgShape.moveTo(-0.058, 0.002);
  afgShape.lineTo(0.056, 0.002);
  afgShape.lineTo(0.056, -0.022);
  afgShape.lineTo(0.044, -0.034); // Front finger stop
  afgShape.lineTo(0.034, -0.034);
  afgShape.lineTo(0.028, -0.026);
  afgShape.lineTo(-0.046, -0.010); // Angled palm ramp
  afgShape.lineTo(-0.058, -0.010);
  afgShape.closePath();

  const body = createBeveledShape(afgShape, 0.028, 0.003, 3, 4);
  body.rotateY(-Math.PI * 0.5);
  const mesh = new THREE.Mesh(body, polyMat);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

export function buildSideFlashlightGroup(textures: TextureLibrary): THREE.Group {
  const g = new THREE.Group();
  const darkMat = simpleAttachmentMat(textures.gunMetal, 0x565c64, 0.88, 0.40);
  const parts: THREE.BufferGeometry[] = [];

  // Offset Picatinny mounting arm connecting inward (+X toward barrel)
  const mount = createChamferedBox(0.018, 0.013, 0.034, 0.002, 2, 2);
  mount.translate(0.008, 0, -0.015);
  parts.push(mount);

  // Flashlight cylindrical tube + flared bezel head along +Z
  const body = createLatheZ(
    [
      [0.002, -0.060],
      [0.010, -0.056],
      [0.010, 0.010],
      [0.0132, 0.016],
      [0.0132, 0.044],
      [0.011, 0.046],
      [0.0095, 0.038],
    ],
    22
  );
  body.translate(-0.004, 0, 0);
  parts.push(body);

  const mesh = new THREE.Mesh(mergeParts(parts, false), darkMat);
  mesh.castShadow = true;
  g.add(mesh);

  const lensMat = new THREE.MeshStandardMaterial({
    color: 0xaad4ff,
    emissive: new THREE.Color(0x3a5275),
    emissiveIntensity: 0.7,
    roughness: 0.05,
    metalness: 0.85,
  });
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0095, 16), lensMat);
  lens.position.set(-0.004, 0, 0.044);
  g.add(lens);

  return g;
}

/**
 * Dynamically populates & activates all modular attachment slots onto a WeaponBuildResult,
 * updating leftGripSocket, sightAlignOffset, muzzlePoint, and magazine visuals immediately.
 */
export function applyWeaponAttachments(
  weaponId: WeaponId,
  build: WeaponBuildResult,
  config: WeaponLoadoutConfig,
  textures: TextureLibrary
): void {
  if (weaponId === 'm1911') {
    build.sightAlignOffset.y = build.sockets.ironSightY;
    return;
  }

  const s = build.sockets;

  // 1. OPTIC SLOT
  build.opticSlot.clear();
  if (config.optic === 'iron') {
    if (build.ironSightsGroup) build.ironSightsGroup.visible = true;
    if (build.foldedRearSight) build.foldedRearSight.visible = false;
    build.sightAlignOffset.y = s.ironSightY;
  } else {
    if (build.ironSightsGroup) build.ironSightsGroup.visible = false;
    if (build.foldedRearSight) build.foldedRearSight.visible = true;
    const built =
      config.optic === 'red_dot'
        ? buildRedDotOpticGroup(textures)
        : buildHoloOpticGroup(textures);
    build.opticSlot.position.set(0, s.opticMountY, s.opticMountZ);
    build.opticSlot.add(built.group);
    build.sightAlignOffset.y = s.opticMountY + built.opticalOffsetY;
  }

  // 2. MUZZLE SLOT
  build.muzzleSlot.clear();
  const effMuzzle = weaponId === 'mp5sd' && config.muzzle === 'default' ? 'suppressor' : config.muzzle;
  if (weaponId === 'mp5sd') {
    if (effMuzzle === 'suppressor') {
      if (build.defaultSuppressor) build.defaultSuppressor.visible = true;
      if (build.brakeExposedBarrel) build.brakeExposedBarrel.visible = false;
      build.muzzlePoint.position.set(0, s.muzzleMountY, s.muzzleMountZ);
    } else {
      if (build.defaultSuppressor) build.defaultSuppressor.visible = false;
      if (build.brakeExposedBarrel) build.brakeExposedBarrel.visible = true;
      const brake = buildMuzzleBrakeGroup(textures);
      build.muzzleSlot.position.set(0, s.muzzleMountY, 0.258);
      build.muzzleSlot.add(brake);
      build.muzzlePoint.position.set(0, s.muzzleMountY, 0.318);
    }
  } else {
    if (effMuzzle === 'default') {
      if (build.defaultFlashHider) build.defaultFlashHider.visible = true;
      build.muzzlePoint.position.set(0, s.muzzleMountY, s.muzzleMountZ + 0.055);
    } else if (effMuzzle === 'suppressor') {
      if (build.defaultFlashHider) build.defaultFlashHider.visible = false;
      const rScale = weaponId === 'm7' ? 1.15 : 1.0;
      const sup = buildTacticalSuppressorGroup(textures, rScale);
      build.muzzleSlot.position.set(0, s.muzzleMountY, s.muzzleMountZ);
      build.muzzleSlot.add(sup);
      build.muzzlePoint.position.set(0, s.muzzleMountY, s.muzzleMountZ + 0.160);
    } else {
      if (build.defaultFlashHider) build.defaultFlashHider.visible = false;
      const brake = buildMuzzleBrakeGroup(textures);
      build.muzzleSlot.position.set(0, s.muzzleMountY, s.muzzleMountZ);
      build.muzzleSlot.add(brake);
      build.muzzlePoint.position.set(0, s.muzzleMountY, s.muzzleMountZ + 0.062);
    }
  }

  // 3. UNDERBARREL SLOT + LEFT HAND IK TARGET
  build.underSlot.clear();
  if (config.underbarrel === 'vertical') {
    const vfg = buildVerticalForegripGroup(textures);
    build.underSlot.position.set(0, s.underMountY, s.underMountZ);
    build.underSlot.add(vfg);
    build.currentGripStyle = 'vertical';
    build.leftGripSocket.position.set(0.0, s.underMountY - 0.056, s.underMountZ);
  } else if (config.underbarrel === 'angled' && weaponId === 'mp5sd') {
    const afg = buildAngledForegripGroup(textures);
    build.underSlot.position.set(0, s.underMountY, s.underMountZ);
    build.underSlot.add(afg);
    build.currentGripStyle = 'angled';
    build.leftGripSocket.position.set(0.0, s.underMountY - 0.018, s.underMountZ);
  } else {
    build.currentGripStyle = 'none';
    build.leftGripSocket.position.copy(build.baseLeftGripPos);
  }

  // 4. SIDE RAIL FLASHLIGHT
  build.sideSlot.clear();
  if (config.side === 'flashlight') {
    const fl = buildSideFlashlightGroup(textures);
    build.sideSlot.position.set(s.sideMountX, s.sideMountY, s.sideMountZ);
    build.sideSlot.add(fl);
  }

  // 5. MAGAZINE VARIANT
  if (build.fastMagLoop) {
    build.fastMagLoop.visible = config.mag === 'fast';
  }
  if (build.extMagExtension) {
    build.extMagExtension.visible = config.mag === 'extended';
  }
}
