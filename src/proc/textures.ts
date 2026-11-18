import * as THREE from 'three';
import { fbm2D, ridged2D, voronoi2D } from './noise';

export interface PBRTextureSet {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  metalnessMap?: THREE.DataTexture;
  aoMap: THREE.DataTexture;
  heightMap?: THREE.DataTexture;
}

export interface TextureLibrary {
  gunMetal: PBRTextureSet;
  gunPolymer: PBRTextureSet;
  walnutWood: PBRTextureSet;
  tacticalFabric: PBRTextureSet;
  terrainGrass: PBRTextureSet;
  terrainMud: PBRTextureSet;
  terrainGravel: PBRTextureSet;
  terrainRock: PBRTextureSet;
  concrete: PBRTextureSet;
  siloWallConcrete: PBRTextureSet;
  siloFloorConcrete: PBRTextureSet;
  hazardTrim: PBRTextureSet;
  industrialMetal: PBRTextureSet;
  woodPlank: PBRTextureSet;
  sandbagBurlap: PBRTextureSet;
  bark: PBRTextureSet;
  soldierCamo: PBRTextureSet;
  soldierGear: PBRTextureSet;
  foliageAlpha: THREE.DataTexture;
  foliageNormal: THREE.DataTexture;
  fernAlpha: THREE.DataTexture;
  fernNormal: THREE.DataTexture;
  maxAnisotropy: number;
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
 * Generates a tileable FBM lookup table (512x512) using periodic domain wrapping.
 */
function createTileableFbmTable(size: number, scale: number, octaves: number, seed: number): Float32Array {
  const table = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const ty = y * inv;
    for (let x = 0; x < size; x++) {
      const tx = x * inv;
      // 4-corner toroidal blend for seamless tiling
      const u = tx * scale;
      const v = ty * scale;
      const a = fbm2D(u, v, octaves, 2.0, 0.5, seed);
      const b = fbm2D(u - scale, v, octaves, 2.0, 0.5, seed);
      const c = fbm2D(u, v - scale, octaves, 2.0, 0.5, seed);
      const d = fbm2D(u - scale, v - scale, octaves, 2.0, 0.5, seed);
      const wx = tx;
      const wy = ty;
      const top = a * (1 - wx) + b * wx;
      const bot = c * (1 - wx) + d * wx;
      table[y * size + x] = (top * (1 - wy) + bot * wy) * 0.5 + 0.5;
    }
  }
  return table;
}

/**
 * Computes a crisp tangent-space Normal map from a scalar height buffer (0..1).
 */
function buildNormalFromHeight(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const mask = size - 1;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1) & mask;
    const yp = (y + 1) & mask;
    const row = y * size;
    const rowM = ym * size;
    const rowP = yp * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1) & mask;
      const xp = (x + 1) & mask;
      const hL = height[row + xm];
      const hR = height[row + xp];
      const hD = height[rowM + x];
      const hU = height[rowP + x];
      const dx = (hL - hR) * strength;
      const dy = (hD - hU) * strength;
      const dz = 1.0;
      const invLen = 1.0 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      const idx = (row + x) * 4;
      out[idx] = Math.round((dx * invLen * 0.5 + 0.5) * 255);
      out[idx + 1] = Math.round((dy * invLen * 0.5 + 0.5) * 255);
      out[idx + 2] = Math.round((dz * invLen * 0.5 + 0.5) * 255);
      out[idx + 3] = 255;
    }
  }
  return out;
}

function fastHash(x: number, y: number, seed: number): number {
  let n = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function sampleTableBilinear(table: Float32Array, tableSize: number, u: number, v: number): number {
  const mask = tableSize - 1;
  const fx = u * tableSize;
  const fy = v * tableSize;
  const x0 = Math.floor(fx) & mask;
  const y0 = Math.floor(fy) & mask;
  const x1 = (x0 + 1) & mask;
  const y1 = (y0 + 1) & mask;
  const tx = fx - Math.floor(fx);
  const ty = fy - Math.floor(fy);
  const a = table[y0 * tableSize + x0];
  const b = table[y0 * tableSize + x1];
  const c = table[y1 * tableSize + x0];
  const d = table[y1 * tableSize + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * 2048x2048 Brushed Parkerized/Anodized Gunmetal PBR Set
 */
function generateGunMetal(aniso: number): PBRTextureSet {
  const size = 2048;
  const tSize = 512;
  const macro = createTileableFbmTable(tSize, 6, 4, 101);
  const streakNoise = createTileableFbmTable(tSize, 24, 3, 202);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const metal = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    // Anisotropic brushed metal band per scanline + micro variation
    const lineBrush = (fastHash(y >> 1, 7, 303) - 0.5) * 0.16;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, tSize, u, v);
      const streak = sampleTableBilinear(streakNoise, tSize, u * 0.25, v * 3.5);
      const microGrain = (fastHash(x, y, 404) - 0.5) * 0.09;
      // Subtle machining scratches
      const scratch = Math.max(0, streak - 0.68) * 1.8;

      const h = 0.5 + lineBrush * 0.5 + (streak - 0.5) * 0.22 + microGrain * 0.35 + (m - 0.5) * 0.15;
      height[row + x] = h;

      // Rich brushed parkerized steel + oil sheen + crisp machined scratch silvering
      const baseLum = 58 + m * 28 + lineBrush * 26 + scratch * 72 + microGrain * 18;
      const idx = (row + x) * 4;
      albedo[idx] = clampByte(baseLum * 0.96);
      albedo[idx + 1] = clampByte(baseLum * 0.99);
      albedo[idx + 2] = clampByte(baseLum * 1.05);
      albedo[idx + 3] = 255;

      // Roughness: oiled machined patches (0.22), bead-blasted parkerized (0.44)
      const rVal = clampByte((0.32 + (1 - m) * 0.14 - scratch * 0.18 + microGrain * 0.1) * 255);
      rough[idx] = rough[idx + 1] = rough[idx + 2] = rVal;
      rough[idx + 3] = 255;

      // Metallic: ~0.88 to 0.98
      const metVal = clampByte((0.88 + scratch * 0.10 + m * 0.05) * 255);
      metal[idx] = metal[idx + 1] = metal[idx + 2] = metVal;
      metal[idx + 3] = 255;

      const aoVal = clampByte((0.85 + h * 0.15 - microGrain * 0.1) * 255);
      ao[idx] = ao[idx + 1] = ao[idx + 2] = aoVal;
      ao[idx + 3] = 255;
    }
  }

  const normal = buildNormalFromHeight(height, size, 2.4);
  return {
    map: makeDataTex(albedo, size, true, aniso, 1),
    normalMap: makeDataTex(normal, size, false, aniso, 1),
    roughnessMap: makeDataTex(rough, size, false, aniso, 1),
    metalnessMap: makeDataTex(metal, size, false, aniso, 1),
    aoMap: makeDataTex(ao, size, false, aniso, 1),
  };
}

