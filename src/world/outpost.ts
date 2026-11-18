import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { createBeveledShape, createChamferedBox, createLatheZ, loftRings, mergeParts } from '../proc/modeling';
import { mulberry32 } from '../proc/noise';
import { TextureLibrary } from '../proc/textures';
import { BattlefieldTerrain } from './terrain';
import { MaterialId } from '../types';

export interface BoxCollider {
  box: THREE.Box3;
  material: MaterialId;
  blocksSight: boolean;
}

export interface OutpostSystem {
  group: THREE.Group;
  colliders: BoxCollider[];
  meshesForRaycast: THREE.Object3D[];
  commsTerminalPos: THREE.Vector3;
  extractionPos: THREE.Vector3;
  checkpointPos: THREE.Vector3;
  beaconLight: THREE.PointLight;
  lzLight: THREE.PointLight;
  update(elapsed: number): void;
}

/**
 * Builds a single gravity-slumped rectangular bolster sandbag (flat contact top/bottom,
 * pillowed burlap waist, stitched end seams — zero floating ellipsoid gaps!).
 */
function buildSingleSandbagGeo(seed: number): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const length = 0.64;
  const width = 0.36;
  const height = 0.145;
  const zRings = 11;
  const radial = 16;
  const rings: THREE.Vector3[][] = [];

  for (let i = 0; i <= zRings; i++) {
    const t = i / zRings;
    const z = (t - 0.5) * length;
    // Steep pillow taper only at the very ends (sewn corners) so body stays rectangular & stacked flush
    const endEnvelope = Math.pow(Math.sin(t * Math.PI), 0.24);
    const foldCrease = 1.0 + Math.sin(t * 19 + seed) * 0.025;
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Rounded-box superellipse cross-section (flat bottom/top contact faces!)
      const sx = Math.sign(ca) * Math.pow(Math.abs(ca), 0.52);
      const sy = Math.sign(sa) * Math.pow(Math.abs(sa), 0.48);
      const rx = width * 0.5 * endEnvelope * foldCrease * (1 + (rng() - 0.5) * 0.03);
      // Slight bottom flattening & gravity bulge at sides
      const ry = height * 0.5 * Math.pow(Math.sin(t * Math.PI), 0.30) * (sa < 0 ? 0.88 : 1.02);
      ring.push(new THREE.Vector3(sx * rx, sy * ry, z));
    }
    rings.push(ring);
  }
  return loftRings(rings, true, true);
}

/**
 * Builds a staggered multi-course sculpted sandbag barrier (~2.5m wide x 1.15m high)
 * including an extra buried foundation course (-0.15m) so sloped ground never shows gaps!
 */
function buildSandbagWallGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const bagA = buildSingleSandbagGeo(11);
  const bagB = buildSingleSandbagGeo(29);
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const cols = r % 2 === 0 ? 4 : 3;
    // Row 0 sits at y = -0.08m (embedded 15cm into sloped earth!)
    const y = -0.08 + r * 0.132;
    const xStart = -((cols - 1) * 0.58) * 0.5;
    for (let c = 0; c < cols; c++) {
      const b = (r + c) % 2 === 0 ? bagA.clone() : bagB.clone();
      b.rotateY(Math.PI * 0.5 + (((r * 7 + c * 13) % 5) - 2) * 0.02);
      b.translate(xStart + c * 0.58, y, (((r + c) % 3) - 1) * 0.012);
      parts.push(b);
    }
  }
  bagA.dispose();
  bagB.dispose();
  return mergeParts(parts, true);
}

/**
 * Builds a realistic Jersey concrete barrier with sloped base skirt & lifting slots.
 */
function buildJerseyBarrierGeo(length = 2.8): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.34, 0);
  shape.lineTo(0.34, 0);
  shape.lineTo(0.32, 0.14);
  shape.lineTo(0.16, 0.34);
  shape.lineTo(0.11, 0.98);
  shape.lineTo(-0.11, 0.98);
  shape.lineTo(-0.16, 0.34);
  shape.lineTo(-0.32, 0.14);
  shape.closePath();
  const geo = createBeveledShape(shape, length, 0.025, 3, 4);
  geo.rotateY(Math.PI * 0.5);
  return geo;
}

