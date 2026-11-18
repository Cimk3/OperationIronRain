import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createChamferedBox, createLatheZ } from '../proc/modeling';
import { TextureLibrary } from '../proc/textures';
import { MaterialId } from '../types';
import { BoxCollider } from './outpost';

export interface ShootableLight {
  id: number;
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  pos: THREE.Vector3;
  broken: boolean;
  flickerPhase: number;
  baseIntensity: number;
}

export interface FloorZone {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  yAt: (x: number, z: number) => number;
  mat: MaterialId;
}

interface DynamicPointLight {
  pos: THREE.Vector3;
  light: THREE.PointLight;
  baseIntensity: number;
  flicker: boolean;
  phase: number;
  bulbMat?: THREE.MeshStandardMaterial;
  shootable?: ShootableLight;
  isAlarm?: boolean;
}

type ZoneKey = 'ext' | 'ramp' | 'corridors' | 'silo' | 'escape';

interface BatchBucket {
  mat: THREE.Material;
  matId: MaterialId;
  isFloor: boolean;
  castShadow: boolean;
  geos: THREE.BufferGeometry[];
}

function applyWorldBoxUVs(
  geo: THREE.BufferGeometry,
  wx: number,
  wy: number,
  wz: number,
  tileW = 2.6,
  tileH = 3.8,
  floorTile = 2.4
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const norm = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  if (!pos || !norm || !uv) return;

  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i) + wx;
    const py = pos.getY(i) + wy;
    const pz = pos.getZ(i) + wz;
    const nx = Math.abs(norm.getX(i));
    const ny = Math.abs(norm.getY(i));
    const nz = Math.abs(norm.getZ(i));

    if (ny >= nx && ny >= nz) {
      uv.setXY(i, px / floorTile, pz / floorTile);
    } else if (nx >= nz) {
      uv.setXY(i, pz / tileW, (py + 8.0) / tileH);
    } else {
      uv.setXY(i, px / tileW, (py + 8.0) / tileH);
    }
  }
  uv.needsUpdate = true;
}

function normalizeForBatch(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    const count = g.attributes.position.count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (g.attributes.color) g.deleteAttribute('color');
  if (g.attributes.tangent) g.deleteAttribute('tangent');
  return g;
}