/**
 * 1024x1024 Stippled Polymer / Rubber Grip Texture Set
 */
function generateGunPolymer(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 6, 3, 505);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const metal = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      // Fine polymer stipple grain (2x2 cell clusters)
      const cx = x >> 1;
      const cy = y >> 1;
      const dot = fastHash(cx, cy, 606);
      const px = (x & 1) - 0.5;
      const py = (y & 1) - 0.5;
      const stipple = dot > 0.42 ? (1.0 - (px * px + py * py) * 0.8) * dot : 0.15;
      const micro = (fastHash(x, y, 707) - 0.5) * 0.12;

      const h = 0.35 + stipple * 0.5 + (m - 0.5) * 0.15 + micro * 0.2;
      height[row + x] = h;

      const lum = 28 + m * 12 + stipple * 11 + micro * 8;
      const idx = (row + x) * 4;
      albedo[idx] = clampByte(lum * 0.98);
      albedo[idx + 1] = clampByte(lum);
      albedo[idx + 2] = clampByte(lum * 1.03);
      albedo[idx + 3] = 255;

      const rVal = clampByte((0.68 - stipple * 0.12 + (1 - m) * 0.12) * 255);
      rough[idx] = rough[idx + 1] = rough[idx + 2] = rVal;
      rough[idx + 3] = 255;

      metal[idx] = metal[idx + 1] = metal[idx + 2] = 14;
      metal[idx + 3] = 255;

      const aoVal = clampByte((0.65 + stipple * 0.35) * 255);
      ao[idx] = ao[idx + 1] = ao[idx + 2] = aoVal;
      ao[idx + 3] = 255;
    }
  }

  const normal = buildNormalFromHeight(height, size, 3.2);
  return {
    map: makeDataTex(albedo, size, true, aniso, 1),
    normalMap: makeDataTex(normal, size, false, aniso, 1),
    roughnessMap: makeDataTex(rough, size, false, aniso, 1),
    metalnessMap: makeDataTex(metal, size, false, aniso, 1),
    aoMap: makeDataTex(ao, size, false, aniso, 1),
  };
}

/**
 * 1024x1024 Walnut / Dark Hardwood PBR Set (for M1911 grip & crates)
 */
function generateWalnutWood(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 5, 4, 808);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      const ringCoord = u * 18 + m * 5.2 + Math.sin(v * Math.PI * 4) * 0.6;
      const grain = Math.sin(ringCoord * Math.PI * 2) * 0.5 + 0.5;
      const fiber = fastHash(x >> 1, y >> 3, 909) * 0.2;
      const h = grain * 0.55 + m * 0.3 + fiber * 0.15;
      height[row + x] = h;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(58 + grain * 44 + m * 22);
      albedo[idx + 1] = clampByte(31 + grain * 24 + m * 14);
      albedo[idx + 2] = clampByte(18 + grain * 12 + m * 8);
      albedo[idx + 3] = 255;

      const rVal = clampByte((0.46 + (1 - grain) * 0.22) * 255);
      rough[idx] = rough[idx + 1] = rough[idx + 2] = rVal;
      rough[idx + 3] = 255;

      const aoVal = clampByte((0.72 + grain * 0.28) * 255);
      ao[idx] = ao[idx + 1] = ao[idx + 2] = aoVal;
      ao[idx + 3] = 255;
    }
  }

  const normal = buildNormalFromHeight(height, size, 2.5);
  return {
    map: makeDataTex(albedo, size, true, aniso, 1),
    normalMap: makeDataTex(normal, size, false, aniso, 1),
    roughnessMap: makeDataTex(rough, size, false, aniso, 1),
    aoMap: makeDataTex(ao, size, false, aniso, 1),
  };
}

