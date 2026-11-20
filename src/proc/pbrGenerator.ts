import * as THREE from 'three';
import { fbm2D, mulberry32, ridged2D, voronoi2D } from './noise';

export interface PBRMaterialPack {
  name: string;
  size: number;
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  aoMap: THREE.DataTexture;
  heightMap: THREE.DataTexture;
  metalnessMap?: THREE.DataTexture;
  alphaMap?: THREE.DataTexture;
  vramBytes: number;
}

export interface EnvironmentPBRAtlas {
  groundForest: PBRMaterialPack;
  groundMud: PBRMaterialPack;
  groundGravel: PBRMaterialPack;
  groundRock: PBRMaterialPack;
  microDetailNormal: THREE.DataTexture;
  microDetailRough: THREE.DataTexture;
  industrialConcrete: PBRMaterialPack;
  paintedMetal: PBRMaterialPack;
  bareSteel: PBRMaterialPack;
  industrialRubber: PBRMaterialPack;
  industrialFloor: PBRMaterialPack;
  industrialGrating: PBRMaterialPack;
  totalVramBytes: number;
  genTimeMs: number;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function fastHash(x: number, y: number, seed: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function makeDataTex(
  data: Uint8Array,
  size: number,
  srgb: boolean,
  anisotropy: number,
  repeat = 1
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Computes VRAM usage of an RGBA8 texture including full mipmap chain (~1.333x).
 */
function texBytes(size: number, count: number): number {
  return Math.round(size * size * 4 * 1.3333 * count);
}

/**
 * Generates a tileable FBM table via 4-corner toroidal blending.
 */
function createTileableFbm(
  tSize: number,
  scale: number,
  octaves: number,
  seed: number,
  ridged = false
): Float32Array {
  const out = new Float32Array(tSize * tSize);
  const inv = 1 / tSize;
  for (let y = 0; y < tSize; y++) {
    const ty = y * inv;
    for (let x = 0; x < tSize; x++) {
      const tx = x * inv;
      const u = tx * scale;
      const v = ty * scale;
      let a: number, b: number, c: number, d: number;
      if (ridged) {
        a = ridged2D(u, v, octaves, 2.05, 0.5, seed);
        b = ridged2D(u - scale, v, octaves, 2.05, 0.5, seed);
        c = ridged2D(u, v - scale, octaves, 2.05, 0.5, seed);
        d = ridged2D(u - scale, v - scale, octaves, 2.05, 0.5, seed);
      } else {
        a = fbm2D(u, v, octaves, 2.05, 0.5, seed) * 0.5 + 0.5;
        b = fbm2D(u - scale, v, octaves, 2.05, 0.5, seed) * 0.5 + 0.5;
        c = fbm2D(u, v - scale, octaves, 2.05, 0.5, seed) * 0.5 + 0.5;
        d = fbm2D(u - scale, v - scale, octaves, 2.05, 0.5, seed) * 0.5 + 0.5;
      }
      const top = a * (1 - tx) + b * tx;
      const bot = c * (1 - tx) + d * tx;
      out[y * tSize + x] = top * (1 - ty) + bot * ty;
    }
  }
  return out;
}

function sampleTable(table: Float32Array, tSize: number, u: number, v: number): number {
  const mask = tSize - 1;
  const fx = ((u % 1) + 1) % 1 * tSize;
  const fy = ((v % 1) + 1) % 1 * tSize;
  const x0 = Math.floor(fx) & mask;
  const y0 = Math.floor(fy) & mask;
  const x1 = (x0 + 1) & mask;
  const y1 = (y0 + 1) & mask;
  const tx = fx - Math.floor(fx);
  const ty = fy - Math.floor(fy);
  const v00 = table[y0 * tSize + x0];
  const v10 = table[y0 * tSize + x1];
  const v01 = table[y1 * tSize + x0];
  const v11 = table[y1 * tSize + x1];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/**
 * Tileable Voronoi cellular field returning F1, edge distance (F2-F1), and cell hash.
 */
function createTileableVoronoi(
  tSize: number,
  cells: number,
  seed: number
): { f1: Float32Array; edge: Float32Array; id: Float32Array } {
  const f1 = new Float32Array(tSize * tSize);
  const edge = new Float32Array(tSize * tSize);
  const id = new Float32Array(tSize * tSize);

  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  const cid = new Float32Array(cells * cells);
  const rng = mulberry32(seed);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = cy * cells + cx;
      px[i] = cx + 0.14 + rng() * 0.72;
      py[i] = cy + 0.14 + rng() * 0.72;
      cid[i] = rng();
    }
  }

  for (let y = 0; y < tSize; y++) {
    const gy = (y / tSize) * cells;
    const iy = Math.floor(gy);
    for (let x = 0; x < tSize; x++) {
      const gx = (x / tSize) * cells;
      const ix = Math.floor(gx);
      let d1 = 999;
      let d2 = 999;
      let bestId = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const ny = (iy + oy + cells) % cells;
        const wrapY = iy + oy < 0 ? -cells : iy + oy >= cells ? cells : 0;
        for (let ox = -1; ox <= 1; ox++) {
          const nx = (ix + ox + cells) % cells;
          const wrapX = ix + ox < 0 ? -cells : ix + ox >= cells ? cells : 0;
          const idx = ny * cells + nx;
          const dx = px[idx] + wrapX - gx;
          const dy = py[idx] + wrapY - gy;
          const d = Math.hypot(dx, dy);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            bestId = cid[idx];
          } else if (d < d2) {
            d2 = d;
          }
        }
      }
      const o = y * tSize + x;
      f1[o] = Math.min(1, d1);
      edge[o] = Math.min(1, d2 - d1);
      id[o] = bestId;
    }
  }
  return { f1, edge, id };
}

/**
 * Builds Sobel-filtered tangent-space normal map + local cavity AO from height buffer (0..1).
 */