/**
 * Builds a broken, weathered wooden perimeter fence with chipped planks & irregular tops.
 */
function buildBrokenWoodenFenceGeo(seed: number): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const width = 3.2;

  // Two sturdy chamfered posts
  for (const px of [-width * 0.48, width * 0.48]) {
    const post = createChamferedBox(0.13, 1.65, 0.13, 0.015, 2, 2);
    post.rotateZ((rng() - 0.5) * 0.05);
    post.translate(px, 0.78, 0);
    parts.push(post);
  }

  // Two horizontal cross-rails
  for (const ry of [0.42, 1.15]) {
    const rail = createChamferedBox(width, 0.09, 0.05, 0.01, 2, 2);
    rail.translate(0, ry, -0.04);
    parts.push(rail);
  }

  // Individual vertical planks with splintered/broken jagged heights & missing gaps
  const numPlanks = 14;
  for (let i = 0; i < numPlanks; i++) {
    if (i === 5 || i === 10) continue; // Battle-damaged gaps!
    const x = -width * 0.44 + (i / (numPlanks - 1)) * (width * 0.88);
    const h = 0.85 + rng() * 0.72;
    const tilt = (rng() - 0.5) * 0.07;

    const pShape = new THREE.Shape();
    const hw = 0.088;
    pShape.moveTo(-hw, 0);
    pShape.lineTo(hw, 0);
    pShape.lineTo(hw, h - rng() * 0.14);
    pShape.lineTo(0.01, h + (rng() - 0.5) * 0.08);
    pShape.lineTo(-hw, h - rng() * 0.16);
    pShape.closePath();

    const plank = createBeveledShape(pShape, 0.032, 0.006, 2, 2);
    plank.rotateZ(tilt);
    plank.translate(x, 0.04, 0.025);
    parts.push(plank);
  }

  return mergeParts(parts, true);
}

/**
 * Builds a military reinforced wooden ammo crate with corner framing & battens.
 */
function buildAmmoCrateGeo(w = 1.25, h = 0.88, d = 0.92): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(createChamferedBox(w, h, d, 0.018, 2, 2));
  // Frame battens
  for (const sx of [-w * 0.47, w * 0.47]) {
    const batten = createChamferedBox(0.07, h + 0.02, d + 0.02, 0.01, 2, 2);
    batten.translate(sx, 0, 0);
    parts.push(batten);
  }
  const topLid = createChamferedBox(w + 0.04, 0.07, d + 0.04, 0.012, 2, 2);
  topLid.translate(0, h * 0.5, 0);
  parts.push(topLid);
  return mergeParts(parts, true);
}

/**
 * Builds a ribbed 55-gallon military steel drum.
 */
function buildSteelDrumGeo(): THREE.BufferGeometry {
  const pts: Array<[number, number]> = [
    [0.01, 0],
    [0.29, 0],
    [0.29, 0.28],
    [0.315, 0.30],
    [0.315, 0.33],
    [0.29, 0.35],
    [0.29, 0.58],
    [0.315, 0.60],
    [0.315, 0.63],
    [0.29, 0.65],
    [0.29, 0.90],
    [0.305, 0.92],
    [0.27, 0.92],
    [0.27, 0.89],
    [0.01, 0.89],
  ];
  const lathe = new THREE.LatheGeometry(
    pts.map(([r, y]) => new THREE.Vector2(r, y)),
    24
  );
  return lathe;
}

/**
 * Builds coiled concertina barbed wire along X axis.
 */