/**
 * 2048x2048 Tactical Glove Leather & Combat Sleeve Ripstop Fabric PBR Set
 * High-contrast normal/roughness detail (stitches, creases, palm grip, ripstop weave) with lifted albedo so gloves never crush to pitch black.
 */
function generateTacticalFabric(aniso: number): PBRTextureSet {
  const size = 2048;
  const macro = createTileableFbmTable(512, 6, 4, 1111);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const warp = Math.sin((y / size) * Math.PI * 2 * 180);
    const ripY = (y & 31) === 0 ? 1 : 0;
    const seamLine = (y & 511) < 3 ? 1 : 0;
    const stitchDot = seamLine && ((y & 1) === 0) ? 1 : 0;

    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 512, u, v);
      const weft = Math.sin((x / size) * Math.PI * 2 * 180);
      const ripX = (x & 31) === 0 ? 1 : 0;
      const weave = warp * weft * 0.28 + 0.5;
      const ripGrid = Math.max(ripX, ripY) * 0.36;
      const leatherCell = fastHash(x >> 2, y >> 2, 1213) * 0.24;
      const pore = (fastHash(x, y, 1212) - 0.5) * 0.12;
      const stitch = stitchDot && (x & 15) < 8 ? 0.35 : 0;

      const h = weave * 0.48 + ripGrid + leatherCell + (m - 0.5) * 0.26 + pore + stitch;
      height[row + x] = h;

      const damp = 0.84 + m * 0.16;
      const idx = (row + x) * 4;
      albedo[idx] = clampByte((96 + m * 32 + ripGrid * 20 + weave * 14 + stitch * 35) * damp);
      albedo[idx + 1] = clampByte((100 + m * 30 + ripGrid * 20 + weave * 14 + stitch * 32) * damp);
      albedo[idx + 2] = clampByte((84 + m * 24 + ripGrid * 16 + weave * 12 + stitch * 28) * damp);
      albedo[idx + 3] = 255;

      const rVal = clampByte((0.68 - m * 0.14 - leatherCell * 0.22) * 255);
      rough[idx] = rough[idx + 1] = rough[idx + 2] = rVal;
      rough[idx + 3] = 255;

      const aoVal = clampByte((0.70 + weave * 0.20 + ripGrid * 0.10) * 255);
      ao[idx] = ao[idx + 1] = ao[idx + 2] = aoVal;
      ao[idx + 3] = 255;
    }
  }

  const normal = buildNormalFromHeight(height, size, 4.0);
  return {
    map: makeDataTex(albedo, size, true, aniso, 1),
    normalMap: makeDataTex(normal, size, false, aniso, 1),
    roughnessMap: makeDataTex(rough, size, false, aniso, 1),
    aoMap: makeDataTex(ao, size, false, aniso, 1),
  };
}

/**
 * 1024x1024 Terrain Grass/Moss PBR Set
 */
function generateTerrainGrass(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 7, 4, 2101);
  const detail = createTileableFbmTable(256, 22, 3, 2102);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      const d = sampleTableBilinear(detail, 256, u, v);
      const blade = fastHash(x, y >> 1, 2103);
      const h = m * 0.45 + d * 0.35 + blade * 0.2;
      height[row + x] = h;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(34 + m * 24 + d * 18 + blade * 12);
      albedo[idx + 1] = clampByte(48 + m * 32 + d * 22 + blade * 16);
      albedo[idx + 2] = clampByte(24 + m * 14 + d * 10);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.68 - m * 0.2) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.65 + h * 0.35) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 3.8);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Wet Mud PBR Set
 */
function generateTerrainMud(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 6, 4, 2201);
  const detail = createTileableFbmTable(256, 18, 3, 2202);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      const d = sampleTableBilinear(detail, 256, u, v);
      const grit = fastHash(x, y, 2203) * 0.14;
      const h = m * 0.55 + d * 0.35 + grit;
      height[row + x] = h;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(42 + m * 22 + d * 14);
      albedo[idx + 1] = clampByte(34 + m * 17 + d * 11);
      albedo[idx + 2] = clampByte(25 + m * 12 + d * 8);
      albedo[idx + 3] = 255;

      // Wet mud has glossy low-roughness troughs
      const rVal = clampByte((0.18 + m * 0.34) * 255);
      rough[idx] = rough[idx + 1] = rough[idx + 2] = rVal;
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.68 + h * 0.32) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 3.6);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Crushed Gravel PBR Set
 */
function generateTerrainGravel(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 8, 3, 2301);
  // Precompute 256x256 Voronoi pebble field and sample + add micro rock grit
  const vor = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const res = voronoi2D((x / 256) * 20, (y / 256) * 20, 2302);
      vor[y * 256 + x] = Math.max(0, Math.min(1, (res.f2 - res.f1) * 1.4 + res.cell * 0.25));
    }
  }

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      const p = sampleTableBilinear(vor, 256, u, v);
      const grit = fastHash(x, y, 2303) * 0.16;
      const h = p * 0.65 + m * 0.22 + grit;
      height[row + x] = h;

      const lum = 46 + p * 44 + m * 18 + grit * 20;
      const idx = (row + x) * 4;
      albedo[idx] = clampByte(lum * 1.02);
      albedo[idx + 1] = clampByte(lum * 0.98);
      albedo[idx + 2] = clampByte(lum * 0.92);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.42 + (1 - p) * 0.28) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.55 + p * 0.45) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 4.2);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Layered Slate Rock PBR Set
 */