function buildNormalAndAO(
  height: Float32Array,
  size: number,
  normalStrength: number,
  aoRadius = 2
): { normal: Uint8Array; ao: Uint8Array; heightBytes: Uint8Array } {
  const normal = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const heightBytes = new Uint8Array(size * size * 4);
  const mask = size - 1;

  for (let y = 0; y < size; y++) {
    const ym = (y - 1) & mask;
    const yp = (y + 1) & mask;
    const yOff = y * size;
    const ymOff = ym * size;
    const ypOff = yp * size;

    const ym2 = (y - aoRadius) & mask;
    const yp2 = (y + aoRadius) & mask;

    for (let x = 0; x < size; x++) {
      const xm = (x - 1) & mask;
      const xp = (x + 1) & mask;

      const tl = height[ymOff + xm];
      const tc = height[ymOff + x];
      const tr = height[ymOff + xp];
      const ml = height[yOff + xm];
      const mc = height[yOff + x];
      const mr = height[yOff + xp];
      const bl = height[ypOff + xm];
      const bc = height[ypOff + x];
      const br = height[ypOff + xp];

      const dx = (tr + 2 * mr + br - (tl + 2 * ml + bl)) * normalStrength;
      const dy = (bl + 2 * bc + br - (tl + 2 * tc + tr)) * normalStrength;
      const nz = 1.0;
      const inv = 1.0 / Math.hypot(dx, dy, nz);

      const idx = (yOff + x) * 4;
      normal[idx] = clampByte((-dx * inv * 0.5 + 0.5) * 255);
      normal[idx + 1] = clampByte((-dy * inv * 0.5 + 0.5) * 255);
      normal[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      normal[idx + 3] = 255;

      // Multi-tap horizon cavity occlusion (crevices darken naturally!)
      const xm2 = (x - aoRadius) & mask;
      const xp2 = (x + aoRadius) & mask;
      const avgN =
        (tl + tc + tr + ml + mr + bl + bc + br +
          height[ym2 * size + x] + height[yp2 * size + x] + height[yOff + xm2] + height[yOff + xp2]) /
        12;
      const cavity = Math.max(0, avgN - mc);
      const aoVal = Math.max(0.28, Math.min(1.0, 0.92 - cavity * 2.6 + mc * 0.14));
      const aoB = clampByte(aoVal * 255);
      ao[idx] = ao[idx + 1] = ao[idx + 2] = aoB;
      ao[idx + 3] = 255;

      const hb = clampByte(Math.max(0, Math.min(1, mc)) * 255);
      heightBytes[idx] = heightBytes[idx + 1] = heightBytes[idx + 2] = hb;
      heightBytes[idx + 3] = 255;
    }
  }
  return { normal, ao, heightBytes };
}

/**
 * Stamps physically-shaped faceted pebbles/stones directly into tiled height, albedo, and roughness buffers.
 */
function stampAngularStones(
  size: number,
  height: Float32Array,
  albedo: Uint8Array,
  rough: Uint8Array,
  count: number,
  minR: number,
  maxR: number,
  heightGain: number,
  palette: Array<[number, number, number]>,
  seed: number
): void {
  const rng = mulberry32(seed);
  const mask = size - 1;

  for (let i = 0; i < count; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const rx = minR + Math.pow(rng(), 1.65) * (maxR - minR);
    const ry = rx * (0.55 + rng() * 0.55);
    const rot = rng() * Math.PI * 2;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const facets = 5 + ((rng() * 4) | 0);
    const facetPhase = rng() * Math.PI * 2;
    const facetAmp = 0.12 + rng() * 0.14;
    const baseLift = 0.25 + rng() * 0.55;
    const tiltX = (rng() - 0.5) * 0.35;
    const tiltY = (rng() - 0.5) * 0.35;
    const col = palette[(rng() * palette.length) | 0];
    const shadeVar = 0.80 + rng() * 0.36;
    const stoneRough = 0.58 + rng() * 0.28;

    const bound = Math.ceil(Math.max(rx, ry) * 1.25);
    const x0 = Math.floor(cx) - bound;
    const x1 = Math.floor(cx) + bound;
    const y0 = Math.floor(cy) - bound;
    const y1 = Math.floor(cy) + bound;

    for (let py = y0; py <= y1; py++) {
      const dy = py - cy;
      const wy = py & mask;
      const row = wy * size;
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx;
        const lx = (dx * cosR + dy * sinR) / rx;
        const ly = (-dx * sinR + dy * cosR) / ry;
        const ang = Math.atan2(ly, lx);
        // Angular rock polygon silhouette
        const polyMod = 1.0 + Math.cos(ang * facets + facetPhase) * facetAmp;
        const dist = Math.hypot(lx, ly) / polyMod;
        if (dist >= 1.0) continue;

        // Beveled chiseled dome profile with facet plane tilt
        const dome = Math.pow(1.0 - dist * dist, 0.52);
        const facetSlope = Math.max(0.25, 1.0 + lx * tiltX + ly * tiltY);
        const microChip = (fastHash(px & mask, py & mask, seed + 7) - 0.5) * 0.06;
        const stoneH = (baseLift + dome * 0.68 * facetSlope + microChip) * heightGain;

        const wx = px & mask;
        const idx = row + wx;
        if (stoneH > height[idx]) {
          // Soft blend at very outer pebble skirt so stone embeds organically into dirt
          const edgeBlend = Math.min(1, (1.0 - dist) * 5.0);
          height[idx] = height[idx] * (1 - edgeBlend) + stoneH * edgeBlend;

          const pIdx = idx * 4;
          const rimAO = 0.72 + 0.28 * Math.min(1, (1.0 - dist) * 3.0);
          const grain = 0.90 + fastHash(wx, wy, seed + 19) * 0.20;
          const rVal = col[0] * shadeVar * rimAO * grain;
          const gVal = col[1] * shadeVar * rimAO * grain;
          const bVal = col[2] * shadeVar * rimAO * grain;

          albedo[pIdx] = clampByte(albedo[pIdx] * (1 - edgeBlend) + rVal * edgeBlend);
          albedo[pIdx + 1] = clampByte(albedo[pIdx + 1] * (1 - edgeBlend) + gVal * edgeBlend);
          albedo[pIdx + 2] = clampByte(albedo[pIdx + 2] * (1 - edgeBlend) + bVal * edgeBlend);

          const targetR = clampByte(stoneRough * 255);
          rough[pIdx] = rough[pIdx + 1] = rough[pIdx + 2] = clampByte(
            rough[pIdx] * (1 - edgeBlend) + targetR * edgeBlend
          );
        }
      }
    }
  }
}