function buildBarbedWireGeo(length = 3.2): THREE.BufferGeometry {
  const turns = 12;
  const pts: THREE.Vector3[] = [];
  const steps = turns * 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    pts.push(
      new THREE.Vector3(
        (t - 0.5) * length,
        0.38 + Math.sin(a) * 0.34,
        Math.cos(a) * 0.34
      )
    );
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, steps, 0.014, 6, false);
}

export function buildMilitaryOutpost(
  terrain: BattlefieldTerrain,
  textures: TextureLibrary,
  csm?: CSM
): OutpostSystem {
  const group = new THREE.Group();
  group.name = 'MilitaryOutpost';
  const colliders: BoxCollider[] = [];
  const meshesForRaycast: THREE.Object3D[] = [];

  const concreteMat = new THREE.MeshStandardMaterial({
    map: textures.concrete.map,
    normalMap: textures.concrete.normalMap,
    normalScale: new THREE.Vector2(1.3, 1.3),
    roughnessMap: textures.concrete.roughnessMap,
    aoMap: textures.concrete.aoMap,
    color: 0xaab0b4,
    roughness: 0.62, // Rain-damp concrete
    metalness: 0.05,
  });
  const sandbagMat = new THREE.MeshStandardMaterial({
    map: textures.sandbagBurlap.map,
    normalMap: textures.sandbagBurlap.normalMap,
    normalScale: new THREE.Vector2(1.4, 1.4),
    roughnessMap: textures.sandbagBurlap.roughnessMap,
    aoMap: textures.sandbagBurlap.aoMap,
    color: 0xa69b82,
    roughness: 0.78,
  });
  const woodMat = new THREE.MeshStandardMaterial({
    map: textures.woodPlank.map,
    normalMap: textures.woodPlank.normalMap,
    normalScale: new THREE.Vector2(1.3, 1.3),
    roughnessMap: textures.woodPlank.roughnessMap,
    aoMap: textures.woodPlank.aoMap,
    color: 0x8e745c,
    roughness: 0.68,
  });
  const metalPropMat = new THREE.MeshStandardMaterial({
    map: textures.industrialMetal.map,
    normalMap: textures.industrialMetal.normalMap,
    normalScale: new THREE.Vector2(1.3, 1.3),
    roughnessMap: textures.industrialMetal.roughnessMap,
    metalnessMap: textures.industrialMetal.metalnessMap,
    aoMap: textures.industrialMetal.aoMap,
    color: 0xffffff,
    roughness: 1.0,
    metalness: 1.0,
  });
  const wireMat = new THREE.MeshStandardMaterial({
    color: 0x62676b,
    roughness: 0.42,
    metalness: 0.85,
  });

  if (csm) {
    csm.setupMaterial(concreteMat);
    csm.setupMaterial(sandbagMat);
    csm.setupMaterial(woodMat);
    csm.setupMaterial(metalPropMat);
    csm.setupMaterial(wireMat);
  }

  const addProp = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    z: number,
    rotY: number,
    colliderMat: MaterialId,
    blocksSight = true,
    yOffset = -0.14,
    addCol = true
  ): THREE.Mesh => {
    // Sample footprint endpoints so sloped ground never leaves any corner floating!
    const cosR = Math.cos(rotY);
    const sinR = Math.sin(rotY);
    const hC = terrain.getHeightAt(x, z);
    const hL = terrain.getHeightAt(x - cosR * 1.15, z + sinR * 1.15);
    const hR = terrain.getHeightAt(x + cosR * 1.15, z - sinR * 1.15);
    const wy = Math.min(hC, hL, hR) + yOffset;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, wy, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.updateMatrixWorld(true);
    group.add(mesh);
    meshesForRaycast.push(mesh);

    if (addCol) {
      const box = new THREE.Box3().setFromObject(mesh);
      colliders.push({ box, material: colliderMat, blocksSight });
    }
    return mesh;
  };

  // Shared Geometries
  const sandbagWallGeo = buildSandbagWallGeo();
  const barrierGeo = buildJerseyBarrierGeo(2.8);
  const fenceGeoA = buildBrokenWoodenFenceGeo(71);
  const fenceGeoB = buildBrokenWoodenFenceGeo(93);
  const crateGeo = buildAmmoCrateGeo(1.25, 0.88, 0.92);
  const drumGeo = buildSteelDrumGeo();
  const wireGeo = buildBarbedWireGeo(3.2);

  // --- A. APPROACH COVER & OUTER CHECKPOINT (z ~ 34) ---
  const checkpointPos = new THREE.Vector3(6, terrain.getHeightAt(6, 34), 34);
  addProp(barrierGeo, concreteMat, 3.2, 34.5, 0.2, MaterialId.CONCRETE, false);
  addProp(barrierGeo, concreteMat, 8.8, 33.0, -0.28, MaterialId.CONCRETE, false);
  addProp(sandbagWallGeo, sandbagMat, 6.2, 31.2, 0.05, MaterialId.SANDBAG, false);
  addProp(crateGeo, woodMat, 10.2, 35.4, 0.4, MaterialId.WOOD, false);
  addProp(drumGeo, metalPropMat, 1.4, 33.8, 0, MaterialId.METAL, false);
  addProp(fenceGeoA, woodMat, -1.8, 36.2, 0.35, MaterialId.WOOD, false);
  addProp(wireGeo, wireMat, -5.5, 36.8, 0.25, MaterialId.METAL, false, -0.02, false);

  // Mid-field forward skirmish cover (z ~ 55 & z ~ 14)
  addProp(sandbagWallGeo, sandbagMat, -4.5, 58, 0.3, MaterialId.SANDBAG, false);
  addProp(crateGeo, woodMat, 6.5, 52, -0.2, MaterialId.WOOD, false);
  addProp(barrierGeo, concreteMat, -3.0, 14, 0.15, MaterialId.CONCRETE, false);
  addProp(sandbagWallGeo, sandbagMat, 5.2, 10, -0.25, MaterialId.SANDBAG, false);

  // --- B. MAIN MILITARY OUTPOST COMPOUND (centered at x=0, z=-34) ---
  const baseY = terrain.getHeightAt(0, -34);

  // Reinforced Concrete Bunker / Command Pillbox at (-6, -38)
  const buildBunker = (bx: number, bz: number, rotY: number) => {
    const by = terrain.getHeightAt(bx, bz) - 0.12;
    const bGroup = new THREE.Group();
    bGroup.position.set(bx, by, bz);
    bGroup.rotation.y = rotY;

    // Concrete foundation slab
    const floor = new THREE.Mesh(createChamferedBox(7.2, 0.35, 6.2, 0.05, 2, 2), concreteMat);
    floor.position.set(0, 0.17, 0);
    floor.receiveShadow = true;
    bGroup.add(floor);

    // Thick Bunker Walls (left, right, back, front split with embrasure & doorway!)
    const wallSpecs: Array<[number, number, number, number, number, number]> = [
      [-3.35, 1.45, 0, 0.5, 2.7, 5.8], // Left wall
      [3.35, 1.45, 0, 0.5, 2.7, 5.8],  // Right wall
      [-2.1, 1.45, -2.75, 2.2, 2.7, 0.5], // Back-left
      [2.1, 1.45, -2.75, 2.2, 2.7, 0.5],  // Back-right (doorway gap in center!)
      [0, 2.45, -2.75, 2.4, 0.7, 0.5],    // Back lintel over doorway
      // Front parapet lower half + upper lintel leaving a wide 0.65m firing slit!
      [0, 0.65, 2.75, 6.4, 1.15, 0.5],
      [0, 2.42, 2.75, 6.4, 0.75, 0.5],
      [-2.4, 1.65, 2.75, 1.6, 0.9, 0.5],
      [2.4, 1.65, 2.75, 1.6, 0.9, 0.5],
    ];

    for (const [wx, wy, wz, sw, sh, sd] of wallSpecs) {
      const m = new THREE.Mesh(createChamferedBox(sw, sh, sd, 0.04, 2, 2), concreteMat);
      m.position.set(wx, wy, wz);
      m.castShadow = true;
      m.receiveShadow = true;
      bGroup.add(m);
    }

    // Overhanging beveled concrete roof slab + rooftop sandbag parapet
    const roof = new THREE.Mesh(createChamferedBox(7.8, 0.42, 6.8, 0.06, 3, 3), concreteMat);
    roof.position.set(0, 2.95, 0);
    roof.castShadow = true;
    roof.receiveShadow = true;
    bGroup.add(roof);

    group.add(bGroup);
    bGroup.updateMatrixWorld(true);
    meshesForRaycast.push(bGroup);

    // Add exact wall colliders in world space
    bGroup.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child !== floor) {
        const box = new THREE.Box3().setFromObject(child);
        colliders.push({ box, material: MaterialId.CONCRETE, blocksSight: true });
      }
    });
  };

  buildBunker(-6.5, -39, 0.12);
  buildBunker(8.5, -41, -0.22);

  // Outpost Perimeter Walls, Broken Wooden Fences, Sandbag Positions, Crates & Barrels
  // Front South Perimeter (z ~ -16) with central breached entry
  addProp(barrierGeo, concreteMat, -8.5, -16.5, 0.05, MaterialId.CONCRETE, false);
  addProp(sandbagWallGeo, sandbagMat, -4.5, -16.0, 0.0, MaterialId.SANDBAG, false);
  addProp(sandbagWallGeo, sandbagMat, 4.8, -16.0, -0.1, MaterialId.SANDBAG, false);
  addProp(barrierGeo, concreteMat, 9.2, -17.0, -0.15, MaterialId.CONCRETE, false);
  addProp(wireGeo, wireMat, -13.0, -17.5, 0.2, MaterialId.METAL, false, -0.02, false);
  addProp(wireGeo, wireMat, 13.5, -18.0, -0.2, MaterialId.METAL, false, -0.02, false);

  // West & East Flank Broken Wooden Fences & Concrete Barriers
  addProp(fenceGeoA, woodMat, -17.5, -23.0, Math.PI * 0.5, MaterialId.WOOD, false);
  addProp(fenceGeoB, woodMat, -17.8, -30.5, Math.PI * 0.48, MaterialId.WOOD, false);
  addProp(fenceGeoA, woodMat, -17.5, -38.0, Math.PI * 0.52, MaterialId.WOOD, false);
  addProp(fenceGeoB, woodMat, 17.5, -24.0, Math.PI * 0.5, MaterialId.WOOD, false);
  addProp(fenceGeoA, woodMat, 17.8, -32.0, Math.PI * 0.47, MaterialId.WOOD, false);
  addProp(fenceGeoB, woodMat, 17.4, -39.5, Math.PI * 0.51, MaterialId.WOOD, false);

  // Courtyard Tactical Cover (Crates, Drums, Jersey Barriers)
  addProp(crateGeo, woodMat, -1.8, -26.5, 0.42, MaterialId.WOOD, false);
  addProp(crateGeo, woodMat, -0.4, -27.2, 0.1, MaterialId.WOOD, false);
  addProp(drumGeo, metalPropMat, 3.2, -25.0, 0, MaterialId.METAL, false);
  addProp(drumGeo, metalPropMat, 3.9, -25.5, 0, MaterialId.METAL, false);
  addProp(sandbagWallGeo, sandbagMat, 1.5, -32.0, 0.2, MaterialId.SANDBAG, false);
  addProp(barrierGeo, concreteMat, -9.5, -27.0, 0.7, MaterialId.CONCRETE, false);
  addProp(crateGeo, woodMat, 10.5, -29.0, -0.5, MaterialId.WOOD, false);

  // --- C. CENTRAL COMMS TERMINAL & FLOODLIGHT MAST (Capture Objective!) ---
  const commsTerminalPos = new THREE.Vector3(1.2, baseY, -36.5);
  const commsGroup = new THREE.Group();
  commsGroup.position.copy(commsTerminalPos);

  const commsRack = new THREE.Mesh(createChamferedBox(1.1, 1.65, 0.75, 0.03, 2, 2), metalPropMat);
  commsRack.position.y = 0.82;
  commsRack.castShadow = true;
  commsRack.receiveShadow = true;
  commsGroup.add(commsRack);

  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x112a22,
    emissive: new THREE.Color(0x22dd88),
    emissiveIntensity: 1.8,
    roughness: 0.2,
  });
  const screenMesh = new THREE.Mesh(createChamferedBox(0.65, 0.42, 0.06, 0.01, 2, 2), screenMat);
  screenMesh.position.set(0, 1.25, 0.36);
  commsGroup.add(screenMesh);

  // Tall steel comms antenna + floodlight mast
  const mast = new THREE.Mesh(
    createLatheZ([[0.055, 0], [0.055, 5.4], [0.035, 5.5], [0.035, 7.6]], 14),
    metalPropMat
  );
  mast.rotation.x = -Math.PI * 0.5;
  mast.position.set(-0.38, 0, -0.2);
  mast.castShadow = true;
  commsGroup.add(mast);

  // Glowing Amber Emergency / Flood Lamp on mast (casts dramatic specular reflections in courtyard puddles!)
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xffcc88,
    emissive: new THREE.Color(0xff9933),
    emissiveIntensity: 4.5,
  });
  const lampHead = new THREE.Mesh(createChamferedBox(0.36, 0.18, 0.22, 0.02, 2, 2), lampMat);
  lampHead.position.set(-0.38, 5.2, 0.0);
  commsGroup.add(lampHead);

  const beaconLight = new THREE.PointLight(0xff9944, 24.0, 26, 1.6);
  beaconLight.position.set(-0.38, 5.0, 0.25);
  commsGroup.add(beaconLight);

  group.add(commsGroup);
  commsGroup.updateMatrixWorld(true);
  meshesForRaycast.push(commsRack);
  colliders.push({
    box: new THREE.Box3().setFromObject(commsRack),
    material: MaterialId.METAL,
    blocksSight: false,
  });

  // --- D. EXTRACTION ZONE (LZ) AT (-46, -88) ---
  const lzY = terrain.getHeightAt(-46, -88);
  const extractionPos = new THREE.Vector3(-46, lzY, -88);
  addProp(sandbagWallGeo, sandbagMat, -43.0, -85.0, -0.7, MaterialId.SANDBAG, false);
  addProp(sandbagWallGeo, sandbagMat, -49.5, -90.5, 2.3, MaterialId.SANDBAG, false);
  addProp(crateGeo, woodMat, -48.5, -85.5, 0.3, MaterialId.WOOD, false);

  const lzFlareMat = new THREE.MeshStandardMaterial({
    color: 0x44ff88,
    emissive: new THREE.Color(0x22ee66),
    emissiveIntensity: 5.5,
  });
  const lzBeacon = new THREE.Mesh(createChamferedBox(0.16, 0.45, 0.16, 0.02, 2, 2), lzFlareMat);
  lzBeacon.position.set(extractionPos.x, lzY + 0.2, extractionPos.z);
  group.add(lzBeacon);

  const lzLight = new THREE.PointLight(0x33ff77, 14.0, 18, 1.6);
  lzLight.position.set(extractionPos.x, lzY + 1.0, extractionPos.z);
  group.add(lzLight);

  return {
    group,
    colliders,
    meshesForRaycast,
    commsTerminalPos,
    extractionPos,
    checkpointPos,
    beaconLight,
    lzLight,
    update(elapsed: number) {
      beaconLight.intensity = 22 + Math.sin(elapsed * 5.2) * 3.0;
      lzLight.intensity = 12 + Math.sin(elapsed * 8.5) * 4.5;
    },
  };
}