function generateTerrainRock(aniso: number): PBRTextureSet {
  const size = 1024;
  const strata = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const u = (x / 256) * 8;
      const v = (y / 256) * 8;
      strata[y * 256 + x] = ridged2D(u, v * 2.1, 4, 2.1, 0.5, 2401);
    }
  }
  const macro = createTileableFbmTable(256, 6, 4, 2402);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const s = sampleTableBilinear(strata, 256, u, v);
      const m = sampleTableBilinear(macro, 256, u, v);
      const grit = fastHash(x, y, 2403) * 0.14;
      const h = s * 0.65 + m * 0.25 + grit;
      height[row + x] = h;

      const lum = 44 + s * 46 + m * 22;
      const idx = (row + x) * 4;
      albedo[idx] = clampByte(lum * 0.96);
      albedo[idx + 1] = clampByte(lum * 0.99);
      albedo[idx + 2] = clampByte(lum * 1.05);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.44 + (1 - s) * 0.3) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.55 + h * 0.45) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 4.4);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Weathered Military Concrete PBR Set (with hazard stripe band, stencil ID, bullet scars & rain streaks)
 */
function generateConcrete(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 5, 4, 3101);
  const detail = createTileableFbmTable(256, 20, 3, 3102);

  // Paint crisp military stencil markings & weathered hazard stripe onto offscreen canvas
  const decCanvas = document.createElement('canvas');
  decCanvas.width = size;
  decCanvas.height = size;
  const ctx = decCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  // Bottom yellow/black weathered hazard caution stripe band
  ctx.fillStyle = '#c89b2a';
  ctx.fillRect(0, size - 130, size, 68);
  ctx.fillStyle = '#1b1d1e';
  for (let x = -120; x < size + 120; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, size - 130);
    ctx.lineTo(x + 32, size - 130);
    ctx.lineTo(x - 18, size - 62);
    ctx.lineTo(x - 50, size - 62);
    ctx.closePath();
    ctx.fill();
  }

  // Stencil military sector lettering
  ctx.fillStyle = 'rgba(225, 222, 205, 0.72)';
  ctx.font = 'bold 58px Consolas, monospace';
  ctx.fillText('SEC-04 // NATO', 64, 210);
  ctx.font = 'bold 34px Consolas, monospace';
  ctx.fillStyle = 'rgba(205, 140, 40, 0.78)';
  ctx.fillText('CAUTION: LIVE FIRE ZONE', 64, 265);

  const decData = ctx.getImageData(0, 0, size, size).data;

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const seamY = (y % 256) < 3 ? 0.25 : 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      const d = sampleTableBilinear(detail, 256, u, v);
      const pit = fastHash(x, y, 3103) > 0.94 ? -0.25 : (fastHash(x, y, 3104) - 0.5) * 0.1;
      const streak = sampleTableBilinear(macro, 256, u * 4.2, v * 0.22);
      const bulletScar = sampleTableBilinear(detail, 256, u * 1.4, v * 1.4) > 0.78 ? -0.35 : 0.0;
      const h = m * 0.36 + d * 0.36 + pit + bulletScar - seamY;
      height[row + x] = h;

      const damp = 0.68 + streak * 0.36;
      const lum = (82 + m * 34 + d * 18 + pit * 40 + bulletScar * 45 - seamY * 60) * damp;
      const idx = (row + x) * 4;
      let rC = lum * 0.98;
      let gC = lum * 1.0;
      let bC = lum * 0.96;

      // Blend chipped paint markings (chipped by concrete noise `d`)
      const decA = (decData[idx + 3] / 255) * (d > 0.34 ? 0.85 : 0.15);
      if (decA > 0.01) {
        rC = rC * (1 - decA) + decData[idx] * damp * decA;
        gC = gC * (1 - decA) + decData[idx + 1] * damp * decA;
        bC = bC * (1 - decA) + decData[idx + 2] * damp * decA;
      }

      albedo[idx] = clampByte(rC);
      albedo[idx + 1] = clampByte(gC);
      albedo[idx + 2] = clampByte(bC);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.58 + (1 - streak) * 0.28) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.72 + h * 0.28) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 3.5);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Industrial Painted Military Steel PBR Set (Drums, Equipment Racks, Stencils & Rust Drips)
 */