/**
 * Stamps organic curved dry grass stalks, pine needles, twigs & dead leaf litter onto ground textures.
 */
function stampOrganicLitter(
  size: number,
  height: Float32Array,
  albedo: Uint8Array,
  rough: Uint8Array,
  stalkCount: number,
  leafCount: number,
  seed: number
): void {
  const rng = mulberry32(seed);
  const mask = size - 1;

  // 1. Dry grass stalks & pine needles
  for (let i = 0; i < stalkCount; i++) {
    let x = rng() * size;
    let y = rng() * size;
    let ang = rng() * Math.PI * 2;
    const len = 10 + rng() * 28;
    const bend = (rng() - 0.5) * 0.09;
    const halfW = 0.8 + rng() * 1.1;
    const isDry = rng() > 0.28;
    const rCol = isDry ? 102 + rng() * 38 : 66 + rng() * 24;
    const gCol = isDry ? 88 + rng() * 30 : 78 + rng() * 26;
    const bCol = isDry ? 52 + rng() * 18 : 42 + rng() * 16;
    const lift = 0.08 + rng() * 0.14;

    const steps = Math.ceil(len);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const taper = 1.0 - t * 0.55;
      const hw = Math.max(1, Math.ceil(halfW * taper));
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      for (let oy = -hw; oy <= hw; oy++) {
        const wy = (cy + oy) & mask;
        for (let ox = -hw; ox <= hw; ox++) {
          const d = Math.hypot(ox, oy);
          if (d > halfW * taper + 0.35) continue;
          const wx = (cx + ox) & mask;
          const idx = wy * size + wx;
          const hNew = height[idx] + lift * (1 - d / (halfW + 0.6));
          if (hNew > height[idx] + 0.01) {
            height[idx] = Math.min(1.0, hNew);
            const pIdx = idx * 4;
            const shade = 0.82 + 0.28 * Math.sin(t * Math.PI);
            albedo[pIdx] = clampByte(albedo[pIdx] * 0.25 + rCol * shade * 0.75);
            albedo[pIdx + 1] = clampByte(albedo[pIdx + 1] * 0.25 + gCol * shade * 0.75);
            albedo[pIdx + 2] = clampByte(albedo[pIdx + 2] * 0.25 + bCol * shade * 0.75);
            const rVal = clampByte((0.86 + rng() * 0.08) * 255);
            rough[pIdx] = rough[pIdx + 1] = rough[pIdx + 2] = rVal;
          }
        }
      }
      x += Math.cos(ang);
      y += Math.sin(ang);
      ang += bend;
    }
  }

  // 2. Fallen decayed autumn/humus leaves
  for (let i = 0; i < leafCount; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const rx = 5 + rng() * 9;
    const ry = rx * (0.42 + rng() * 0.28);
    const rot = rng() * Math.PI * 2;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const tone = rng();
    const rCol = tone < 0.5 ? 86 + rng() * 32 : 64 + rng() * 24;
    const gCol = tone < 0.5 ? 62 + rng() * 24 : 52 + rng() * 20;
    const bCol = 32 + rng() * 14;
    const bound = Math.ceil(rx * 1.15);

    for (let dy = -bound; dy <= bound; dy++) {
      const wy = (Math.floor(cy) + dy) & mask;
      for (let dx = -bound; dx <= bound; dx++) {
        const lx = (dx * cosR + dy * sinR) / rx;
        const ly = (-dx * sinR + dy * cosR) / ry;
        // Pointed leaf silhouette
        const leafWidth = Math.max(0, 1 - lx * lx);
        if (Math.abs(lx) >= 1 || Math.abs(ly) >= leafWidth) continue;
        const wx = (Math.floor(cx) + dx) & mask;
        const idx = wy * size + wx;
        const midrib = 1 - Math.min(1, Math.abs(ly) * 4.0);
        height[idx] = Math.min(1.0, height[idx] + 0.055 + midrib * 0.025);
        const pIdx = idx * 4;
        const ribShade = 0.86 + midrib * 0.16;
        albedo[pIdx] = clampByte(albedo[pIdx] * 0.2 + rCol * ribShade * 0.8);
        albedo[pIdx + 1] = clampByte(albedo[pIdx + 1] * 0.2 + gCol * ribShade * 0.8);
        albedo[pIdx + 2] = clampByte(albedo[pIdx + 2] * 0.2 + bCol * ribShade * 0.8);
        rough[pIdx] = rough[pIdx + 1] = rough[pIdx + 2] = clampByte(0.84 * 255);
      }
    }
  }
}

/**
 * 1. FOREST FLOOR PBR: Humus soil clumps + moss patches + stamped dry grass stalks, twigs & dead leaves
 */
