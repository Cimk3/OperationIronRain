import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { EnvironmentPBRAtlas } from '../proc/pbrGenerator';
import { createTerrainMaterial } from '../proc/terrainShader';
import { MaterialId, TerrainWorkerOutput } from '../types';

export class BattlefieldTerrain {
  public mesh: THREE.Group;
  public material: THREE.MeshStandardMaterial;
  public readonly gridSize: number;
  public readonly worldSize: number;
  public readonly heights: Float32Array;
  public readonly waterDepth: Float32Array;
  public readonly wetness: Float32Array;
  public readonly splat: Uint8Array;
  public readonly packVramBytes: number;
  private readonly half: number;
  private readonly step: number;
  private readonly lods: THREE.LOD[] = [];
  public timeUniform: { value: number };

  constructor(
    data: TerrainWorkerOutput,
    envAtlas: EnvironmentPBRAtlas,
    renderer: THREE.WebGLRenderer,
    csm?: CSM
  ) {
    this.gridSize = data.gridSize;
    this.worldSize = data.worldSize;
    this.heights = data.heights;
    this.waterDepth = data.waterDepth;
    this.wetness = data.wetness;
    this.splat = data.splat;
    this.half = data.worldSize * 0.5;
    this.step = data.worldSize / (data.gridSize - 1);

    const bundle = createTerrainMaterial(envAtlas, renderer, csm);
    this.material = bundle.material;
    this.timeUniform = bundle.timeUniform;
    this.packVramBytes = bundle.packVramBytes;

    this.mesh = new THREE.Group();
    this.mesh.name = 'BattlefieldTerrainLOD';

    // 4x4 Chunked LOD Grid over 513x513 heightfield: preserves full 0.488m core precision while saving 48 Draw Calls!
    const chunks = 4;
    const chunkQuads = (this.gridSize - 1) / chunks; // 128 quads per chunk at LOD0
    for (let cz = 0; cz < chunks; cz++) {
      for (let cx = 0; cx < chunks; cx++) {
        const lod = new THREE.LOD();
        const gx0 = cx * chunkQuads;
        const gz0 = cz * chunkQuads;
        const centerX = -this.half + (gx0 + chunkQuads * 0.5) * this.step;
        const centerZ = -this.half + (gz0 + chunkQuads * 0.5) * this.step;
        lod.position.set(centerX, 0, centerZ);

        // LOD0: Full 0.488m precision (stride=1)
        const geo0 = this.buildChunkGeometry(gx0, gz0, chunkQuads, 1, centerX, centerZ);
        const mesh0 = new THREE.Mesh(geo0, this.material);
        mesh0.receiveShadow = true;
        mesh0.userData.isTerrain = true;
        lod.addLevel(mesh0, 0);

        // LOD1: Far terrain 1.95m precision (stride=4) with skirt
        const geo1 = this.buildChunkGeometry(gx0, gz0, chunkQuads, 4, centerX, centerZ);
        const mesh1 = new THREE.Mesh(geo1, this.material);
        mesh1.receiveShadow = true;
        mesh1.userData.isTerrain = true;
        lod.addLevel(mesh1, 105);

        this.lods.push(lod);
        this.mesh.add(lod);
      }
    }
  }