function generateIndustrialMetal(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 6, 4, 3201);
  const detail = createTileableFbmTable(256, 18, 3, 3202);

  const decCanvas = document.createElement('canvas');
  decCanvas.width = size;
  decCanvas.height = size;
  const ctx = decCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#d4a024';
  ctx.fillRect(0, 420, size, 48);
  ctx.fillStyle = '#181a1b';
  for (let x = -80; x < size + 80; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 420);
    ctx.lineTo(x + 24, 420);
    ctx.lineTo(x - 10, 468);
    ctx.lineTo(x - 34, 468);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(235, 232, 218, 0.85)';
  ctx.font = 'bold 54px Consolas, monospace';
  ctx.fillText('7.62 / JP-8', 72, 340);
  ctx.font = 'bold 38px Consolas, monospace';
  ctx.fillText('UNIT 04 - FLAMMABLE', 72, 540);
  const decData = ctx.getImageData(0, 0, size, size).data;

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const metal = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      const d = sampleTableBilinear(detail, 256, u, v);
      const rust = Math.max(0, sampleTableBilinear(macro, 256, u * 2.5, v * 0.4) - 0.62) * 2.5;
      const h = m * 0.4 + d * 0.3 - rust * 0.25;
      height[row + x] = h;

      const idx = (row + x) * 4;
      let rC = 58 + m * 22 + rust * 88;
      let gC = 68 + m * 24 + rust * 34;
      let bC = 52 + m * 16 + rust * 12;

      const decA = (decData[idx + 3] / 255) * (d > 0.3 ? 0.9 : 0.2);
      if (decA > 0.01) {
        rC = rC * (1 - decA) + decData[idx] * decA;
        gC = gC * (1 - decA) + decData[idx + 1] * decA;
        bC = bC * (1 - decA) + decData[idx + 2] * decA;
      }

      albedo[idx] = clampByte(rC);
      albedo[idx + 1] = clampByte(gC);
      albedo[idx + 2] = clampByte(bC);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.42 + rust * 0.45 + (1 - m) * 0.14) * 255);
      rough[idx + 3] = 255;

      metal[idx] = metal[idx + 1] = metal[idx + 2] = clampByte((0.68 - rust * 0.55) * 255);
      metal[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.72 + h * 0.28) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 3.2);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    metalnessMap: makeDataTex(metal, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Underground Bunker Concrete Wall PBR Set
 * Formwork board seams, recessed tie-rod holes, damp water seepage drips & high wet/dry roughness contrast.
 */
function generateSiloWallConcrete(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 5, 4, 3401);
  const detail = createTileableFbmTable(256, 18, 3, 3402);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const my = y % 256;
    const seamY = my < 2 || my > 254 ? 0.22 : (y % 128) < 1 ? 0.10 : 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const mx = x % 256;
      const seamX = mx < 2 || mx > 254 ? 0.22 : 0;
      const m = sampleTableBilinear(macro, 256, u, v);
      const d = sampleTableBilinear(detail, 256, u, v);
      // Seamless toroidal vertical mineral streaks (no v-bound band to avoid horizontal zebra stripes on tall walls)
      const streak = sampleTableBilinear(macro, 256, u * 5.0, v * 0.25);
      const vein = sampleTableBilinear(detail, 256, u * 3.0, v * 0.35);

      // Formwork tie-rod holes at (64,64), (192,64), (64,192), (192,192) mod 256
      const tx = (mx % 128) - 64;
      const ty = (my % 128) - 64;
      const distTie = Math.hypot(tx, ty);
      const tieHole = distTie < 6 ? (1 - distTie / 6) * 0.36 : 0;
      const tieDrip = Math.abs(tx) < 4 && my % 128 < 48 && my % 128 > 4 ? (1 - (my % 128) / 48) * 0.16 : 0;

      const pit = fastHash(x, y, 3403) > 0.94 ? -0.18 : (fastHash(x, y, 3404) - 0.5) * 0.10;
      const h = m * 0.30 + d * 0.28 + pit - seamY - seamX - tieHole;
      height[row + x] = h;

      const dampMask = Math.min(1, streak > 0.56 ? (streak - 0.56) * 1.65 * (0.45 + vein * 0.7) : 0);
      const darken = (1 - dampMask * 0.30) * (1 - tieDrip * 0.55);
      const lum = (78 + m * 26 + d * 16 + pit * 30 - (seamY + seamX) * 48 - tieHole * 46) * darken;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(lum * 0.96);
      albedo[idx + 1] = clampByte(lum * 1.0);
      albedo[idx + 2] = clampByte(lum * 1.04);
      albedo[idx + 3] = 255;

      // Subtle vertical seepage sheen without sharp horizontal tiling bands
      const rVal = 0.88 - dampMask * 0.54 - d * 0.08;
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(Math.max(0.20, rVal) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.72 + h * 0.28 - (seamY + seamX) * 0.35) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 4.2);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Underground Concrete Floor PBR Set
 * Expansion joint grid, boot/oil grime, micro-pitting & stark wet-streak roughness contrast.
 */
function generateSiloFloorConcrete(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 4, 4, 3501);
  const detail = createTileableFbmTable(256, 22, 3, 3502);
  const wetNoise = createTileableFbmTable(256, 3.2, 4, 3503);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const jointY = (y % 256) < 4 || (y % 256) > 252 ? 0.36 : 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const jointX = (x % 256) < 4 || (x % 256) > 252 ? 0.36 : 0;
      const joint = Math.max(jointX, jointY);

      const m = sampleTableBilinear(macro, 256, u, v);
      const d = sampleTableBilinear(detail, 256, u, v);
      const w = sampleTableBilinear(wetNoise, 256, u, v);
      const pit = fastHash(x, y, 3504) > 0.93 ? -0.20 : (fastHash(x, y, 3505) - 0.5) * 0.1;

      const h = m * 0.28 + d * 0.28 + pit - joint;
      height[row + x] = h;

      const isWet = Math.max(0, Math.min(1, (w - 0.46) * 3.8));
      const oilStain = m < 0.32 ? (0.32 - m) * 1.4 : 0;
      const lum = (68 + m * 24 + d * 14 + pit * 28 - joint * 68) * (1 - isWet * 0.38) * (1 - oilStain * 0.45);

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(lum * 0.96);
      albedo[idx + 1] = clampByte(lum * 0.99);
      albedo[idx + 2] = clampByte(lum * 1.03);
      albedo[idx + 3] = 255;

      // Specular moisture zones (0.10) vs dry matte concrete (0.82)
      const rVal = joint > 0.1 ? 0.45 : 0.84 - isWet * 0.72 - oilStain * 0.35;
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte(Math.max(0.08, rVal) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.72 + h * 0.28 - joint * 0.45) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 3.6);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 512x512 Weathered Black-Yellow Hazard Stripe Trim PBR Set
 */