function generateGroundForest(size: number, aniso: number): PBRMaterialPack {
  const warpX = createTileableFbm(128, 4, 3, 7101);
  const warpY = createTileableFbm(128, 4, 3, 7102);
  const macro = createTileableFbm(128, 5, 4, 7103);
  const clods = createTileableVoronoi(128, 22, 7104);
  const mossNoise = createTileableFbm(128, 7, 4, 7105);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const wx = sampleTable(warpX, 128, u, v) - 0.5;
      const wy = sampleTable(warpY, 128, u, v) - 0.5;
      const wu = u + wx * 0.09;
      const wv = v + wy * 0.09;

      const m = sampleTable(macro, 128, wu, wv);
      const clodEdge = sampleTable(clods.edge, 128, wu * 1.5, wv * 1.5);
      const clodH = Math.min(1, clodEdge * 2.6);
      const moss = sampleTable(mossNoise, 128, wu, wv);
      const grain = (fastHash(x, y, 7106) - 0.5) * 0.10;

      // Rich organic humus micro-relief
      const mossPatch = Math.max(0, (moss - 0.42) * 1.9);
      const h = Math.max(0.02, Math.min(0.82, 0.24 + m * 0.26 + clodH * 0.18 + mossPatch * 0.14 + grain));
      height[row + x] = h;

      // CoD4 overcast natural olive-brown humus + muted woodland moss (never neon green!)
      let r = 56 + m * 24 + clodH * 14 + grain * 26;
      let g = 50 + m * 20 + clodH * 11 + grain * 22;
      let b = 36 + m * 14 + clodH * 7 + grain * 16;

      // Blend damp mossy turf patches
      const mBlend = Math.min(1, mossPatch * 0.92);
      const mr = 54 + moss * 24 + grain * 18;
      const mg = 70 + moss * 30 + grain * 22;
      const mb = 38 + moss * 14 + grain * 12;
      r = r * (1 - mBlend) + mr * mBlend;
      g = g * (1 - mBlend) + mg * mBlend;
      b = b * (1 - mBlend) + mb * mBlend;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(r);
      albedo[idx + 1] = clampByte(g);
      albedo[idx + 2] = clampByte(b);
      albedo[idx + 3] = 255;

      const rv = 0.88 - m * 0.08 + mBlend * 0.06;
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(Math.min(0.96, rv) * 255);
      rough[idx + 3] = 255;
    }
  }

  // Stamp real dry grass blades, pine needles, humus leaves & small embedded soil pebbles
  stampOrganicLitter(size, height, albedo, rough, Math.round(size * 2.2), Math.round(size * 0.35), 7110);
  stampAngularStones(
    size,
    height,
    albedo,
    rough,
    Math.round(size * 0.45),
    2.5,
    8.0,
    0.72,
    [
      [92, 88, 82],
      [74, 70, 65],
      [108, 102, 92],
    ],
    7111
  );

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 4.4, 3);
  return {
    name: 'groundForest',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 5),
  };
}

/**
 * 2. WET CLAY / MUD PBR: Domain-warped mud flow ridges, organic soft clods, fine grit & stamped small stones
 * (Zero uniform Voronoi scales — natural muddy battlefield earth!)
 */
function generateGroundMud(size: number, aniso: number): PBRMaterialPack {
  const warpX = createTileableFbm(128, 3.0, 3, 7201);
  const warpY = createTileableFbm(128, 3.0, 3, 7202);
  const macro = createTileableFbm(128, 4.0, 4, 7203);
  const midFbm = createTileableFbm(128, 9.0, 4, 7204);
  const fineFbm = createTileableFbm(128, 22.0, 3, 7205);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const wx = sampleTable(warpX, 128, u, v) - 0.5;
      const wy = sampleTable(warpY, 128, u, v) - 0.5;
      const wu = u + wx * 0.18;
      const wv = v + wy * 0.18;

      const m = sampleTable(macro, 128, wu, wv);
      const mid = sampleTable(midFbm, 128, wu + wy * 0.08, wv - wx * 0.08);
      const fn = sampleTable(fineFbm, 128, u, v);
      // Soft flow ripples mimicking rain-washed earth & boot prints
      const flow = sampleTable(macro, 128, wu * 0.65, wv * 2.1);
      const sand = (fastHash(x, y, 7206) - 0.5) * 0.11;

      const h = Math.max(0.02, Math.min(0.84, 0.14 + m * 0.30 + mid * 0.24 + flow * 0.12 + fn * 0.10 + sand * 0.6));
      height[row + x] = h;

      // Rich damp brown clay in depressions, slightly drier loamy earth on raised bumps
      const elev = Math.max(0, (h - 0.38) * 1.9);
      const r = 48 + m * 24 + elev * 26 + fn * 12 + sand * 22;
      const g = 39 + m * 19 + elev * 20 + fn * 10 + sand * 18;
      const b = 29 + m * 13 + elev * 13 + fn * 7 + sand * 14;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(r);
      albedo[idx + 1] = clampByte(g);
      albedo[idx + 2] = clampByte(b);
      albedo[idx + 3] = 255;

      const rv = Math.max(0.36, Math.min(0.90, 0.48 + elev * 0.36 + fn * 0.08 + sand * 0.10));
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(rv * 255);
      rough[idx + 3] = 255;
    }
  }

  // Stamp organic varied dirt clods + embedded grit pebbles + stray crushed stalks
  stampAngularStones(
    size,
    height,
    albedo,
    rough,
    Math.round(size * 0.9),
    3.5,
    13.0,
    0.58,
    [
      [62, 50, 37],
      [52, 42, 31],
      [74, 60, 44],
    ],
    7209
  );
  stampAngularStones(
    size,
    height,
    albedo,
    rough,
    Math.round(size * 0.65),
    1.8,
    6.5,
    0.76,
    [
      [88, 84, 78],
      [70, 66, 61],
      [104, 98, 88],
    ],
    7210
  );
  stampOrganicLitter(size, height, albedo, rough, Math.round(size * 0.55), Math.round(size * 0.16), 7211);

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 4.0, 3);
  return {
    name: 'groundMud',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 5),
  };
}

/**
 * 3. CRUSHED GRAVEL & COARSE SAND PBR: Multi-scale faceted angular stones densely packed over dark silty bed
 */
function generateGroundGravel(size: number, aniso: number): PBRMaterialPack {
  const macro = createTileableFbm(128, 6, 4, 7301);
  const fineVor = createTileableVoronoi(128, 38, 7302);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  // Sandy-silt gravel bed base
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTable(macro, 128, u, v);
      const fv = sampleTable(fineVor.edge, 128, u * 2.0, v * 2.0);
      const fId = sampleTable(fineVor.id, 128, u * 2.0, v * 2.0);
      const grit = (fastHash(x, y, 7303) - 0.5) * 0.14;
      const fineSand = Math.min(1, fv * 3.2) * (0.65 + fId * 0.35);

      height[row + x] = Math.max(0.04, 0.14 + m * 0.14 + fineSand * 0.22 + grit * 0.5);
      const idx = (row + x) * 4;
      const lum = 54 + m * 20 + fineSand * 28 + grit * 32;
      albedo[idx] = clampByte(lum * 1.02);
      albedo[idx + 1] = clampByte(lum * 0.99);
      albedo[idx + 2] = clampByte(lum * 0.93);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.84 - fineSand * 0.12) * 255);
      rough[idx + 3] = 255;
    }
  }

  const gravelPalette: Array<[number, number, number]> = [
    [118, 114, 108], // Crushed limestone
    [92, 90, 88],    // Granite grey
    [134, 126, 114], // Pale quartz-sandstone
    [72, 74, 76],    // Dark basalt chip
    [108, 96, 82],   // Iron-stained ochre pebble
  ];

  // 3-tier gravel particle stamping: coarse sand -> medium crushed chips -> larger angular cobbles
  stampAngularStones(size, height, albedo, rough, Math.round(size * 4.5), 2.2, 5.2, 0.65, gravelPalette, 7310);
  stampAngularStones(size, height, albedo, rough, Math.round(size * 2.4), 5.0, 12.0, 0.85, gravelPalette, 7311);
  stampAngularStones(size, height, albedo, rough, Math.round(size * 0.55), 11.0, 21.0, 0.98, gravelPalette, 7312);

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 4.8, 3);
  return {
    name: 'groundGravel',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 5),
  };
}

