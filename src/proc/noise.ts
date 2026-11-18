// Deterministic fast PRNG & 2D/3D procedural noise functions
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2D(ix: number, iy: number, seed = 1337): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hash3D(ix: number, iy: number, iz: number, seed = 1337): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1597334677) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function grad2(ix: number, iy: number, x: number, y: number, seed: number): number {
  const h = (hash2D(ix, iy, seed) * 8) | 0;
  switch (h & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x * 1.4142;
    case 5: return -x * 1.4142;
    case 6: return y * 1.4142;
    default: return -y * 1.4142;
  }
}

export function perlin2D(x: number, y: number, seed = 1337): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fade(fx);
  const v = fade(fy);

  const n00 = grad2(x0, y0, fx, fy, seed);
  const n10 = grad2(x0 + 1, y0, fx - 1, fy, seed);
  const n01 = grad2(x0, y0 + 1, fx, fy - 1, seed);
  const n11 = grad2(x0 + 1, y0 + 1, fx - 1, fy - 1, seed);

  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 0.7071;
}

export function valueNoise3D(x: number, y: number, z: number, seed = 1337): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const fz = fade(z - z0);

  const c000 = hash3D(x0, y0, z0, seed);
  const c100 = hash3D(x0 + 1, y0, z0, seed);
  const c010 = hash3D(x0, y0 + 1, z0, seed);
  const c110 = hash3D(x0 + 1, y0 + 1, z0, seed);
  const c001 = hash3D(x0, y0, z0 + 1, seed);
  const c101 = hash3D(x0 + 1, y0, z0 + 1, seed);
  const c011 = hash3D(x0, y0 + 1, z0 + 1, seed);
  const c111 = hash3D(x0 + 1, y0 + 1, z0 + 1, seed);

  const nx00 = lerp(c000, c100, fx);
  const nx10 = lerp(c010, c110, fx);
  const nx01 = lerp(c001, c101, fx);
  const nx11 = lerp(c011, c111, fx);

  return lerp(lerp(nx00, nx10, fy), lerp(nx01, nx11, fy), fz) * 2 - 1;
}

export function fbm2D(
  x: number,
  y: number,
  octaves = 5,
  lacunarity = 2.02,
  gain = 0.5,
  seed = 1337
): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin2D(x * freq, y * freq, seed + i * 97);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function ridged2D(
  x: number,
  y: number,
  octaves = 4,
  lacunarity = 2.1,
  gain = 0.52,
  seed = 4242
): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let weight = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = 1.0 - Math.abs(perlin2D(x * freq, y * freq, seed + i * 131));
    n = n * n * weight;
    weight = Math.max(0, Math.min(1, n * 1.8));
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function voronoi2D(x: number, y: number, seed = 7919): { f1: number; f2: number; cell: number } {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 99;
  let f2 = 99;
  let cell = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      const px = cx + hash2D(cx, cy, seed);
      const py = cy + hash2D(cx, cy, seed + 531);
      const distX = px - x;
      const distY = py - y;
      const d = Math.sqrt(distX * distX + distY * distY);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        cell = hash2D(cx, cy, seed + 997);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, cell };
}