function generateHazardTrim(aniso: number): PBRTextureSet {
  const size = 512;
  const wear = createTileableFbmTable(128, 8, 3, 3601);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const borderDark = y < 14 || y > size - 14 ? 0.45 : 1.0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const d = sampleTableBilinear(wear, 128, u, v);
      const stripe = ((x + y) % 128) < 64;
      const chip = d < 0.26 ? 0.35 : 1.0;
      const baseR = stripe ? 205 : 26;
      const baseG = stripe ? 152 : 28;
      const baseB = stripe ? 32 : 30;
      const idx = (row + x) * 4;
      albedo[idx] = clampByte(baseR * borderDark * (0.72 + d * 0.38) * chip);
      albedo[idx + 1] = clampByte(baseG * borderDark * (0.72 + d * 0.38) * chip);
      albedo[idx + 2] = clampByte(baseB * borderDark * (0.72 + d * 0.38) * chip);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.42 + (1 - d) * 0.35) * 255);
      rough[idx + 3] = 255;
      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte(borderDark * 255);
      ao[idx + 3] = 255;
      height[row + x] = (d - 0.5) * 0.25 + (stripe ? 0.04 : 0);
    }
  }
  const normal = buildNormalFromHeight(height, size, 2.5);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Burlap Sandbag Weave PBR Set
 */
function generateSandbagBurlap(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 6, 4, 3301);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const ty = Math.sin((y / size) * Math.PI * 2 * 140);
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      const tx = Math.sin((x / size) * Math.PI * 2 * 140);
      const weave = tx * ty * 0.35 + 0.5;
      const h = weave * 0.65 + m * 0.35;
      height[row + x] = h;

      const idx = (row + x) * 4;
      albedo[idx] = clampByte(78 + m * 36 + weave * 24);
      albedo[idx + 1] = clampByte(68 + m * 30 + weave * 20);
      albedo[idx + 2] = clampByte(48 + m * 22 + weave * 14);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.76 - m * 0.15) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.58 + weave * 0.42) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 3.8);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 1024x1024 Furrowed Wet Tree Bark PBR Set
 */
function generateBark(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 8, 4, 3401);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u * 2.2, v * 0.5);
      const ridge = Math.abs(Math.sin((u * 14 + m * 2.2) * Math.PI * 2));
      const h = ridge * 0.65 + m * 0.35;
      height[row + x] = h;

      const moss = Math.max(0, m - 0.6) * 1.8;
      const idx = (row + x) * 4;
      albedo[idx] = clampByte(32 + ridge * 28 + m * 16 - moss * 10);
      albedo[idx + 1] = clampByte(26 + ridge * 22 + m * 14 + moss * 26);
      albedo[idx + 2] = clampByte(20 + ridge * 16 + m * 10);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.55 + (1 - ridge) * 0.25) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.45 + ridge * 0.55) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 4.5);
  return {
    map: makeDataTex(albedo, size, true, aniso),
    normalMap: makeDataTex(normal, size, false, aniso),
    roughnessMap: makeDataTex(rough, size, false, aniso),
    aoMap: makeDataTex(ao, size, false, aniso),
  };
}

/**
 * 512x512 Organic Fluffy Pine/Spruce Branchlet Cluster Alpha Texture + Normal (zero comb/herringbone symmetry!)
 */