/**
 * 4. STRATIFIED WEATHERED BEDROCK PBR: Natural sedimentary cliff strata, diagonal shear fractures, mineral grain & crevice moss
 * (Zero cobblestone brick look — realistic natural mountain rockface!)
 */
function generateGroundRock(size: number, aniso: number): PBRMaterialPack {
  const warpX = createTileableFbm(128, 3, 4, 7401);
  const warpY = createTileableFbm(128, 3, 4, 7402);
  const strata = createTileableFbm(128, 5, 4, 7403, true);
  const macro = createTileableFbm(128, 4, 4, 7404);
  const fine = createTileableFbm(128, 18, 3, 7408);
  const crackFbm = createTileableFbm(128, 7, 3, 7405, true);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const wx = sampleTable(warpX, 128, u, v) - 0.5;
      const wy = sampleTable(warpY, 128, u, v) - 0.5;
      const wu = u + wx * 0.22;
      const wv = v + wy * 0.16;

      // Elongated stratified sedimentary rock shelves
      const sLayer = sampleTable(strata, 128, wu * 0.6, wv * 2.6);
      const sSub = sampleTable(strata, 128, wu * 1.4, wv * 4.2);
      const m = sampleTable(macro, 128, wu, wv);
      const fn = sampleTable(fine, 128, u, v);
      // Narrow organic rock fissures (only sharp where ridged noise peaks!)
      const fissure = sampleTable(crackFbm, 128, wu * 1.2, wv * 1.8);
      const crackCut = fissure > 0.80 ? Math.min(0.45, (fissure - 0.80) * 2.8) : 0;
      const mineral = (fastHash(x, y, 7407) - 0.5) * 0.14;

      // Terraced cliff strata steps
      const terrace = Math.floor(sLayer * 5.0) / 5.0 * 0.35 + sLayer * 0.65;
      const h = Math.max(
        0.02,
        Math.min(0.98, 0.22 + terrace * 0.42 + sSub * 0.16 + m * 0.16 + fn * 0.08 - crackCut + mineral * 0.32)
      );
      height[row + x] = h;

      // Realistic cool weathered slate-granite + warm ochre iron veins + dark moss in crevices
      const ironTint = Math.max(0, m - 0.56) * 1.4;
      const lum = 56 + h * 62 + fn * 14 + mineral * 28 - crackCut * 70;
      const crackMoss = crackCut > 0.08 && m > 0.46 ? Math.min(0.75, crackCut * 2.2) : 0;

      const r = (lum * (0.95 + ironTint * 0.12)) * (1 - crackMoss) + 46 * crackMoss;
      const g = (lum * (0.98 + ironTint * 0.04)) * (1 - crackMoss) + 64 * crackMoss;
      const b = (lum * (1.02 - ironTint * 0.08)) * (1 - crackMoss) + 36 * crackMoss;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(r);
      albedo[idx + 1] = clampByte(g);
      albedo[idx + 2] = clampByte(b);
      albedo[idx + 3] = 255;

      const rv = 0.72 + (1 - h) * 0.18 + crackMoss * 0.14 - mineral * 0.12;
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(Math.max(0.48, Math.min(0.95, rv)) * 255);
      rough[idx + 3] = 255;
    }
  }

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 4.8, 3);
  return {
    name: 'groundRock',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 5),
  };
}

/**
 * High-frequency 512x512 detail normal & roughness micro-grain texture for crisp close-up terrain inspection.
 */
function generateMicroDetail(aniso: number): { normal: THREE.DataTexture; rough: THREE.DataTexture } {
  const size = 512;
  const f1 = createTileableFbm(128, 12, 3, 7501);
  const v1 = createTileableVoronoi(128, 28, 7502);
  const height = new Float32Array(size * size);
  const rough = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const n = sampleTable(f1, 128, u, v);
      const ve = sampleTable(v1.edge, 128, u, v);
      const g = fastHash(x, y, 7503);
      const h = n * 0.4 + Math.min(1, ve * 3.0) * 0.35 + g * 0.25;
      height[row + x] = h;
      const idx = (row + x) * 4;
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.75 + (g - 0.5) * 0.25) * 255);
      rough[idx + 3] = 255;
    }
  }
  const { normal } = buildNormalAndAO(height, size, 3.6, 1);
  return {
    normal: makeDataTex(normal, size, false, aniso),
    rough: makeDataTex(rough, size, false, aniso),
  };
}

/**
 * 5. INDUSTRIAL REINFORCED CONCRETE PBR (Poured formwork seams, recessed tie-rod holes, spalling, dust & seepage)
 */