  private buildChunkGeometry(
    gx0: number,
    gz0: number,
    quads: number,
    stride: number,
    centerX: number,
    centerZ: number
  ): THREE.BufferGeometry {
    const vertsPerSide = quads / stride + 1;
    const vCount = vertsPerSide * vertsPerSide;
    const skirtVerts = vertsPerSide * 4;
    const totalVerts = vCount + skirtVerts;

    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const splats = new Float32Array(totalVerts * 4);
    const wets = new Float32Array(totalVerts * 2);
    const indices: number[] = [];

    const writeVertex = (outIdx: number, gx: number, gz: number, yDrop = 0) => {
      const i = gz * this.gridSize + gx;
      const wx = -this.half + gx * this.step - centerX;
      const wz = -this.half + gz * this.step - centerZ;
      const wy = this.heights[i] - yDrop;

      positions[outIdx * 3] = wx;
      positions[outIdx * 3 + 1] = wy;
      positions[outIdx * 3 + 2] = wz;
      uvs[outIdx * 2] = gx / (this.gridSize - 1);
      uvs[outIdx * 2 + 1] = gz / (this.gridSize - 1);

      splats[outIdx * 4] = this.splat[i * 4] / 255;
      splats[outIdx * 4 + 1] = this.splat[i * 4 + 1] / 255;
      splats[outIdx * 4 + 2] = this.splat[i * 4 + 2] / 255;
      splats[outIdx * 4 + 3] = this.splat[i * 4 + 3] / 255;
      wets[outIdx * 2] = this.waterDepth[i];
      wets[outIdx * 2 + 1] = this.wetness[i];

      const xm = Math.max(0, gx - 1);
      const xp = Math.min(this.gridSize - 1, gx + 1);
      const zm = Math.max(0, gz - 1);
      const zp = Math.min(this.gridSize - 1, gz + 1);
      const nx = (this.heights[gz * this.gridSize + xm] - this.heights[gz * this.gridSize + xp]) / ((xp - xm) * this.step);
      const nz = (this.heights[zm * this.gridSize + gx] - this.heights[zp * this.gridSize + gx]) / ((zp - zm) * this.step);
      const ny = 1.0;
      const invLen = 1.0 / Math.hypot(nx, ny, nz);
      normals[outIdx * 3] = nx * invLen;
      normals[outIdx * 3 + 1] = ny * invLen;
      normals[outIdx * 3 + 2] = nz * invLen;
    };

    for (let iz = 0; iz < vertsPerSide; iz++) {
      const gz = gz0 + iz * stride;
      for (let ix = 0; ix < vertsPerSide; ix++) {
        const gx = gx0 + ix * stride;
        writeVertex(iz * vertsPerSide + ix, gx, gz, 0);
      }
    }

    for (let iz = 0; iz < vertsPerSide - 1; iz++) {
      for (let ix = 0; ix < vertsPerSide - 1; ix++) {
        const a = iz * vertsPerSide + ix;
        const b = (iz + 1) * vertsPerSide + ix;
        const c = (iz + 1) * vertsPerSide + (ix + 1);
        const d = iz * vertsPerSide + (ix + 1);
        indices.push(a, b, d, b, c, d);
      }
    }

    let sPtr = vCount;
    const addSkirtStrip = (getGrid: (k: number) => [number, number], getTopIdx: (k: number) => number, flip: boolean) => {
      const base = sPtr;
      for (let k = 0; k < vertsPerSide; k++) {
        const [gx, gz] = getGrid(k);
        writeVertex(sPtr++, gx, gz, 0.65);
      }
      for (let k = 0; k < vertsPerSide - 1; k++) {
        const t0 = getTopIdx(k);
        const t1 = getTopIdx(k + 1);
        const b0 = base + k;
        const b1 = base + k + 1;
        if (!flip) {
          indices.push(t0, b0, t1, t1, b0, b1);
        } else {
          indices.push(t0, t1, b0, t1, b1, b0);
        }
      }
    };

    addSkirtStrip((k) => [gx0 + k * stride, gz0], (k) => k, true);
    addSkirtStrip((k) => [gx0 + k * stride, gz0 + quads], (k) => (vertsPerSide - 1) * vertsPerSide + k, false);
    addSkirtStrip((k) => [gx0, gz0 + k * stride], (k) => k * vertsPerSide, false);
    addSkirtStrip((k) => [gx0 + quads, gz0 + k * stride], (k) => k * vertsPerSide + (vertsPerSide - 1), true);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aSplat', new THREE.BufferAttribute(splats, 4));
    geo.setAttribute('aWet', new THREE.BufferAttribute(wets, 2));
    geo.setIndex(indices);
    return geo;
  }

  public update(elapsed: number, camera?: THREE.Camera): void {
    this.timeUniform.value = elapsed;
    if (camera) {
      for (const lod of this.lods) lod.update(camera);
    }
  }

  public getHeightAt(wx: number, wz: number, _refY?: number): number {
    const fx = (wx + this.half) / this.step;
    const fz = (wz + this.half) / this.step;
    const ix = Math.max(0, Math.min(this.gridSize - 2, Math.floor(fx)));
    const iz = Math.max(0, Math.min(this.gridSize - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - ix));
    const tz = Math.max(0, Math.min(1, fz - iz));
    const i = iz * this.gridSize + ix;
    const h00 = this.heights[i];
    const h10 = this.heights[i + 1];
    const h01 = this.heights[i + this.gridSize];
    const h11 = this.heights[i + this.gridSize + 1];
    if (tx + tz <= 1) {
      return h00 + tx * (h10 - h00) + tz * (h01 - h00);
    } else {
      return h11 + (1 - tx) * (h01 - h11) + (1 - tz) * (h10 - h11);
    }
  }

  public getNormalAt(wx: number, wz: number, target = new THREE.Vector3()): THREE.Vector3 {
    const eps = 0.5;
    const hL = this.getHeightAt(wx - eps, wz);
    const hR = this.getHeightAt(wx + eps, wz);
    const hD = this.getHeightAt(wx, wz - eps);
    const hU = this.getHeightAt(wx, wz + eps);
    return target.set(hL - hR, 2 * eps, hD - hU).normalize();
  }

  public getWaterDepthAt(wx: number, wz: number): number {
    const gx = Math.max(0, Math.min(this.gridSize - 1, Math.round((wx + this.half) / this.step)));
    const gz = Math.max(0, Math.min(this.gridSize - 1, Math.round((wz + this.half) / this.step)));
    return this.waterDepth[gz * this.gridSize + gx];
  }

  public getMaterialAt(wx: number, wz: number): MaterialId {
    const gx = Math.max(0, Math.min(this.gridSize - 1, Math.round((wx + this.half) / this.step)));
    const gz = Math.max(0, Math.min(this.gridSize - 1, Math.round((wz + this.half) / this.step)));
    const idx = gz * this.gridSize + gx;
    if (this.waterDepth[idx] > 0.025) return MaterialId.WATER;

    const sIdx = idx * 4;
    const g = this.splat[sIdx];
    const m = this.splat[sIdx + 1];
    const gr = this.splat[sIdx + 2];
    const r = this.splat[sIdx + 3];
    if (m >= g && m >= gr && m >= r) return MaterialId.WET_MUD;
    if (gr >= g && gr >= r) return MaterialId.GRAVEL;
    if (r >= g) return MaterialId.ROCK;
    return MaterialId.GRASS;
  }
}