function generateFoliageTextures(aniso: number): { alpha: THREE.DataTexture; normal: THREE.DataTexture } {
  const size = 512;
  const rgba = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  // Irregular organic woody twiglets radiating from center-bottom
  const clusters = 14;
  for (let c = 0; c < clusters; c++) {
    const t = c / clusters;
    const ang = (c * 2.39996) % (Math.PI * 2); // Golden-angle phyllotaxis!
    const dist = size * (0.06 + Math.sqrt(t) * 0.24);
    const cx = size * 0.5 + Math.cos(ang) * dist;
    const cy = size * 0.5 + Math.sin(ang) * dist * 0.92;

    // Twig segment
    ctx.strokeStyle = '#382c21';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.56);
    ctx.quadraticCurveTo((size * 0.5 + cx) * 0.5 + 8, (size * 0.56 + cy) * 0.5, cx, cy);
    ctx.stroke();

    // Fluffy radial conifer needle rosette around each sub-cluster
    const needles = 42;
    for (let n = 0; n < needles; n++) {
      const na = (n / needles) * Math.PI * 2 + fastHash(c, n, 41) * 0.35;
      const nLen = 22 + fastHash(n, c, 83) * 34;
      const r0 = fastHash(c + n, n, 17) * 14;
      const sx = cx + Math.cos(na) * r0;
      const sy = cy + Math.sin(na) * r0;
      const ex = Math.max(12, Math.min(size - 12, sx + Math.cos(na) * nLen));
      const ey = Math.max(12, Math.min(size - 12, sy + Math.sin(na) * nLen));

      const depthShade = 0.65 + 0.35 * (n / needles) + fastHash(c, n, 29) * 0.25;
      const rCol = Math.min(110, Math.floor(28 * depthShade + 10));
      const gCol = Math.min(145, Math.floor(58 * depthShade + 16));
      const bCol = Math.min(90, Math.floor(24 * depthShade + 8));
      ctx.strokeStyle = `rgb(${rCol}, ${gCol}, ${bCol})`;
      ctx.lineWidth = 2.6 + fastHash(n, c, 91) * 1.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
  }

  const imgData = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    const idx = i * 4;
    rgba[idx] = imgData[idx];
    rgba[idx + 1] = imgData[idx + 1];
    rgba[idx + 2] = imgData[idx + 2];
    rgba[idx + 3] = imgData[idx + 3];
    height[i] = imgData[idx + 3] > 20 ? (imgData[idx + 1] / 255) * 0.8 + 0.2 : 0;
  }

  const normalBytes = buildNormalFromHeight(height, size, 2.2);
  const alpha = makeDataTex(rgba, size, true, aniso, 1);
  alpha.wrapS = THREE.ClampToEdgeWrapping;
  alpha.wrapT = THREE.ClampToEdgeWrapping;
  const normal = makeDataTex(normalBytes, size, false, aniso, 1);
  normal.wrapS = THREE.ClampToEdgeWrapping;
  normal.wrapT = THREE.ClampToEdgeWrapping;
  return { alpha, normal };
}

/**
 * 1024x1024 Military Woodland/Tactical Camo Ripstop Fabric PBR Set
 */
function generateSoldierCamo(aniso: number): PBRTextureSet {
  const size = 1024;
  const c1 = createTileableFbmTable(256, 7, 3, 4101);
  const c2 = createTileableFbmTable(256, 11, 3, 4102);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const warp = Math.sin((y / size) * Math.PI * 2 * 160);
    const ripY = (y & 15) === 0 ? 1 : 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Quantize UVs subtly for modern digital/multicam blotches
      const qu = Math.floor(u * 64) / 64;
      const qv = Math.floor(v * 64) / 64;
      const n1 = sampleTableBilinear(c1, 256, qu, qv);
      const n2 = sampleTableBilinear(c2, 256, qu, qv);

      const weft = Math.sin((x / size) * Math.PI * 2 * 160);
      const ripX = (x & 15) === 0 ? 1 : 0;
      const weave = warp * weft * 0.28 + 0.5;
      const rip = Math.max(ripX, ripY) * 0.25;
      const h = weave * 0.55 + rip + n1 * 0.2;
      height[row + x] = h;

      // 4-tone tactical urban sage / light grey-green camo palette (high silhouette contrast in rain & corridors!)
      let r = 136, g = 146, b = 132; // Base urban sage grey-green
      if (n1 > 0.57) {
        r = 104; g = 116, b = 106; // Muted slate green
      } else if (n2 > 0.58) {
        r = 122; g = 118, b = 104; // Taupe stone
      } else if (n1 < 0.36 && n2 < 0.46) {
        r = 162; g = 168, b = 154; // Light ash-sage highlight blotch
      }

      const idx = (row + x) * 4;
      const weaveShade = 0.90 + weave * 0.18;
      albedo[idx] = clampByte(r * weaveShade);
      albedo[idx + 1] = clampByte(g * weaveShade);
      albedo[idx + 2] = clampByte(b * weaveShade);
      albedo[idx + 3] = 255;

      // Pure matte woven ripstop fabric (strictly 0.87..0.95 roughness, zero plastic shine)
      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.87 + (1 - weave) * 0.08) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.72 + weave * 0.28) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 3.2);
  return {
    map: makeDataTex(albedo, size, true, aniso, 2),
    normalMap: makeDataTex(normal, size, false, aniso, 2),
    roughnessMap: makeDataTex(rough, size, false, aniso, 2),
    aoMap: makeDataTex(ao, size, false, aniso, 2),
  };
}

/**
 * 1024x1024 Coyote Tan / Sand 500D Cordura Nylon Gear PBR Set (Vest, Pouches, Helmet, Pads)
 * Strict matte roughness (0.86..0.94) to eliminate any black plastic oil sheen.
 */