function generateIndustrialConcrete(size: number, aniso: number): PBRMaterialPack {
  const macro = createTileableFbm(256, 5, 4, 8101);
  const detail = createTileableFbm(256, 18, 3, 8102);
  const spall = createTileableVoronoi(256, 16, 8103);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  const panelStep = size / 4; // 4x4 concrete formwork blocks per tile
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const py = y % panelStep;
    const seamY = py < 3 || py > panelStep - 3 ? 0.32 : (y % (panelStep / 2)) < 1 ? 0.10 : 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const px = x % panelStep;
      const seamX = px < 3 || px > panelStep - 3 ? 0.28 : 0;

      const m = sampleTable(macro, 256, u, v);
      const d = sampleTable(detail, 256, u, v);
      const spEdge = sampleTable(spall.edge, 256, u * 1.5, v * 1.5);
      const streak = sampleTable(macro, 256, u * 5.0, v * 0.22);

      // Tie-rod cone holes centered symmetrically per formwork panel
      const tx = (px % (panelStep / 2)) - panelStep * 0.25;
      const ty = (py % (panelStep / 2)) - panelStep * 0.25;
      const dTie = Math.hypot(tx, ty);
      const tieHole = dTie < size * 0.0065 ? (1 - dTie / (size * 0.0065)) * 0.44 : 0;
      const tieRust = Math.abs(tx) < 4 && ty > 0 && ty < panelStep * 0.35 ? (1 - ty / (panelStep * 0.35)) * 0.26 : 0;

      // Aggregate air pockets + weathered concrete spalling near seams
      const pit = fastHash(x, y, 8104) > 0.955 ? -0.22 : (fastHash(x, y, 8105) - 0.5) * 0.08;
      const chip = (seamX > 0 || seamY > 0) && spEdge < 0.14 ? -0.18 : 0;
      const h = Math.max(0.02, Math.min(0.98, 0.56 + (m - 0.5) * 0.22 + (d - 0.5) * 0.16 + pit + chip - seamY - seamX - tieHole));
      height[row + x] = h;

      const damp = streak > 0.58 ? Math.min(1, (streak - 0.58) * 1.8) : 0;
      const dust = Math.max(0, (d - 0.62) * 1.4) * (1 - damp);
      const baseLum = (96 + m * 24 + d * 14 + pit * 36 - (seamY + seamX) * 58 - tieHole * 54) * (1 - damp * 0.28) + dust * 16;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(baseLum * 0.98 + tieRust * 52);
      albedo[idx + 1] = clampByte(baseLum * 1.0 + tieRust * 22);
      albedo[idx + 2] = clampByte(baseLum * 1.01 - tieRust * 14);
      albedo[idx + 3] = 255;

      const rv = Math.max(0.32, Math.min(0.96, 0.88 - damp * 0.44 + dust * 0.07 + Math.abs(pit) * 0.2));
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(rv * 255);
      rough[idx + 3] = 255;
    }
  }

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 4.4, 2);
  return {
    name: 'industrialConcrete',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 5),
  };
}

/**
 * 6. PAINTED INDUSTRIAL METAL PBR (Cold-war military slate-olive enamel, panel rivets, edge paint chipping, scratches, dust & rust streaks)
 */
function generatePaintedMetal(size: number, aniso: number): PBRMaterialPack {
  const macro = createTileableFbm(256, 5, 4, 8201);
  const detail = createTileableFbm(256, 20, 3, 8202);
  const rustMap = createTileableFbm(256, 7, 4, 8203, true);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const metal = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  const panelStep = size / 2;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const py = y % panelStep;
    const distEdgeY = Math.min(py, panelStep - py);
    const seamY = distEdgeY < 3 ? 0.35 : 0;

    for (let x = 0; x < size; x++) {
      const u = x / size;
      const px = x % panelStep;
      const distEdgeX = Math.min(px, panelStep - px);
      const seamX = distEdgeX < 3 ? 0.35 : 0;

      const m = sampleTable(macro, 256, u, v);
      const d = sampleTable(detail, 256, u, v);
      const rm = sampleTable(rustMap, 256, u, v);
      const scratchNoise = sampleTable(detail, 256, u * 0.3, v * 4.5);

      // Raised dome rivets along panel perimeter
      const rivetSpacing = size / 16;
      let rivetH = 0;
      if ((distEdgeX > 14 && distEdgeX < 26) || (distEdgeY > 14 && distEdgeY < 26)) {
        const rx = (x % rivetSpacing) - rivetSpacing * 0.5;
        const ry = (y % rivetSpacing) - rivetSpacing * 0.5;
        const rd = Math.hypot(rx, ry);
        if (rd < 5.0) rivetH = Math.sqrt(Math.max(0, 1 - (rd / 5.0) ** 2)) * 0.28;
      }

      // Edge paint wear & subtle scratches revealing bare steel + localized dark rust at seams/rivets!
      const nearEdge = Math.min(distEdgeX, distEdgeY) < 18 ? 1 - Math.min(distEdgeX, distEdgeY) / 18 : 0;
      const scratch = scratchNoise > 0.82 ? (scratchNoise - 0.82) * 4.2 : 0;
      const paintChip = Math.min(1, Math.max(0, nearEdge * (0.45 + d * 0.95) - 0.55) * 2.2 + scratch * 0.72);
      // Restrained realistic rust concentrated near seams, drips & sporadic spots (8..15% coverage, dark oxidized brown!)
      const seamRust = nearEdge * Math.max(0, m - 0.36) * 1.45;
      const spotRust = Math.max(0, (rm - 0.78) * 3.2) * (m > 0.54 ? 0.75 : 0.15);
      const rust = Math.min(0.92, (seamRust + spotRust) * (1 - paintChip * 0.6));
      const grime = Math.max(0, (1 - m) * 0.42);

      const h = Math.max(0.04, Math.min(0.98, 0.56 + (m - 0.5) * 0.08 + rivetH - paintChip * 0.09 - rust * 0.05 - seamX - seamY));
      height[row + x] = h;

      // Industrial cold-war painted steel base (muted steel slate-olive)
      let r = 82 + m * 18 - grime * 20;
      let g = 90 + m * 20 - grime * 20;
      let b = 86 + m * 18 - grime * 16;

      // Blend bare steel on chipped edges & scratches
      r = r * (1 - paintChip) + 154 * paintChip;
      g = g * (1 - paintChip) + 158 * paintChip;
      b = b * (1 - paintChip) + 164 * paintChip;

      // Blend dark oxidized iron-oxide rust (muted brown-umber, never neon orange!)
      r = r * (1 - rust) + (78 + d * 22) * rust;
      g = g * (1 - rust) + (44 + d * 12) * rust;
      b = b * (1 - rust) + (28 + d * 8) * rust;

      const seamDark = 1 - Math.min(0.65, (seamX + seamY) * 1.6);
      const idx = (row + x) * 4;
      albedo[idx] = clampByte(r * seamDark);
      albedo[idx + 1] = clampByte(g * seamDark);
      albedo[idx + 2] = clampByte(b * seamDark);
      albedo[idx + 3] = 255;

      const rv = Math.max(0.24, Math.min(0.94, 0.50 + grime * 0.30 + rust * 0.40 - paintChip * 0.24));
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(rv * 255);
      rough[idx + 3] = 255;

      const mv = Math.max(0.05, Math.min(0.96, (0.26 + paintChip * 0.68) * (1 - rust * 0.85)));
      metal[idx] = metal[idx + 1] = metal[idx + 2] = clampByte(mv * 255);
      metal[idx + 3] = 255;
    }
  }

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 3.8, 2);
  return {
    name: 'paintedMetal',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    metalnessMap: makeDataTex(metal, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 6),
  };
}