function makeStencilSignTexture(
  title: string,
  sub: string,
  bgColor = '#252a2e',
  accentColor = '#d49a2a'
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, 246, 118);

  ctx.fillStyle = accentColor;
  ctx.fillRect(10, 10, 236, 26);

  ctx.fillStyle = '#14171a';
  ctx.font = 'bold 17px Consolas, monospace';
  ctx.fillText(sub, 18, 29);

  ctx.fillStyle = '#e5e9ec';
  ctx.font = 'bold 28px Consolas, monospace';
  ctx.fillText(title, 18, 82);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeFloorGlowTexture(hexColor: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, hexColor);
  grad.addColorStop(0.5, hexColor.replace('1)', '0.28)').replace('0.9)', '0.25)'));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SiloWorld {
  public group = new THREE.Group();
  public mesh: THREE.Group;
  public colliders: BoxCollider[] = [];
  public meshesForRaycast: THREE.Object3D[] = [];
  public shootableLights: ShootableLight[] = [];
  public alarmLights: THREE.PointLight[] = [];
  public alarmBeacons: THREE.Mesh[] = [];
  public siloFloorLights: THREE.PointLight[] = [];

  public entryDoorPos = new THREE.Vector3(0, 0, 62);
  public terminalPos = new THREE.Vector3(6.2, -8.0, -34.0);
  public extractionPos = new THREE.Vector3(22.5, 0.0, 22.0);

  public entryDoorOpen = false;
  public escapeDoorOpen = false;
  public alarmActive = false;

  private entryDoorMesh!: THREE.Mesh;
  private entryDoorCollider!: BoxCollider;
  private escapeDoorMesh!: THREE.Mesh;
  private escapeDoorCollider!: BoxCollider;

  private zones: Record<ZoneKey, THREE.Group>;
  private floorZones: FloorZone[] = [];
  private dynamicLights: DynamicPointLight[] = [];
  private pipeRedMat!: THREE.MeshStandardMaterial;

  // Match BattlefieldTerrain readonly props used by PostProcessPipeline
  public readonly gridSize = 257;
  public readonly worldSize = 250;
  public readonly heights = new Float32Array(257 * 257);
  public readonly waterDepth = new Float32Array(257 * 257);
  public readonly wetness = new Float32Array(257 * 257);

  constructor(textures: TextureLibrary, csm?: CSM) {
    this.group.name = 'UndergroundSiloWorld';
    this.mesh = new THREE.Group();
    this.mesh.name = 'SiloArchitecture';
    this.group.add(this.mesh);

    this.zones = {
      ext: new THREE.Group(),
      ramp: new THREE.Group(),
      corridors: new THREE.Group(),
      silo: new THREE.Group(),
      escape: new THREE.Group(),
    };
    this.mesh.add(
      this.zones.ext,
      this.zones.ramp,
      this.zones.corridors,
      this.zones.silo,
      this.zones.escape
    );

    const concreteMat = new THREE.MeshStandardMaterial({
      map: textures.siloWallConcrete.map,
      normalMap: textures.siloWallConcrete.normalMap,
      normalScale: new THREE.Vector2(1.55, 1.55),
      roughnessMap: textures.siloWallConcrete.roughnessMap,
      aoMap: textures.siloWallConcrete.aoMap,
      color: 0xc2c8cc,
      roughness: 0.92,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });

    const floorMat = new THREE.MeshStandardMaterial({
      map: textures.siloFloorConcrete.map,
      normalMap: textures.siloFloorConcrete.normalMap,
      normalScale: new THREE.Vector2(1.4, 1.4),
      roughnessMap: textures.siloFloorConcrete.roughnessMap,
      aoMap: textures.siloFloorConcrete.aoMap,
      color: 0xb0b6bc,
      roughness: 0.90,
      metalness: 0.08,
    });

    const hazardMat = new THREE.MeshStandardMaterial({
      map: textures.hazardTrim.map,
      normalMap: textures.hazardTrim.normalMap,
      roughnessMap: textures.hazardTrim.roughnessMap,
      aoMap: textures.hazardTrim.aoMap,
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0.14,
    });

    const steelMat = new THREE.MeshStandardMaterial({
      map: textures.industrialMetal.map,
      normalMap: textures.industrialMetal.normalMap,
      roughnessMap: textures.industrialMetal.roughnessMap,
      metalnessMap: textures.industrialMetal.metalnessMap,
      color: 0x9aa2aa,
      roughness: 0.48,
      metalness: 0.82,
    });

    const darkSteelMat = new THREE.MeshStandardMaterial({
      map: textures.gunMetal.map,
      normalMap: textures.gunMetal.normalMap,
      roughnessMap: textures.gunMetal.roughnessMap,
      color: 0x454c54,
      roughness: 0.42,
      metalness: 0.88,
    });

    const catwalkMat = new THREE.MeshStandardMaterial({
      map: textures.gunMetal.map,
      normalMap: textures.gunMetal.normalMap,
      roughnessMap: textures.gunMetal.roughnessMap,
      color: 0x6b7278,
      roughness: 0.45,
      metalness: 0.86,
    });

    this.pipeRedMat = new THREE.MeshStandardMaterial({ color: 0x9e2824, roughness: 0.36, metalness: 0.68 });
    const pipeYellowMat = new THREE.MeshStandardMaterial({ color: 0xc29224, roughness: 0.38, metalness: 0.62 });
    const pipeBlueMat = new THREE.MeshStandardMaterial({ color: 0x2a6596, roughness: 0.34, metalness: 0.70 });
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x16191d, roughness: 0.72, metalness: 0.15 });
    const handrailMat = new THREE.MeshStandardMaterial({ color: 0xc89a28, roughness: 0.36, metalness: 0.76 });
    const ledGreenMat = new THREE.MeshBasicMaterial({ color: 0x22ee66 });
    const ledCyanMat = new THREE.MeshBasicMaterial({ color: 0x33ddff });
    const unlitBulbMat = new THREE.MeshStandardMaterial({ color: 0x383e42, roughness: 0.25 });

    const warmGlowMat = new THREE.MeshBasicMaterial({
      map: makeFloorGlowTexture('rgba(255, 175, 80, 0.38)'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const coolGlowMat = new THREE.MeshBasicMaterial({
      map: makeFloorGlowTexture('rgba(155, 215, 255, 0.30)'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    if (csm) {
      csm.setupMaterial(concreteMat);
      csm.setupMaterial(floorMat);
      csm.setupMaterial(hazardMat);
      csm.setupMaterial(steelMat);
      csm.setupMaterial(darkSteelMat);
      csm.setupMaterial(catwalkMat);
      csm.setupMaterial(this.pipeRedMat);
      csm.setupMaterial(pipeYellowMat);
      csm.setupMaterial(pipeBlueMat);
    }

    // Per-Zone Geometry Batcher -> crushes hundreds of small parts into <= 10 merged Draw Calls per zone!
    const zoneBuckets: Record<ZoneKey, Map<string, BatchBucket>> = {
      ext: new Map(),
      ramp: new Map(),
      corridors: new Map(),
      silo: new Map(),
      escape: new Map(),
    };
    const matIds = new Map<THREE.Material, number>();
    let nextMatId = 1;
    const tmpM4 = new THREE.Matrix4();
    const tmpQ = new THREE.Quaternion();
    const tmpEuler = new THREE.Euler();
    const tmpPos = new THREE.Vector3();
    const tmpScale = new THREE.Vector3(1, 1, 1);

    const pushBatch = (
      zoneKey: ZoneKey,
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      colMat: MaterialId,
      x: number,
      y: number,
      z: number,
      rx = 0,
      ry = 0,
      rz = 0,
      isFloor = false,
      castShadow = false
    ) => {
      if (!matIds.has(mat)) matIds.set(mat, nextMatId++);
      const key = `${matIds.get(mat)}-${colMat}-${isFloor ? 1 : 0}-${castShadow ? 1 : 0}`;
      let bucket = zoneBuckets[zoneKey].get(key);
      if (!bucket) {
        bucket = { mat, matId: colMat, isFloor, castShadow, geos: [] };
        zoneBuckets[zoneKey].set(key, bucket);
      }
      const g = normalizeForBatch(geo);
      tmpPos.set(x, y, z);
      tmpEuler.set(rx, ry, rz);
      tmpQ.setFromEuler(tmpEuler);
      tmpM4.compose(tmpPos, tmpQ, tmpScale);
      g.applyMatrix4(tmpM4);
      bucket.geos.push(g);
    };

    const addBox = (
      zoneKey: ZoneKey,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      mat: THREE.Material,
      colMat: MaterialId = MaterialId.CONCRETE,
      addCol = true,
      castShadow = false,
      worldScaleUV = true
    ) => {
      const geo = createChamferedBox(w, h, d, Math.min(0.03, Math.min(w, h, d) * 0.15), 2, 2);
      if (worldScaleUV) {
        applyWorldBoxUVs(geo, x, y, z);
      }
      pushBatch(zoneKey, geo, mat, colMat, x, y, z, 0, 0, 0, false, castShadow);
      if (addCol) {
        this.colliders.push({
          box: new THREE.Box3(
            new THREE.Vector3(x - w * 0.5, y - h * 0.5, z - d * 0.5),
            new THREE.Vector3(x + w * 0.5, y + h * 0.5, z + d * 0.5)
          ),
          material: colMat,
          blocksSight: true,
        });
      }
    };

    const addHazardStrip = (
      zoneKey: ZoneKey,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      rotX = 0
    ) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const len = Math.max(w, d);
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * Math.max(1, len / 0.8), uv.getY(i));
      }
      pushBatch(zoneKey, geo, hazardMat, MaterialId.CONCRETE, x, y, z, rotX, 0, 0);
    };

    const addSlopedSlab = (
      zoneKey: ZoneKey,
      x: number,
      zStart: number,
      yStart: number,
      zEnd: number,
      yEnd: number,
      width: number,
      thickness: number,
      mat: THREE.Material,
      colMat = MaterialId.CONCRETE
    ) => {
      const dz = zEnd - zStart;
      const dy = yEnd - yStart;
      const len = Math.hypot(dz, dy);
      const angle = Math.atan2(dy, dz);
      const geo = createChamferedBox(width, thickness, len + 0.5, 0.02, 2, 2);
      applyWorldBoxUVs(geo, x, 0, (zStart + zEnd) * 0.5);
      pushBatch(
        zoneKey,
        geo,
        mat,
        colMat,
        x,
        (yStart + yEnd) * 0.5 - thickness * 0.5,
        (zStart + zEnd) * 0.5,
        -angle,
        0,
        0,
        colMat === MaterialId.CONCRETE
      );

      // Non-slip ribbed traction bars along ramp (batched cleanly!)
      const ribs = Math.floor(len / 0.85);
      for (let i = 0; i < ribs; i++) {
        const t = (i + 0.5) / ribs;
        const ribGeo = new THREE.BoxGeometry(width * 0.88, 0.028, 0.075);
        pushBatch(
          zoneKey,
          ribGeo,
          darkSteelMat,
          MaterialId.METAL,
          x,
          THREE.MathUtils.lerp(yStart, yEnd, t) + 0.014,
          THREE.MathUtils.lerp(zStart, zEnd, t),
          -angle
        );
      }

      this.floorZones.push({
        minX: x - width * 0.5,
        maxX: x + width * 0.5,
        minZ: Math.min(zStart, zEnd),
        maxZ: Math.max(zStart, zEnd),
        yAt: (_px, pz) => THREE.MathUtils.lerp(yStart, yEnd, THREE.MathUtils.clamp((pz - zStart) / (zEnd - zStart), 0, 1)),
        mat: colMat,
      });
    };

    const addFloor = (
      zoneKey: ZoneKey,
      minX: number,
      maxX: number,
      minZ: number,
      maxZ: number,
      y: number,
      mat: THREE.Material,
      colMat = MaterialId.CONCRETE
    ) => {
      // Overlap floor geometry 0.3m past edge to ensure zero seam voids!
      const w = maxX - minX + 0.35;
      const d = maxZ - minZ + 0.35;
      const cx = (minX + maxX) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      const geo = new THREE.BoxGeometry(w, 0.45, d);
      applyWorldBoxUVs(geo, cx, y - 0.225, cz);
      pushBatch(zoneKey, geo, mat, colMat, cx, y - 0.225, cz, 0, 0, 0, colMat === MaterialId.CONCRETE);
      this.floorZones.push({ minX, maxX, minZ, maxZ, yAt: () => y, mat: colMat });
    };

    const buildBlastBulkhead = (
      zoneKey: ZoneKey,
      x: number,
      yFloor: number,
      z: number,
      width: number,
      height: number,
      rotY: number,
      beaconCol: number
    ) => {
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const toWorld = (lx: number, ly: number, lz: number): [number, number, number] => [
        x + lx * cosY + lz * sinY,
        yFloor + ly,
        z - lx * sinY + lz * cosY,
      ];

      const hw = width * 0.5;
      for (const sx of [-hw - 0.16, hw + 0.16]) {
        const [wx, wy, wz] = toWorld(sx, (height + 0.35) * 0.5, 0);
        pushBatch(
          zoneKey,
          createChamferedBox(0.46, height + 0.35, 0.92, 0.03, 2, 2),
          darkSteelMat,
          MaterialId.METAL,
          wx,
          wy,
          wz,
          0,
          rotY
        );
      }
      {
        const [wx, wy, wz] = toWorld(0, height + 0.18, 0);
        pushBatch(
          zoneKey,
          createChamferedBox(width + 0.78, 0.48, 0.96, 0.03, 2, 2),
          darkSteelMat,
          MaterialId.METAL,
          wx,
          wy,
          wz,
          0,
          rotY
        );
        const [hx, hy, hz] = toWorld(0, height - 0.02, 0);
        pushBatch(
          zoneKey,
          new THREE.BoxGeometry(width + 0.4, 0.18, 0.98),
          hazardMat,
          MaterialId.CONCRETE,
          hx,
          hy,
          hz,
          0,
          rotY
        );
      }
      for (const sx of [-hw + 0.12, hw - 0.12]) {
        const [cx, cy, cz] = toWorld(sx, height * 0.45, 0.34);
        pushBatch(
          zoneKey,
          new THREE.CylinderGeometry(0.085, 0.095, height * 0.86, 10),
          steelMat,
          MaterialId.METAL,
          cx,
          cy,
          cz,
          0,
          rotY
        );
        const [rx, ry, rz] = toWorld(sx, height * 0.68, 0.34);
        pushBatch(
          zoneKey,
          new THREE.CylinderGeometry(0.042, 0.042, height * 0.5, 8),
          this.pipeRedMat,
          MaterialId.METAL,
          rx,
          ry,
          rz,
          0,
          rotY
        );
      }

      const [bx, by, bz] = toWorld(0, height + 0.25, 0.52);
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 0.16, 10),
        new THREE.MeshBasicMaterial({ color: beaconCol })
      );
      beacon.position.set(bx, by, bz);
      this.zones[zoneKey].add(beacon);
    };

    const attachDoorWheelAndRibs = (doorMesh: THREE.Mesh, w: number, h: number) => {
      const ribGeo = createChamferedBox(w * 0.9, 0.16, 0.44, 0.02, 2, 2);
      for (const ry of [-h * 0.26, 0, h * 0.26]) {
        const r = new THREE.Mesh(ribGeo, darkSteelMat);
        r.position.set(0, ry, 0);
        r.userData.materialId = MaterialId.METAL;
        doorMesh.add(r);
      }
      const haz = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.22, 0.41), hazardMat);
      haz.position.set(0, -h * 0.42, 0);
      doorMesh.add(haz);
      for (const zSide of [-0.22, 0.22]) {
        const wheel = new THREE.Group();
        wheel.position.set(0.35, -0.1, zSide);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.028, 8, 16), handrailMat);
        wheel.add(rim);
        for (let s = 0; s < 3; s++) {
          const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.026, 0.026), darkSteelMat);
          spoke.rotation.z = (s / 3) * Math.PI;
          wheel.add(spoke);
        }
        doorMesh.add(wheel);
      }
    };

    const addArchFrame = (
      zoneKey: ZoneKey,
      cx: number,
      yFloor: number,
      z: number,
      spanWidth: number,
      clearH: number,
      leftPilaster = true,
      rightPilaster = true,
      tiltX = 0
    ) => {
      const half = spanWidth * 0.5;
      const pilGeo = createChamferedBox(0.34, clearH, 0.38, 0.025, 2, 2);
      const shoeGeo = createChamferedBox(0.40, 0.32, 0.46, 0.02, 2, 2);
      const topBeam = createChamferedBox(spanWidth, 0.28, 0.34, 0.02, 2, 2);

      const placeLocal = (lx: number, ly: number, lz: number): [number, number, number] => {
        const cosX = Math.cos(tiltX);
        const sinX = Math.sin(tiltX);
        return [cx + lx, yFloor + ly * cosX - lz * sinX, z + ly * sinX + lz * cosX];
      };

      if (leftPilaster) {
        const [px, py, pz] = placeLocal(-half + 0.17, clearH * 0.5, 0);
        pushBatch(zoneKey, pilGeo, concreteMat, MaterialId.CONCRETE, px, py, pz, tiltX);
        const [sx, sy, sz] = placeLocal(-half + 0.17, 0.16, 0);
        pushBatch(zoneKey, shoeGeo, darkSteelMat, MaterialId.METAL, sx, sy, sz, tiltX);
      }
      if (rightPilaster) {
        const [px, py, pz] = placeLocal(half - 0.17, clearH * 0.5, 0);
        pushBatch(zoneKey, pilGeo, concreteMat, MaterialId.CONCRETE, px, py, pz, tiltX);
        const [sx, sy, sz] = placeLocal(half - 0.17, 0.16, 0);
        pushBatch(zoneKey, shoeGeo, darkSteelMat, MaterialId.METAL, sx, sy, sz, tiltX);
      }
      const [bx, by, bz] = placeLocal(0, clearH - 0.12, 0);
      pushBatch(zoneKey, topBeam, darkSteelMat, MaterialId.METAL, bx, by, bz, tiltX);
    };

    const addWallSconce = (
      zoneKey: ZoneKey,
      wx: number,
      wy: number,
      wz: number,
      inwardDirX: number,
      colorHex: number,
      intensity: number,
      floorY: number,
      flicker = false,
      tiltX = 0
    ) => {
      pushBatch(
        zoneKey,
        createChamferedBox(0.08, 0.36, 0.22, 0.015, 2, 2),
        darkSteelMat,
        MaterialId.METAL,
        wx,
        wy,
        wz,
        tiltX
      );
      for (const cy of [-0.08, 0.08]) {
        pushBatch(
          zoneKey,
          new THREE.TorusGeometry(0.068, 0.008, 6, 10),
          darkSteelMat,
          MaterialId.METAL,
          wx + inwardDirX * 0.08,
          wy + cy,
          wz,
          Math.PI * 0.5 + tiltX
        );
      }

      const isLit = intensity > 0.01;
      const bulbMat = isLit
        ? new THREE.MeshStandardMaterial({
            color: colorHex,
            emissive: new THREE.Color(colorHex),
            emissiveIntensity: 3.4,
            roughness: 0.2,
          })
        : unlitBulbMat;
      const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 8), bulbMat);
      bulb.position.set(wx + inwardDirX * 0.08, wy, wz);
      bulb.rotation.x = tiltX;
      this.zones[zoneKey].add(bulb);

      if (isLit) {
        // Baked soft ground light pool quad (zero GPU light cost!)
        const isWarm = colorHex > 0xd0d000;
        pushBatch(
          zoneKey,
          new THREE.PlaneGeometry(4.4, 4.4),
          isWarm ? warmGlowMat : coolGlowMat,
          MaterialId.CONCRETE,
          wx + inwardDirX * 1.4,
          floorY + 0.018,
          wz,
          -Math.PI * 0.5 + tiltX
        );

        // Non-shadow lightweight PointLight (culled strictly <= 6 active in update!)
        const light = new THREE.PointLight(colorHex, intensity, 13.5, 1.55);
        light.castShadow = false;
        light.position.set(wx + inwardDirX * 0.5, wy - 0.1, wz);
        this.zones[zoneKey].add(light);
        this.dynamicLights.push({
          pos: new THREE.Vector3(wx, wy, wz),
          light,
          baseIntensity: intensity,
          flicker,
          phase: Math.abs(wz) * 1.7 + Math.abs(wx),
          bulbMat,
        });
      }
    };

    const addWallProp = (
      zoneKey: ZoneKey,
      kind: 'vent' | 'panel' | 'firebox',
      wx: number,
      wy: number,
      wz: number,
      inwardX: number
    ) => {
      if (kind === 'vent') {
        pushBatch(zoneKey, createChamferedBox(0.09, 0.62, 0.92, 0.015, 2, 2), darkSteelMat, MaterialId.METAL, wx, wy, wz);
        for (let s = -2; s <= 2; s++) {
          pushBatch(
            zoneKey,
            new THREE.BoxGeometry(0.11, 0.04, 0.78),
            steelMat,
            MaterialId.METAL,
            wx + inwardX * 0.02,
            wy + s * 0.09,
            wz,
            0,
            0,
            inwardX * 0.35
          );
        }
      } else if (kind === 'panel') {
        pushBatch(zoneKey, createChamferedBox(0.18, 0.88, 0.58, 0.02, 2, 2), steelMat, MaterialId.METAL, wx, wy, wz);
        pushBatch(zoneKey, new THREE.CylinderGeometry(0.028, 0.028, 1.8, 8), darkSteelMat, MaterialId.METAL, wx, wy + 1.32, wz);
        pushBatch(zoneKey, new THREE.BoxGeometry(0.03, 0.05, 0.08), ledGreenMat, MaterialId.METAL, wx + inwardX * 0.1, wy + 0.24, wz + 0.15);
      } else {
        pushBatch(zoneKey, createChamferedBox(0.18, 0.72, 0.48, 0.02, 2, 2), this.pipeRedMat, MaterialId.METAL, wx, wy, wz);
        pushBatch(zoneKey, new THREE.BoxGeometry(0.19, 0.08, 0.42), steelMat, MaterialId.METAL, wx + inwardX * 0.01, wy + 0.18, wz);
      }
    };

    const addDrainGrate = (
      zoneKey: ZoneKey,
      x: number,
      yStart: number,
      zStart: number,
      yEnd: number,
      zEnd: number,
      width = 0.46
    ) => {
      const dz = zEnd - zStart;
      const dy = yEnd - yStart;
      const len = Math.hypot(dz, dy);
      const tilt = Math.atan2(dy, dz);
      pushBatch(
        zoneKey,
        new THREE.BoxGeometry(width, 0.012, len),
        darkSteelMat,
        MaterialId.METAL,
        x,
        (yStart + yEnd) * 0.5 + 0.008,
        (zStart + zEnd) * 0.5,
        -tilt
      );
      const barCount = Math.floor(len / 0.28);
      for (let i = 0; i < barCount; i++) {
        const t = (i + 0.5) / barCount;
        pushBatch(
          zoneKey,
          new THREE.BoxGeometry(width * 0.88, 0.014, 0.045),
          steelMat,
          MaterialId.METAL,
          x,
          THREE.MathUtils.lerp(yStart, yEnd, t) + 0.016,
          THREE.MathUtils.lerp(zStart, zEnd, t),
          -tilt
        );
      }
    };

    const addSlopedHandrail = (
      zoneKey: ZoneKey,
      x: number,
      zStart: number,
      yStart: number,
      zEnd: number,
      yEnd: number
    ) => {
      const dz = zEnd - zStart;
      const dy = yEnd - yStart;
      const len = Math.hypot(dz, dy);
      const tilt = Math.atan2(dy, dz);
      const midZ = (zStart + zEnd) * 0.5;
      const midY = (yStart + yEnd) * 0.5;

      const railGeo = new THREE.CylinderGeometry(0.025, 0.025, len, 8);
      railGeo.rotateX(Math.PI * 0.5);
      for (const hOff of [0.98, 0.54]) {
        pushBatch(zoneKey, railGeo.clone(), handrailMat, MaterialId.METAL, x, midY + hOff, midZ, -tilt);
      }
      const posts = Math.floor(len / 3.0) + 1;
      for (let i = 0; i < posts; i++) {
        const t = posts > 1 ? i / (posts - 1) : 0.5;
        pushBatch(
          zoneKey,
          new THREE.CylinderGeometry(0.024, 0.026, 1.0, 8),
          darkSteelMat,
          MaterialId.METAL,
          x,
          THREE.MathUtils.lerp(yStart, yEnd, t) + 0.5,
          THREE.MathUtils.lerp(zStart, zEnd, t)
        );
      }
    };

    const addPipeRunWithFlanges = (
      zoneKey: ZoneKey,
      x: number,
      yStart: number,
      zStart: number,
      yEnd: number,
      zEnd: number,
      radius: number,
      mat: THREE.Material
    ) => {
      const dz = zEnd - zStart;
      const dy = yEnd - yStart;
      const len = Math.hypot(dz, dy);
      const tilt = Math.atan2(dy, dz);

      const pipeGeo = createLatheZ([[radius, -len * 0.5], [radius, len * 0.5]], 10);
      pushBatch(zoneKey, pipeGeo, mat, MaterialId.METAL, x, (yStart + yEnd) * 0.5, (zStart + zEnd) * 0.5, -tilt);

      const flCount = Math.max(2, Math.floor(len / 4.5));
      for (let i = 0; i < flCount; i++) {
        const t = (i + 0.5) / flCount;
        const flGeo = new THREE.CylinderGeometry(radius * 1.65, radius * 1.65, 0.065, 10);
        flGeo.rotateX(Math.PI * 0.5);
        pushBatch(
          zoneKey,
          flGeo,
          darkSteelMat,
          MaterialId.METAL,
          x,
          THREE.MathUtils.lerp(yStart, yEnd, t),
          THREE.MathUtils.lerp(zStart, zEnd, t),
          -tilt
        );
      }
    };

    const addCableTray = (
      zoneKey: ZoneKey,
      x: number,
      yStart: number,
      zStart: number,
      yEnd: number,
      zEnd: number
    ) => {
      const dz = zEnd - zStart;
      const dy = yEnd - yStart;
      const len = Math.hypot(dz, dy);
      const tilt = Math.atan2(dy, dz);
      const midZ = (zStart + zEnd) * 0.5;
      const midY = (yStart + yEnd) * 0.5;

      pushBatch(zoneKey, new THREE.BoxGeometry(0.42, 0.03, len), steelMat, MaterialId.METAL, x, midY, midZ, -tilt);
      for (const cxOff of [-0.12, 0, 0.12]) {
        pushBatch(
          zoneKey,
          createLatheZ([[0.03, -len * 0.5], [0.03, len * 0.5]], 6),
          cableMat,
          MaterialId.METAL,
          x + cxOff,
          midY + 0.04,
          midZ,
          -tilt
        );
      }
    };

    // =========================================================================
    // ZONE 0: EXTERIOR SURFACE ENTRY PAD (Z: 62..88, Y: 0) & EXTRACTION PAD (X: 15..31, Z: 16..34)
    // =========================================================================
    addFloor('ext', -14, 14, 62, 88, 0, floorMat, MaterialId.CONCRETE);
    addBox('ext', -13.5, 1.5, 75, 1.0, 3.4, 27, concreteMat);
    addBox('ext', 13.5, 1.5, 75, 1.0, 3.4, 27, concreteMat);
    addBox('ext', 0, 1.5, 87.5, 28, 3.4, 1.0, concreteMat);
    addHazardStrip('ext', -12.95, 0.12, 75, 0.06, 0.24, 25);
    addHazardStrip('ext', 12.95, 0.12, 75, 0.06, 0.24, 25);

    // Bunker facade around Entry Blast Door (Z = 62, solid overlap >= 0.4m)
    addBox('ext', -8.4, 2.2, 62, 11.4, 4.6, 1.3, concreteMat);
    addBox('ext', 8.4, 2.2, 62, 11.4, 4.6, 1.3, concreteMat);
    addBox('ext', 0, 3.9, 62, 6.2, 1.4, 1.3, concreteMat);
    buildBlastBulkhead('ext', 0, 0, 62.0, 5.5, 3.3, 0, 0xffaa33);

    // Surface tactical barriers, crate stacks & blast door weather canopy
    addBox('ext', -4.4, 0.58, 72.5, 2.8, 1.16, 0.72, concreteMat);
    addHazardStrip('ext', -4.4, 0.14, 72.88, 2.7, 0.22, 0.04);
    addBox('ext', 4.6, 0.58, 70.0, 2.8, 1.16, 0.72, concreteMat);
    addHazardStrip('ext', 4.6, 0.14, 70.38, 2.7, 0.22, 0.04);
    addBox('ext', 5.8, 0.55, 74.8, 1.4, 1.1, 1.1, steelMat, MaterialId.METAL, true, false, false);
    addBox('ext', -6.2, 0.45, 76.2, 1.3, 0.9, 1.0, darkSteelMat, MaterialId.METAL, true, false, false);
    // Overhead blast door awning canopy & steel support gussets
    addBox('ext', 0, 3.88, 63.3, 7.0, 0.34, 2.2, darkSteelMat, MaterialId.METAL, false);
    addBox('ext', -3.0, 3.35, 63.2, 0.22, 0.9, 1.8, steelMat, MaterialId.METAL, false);
    addBox('ext', 3.0, 3.35, 63.2, 0.22, 0.9, 1.8, steelMat, MaterialId.METAL, false);
    pushBatch('ext', new THREE.BoxGeometry(3.4, 0.08, 0.14), warmGlowMat, MaterialId.METAL, 0, 3.68, 63.4);

    const entrySign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.85),
      new THREE.MeshBasicMaterial({ map: makeStencilSignTexture('SECTOR-02 // B1', 'MISSILE COMPLEX') })
    );
    entrySign.position.set(4.15, 2.35, 62.68);
    this.zones.ext.add(entrySign);

    this.entryDoorMesh = new THREE.Mesh(
      createChamferedBox(5.4, 3.3, 0.35, 0.03, 2, 2),
      steelMat
    );
    this.entryDoorMesh.position.set(0, 1.65, 62);
    this.entryDoorMesh.userData.materialId = MaterialId.METAL;
    attachDoorWheelAndRibs(this.entryDoorMesh, 5.4, 3.3);
    this.zones.ext.add(this.entryDoorMesh);
    this.meshesForRaycast.push(this.entryDoorMesh);
    this.entryDoorCollider = {
      box: new THREE.Box3(new THREE.Vector3(-2.7, 0, 61.7), new THREE.Vector3(2.7, 3.3, 62.3)),
      material: MaterialId.METAL,
      blocksSight: true,
    };
    this.colliders.push(this.entryDoorCollider);

    const extLight = new THREE.PointLight(0xffaa55, 16, 22, 1.6);
    extLight.castShadow = false;
    extLight.position.set(0, 3.5, 64.5);
    this.zones.ext.add(extLight);
    this.dynamicLights.push({ pos: extLight.position.clone(), light: extLight, baseIntensity: 16, flicker: false, phase: 0 });

    // Surface Extraction Pad (X: 15..31, Z: 16..34, Y: 0) — fully sealed South parapets flanking Escape Ramp!
    addFloor('ext', 15, 31, 16, 34, 0, floorMat, MaterialId.CONCRETE);
    addBox('ext', 31.0, 1.4, 25, 0.9, 2.8, 19, concreteMat);
    addBox('ext', 23.0, 1.4, 33.8, 17, 2.8, 0.9, concreteMat);
    addBox('ext', 15.2, 1.4, 25, 0.9, 2.8, 19, concreteMat);
    // Sealed South concrete wing walls flanking Escape Ramp exit (X: 19.1..25.3)
    addBox('ext', 17.0, 1.4, 16.0, 4.4, 2.8, 0.9, concreteMat);
    addBox('ext', 28.2, 1.4, 16.0, 6.2, 2.8, 0.9, concreteMat);
    addBox('ext', 22.2, 3.7, 16.0, 7.2, 1.2, 0.9, concreteMat); // Portal lintel over escape mouth
    // Helipad LZ markings & green perimeter bollards
    addHazardStrip('ext', 23.0, 0.02, 24.5, 4.2, 0.02, 0.28);
    addHazardStrip('ext', 21.0, 0.02, 24.5, 0.28, 0.02, 3.4);
    addHazardStrip('ext', 25.0, 0.02, 24.5, 0.28, 0.02, 3.4);
    for (const [bx, bz] of [[20.2, 21.5], [25.8, 21.5], [20.2, 27.5], [25.8, 27.5]]) {
      addBox('ext', bx, 0.45, bz, 0.28, 0.9, 0.28, darkSteelMat, MaterialId.METAL, false);
      pushBatch('ext', new THREE.BoxGeometry(0.18, 0.12, 0.18), ledGreenMat, MaterialId.METAL, bx, 0.96, bz);
    }
    const lzFlare = new THREE.Mesh(
      createChamferedBox(0.22, 0.45, 0.22, 0.02, 2, 2),
      ledGreenMat
    );
    lzFlare.position.copy(this.extractionPos).add(new THREE.Vector3(0, 0.22, 0));
    this.zones.ext.add(lzFlare);
    const lzPt = new THREE.PointLight(0x33ff88, 12, 18, 1.6);
    lzPt.castShadow = false;
    lzPt.position.copy(this.extractionPos).add(new THREE.Vector3(0, 1.0, 0));
    this.zones.ext.add(lzPt);
    this.dynamicLights.push({ pos: lzPt.position.clone(), light: lzPt, baseIntensity: 12, flicker: false, phase: 0 });

    // =========================================================================
    // ZONE 1: SLOPED BLAST ENTRY RAMP (Z: 34..62, X: -2.8..2.8, Y: -8..0)
    // =========================================================================
    addSlopedSlab('ramp', 0, 34, -8.0, 62, 0.0, 6.0, 0.6, floorMat);
    const entryTilt = Math.atan2(8.0, 28.0);
    const rampYAt = (pz: number) => THREE.MathUtils.lerp(-8.0, 0.0, THREE.MathUtils.clamp((pz - 34) / 28, 0, 1));

    for (const sx of [-3.05, 3.05]) {
      const geo = createChamferedBox(0.7, 4.8, 31.2, 0.02, 2, 2);
      applyWorldBoxUVs(geo, sx, -2.2, 48);
      pushBatch('ramp', geo, concreteMat, MaterialId.CONCRETE, sx, -2.2, 48, -entryTilt);
      // Continuous vertical collider wall spanning ramp sides with generous overlap!
      this.colliders.push({
        box: new THREE.Box3(new THREE.Vector3(sx - 0.35, -8.5, 33.5), new THREE.Vector3(sx + 0.35, 4.5, 62.5)),
        material: MaterialId.CONCRETE,
        blocksSight: true,
      });
    }
    const rampRoofGeo = createChamferedBox(6.8, 0.65, 31.4, 0.02, 2, 2);
    applyWorldBoxUVs(rampRoofGeo, 0, -0.08, 48);
    pushBatch('ramp', rampRoofGeo, concreteMat, MaterialId.CONCRETE, 0, -0.08, 48, -entryTilt);

    // North-end bulkhead closing off corridor corners beside ramp mouth (Z = 34.0)
    addBox('ramp', -7.8, -6.2, 34.2, 9.4, 4.4, 0.8, concreteMat);
    addBox('ramp', 7.8, -6.2, 34.2, 9.4, 4.4, 0.8, concreteMat);

    for (let rz = 37; rz <= 59; rz += 4) {
      addArchFrame('ramp', 0, rampYAt(rz), rz, 5.4, 3.26, true, true, -entryTilt);
    }
    addSlopedHandrail('ramp', -2.42, 34.5, rampYAt(34.5), 61.2, rampYAt(61.2));
    addSlopedHandrail('ramp', 2.42, 34.5, rampYAt(34.5), 61.2, rampYAt(61.2));
    addDrainGrate('ramp', 0, -8.0, 34.5, 0.0, 61.2, 0.48);
    addHazardStrip('ramp', -2.72, -3.88, 48, 0.05, 0.22, 29.0, -entryTilt);
    addHazardStrip('ramp', 2.72, -3.88, 48, 0.05, 0.22, 29.0, -entryTilt);
    addPipeRunWithFlanges('ramp', -2.25, -4.95, 34.5, 3.05, 61.2, 0.09, this.pipeRedMat);
    addPipeRunWithFlanges('ramp', -1.98, -4.95, 34.5, 3.05, 61.2, 0.075, pipeYellowMat);
    addPipeRunWithFlanges('ramp', 2.22, -4.95, 34.5, 3.05, 61.2, 0.085, pipeBlueMat);
    addCableTray('ramp', 1.65, -4.9, 34.5, 3.1, 61.2);

    addWallSconce('ramp', -2.68, rampYAt(56) + 2.35, 56, 1, 0xffaa44, 8.5, rampYAt(56), false, -entryTilt);
    addWallSconce('ramp', 2.68, rampYAt(49) + 2.35, 49, -1, 0xcbe8ff, 0.0, rampYAt(49), false, -entryTilt);
    addWallSconce('ramp', -2.68, rampYAt(42) + 2.35, 42, 1, 0xb8e0ff, 8.5, rampYAt(42), true, -entryTilt);
    addWallProp('ramp', 'panel', 2.65, rampYAt(52) + 1.4, 52, -1);
    addWallProp('ramp', 'vent', -2.65, rampYAt(44) + 1.8, 44, 1);

    // =========================================================================
    // ZONE 2: PARALLEL CORRIDORS & GENERATOR ROOM (Z: -22..34, Y: -8.0, 0.45m solid seam overlap!)
    // =========================================================================
    addFloor('corridors', -2.9, 2.9, -22.5, 34.5, -8.0, floorMat);
    addBox('corridors', 0, -4.25, 6, 6.8, 0.55, 57.5, concreteMat, MaterialId.CONCRETE, false);

    // Left Stealth Dark Vent/Cable Tunnel (X: -11.2..-7.4, Z: -18..30, Y: -8.0)
    addFloor('corridors', -11.4, -7.2, -18.4, 30.4, -8.0, floorMat);
    addBox('corridors', -9.3, -4.55, 6, 4.9, 0.55, 49.0, concreteMat, MaterialId.CONCRETE, false);
    addBox('corridors', -11.55, -6.2, 6, 0.7, 4.2, 49.8, concreteMat);
    addBox('corridors', -9.3, -6.2, 30.35, 4.9, 4.2, 0.7, concreteMat);
    addBox('corridors', -9.3, -6.2, -18.35, 4.9, 4.2, 0.7, concreteMat);

    // 3 Transverse Maintenance Cross-Passages (overlapped cleanly at T-junctions!)
    const crossZs = [26, 6, -14];
    for (const cz of crossZs) {
      addFloor('corridors', -7.6, -2.6, cz - 1.9, cz + 1.9, -8.0, floorMat);
      addBox('corridors', -5.1, -4.55, cz, 5.2, 0.55, 4.2, concreteMat, MaterialId.CONCRETE, false);
      addBox('corridors', -5.1, -6.2, cz - 1.95, 5.2, 4.2, 0.5, concreteMat);
      addBox('corridors', -5.1, -6.2, cz + 1.95, 5.2, 4.2, 0.5, concreteMat);
      addArchFrame('corridors', -5.1, -8.0, cz, 3.3, 3.1, true, true);
      addHazardStrip('corridors', -5.1, -7.89, cz - 1.68, 4.4, 0.22, 0.04);
      addHazardStrip('corridors', -5.1, -7.89, cz + 1.68, 4.4, 0.22, 0.04);
    }

    // Divider Walls between Main (-2.8) & Stealth (-7.4) with 0.4m overlap into cross walls!
    const segsLeft: Array<[number, number]> = [
      [27.7, 34.5],
      [7.7, 24.3],
      [-12.3, 4.3],
      [-22.5, -15.7],
    ];
    for (const [z0, z1] of segsLeft) {
      const len = z1 - z0;
      const mid = (z0 + z1) * 0.5;
      addBox('corridors', -3.05, -6.2, mid, 0.55, 4.2, len, concreteMat);
      addHazardStrip('corridors', -2.76, -7.89, mid, 0.04, 0.22, len - 0.3);
      if (z0 >= -18.5 && z1 <= 30.5) {
        addBox('corridors', -7.15, -6.2, mid, 0.55, 4.2, len, concreteMat);
        addHazardStrip('corridors', -7.44, -7.89, mid, 0.04, 0.22, len - 0.3);
      }
    }

    // Right Wall of Main Corridor (+2.8) leaving Generator Room opening (Z: 5..15)
    addBox('corridors', 3.05, -6.2, 24.75, 0.55, 4.2, 19.6, concreteMat);
    addBox('corridors', 3.05, -6.2, -8.75, 0.55, 4.2, 27.6, concreteMat);
    addHazardStrip('corridors', 2.76, -7.89, 24.5, 0.04, 0.22, 18.8);
    addHazardStrip('corridors', 2.76, -7.89, -8.5, 0.04, 0.22, 26.8);
    addHazardStrip('corridors', -11.18, -7.89, 6.0, 0.04, 0.22, 47.5);

    // Generator Sub-Room (X: 2.8..11.5, Z: 2..18, Y: -8.0) with 0.45m overlap
    addFloor('corridors', 2.6, 11.8, 1.6, 18.4, -8.0, floorMat);
    addBox('corridors', 7.2, -4.25, 10, 9.6, 0.55, 17.2, concreteMat, MaterialId.CONCRETE, false);
    addBox('corridors', 11.8, -6.2, 10, 0.6, 4.2, 17.4, concreteMat);
    addBox('corridors', 7.2, -6.2, 18.3, 9.8, 4.2, 0.6, concreteMat);
    addBox('corridors', 7.2, -6.2, 1.7, 9.8, 4.2, 0.6, concreteMat);
    addHazardStrip('corridors', 11.48, -7.89, 10, 0.04, 0.22, 16);

    // Turbine Generators & Crates (with full solid BoxColliders & industrial silhouette!)
    addBox('corridors', 7.6, -7.85, 10, 2.8, 0.3, 6.2, darkSteelMat, MaterialId.METAL, false);
    addHazardStrip('corridors', 6.18, -7.84, 10, 0.05, 0.24, 6.0);
    addBox('corridors', 7.6, -6.7, 10, 2.1, 2.0, 5.2, steelMat, MaterialId.METAL, true, false, false);
    const turbDrum = createLatheZ([[0.68, -2.35], [0.76, -2.0], [0.76, 2.0], [0.68, 2.35]], 16);
    pushBatch('corridors', turbDrum, darkSteelMat, MaterialId.METAL, 7.6, -5.65, 10);
    pushBatch('corridors', new THREE.CylinderGeometry(0.16, 0.18, 1.35, 10), pipeYellowMat, MaterialId.METAL, 7.6, -5.0, 8.2);
    pushBatch('corridors', new THREE.CylinderGeometry(0.16, 0.18, 1.35, 10), pipeYellowMat, MaterialId.METAL, 7.6, -5.0, 11.8);
    addBox('corridors', 10.6, -6.9, 6.5, 0.9, 2.2, 1.4, darkSteelMat, MaterialId.METAL, true, false, false);
    pushBatch('corridors', new THREE.BoxGeometry(0.06, 0.45, 0.75), ledCyanMat, MaterialId.METAL, 10.12, -6.35, 6.5);
    addBox('corridors', 4.5, -7.45, 13.8, 1.1, 1.1, 1.1, darkSteelMat, MaterialId.METAL, true, false, false);
    addBox('corridors', -1.6, -7.45, 20, 1.3, 1.1, 0.85, concreteMat, MaterialId.CONCRETE, true, false);
    addBox('corridors', 1.6, -7.45, 0, 1.3, 1.1, 0.85, concreteMat, MaterialId.CONCRETE, true, false);
    addBox('corridors', -1.5, -7.45, -10, 1.2, 1.0, 1.0, steelMat, MaterialId.METAL, true, false, false);

    // Batched 3D Ribbed Archway Portals every 4m
    for (let z = -20; z <= 32; z += 4) {
      const clearEast = z >= 6 && z <= 14;
      const clearWest = z === 26 || z === 6 || z === -14;
      addArchFrame('corridors', 0, -8.0, z, 5.5, 3.55, !clearWest, !clearEast);
    }
    for (let z = -16; z <= 28; z += 4) {
      const clearEast = z === 26 || z === 6 || z === -14;
      addArchFrame('corridors', -9.3, -8.0, z, 3.7, 3.25, true, !clearEast);
    }

    addPipeRunWithFlanges('corridors', -2.36, -4.88, -21, -4.88, 33, 0.095, this.pipeRedMat);
    addPipeRunWithFlanges('corridors', -2.10, -4.88, -21, -4.88, 33, 0.078, pipeYellowMat);
    addPipeRunWithFlanges('corridors', 2.32, -4.88, -21, -4.88, 33, 0.09, pipeBlueMat);
    addPipeRunWithFlanges('corridors', -2.62, -6.9, -21, -6.9, 33, 0.045, pipeYellowMat);
    addCableTray('corridors', 1.68, -4.78, -21, -4.78, 33);
    addCableTray('corridors', -1.48, -4.78, -21, -4.78, 33);
    addDrainGrate('corridors', 0, -8.0, -21, -8.0, 33, 0.48);

    addPipeRunWithFlanges('corridors', -10.85, -5.25, -17.5, -5.25, 29.5, 0.09, pipeBlueMat);
    addPipeRunWithFlanges('corridors', -7.75, -5.45, -17.5, -5.45, 29.5, 0.08, pipeYellowMat);
    addCableTray('corridors', -9.3, -5.0, -17.5, -5.0, 29.5);
    addDrainGrate('corridors', -9.3, -8.0, -17.5, -8.0, 29.5, 0.36);

    addWallProp('corridors', 'firebox', -2.74, -6.55, 30, 1);
    addWallProp('corridors', 'panel', 2.74, -6.45, 22, -1);
    addWallProp('corridors', 'vent', -2.74, -6.1, 18, 1);
    addWallProp('corridors', 'panel', -2.74, -6.45, 2, 1);
    addWallProp('corridors', 'vent', 2.74, -6.1, -2, -1);
    addWallProp('corridors', 'firebox', 2.74, -6.55, -10, -1);
    addWallProp('corridors', 'panel', -2.74, -6.45, -18, 1);
    addWallProp('corridors', 'vent', -11.12, -6.2, 22, 1);
    addWallProp('corridors', 'panel', -11.12, -6.45, 10, 1);
    addWallProp('corridors', 'vent', -11.12, -6.2, -2, 1);

    const corSign1 = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.7),
      new THREE.MeshBasicMaterial({ map: makeStencilSignTexture('SECTOR-02 // B1', 'MAIN CONDUIT') })
    );
    corSign1.position.set(2.74, -5.9, 30);
    corSign1.rotation.y = -Math.PI * 0.5;
    this.zones.corridors.add(corSign1);

    const corSign2 = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.7),
      new THREE.MeshBasicMaterial({ map: makeStencilSignTexture('SILO BAY 01 ->', 'AUTHORIZED ONLY', '#24292d', '#38b6ff') })
    );
    corSign2.position.set(-2.74, -5.9, -18);
    corSign2.rotation.y = Math.PI * 0.5;
    this.zones.corridors.add(corSign2);

    // Wall Sconces + Low Green EXIT Signs
    addWallSconce('corridors', 2.72, -5.65, 26, -1, 0xffaa44, 8.5, -8.0);
    addWallSconce('corridors', -2.72, -5.65, 14, 1, 0xcbe8ff, 0.0, -8.0);
    addWallSconce('corridors', 2.72, -5.65, 2, -1, 0xffaa44, 8.0, -8.0, true);
    addWallSconce('corridors', -2.72, -5.65, -6, 1, 0xcbe8ff, 0.0, -8.0);
    addWallSconce('corridors', 2.72, -5.65, -16, -1, 0xffaa44, 8.5, -8.0);
    addWallSconce('corridors', 11.42, -5.5, 10, -1, 0xffaa44, 9.5, -8.0);
    addWallSconce('corridors', -11.12, -5.8, 14, 1, 0xff8833, 4.5, -8.0, true);
    addWallSconce('corridors', -11.12, -5.8, -6, 1, 0x33dd77, 4.0, -8.0, false);

    for (const ez of [26, 6, -14]) {
      pushBatch('corridors', new THREE.BoxGeometry(0.42, 0.16, 0.06), ledGreenMat, MaterialId.METAL, -9.3, -7.65, ez);
    }

    // 7 Destructible Ceiling Fluorescent Tubes
    const tubeGeo = createChamferedBox(0.16, 0.09, 1.5, 0.015, 2, 2);
    const tubeSpecs: Array<[number, number, number]> = [
      [0, -4.58, 28],
      [0, -4.58, 18],
      [0, -4.58, 8],
      [0, -4.58, -2],
      [0, -4.58, -12],
      [0, -4.58, -20],
      [7.2, -4.58, 10],
    ];
    tubeSpecs.forEach(([lx, ly, lz], idx) => {
      pushBatch('corridors', createChamferedBox(0.32, 0.06, 1.62, 0.01, 2, 2), darkSteelMat, MaterialId.METAL, lx, ly + 0.06, lz);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xdff2ff,
        emissive: new THREE.Color(0xc2e6ff),
        emissiveIntensity: 3.5,
      });
      const mesh = new THREE.Mesh(tubeGeo, mat);
      mesh.position.set(lx, ly, lz);
      mesh.userData.shootableLightId = idx;
      mesh.userData.materialId = MaterialId.METAL;
      this.zones.corridors.add(mesh);
      this.meshesForRaycast.push(mesh);

      const light = new THREE.PointLight(0xc2e6ff, 11.5, 14.5, 1.6);
      light.castShadow = false;
      light.position.set(lx, ly - 0.35, lz);
      this.zones.corridors.add(light);

      const sl: ShootableLight = {
        id: idx,
        mesh,
        light,
        pos: new THREE.Vector3(lx, ly, lz),
        broken: false,
        flickerPhase: idx * 2.1,
        baseIntensity: 11.5,
      };
      this.shootableLights.push(sl);
      this.dynamicLights.push({
        pos: sl.pos.clone(),
        light,
        baseIntensity: 11.5,
        flicker: idx === 1 || idx === 4,
        phase: sl.flickerPhase,
        shootable: sl,
      });
    });

    // =========================================================================
    // ZONE 3: 3-STORY VERTICAL MISSILE SILO HALL (Z: -68..-22, X: -18..18, fully sealed!)
    // =========================================================================
    addFloor('silo', -18.4, 18.4, -36.2, -21.8, -8.0, floorMat);
    addFloor('silo', -18.4, 18.4, -68.4, -51.8, -8.0, floorMat);
    addFloor('silo', -18.4, -5.4, -52.2, -35.8, -8.0, floorMat);
    addFloor('silo', 5.4, 18.4, -52.2, -35.8, -8.0, floorMat);
    addFloor('silo', -6.8, 6.8, -53.2, -34.8, -12.0, floorMat);

    // SEALED 4.5m tall Concrete Pit Liner Walls around central Missile Pit (Y: -12.2..-7.9 -> zero void under Floor 1!)
    addBox('silo', 0, -10.0, -35.8, 11.8, 4.4, 0.7, concreteMat);
    addBox('silo', 0, -10.0, -52.2, 11.8, 4.4, 0.7, concreteMat);
    addBox('silo', -5.65, -10.0, -44.0, 0.7, 4.4, 17.0, concreteMat);
    addBox('silo', 5.65, -10.0, -44.0, 0.7, 4.4, 17.0, concreteMat);
    // Pit edge safety colliders (prevent AI / player accidentally falling into -12m pit)
    this.colliders.push(
      { box: new THREE.Box3(new THREE.Vector3(-5.8, -8.2, -36.1), new THREE.Vector3(5.8, -6.5, -35.5)), material: MaterialId.METAL, blocksSight: false },
      { box: new THREE.Box3(new THREE.Vector3(-5.8, -8.2, -52.5), new THREE.Vector3(5.8, -6.5, -51.9)), material: MaterialId.METAL, blocksSight: false },
      { box: new THREE.Box3(new THREE.Vector3(-5.9, -8.2, -52.2), new THREE.Vector3(-5.3, -6.5, -35.8)), material: MaterialId.METAL, blocksSight: false },
      { box: new THREE.Box3(new THREE.Vector3(5.3, -8.2, -52.2), new THREE.Vector3(5.9, -6.5, -35.8)), material: MaterialId.METAL, blocksSight: false }
    );

    // Perimeter 22m tall Silo Walls (overlapped cleanly around all doorways & corners!)
    addBox('silo', -10.6, 0.0, -22.25, 15.8, 23, 0.8, concreteMat);
    addBox('silo', 10.6, 0.0, -22.25, 15.8, 23, 0.8, concreteMat);
    addBox('silo', 0, 3.2, -22.25, 6.4, 15.2, 0.8, concreteMat); // Airlock lintel drops down to -4.4 (overlaps corridor ceiling!)
    addBox('silo', 0, 0.0, -68.25, 37.5, 23, 0.8, concreteMat);
    addBox('silo', -18.25, 0.0, -45.0, 0.8, 23, 47.2, concreteMat);
    addBox('silo', 18.25, 0.0, -26.4, 0.8, 23, 9.6, concreteMat);
    addBox('silo', 18.25, 0.0, -52.2, 0.8, 23, 33.2, concreteMat);
    addBox('silo', 18.25, 3.2, -33.5, 0.8, 15.2, 5.8, concreteMat); // Escape lintel drops cleanly to -4.4
    addBox('silo', 0, 10.2, -45.0, 38.0, 0.8, 48.0, concreteMat, MaterialId.CONCRETE, false);

    buildBlastBulkhead('silo', 0, -8.0, -22.25, 5.5, 3.6, 0, 0x38b6ff);
    buildBlastBulkhead('silo', 18.25, -8.0, -33.5, 5.0, 3.6, Math.PI * 0.5, 0xff2a2a);

    for (const wx of [-12, 12]) {
      addBox('silo', wx, 0, -22.7, 0.65, 20, 0.55, darkSteelMat, MaterialId.METAL, false);
      addBox('silo', wx, 0, -67.8, 0.65, 20, 0.55, darkSteelMat, MaterialId.METAL, false);
    }
    for (const wz of [-30, -44, -58]) {
      addBox('silo', -17.8, 0, wz, 0.55, 20, 0.65, darkSteelMat, MaterialId.METAL, false);
      if (wz !== -30) addBox('silo', 17.8, 0, wz, 0.55, 20, 0.65, darkSteelMat, MaterialId.METAL, false);
      addBox('silo', -17.5, 1.0, wz + 0.8, 0.16, 18, 0.16, pipeBlueMat, MaterialId.METAL, false, false, false);
    }
    addHazardStrip('silo', 0, -7.96, -35.85, 11.4, 0.08, 0.28);
    addHazardStrip('silo', 0, -7.96, -52.15, 11.4, 0.08, 0.28);
    addHazardStrip('silo', -5.65, -7.96, -44.0, 0.28, 0.08, 16.5);
    addHazardStrip('silo', 5.65, -7.96, -44.0, 0.28, 0.08, 16.5);

    // Central Giant Multi-Stage ICBM Missile + Booster Nozzle + Umbilical Arms + Overhead Bridge Crane
    const missilePts: Array<[number, number]> = [
      [0.01, -11.5],
      [1.35, -11.5],
      [1.05, -10.4],
      [2.15, -10.1],
      [2.15, -3.2],
      [2.05, -2.95],
      [2.15, -2.7],
      [2.15, 2.6],
      [1.82, 5.4],
      [0.92, 7.9],
      [0.01, 8.95],
    ];
    const missileGeo = new THREE.LatheGeometry(missilePts.map(([r, y]) => new THREE.Vector2(r, y)), 28);
    pushBatch('silo', missileGeo, steelMat, MaterialId.METAL, 0, 0, -44, 0, 0, 0, false, false);
    // Missile collar bands (red warning ring + hazard trim)
    const stageCollar = new THREE.CylinderGeometry(2.20, 2.20, 0.42, 28);
    pushBatch('silo', stageCollar, this.pipeRedMat, MaterialId.METAL, 0, 2.4, -44, 0, 0, 0, false, false);
    pushBatch('silo', new THREE.CylinderGeometry(2.20, 2.20, 0.34, 28), pipeYellowMat, MaterialId.METAL, 0, -3.0, -44, 0, 0, 0, false, false);
    this.colliders.push({
      box: new THREE.Box3(new THREE.Vector3(-2.3, -12, -46.3), new THREE.Vector3(2.3, 9, -41.7)),
      material: MaterialId.METAL,
      blocksSight: true,
    });

    for (const [gx, gz] of [[-4.8, -40], [4.8, -40], [-4.8, -48], [4.8, -48]]) {
      addBox('silo', gx, -1.5, gz, 0.65, 21.0, 0.65, catwalkMat, MaterialId.METAL, true, false, false);
      // Horizontal gantry umbilical arms reaching toward the ICBM hull
      const sx = gx < 0 ? 1 : -1;
      const sz = gz < -44 ? 1 : -1;
      addBox('silo', gx + sx * 1.4, -3.0, gz + sz * 1.1, 2.8, 0.32, 0.32, darkSteelMat, MaterialId.METAL, false);
      addBox('silo', gx + sx * 1.4, 2.2, gz + sz * 1.1, 2.8, 0.32, 0.32, darkSteelMat, MaterialId.METAL, false);
    }
    // Overhead Silo Bridge Crane spanning X = -17.5..17.5 at Y = +8.1
    addBox('silo', 0, 8.1, -44, 35.0, 0.72, 1.4, pipeYellowMat, MaterialId.METAL, false);
    addBox('silo', -3.5, 7.45, -44, 2.2, 0.65, 1.8, darkSteelMat, MaterialId.METAL, false);
    addBox('silo', 0, -7.55, -35.8, 11.4, 0.9, 0.14, handrailMat, MaterialId.METAL, false, false, false);
    addBox('silo', 0, -7.55, -52.2, 11.4, 0.9, 0.14, handrailMat, MaterialId.METAL, false, false, false);

    // 2nd-Floor Catwalk Loop (Y = -3.8) + Smooth Ramps
    addSlopedSlab('silo', -14.5, -24, -8.0, -38, -3.8, 3.2, 0.3, catwalkMat, MaterialId.METAL);
    addSlopedSlab('silo', 14.5, -24, -8.0, -38, -3.8, 3.2, 0.3, catwalkMat, MaterialId.METAL);
    addSlopedHandrail('silo', -13.0, -24, -8.0, -38, -3.8);
    addSlopedHandrail('silo', 13.0, -24, -8.0, -38, -3.8);
    addFloor('silo', -18.0, -12.5, -64.2, -38, -3.8, catwalkMat, MaterialId.METAL);
    addFloor('silo', 12.5, 18.0, -64.2, -38, -3.8, catwalkMat, MaterialId.METAL);
    addFloor('silo', -12.5, 12.5, -64.2, -59, -3.8, catwalkMat, MaterialId.METAL);

    addBox('silo', -12.6, -3.25, -51, 0.12, 1.0, 26, handrailMat, MaterialId.METAL, false, false, false);
    addBox('silo', 12.6, -3.25, -51, 0.12, 1.0, 26, handrailMat, MaterialId.METAL, false, false, false);
    addBox('silo', 0, -3.25, -59.1, 25, 1.0, 0.12, handrailMat, MaterialId.METAL, false, false, false);

    // Glowing Main Control Terminal + Server Racks
    addBox('silo', 6.2, -7.1, -34.0, 1.6, 1.8, 0.85, darkSteelMat, MaterialId.METAL, true, false, false);
    pushBatch('silo', new THREE.BoxGeometry(1.1, 0.55, 0.08), ledCyanMat, MaterialId.METAL, 6.2, -6.6, -33.55);

    for (const [sx, sz] of [[-7.5, -31], [-9.2, -31], [8.5, -45], [8.5, -49]]) {
      addBox('silo', sx, -6.9, sz, 1.1, 2.2, 0.9, darkSteelMat, MaterialId.METAL, true, false, false);
      pushBatch('silo', new THREE.BoxGeometry(0.7, 0.12, 0.05), ledCyanMat, MaterialId.METAL, sx, -6.3, sz + 0.46);
    }

    // Silo Hall Primary Non-Shadow PointLights
    const pitWarm1 = new THREE.PointLight(0xff7b29, 44, 36, 1.4);
    pitWarm1.castShadow = false;
    pitWarm1.position.set(-4.0, -10.5, -44);
    this.zones.silo.add(pitWarm1);
    const pitWarm2 = new THREE.PointLight(0xff7b29, 44, 36, 1.4);
    pitWarm2.castShadow = false;
    pitWarm2.position.set(4.0, -10.5, -44);
    this.zones.silo.add(pitWarm2);
    this.siloFloorLights.push(pitWarm1, pitWarm2);

    const termBlue = new THREE.PointLight(0x38b6ff, 18, 22, 1.5);
    termBlue.castShadow = false;
    termBlue.position.set(6.2, -5.8, -33.0);
    this.zones.silo.add(termBlue);

    const catwalkWhite = new THREE.PointLight(0xbfd8f0, 24, 34, 1.5);
    catwalkWhite.castShadow = false;
    catwalkWhite.position.set(0, 1.5, -45);
    this.zones.silo.add(catwalkWhite);

    this.dynamicLights.push(
      { pos: pitWarm1.position.clone(), light: pitWarm1, baseIntensity: 44, flicker: false, phase: 0 },
      { pos: pitWarm2.position.clone(), light: pitWarm2, baseIntensity: 44, flicker: false, phase: 0 },
      { pos: termBlue.position.clone(), light: termBlue, baseIntensity: 18, flicker: false, phase: 0 },
      { pos: catwalkWhite.position.clone(), light: catwalkWhite, baseIntensity: 24, flicker: false, phase: 0 }
    );

    // =========================================================================
    // ZONE 4: SEALED ESCAPE RAMP SHAFT (X: 18..26, Z: -36..16, Y: -8..0)
    // =========================================================================
    this.escapeDoorMesh = new THREE.Mesh(
      createChamferedBox(0.4, 3.6, 5.0, 0.03, 2, 2),
      steelMat
    );
    this.escapeDoorMesh.position.set(18.25, -6.2, -33.5);
    this.escapeDoorMesh.userData.materialId = MaterialId.METAL;
    attachDoorWheelAndRibs(this.escapeDoorMesh, 4.8, 3.5);
    this.zones.silo.add(this.escapeDoorMesh);
    this.meshesForRaycast.push(this.escapeDoorMesh);
    this.escapeDoorCollider = {
      box: new THREE.Box3(new THREE.Vector3(17.9, -8.0, -36.0), new THREE.Vector3(18.6, -4.4, -31.0)),
      material: MaterialId.METAL,
      blocksSight: true,
    };
    this.colliders.push(this.escapeDoorCollider);

    addFloor('escape', 18.0, 26.2, -36.5, -29.6, -8.0, floorMat);
    addSlopedSlab('escape', 22.2, -30, -8.0, 16, 0.0, 6.6, 0.6, floorMat);
    const escTilt = Math.atan2(8.0, 46.0);
    const escYAt = (pz: number) => THREE.MathUtils.lerp(-8.0, 0.0, THREE.MathUtils.clamp((pz + 30) / 46, 0, 1));

    // Sealed Escape Shaft Side Walls + Full-Clearance Sloped Concrete Roof (zero head clipping & zero gaps!)
    addBox('escape', 18.7, -2.0, -7.2, 0.8, 12.6, 47.4, concreteMat); // West wall Z: -30.9..+16.5, Y: -8.3..+4.3
    addBox('escape', 25.6, -2.0, -10.0, 0.8, 12.6, 54.0, concreteMat); // East wall spanning FULL Z=-37..17, Y: -8.3..+4.3
    // Flat concrete ceiling over Z=-36.6..-29.4 vestibule, then sloped ceiling tracking -escTilt at +3.85m clearance!
    addBox('escape', 22.15, -4.05, -33.0, 7.6, 0.65, 7.4, concreteMat, MaterialId.CONCRETE, false);
    const escRoofLen = Math.hypot(46.0, 8.0) + 0.4;
    const escRoofGeo = createChamferedBox(7.6, 0.65, escRoofLen, 0.02, 2, 2);
    applyWorldBoxUVs(escRoofGeo, 22.15, -0.15, -7.0);
    pushBatch('escape', escRoofGeo, concreteMat, MaterialId.CONCRETE, 22.15, -0.15, -7.0, -escTilt);
    addBox('escape', 22.2, -6.2, -36.4, 8.2, 4.4, 0.8, concreteMat); // South end cap at Z=-36.4

    for (let ez = -28; ez <= 14; ez += 4.5) {
      addArchFrame('escape', 22.15, escYAt(ez), ez, 6.0, 3.45, true, true, -escTilt);
    }
    addSlopedHandrail('escape', 19.48, -29.5, escYAt(-29.5), 15.5, escYAt(15.5));
    addSlopedHandrail('escape', 24.92, -29.5, escYAt(-29.5), 15.5, escYAt(15.5));
    addDrainGrate('escape', 22.2, -8.0, -29.5, 0.0, 15.5, 0.48);
    addHazardStrip('escape', 19.18, -3.88, -7, 0.05, 0.22, 46, -escTilt);
    addHazardStrip('escape', 25.22, -3.88, -7, 0.05, 0.22, 46, -escTilt);
    addPipeRunWithFlanges('escape', 19.65, -4.8, -29.5, 3.2, 15.5, 0.09, this.pipeRedMat);
    addPipeRunWithFlanges('escape', 24.75, -4.8, -29.5, 3.2, 15.5, 0.085, pipeBlueMat);
    addCableTray('escape', 22.2, -4.72, -29.5, 3.28, 15.5);

    addWallSconce('escape', 19.22, escYAt(-22) + 2.35, -22, 1, 0xffaa44, 7.5, escYAt(-22), false, -escTilt);
    addWallSconce('escape', 25.18, escYAt(-8) + 2.35, -8, -1, 0xcbe8ff, 0.0, escYAt(-8), false, -escTilt);
    addWallSconce('escape', 19.22, escYAt(6) + 2.35, 6, 1, 0xffaa44, 7.5, escYAt(6), false, -escTilt);

    // Outer Safety Containment Hull Colliders (hard boundary preventing anyone falling out of underground bounds)
    this.colliders.push(
      { box: new THREE.Box3(new THREE.Vector3(-24, -14, -74), new THREE.Vector3(-18.3, 12, 90)), material: MaterialId.CONCRETE, blocksSight: true },
      { box: new THREE.Box3(new THREE.Vector3(31.2, -14, -74), new THREE.Vector3(36, 12, 90)), material: MaterialId.CONCRETE, blocksSight: true },
      { box: new THREE.Box3(new THREE.Vector3(-24, -14, -74), new THREE.Vector3(36, 12, -68.3)), material: MaterialId.CONCRETE, blocksSight: true },
      { box: new THREE.Box3(new THREE.Vector3(-24, -14, 87.6), new THREE.Vector3(36, 12, 92)), material: MaterialId.CONCRETE, blocksSight: true }
    );

    // Rotating Red Alarm Beacons (non-shadow lightweight PointLights, active only after terminal hack!)
    const alarmCoords: Array<[number, number, number]> = [
      [0, -4.7, 22],
      [0, -4.7, 0],
      [0, -4.7, -18],
      [0, 2.0, -44],
      [14, -4.5, -33.5],
      [22.2, -1.5, -10],
    ];
    alarmCoords.forEach(([ax, ay, az]) => {
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 0.24, 10),
        new THREE.MeshBasicMaterial({ color: 0xff1e1e })
      );
      beacon.position.set(ax, ay, az);
      beacon.visible = false;
      this.group.add(beacon);
      this.alarmBeacons.push(beacon);

      const al = new THREE.PointLight(0xff1a1a, 0, 24, 1.5);
      al.castShadow = false;
      al.position.set(ax, ay - 0.3, az);
      this.group.add(al);
      this.alarmLights.push(al);
      this.dynamicLights.push({ pos: al.position.clone(), light: al, baseIntensity: 22, flicker: false, phase: 0, isAlarm: true });
    });

    // FINALIZE STATIC GEOMETRY BATCHING: Merge each material bucket into 1 Draw Call per zone!
    for (const zoneKey of ['ext', 'ramp', 'corridors', 'silo', 'escape'] as ZoneKey[]) {
      for (const bucket of zoneBuckets[zoneKey].values()) {
        if (bucket.geos.length === 0) continue;
        const merged = mergeGeometries(bucket.geos, false);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, bucket.mat);
        mesh.receiveShadow = true;
        mesh.castShadow = bucket.castShadow;
        mesh.userData.materialId = bucket.matId;
        mesh.userData.isFloor = bucket.isFloor;
        this.zones[zoneKey].add(mesh);
        if (bucket.mat !== warmGlowMat && bucket.mat !== coolGlowMat) {
          this.meshesForRaycast.push(mesh);
        }
      }
    }
  }

  public reset(): void {
    this.entryDoorOpen = false;
    this.escapeDoorOpen = false;
    this.alarmActive = false;
    this.entryDoorMesh.position.y = 1.65;
    this.entryDoorCollider.box.set(new THREE.Vector3(-2.7, 0, 61.7), new THREE.Vector3(2.7, 3.3, 62.3));
    this.escapeDoorMesh.position.y = -6.2;
    this.escapeDoorCollider.box.set(new THREE.Vector3(17.9, -8.0, -36.0), new THREE.Vector3(18.6, -4.4, -31.0));

    for (const dl of this.dynamicLights) {
      if (dl.isAlarm) {
        dl.light.intensity = 0;
        dl.light.visible = false;
      } else {
        dl.light.intensity = dl.baseIntensity;
        if (dl.bulbMat) dl.bulbMat.emissiveIntensity = 3.4;
      }
    }
    for (const sl of this.shootableLights) {
      sl.broken = false;
      sl.light.intensity = sl.baseIntensity;
      const mat = sl.mesh.material as THREE.MeshStandardMaterial;
      mat.color.setHex(0xdff2ff);
      mat.emissive.setHex(0xc2e6ff);
      mat.emissiveIntensity = 3.5;
    }
    for (const b of this.alarmBeacons) b.visible = false;
  }

  public triggerAlarm(): void {
    if (this.alarmActive) return;
    this.alarmActive = true;
    this.escapeDoorOpen = true;
    for (const dl of this.dynamicLights) {
      if (!dl.isAlarm) {
        dl.light.intensity = 0;
        dl.light.visible = false;
        if (dl.bulbMat) dl.bulbMat.emissiveIntensity = 0;
      }
    }
    for (const sl of this.shootableLights) {
      if (!sl.broken) {
        (sl.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.0;
      }
    }
    for (const b of this.alarmBeacons) b.visible = true;
  }

  public breakLight(id: number): THREE.Vector3 | null {
    const sl = this.shootableLights[id];
    if (!sl || sl.broken) return null;
    sl.broken = true;
    sl.light.intensity = 0;
    sl.light.visible = false;
    const mat = sl.mesh.material as THREE.MeshStandardMaterial;
    mat.emissive.setHex(0x000000);
    mat.emissiveIntensity = 0;
    mat.color.setHex(0x202428);
    return sl.pos;
  }

  public isNearBrokenLight(pos: THREE.Vector3): boolean {
    for (const sl of this.shootableLights) {
      if (sl.broken && sl.pos.distanceTo(pos) < 8.5) return true;
    }
    return false;
  }

  public update(dt: number, elapsed: number, playerPos: THREE.Vector3): void {
    // 1. Entry & Escape Blast Doors
    if (!this.entryDoorOpen && playerPos.distanceTo(this.entryDoorPos) < 5.5) {
      this.entryDoorOpen = true;
    }
    const targetEntryY = this.entryDoorOpen ? 4.8 : 1.65;
    this.entryDoorMesh.position.y = THREE.MathUtils.lerp(this.entryDoorMesh.position.y, targetEntryY, Math.min(1, dt * 4.5));
    if (this.entryDoorOpen && this.entryDoorMesh.position.y > 3.6) {
      this.entryDoorCollider.box.makeEmpty();
    }
    if (this.escapeDoorOpen) {
      this.escapeDoorMesh.position.y = THREE.MathUtils.lerp(this.escapeDoorMesh.position.y, -2.5, Math.min(1, dt * 4.0));
      if (this.escapeDoorMesh.position.y > -4.4) {
        this.escapeDoorCollider.box.makeEmpty();
      }
    }

    // 2. Hard Cap Active PointLights <= 6 Nearest to Player (maintains >= 60 FPS!)
    const candidates: Array<{ dl: DynamicPointLight; dSq: number }> = [];
    for (const dl of this.dynamicLights) {
      dl.light.visible = false;
      if (dl.shootable?.broken) continue;
      if (this.alarmActive && !dl.isAlarm) continue;
      if (!this.alarmActive && dl.isAlarm) continue;
      const dSq = dl.pos.distanceToSquared(playerPos);
      if (dSq < 34 * 34) {
        candidates.push({ dl, dSq });
      }
    }
    candidates.sort((a, b) => a.dSq - b.dSq);
    const maxLights = 6;
    const pulse = 0.35 + 0.65 * Math.pow(Math.sin(elapsed * 5.6) * 0.5 + 0.5, 2.0);
    for (let i = 0; i < Math.min(maxLights, candidates.length); i++) {
      const { dl } = candidates[i];
      dl.light.visible = true;
      if (dl.isAlarm) {
        dl.light.intensity = dl.baseIntensity * pulse;
      } else if (dl.flicker) {
        const fl = Math.sin(elapsed * 21 + dl.phase) * Math.sin(elapsed * 6.8) > 0.70 ? 0.25 : 1.0;
        dl.light.intensity = dl.baseIntensity * fl;
        if (dl.shootable) (dl.shootable.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 3.5 * fl;
        if (dl.bulbMat) dl.bulbMat.emissiveIntensity = 3.4 * fl;
      }
    }
    if (this.alarmActive) {
      for (const b of this.alarmBeacons) b.rotation.y = elapsed * 6.0;
    }

    // 3. Tight Room / Zone Visibility Culling
    const z = playerPos.z;
    const x = playerPos.x;
    this.zones.ext.visible = z > 32 || (x > 14 && z > -2);
    this.zones.ramp.visible = z > 20;
    this.zones.corridors.visible = z > -38 && z < 60 && x < 16;
    this.zones.silo.visible = z < 12;
    this.zones.escape.visible = z < -12 || x > 14;
  }

  public getHeightAt(wx: number, wz: number, refY = 2.0): number {
    let bestY = -8.0;
    let found = false;
    for (const f of this.floorZones) {
      if (wx >= f.minX && wx <= f.maxX && wz >= f.minZ && wz <= f.maxZ) {
        const y = f.yAt(wx, wz);
        if (y <= refY + 1.35) {
          if (!found || y > bestY) {
            bestY = y;
            found = true;
          }
        }
      }
    }
    return found ? bestY : -8.0;
  }

  public getNormalAt(_wx: number, _wz: number, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(0, 1, 0);
  }

  public getWaterDepthAt(wx: number, wz: number): number {
    const n = Math.sin(wx * 0.75 + wz * 0.42) * Math.cos(wz * 0.65 - wx * 0.35);
    return n > 0.48 ? (n - 0.48) * 0.2 : 0;
  }

  public getMaterialAt(wx: number, wz: number): MaterialId {
    if (this.getWaterDepthAt(wx, wz) > 0.02) return MaterialId.WATER;
    return MaterialId.CONCRETE;
  }
}