function generateSoldierGear(aniso: number): PBRTextureSet {
  const size = 1024;
  const macro = createTileableFbmTable(256, 6, 3, 4201);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const ao = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const row = y * size;
    const warp = Math.sin(v * Math.PI * 2 * 200);
    const stitchY = (y & 63) < 2 ? 0.22 : 0;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const m = sampleTableBilinear(macro, 256, u, v);
      const weft = Math.sin(u * Math.PI * 2 * 200);
      const cordura = warp * weft * 0.30 + 0.5;
      const grain = (fastHash(x, y, 4202) - 0.5) * 0.08;
      const h = cordura * 0.65 + stitchY + (m - 0.5) * 0.22 + grain;
      height[row + x] = h;

      // Coyote Tan / Sand palette
      const shade = 0.90 + m * 0.14 + cordura * 0.08 + stitchY * 0.12;
      const idx = (row + x) * 4;
      albedo[idx] = clampByte(178 * shade);
      albedo[idx + 1] = clampByte(146 * shade);
      albedo[idx + 2] = clampByte(104 * shade);
      albedo[idx + 3] = 255;

      rough[idx] = rough[idx + 1] = rough[idx + 2] = clampByte((0.86 + (1 - cordura) * 0.08) * 255);
      rough[idx + 3] = 255;

      ao[idx] = ao[idx + 1] = ao[idx + 2] = clampByte((0.72 + cordura * 0.28 - stitchY * 0.15) * 255);
      ao[idx + 3] = 255;
    }
  }
  const normal = buildNormalFromHeight(height, size, 3.4);
  return {
    map: makeDataTex(albedo, size, true, aniso, 2),
    normalMap: makeDataTex(normal, size, false, aniso, 2),
    roughnessMap: makeDataTex(rough, size, false, aniso, 2),
    aoMap: makeDataTex(ao, size, false, aniso, 2),
  };
}

/**
 * 512x512 Pinnate Woodland Fern Frond Alpha + Normal Texture
 */
function generateFernTextures(aniso: number): { alpha: THREE.DataTexture; normal: THREE.DataTexture } {
  const size = 512;
  const rgba = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  // Central fern stem (rachis)
  ctx.strokeStyle = '#364d24';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.98);
  ctx.quadraticCurveTo(size * 0.51, size * 0.5, size * 0.5, size * 0.04);
  ctx.stroke();

  const pairs = 14;
  for (let i = 0; i < pairs; i++) {
    const t = 0.12 + (i / pairs) * 0.82;
    const y = size * (1 - t);
    const pinnaLen = size * 0.36 * Math.sin(Math.pow(t, 0.75) * Math.PI * 0.94);
    for (const side of [-1, 1]) {
      const ex = size * 0.5 + side * pinnaLen;
      const ey = y - pinnaLen * 0.22;
      ctx.fillStyle = `rgb(${44 + (i % 3) * 9}, ${76 + (i % 4) * 10}, ${32 + (i % 2) * 7})`;
      ctx.beginPath();
      ctx.moveTo(size * 0.5, y);
      ctx.quadraticCurveTo(size * 0.5 + side * pinnaLen * 0.55, y - 10, ex, ey);
      ctx.quadraticCurveTo(size * 0.5 + side * pinnaLen * 0.5, y + 6, size * 0.5, y + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  const imgData = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    const idx = i * 4;
    rgba[idx] = imgData[idx];
    rgba[idx + 1] = imgData[idx + 1];
    rgba[idx + 2] = imgData[idx + 2];
    rgba[idx + 3] = imgData[idx + 3];
    height[i] = imgData[idx + 3] > 20 ? 0.6 : 0;
  }
  const normalBytes = buildNormalFromHeight(height, size, 2.0);
  const alpha = makeDataTex(rgba, size, true, aniso, 1);
  alpha.wrapS = THREE.ClampToEdgeWrapping;
  alpha.wrapT = THREE.ClampToEdgeWrapping;
  const normal = makeDataTex(normalBytes, size, false, aniso, 1);
  normal.wrapS = THREE.ClampToEdgeWrapping;
  normal.wrapT = THREE.ClampToEdgeWrapping;
  return { alpha, normal };
}

let cachedLibrary: TextureLibrary | null = null;

export function getTextureLibrary(renderer: THREE.WebGLRenderer): TextureLibrary {
  if (cachedLibrary) return cachedLibrary;
  const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const foliage = generateFoliageTextures(maxAnisotropy);
  const fern = generateFernTextures(maxAnisotropy);

  cachedLibrary = {
    gunMetal: generateGunMetal(maxAnisotropy),
    gunPolymer: generateGunPolymer(maxAnisotropy),
    walnutWood: generateWalnutWood(maxAnisotropy),
    tacticalFabric: generateTacticalFabric(maxAnisotropy),
    terrainGrass: generateTerrainGrass(maxAnisotropy),
    terrainMud: generateTerrainMud(maxAnisotropy),
    terrainGravel: generateTerrainGravel(maxAnisotropy),
    terrainRock: generateTerrainRock(maxAnisotropy),
    concrete: generateConcrete(maxAnisotropy),
    siloWallConcrete: generateSiloWallConcrete(maxAnisotropy),
    siloFloorConcrete: generateSiloFloorConcrete(maxAnisotropy),
    hazardTrim: generateHazardTrim(maxAnisotropy),
    industrialMetal: generateIndustrialMetal(maxAnisotropy),
    woodPlank: generateWalnutWood(maxAnisotropy),
    sandbagBurlap: generateSandbagBurlap(maxAnisotropy),
    bark: generateBark(maxAnisotropy),
    soldierCamo: generateSoldierCamo(maxAnisotropy),
    soldierGear: generateSoldierGear(maxAnisotropy),
    foliageAlpha: foliage.alpha,
    foliageNormal: foliage.normal,
    fernAlpha: fern.alpha,
    fernNormal: fern.normal,
    maxAnisotropy,
  };
  return cachedLibrary;
}