/**
 * 7. BARE STRUCTURAL STEEL PBR (Hot-rolled I-beams & plates: mill scale, brushed scratches, weld oil & spot rust)
 */
function generateBareSteel(size: number, aniso: number): PBRMaterialPack {
  const macro = createTileableFbm(256, 6, 4, 8301);
  const brush = createTileableFbm(256, 16, 3, 8302);
  const rustN = createTileableFbm(256, 8, 4, 8303, true);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const metal = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const lineBrush = (fastHash(y >> 1, 13, 8304) - 0.5) * 0.14;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTable(macro, 256, u, v);
      const b = sampleTable(brush, 256, u * 0.25, v * 3.2);
      const rn = sampleTable(rustN, 256, u, v);
      const grain = (fastHash(x, y, 8305) - 0.5) * 0.08;

      const scratch = Math.max(0, b - 0.68) * 2.1;
      // Restrained realistic hot-rolled mill-scale oxidation & sparse dark rust blotches
      const rust = Math.min(0.85, Math.max(0, (rn - 0.77) * 3.2) * (m > 0.50 ? 1.0 : 0.25));
      const h = Math.max(0.05, Math.min(0.98, 0.52 + lineBrush * 0.35 + (m - 0.5) * 0.16 + scratch * 0.12 - rust * 0.14 + grain));
      height[row + x] = h;

      // Dark hot-rolled mill scale steel with bright machined scratches & subtle umber rust
      const lum = 92 + m * 34 + lineBrush * 24 + scratch * 72 + grain * 18;
      const r = lum * 0.96 * (1 - rust) + (82 + m * 24) * rust;
      const g = lum * 0.99 * (1 - rust) + (48 + m * 14) * rust;
      const bCol = lum * 1.04 * (1 - rust) + (30 + m * 8) * rust;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(r);
      albedo[idx + 1] = clampByte(g);
      albedo[idx + 2] = clampByte(bCol);
      albedo[idx + 3] = 255;

      const rv = Math.max(0.20, Math.min(0.92, 0.42 + (1 - m) * 0.18 - scratch * 0.22 + rust * 0.46));
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(rv * 255);
      rough[idx + 3] = 255;

      const mv = Math.max(0.08, Math.min(0.98, 0.88 + scratch * 0.09 - rust * 0.78));
      metal[idx] = metal[idx + 1] = metal[idx + 2] = clampByte(mv * 255);
      metal[idx + 3] = 255;
    }
  }

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 3.2, 2);
  return {
    name: 'bareSteel',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    metalnessMap: makeDataTex(metal, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 6),
  };
}

/**
 * 8. INDUSTRIAL RUBBER PBR (Anti-slip ribbed & diamond-knurled mat/cable jacket, micro-granule & dusty scuffing)
 */
function generateIndustrialRubber(size: number, aniso: number): PBRMaterialPack {
  const macro = createTileableFbm(256, 6, 3, 8401);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  const cell = size / 32;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTable(macro, 256, u, v);
      // Raised alternating diamond tread ribs
      const gx = (x / cell) % 2;
      const gy = (y / cell) % 2;
      const fx = (gx % 1) - 0.5;
      const fy = (gy % 1) - 0.5;
      const alt = ((Math.floor(gx) + Math.floor(gy)) & 1) === 0;
      const rx = alt ? fx * 0.707 - fy * 0.707 : fx * 0.707 + fy * 0.707;
      const ry = alt ? fx * 0.707 + fy * 0.707 : -fx * 0.707 + fy * 0.707;
      const tread = Math.abs(rx) < 0.14 && Math.abs(ry) < 0.34 ? 1.0 - Math.abs(rx) / 0.14 : 0;
      const micro = (fastHash(x, y, 8402) - 0.5) * 0.12;

      const h = Math.max(0.05, Math.min(0.98, 0.36 + tread * 0.44 + (m - 0.5) * 0.08 + micro));
      height[row + x] = h;

      // Scuffed dark vulcanized rubber with subtle grey dust in recessed grooves
      const dustInGroove = (1 - tread) * Math.max(0, m - 0.42) * 28;
      const scuffTop = tread * Math.max(0, 0.55 - m) * 24;
      const lum = 36 + tread * 14 + dustInGroove + scuffTop + micro * 16;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(lum * 0.99);
      albedo[idx + 1] = clampByte(lum * 1.0);
      albedo[idx + 2] = clampByte(lum * 1.02);
      albedo[idx + 3] = 255;

      const rv = Math.max(0.55, Math.min(0.95, 0.78 - tread * 0.14 + (dustInGroove / 28) * 0.16));
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(rv * 255);
      rough[idx + 3] = 255;
    }
  }

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 4.0, 2);
  return {
    name: 'industrialRubber',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 5),
  };
}

/**
 * 9. INDUSTRIAL CONCRETE FLOOR PBR (Expansion joints, boot/tire traffic polish, oil spills, dust in seams, subtle aggregate)
 */
function generateIndustrialFloor(size: number, aniso: number): PBRMaterialPack {
  const macro = createTileableFbm(256, 4, 4, 8501);
  const detail = createTileableFbm(256, 20, 3, 8502);
  const oilN = createTileableFbm(256, 3.5, 4, 8503);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  const slab = size / 2;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const jy = y % slab;
    const jointY = jy < 4 || jy > slab - 4 ? 0.36 : 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const jx = x % slab;
      const jointX = jx < 4 || jx > slab - 4 ? 0.36 : 0;

      const m = sampleTable(macro, 256, u, v);
      const d = sampleTable(detail, 256, u, v);
      const oil = sampleTable(oilN, 256, u, v);
      const grit = (fastHash(x, y, 8504) - 0.5) * 0.12;

      const h = Math.max(0.02, Math.min(0.95, 0.54 + (m - 0.5) * 0.18 + (d - 0.5) * 0.16 + grit - jointX - jointY));
      height[row + x] = h;

      // Oil/water sheen puddles in localized spots vs dusty matte concrete elsewhere
      const oilSpot = Math.max(0, (oil - 0.60) * 2.5);
      const dust = Math.max(0, (0.48 - oil) * 1.4);
      const lum = (78 + m * 24 + d * 14 + grit * 26 - (jointX + jointY) * 52) * (1 - oilSpot * 0.36) + dust * 14;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(lum * 0.96);
      albedo[idx + 1] = clampByte(lum * 0.99);
      albedo[idx + 2] = clampByte(lum * 1.03);
      albedo[idx + 3] = 255;

      // Strong oil/dry roughness contrast without making the entire floor look like glossy plastic tiles!
      const rv = Math.max(0.18, Math.min(0.94, 0.82 - oilSpot * 0.56 + dust * 0.12 + (jointX + jointY) * 0.25));
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(rv * 255);
      rough[idx + 3] = 255;
    }
  }

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 4.0, 2);
  return {
    name: 'industrialFloor',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 5),
  };
}

/**
 * 10. INDUSTRIAL METAL GRATING PBR (True perforated steel catwalk grating with serrated anti-slip bars + alpha cutout)
 */
function generateIndustrialGrating(size: number, aniso: number): PBRMaterialPack {
  const macro = createTileableFbm(256, 6, 3, 8601);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const metal = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  const cellX = size / 20;
  const cellY = size / 10;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const fy = (y % cellY) / cellY;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const fx = (x % cellX) / cellX;
      const m = sampleTable(macro, 256, u, v);

      const bearingBar = fx < 0.20 || fx > 0.80;
      const crossBar = fy < 0.14 || fy > 0.86;
      const solid = bearingBar || crossBar;

      // Serrated anti-slip teeth along bearing bars
      const tooth = bearingBar ? 0.85 + 0.15 * Math.sin(v * Math.PI * 2 * 60) : 0.72;
      const h = solid ? tooth : 0.0;
      height[row + x] = h;

      const idx = (row + x) * 4;
      const rust = Math.max(0, (m - 0.68) * 2.6);
      const lum = solid ? (108 + tooth * 28 + (m - 0.5) * 24) : 0;
      albedo[idx] = clampByte(lum * (1 - rust) + 118 * rust);
      albedo[idx + 1] = clampByte(lum * 1.01 * (1 - rust) + 60 * rust);
      albedo[idx + 2] = clampByte(lum * 1.04 * (1 - rust) + 34 * rust);
      albedo[idx + 3] = solid ? 255 : 0;

      const rv = Math.max(0.28, Math.min(0.9, 0.42 + rust * 0.42));
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(rv * 255);
      rough[idx + 3] = 255;

      const mv = solid ? 0.88 * (1 - rust * 0.8) : 0;
      metal[idx] = metal[idx + 1] = metal[idx + 2] = clampByte(mv * 255);
      metal[idx + 3] = 255;
    }
  }

  const { normal, ao, heightBytes } = buildNormalAndAO(height, size, 4.0, 1);
  return {
    name: 'industrialGrating',
    size,
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    metalnessMap: makeDataTex(metal, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
    heightMap: makeDataTex(heightBytes, size, false, aniso),
    vramBytes: texBytes(size, 6),
  };
}

let cachedAtlas: EnvironmentPBRAtlas | null = null;

/**
 * Generates (and caches) the full procedural Environment PBR Atlas.
 * Supports 1024 (balanced VRAM & crisp close-up) or 2048 for ground materials.
 */
export function getEnvironmentPBRAtlas(
  renderer: THREE.WebGLRenderer,
  groundResolution: 1024 | 2048 = 1024,
  industrialResolution: 512 | 1024 = 1024
): EnvironmentPBRAtlas {
  if (cachedAtlas && cachedAtlas.groundForest.size === groundResolution) {
    return cachedAtlas;
  }
  const t0 = performance.now();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const groundForest = generateGroundForest(groundResolution, aniso);
  const groundMud = generateGroundMud(groundResolution, aniso);
  const groundGravel = generateGroundGravel(groundResolution, aniso);
  const groundRock = generateGroundRock(groundResolution, aniso);
  const micro = generateMicroDetail(aniso);

  const industrialConcrete = generateIndustrialConcrete(industrialResolution, aniso);
  const paintedMetal = generatePaintedMetal(industrialResolution, aniso);
  const bareSteel = generateBareSteel(industrialResolution, aniso);
  const industrialRubber = generateIndustrialRubber(industrialResolution, aniso);
  const industrialFloor = generateIndustrialFloor(industrialResolution, aniso);
  const industrialGrating = generateIndustrialGrating(Math.min(512, industrialResolution), aniso);

  const totalVramBytes =
    groundForest.vramBytes +
    groundMud.vramBytes +
    groundGravel.vramBytes +
    groundRock.vramBytes +
    texBytes(512, 2) +
    industrialConcrete.vramBytes +
    paintedMetal.vramBytes +
    bareSteel.vramBytes +
    industrialRubber.vramBytes +
    industrialFloor.vramBytes +
    industrialGrating.vramBytes;

  cachedAtlas = {
    groundForest,
    groundMud,
    groundGravel,
    groundRock,
    microDetailNormal: micro.normal,
    microDetailRough: micro.rough,
    industrialConcrete,
    paintedMetal,
    bareSteel,
    industrialRubber,
    industrialFloor,
    industrialGrating,
    totalVramBytes,
    genTimeMs: Math.round(performance.now() - t0),
  };

  return cachedAtlas;
}
