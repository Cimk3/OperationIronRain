import { fbm2D, mulberry32, ridged2D } from '../proc/noise';
import type { TerrainWorkerOutput } from '../types';

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

self.onmessage = (e: MessageEvent<{ gridSize: number; worldSize: number; seed: number }>) => {
  const { gridSize, worldSize, seed } = e.data;
  const count = gridSize * gridSize;
  const heights = new Float32Array(count);
  const half = worldSize * 0.5;
  const step = worldSize / (gridSize - 1);

  // 1. Base procedural topography: rolling hills + ridged perimeter + tactical zones
  for (let gz = 0; gz < gridSize; gz++) {
    const wz = -half + gz * step;
    for (let gx = 0; gx < gridSize; gx++) {
      const wx = -half + gx * step;

      // Macro hills & valley corridor along x ~ 0
      const baseFbm = fbm2D(wx * 0.014, wz * 0.014, 5, 2.05, 0.5, seed) * 7.5;
      const ridge = ridged2D(wx * 0.011 + 3.1, wz * 0.011 - 1.7, 4, 2.1, 0.5, seed + 17) * 6.5;
      const micro = fbm2D(wx * 0.06, wz * 0.06, 3, 2.0, 0.45, seed + 99) * 0.65;

      // Perimeter mountain bowl so player stays visually enclosed in a valley
      const edgeDist = Math.max(Math.abs(wx), Math.abs(wz)) / half;
      const rimLift = Math.pow(smoothstep(0.68, 1.0, edgeDist), 1.6) * 18.0;

      // Gentle uphill slope toward North outpost (-Z)
      const northSlope = smoothstep(105, -60, wz) * 3.8;

      let h = baseFbm + ridge * 0.55 + micro + rimLift + northSlope;

      // Carve winding muddy road/trail from spawn (0, 92) -> checkpoint (6, 34) -> outpost (0, -34) -> LZ (-46, -88)
      const roadX =
        wz > -34
          ? Math.sin(wz * 0.045) * 6.5 + smoothstep(92, 34, wz) * 4.0
          : lerp(0, -46, smoothstep(-34, -88, wz)) + Math.sin(wz * 0.06) * 4.0;
      const distToRoad = Math.abs(wx - roadX);
      const roadBlend = 1.0 - smoothstep(2.6, 8.5, distToRoad);
      const roadTargetH = 1.4 + smoothstep(95, -85, wz) * 4.2 + Math.sin(wz * 0.09) * 0.25;
      h = lerp(h, roadTargetH, roadBlend * 0.72);

      // Dual muddy tire ruts along approach trail (resolved cleanly at 0.488m vertex spacing!)
      const rutDist = Math.abs(distToRoad - 1.05);
      const rutGroove = Math.exp(-Math.pow(rutDist / 0.45, 2)) * (1.0 - smoothstep(4.5, 6.0, distToRoad));
      if (wz > -16 && wz < 98) {
        h -= rutGroove * 0.14;
      }

      // Shallow meandering forest stream crossing mid-valley (z ~ 22)
      const creekZ = 22.0 + Math.sin(wx * 0.055) * 5.2;
      const distCreek = Math.abs(wz - creekZ);
      const creekCarve = 1.0 - smoothstep(1.2, 4.4, distCreek);
      h -= creekCarve * 0.42;

      // Shell craters (smooth raised lip + concave blast bowl)
      const craters: Array<[number, number, number]> = [
        [-4.5, 67, 2.8],
        [4.2, 48, 3.1],
        [-7.2, 26, 2.6],
        [7.5, 15, 3.2],
        [-3.2, -5, 2.9],
        [6.8, -11, 2.7],
      ];
      for (const [cx, cz, cr] of craters) {
        const d = Math.hypot(wx - cx, wz - cz);
        if (d < cr * 1.45) {
          const normD = d / cr;
          const bowl = normD < 1.0 ? -Math.cos(normD * Math.PI * 0.5) * 0.52 : 0;
          const rim = Math.exp(-Math.pow((normD - 1.02) / 0.22, 2)) * 0.18;
          h += bowl + rim;
        }
      }

      // Spawn clearing around (0, 92)
      const dSpawn = Math.hypot(wx - 0, wz - 92);
      h = lerp(h, 1.55, (1.0 - smoothstep(6, 16, dSpawn)) * 0.85);

      // Outer Checkpoint pad around (6, 34)
      const dCheck = Math.hypot(wx - 6, wz - 34);
      h = lerp(h, 2.75, (1.0 - smoothstep(7, 15, dCheck)) * 0.9);

      // Military Outpost plateau around (0, -34)
      const dOutpost = Math.max(Math.abs(wx - 0), Math.abs(wz + 34));
      h = lerp(h, 4.6, (1.0 - smoothstep(22, 33, dOutpost)) * 0.96);

      // Extraction ridge pad around (-46, -88)
      const dLZ = Math.hypot(wx + 46, wz + 88);
      h = lerp(h, 6.8, (1.0 - smoothstep(8, 17, dLZ)) * 0.92);

      // Tactical drainage trench near z = 54 & z = 12
      const trench1 = Math.exp(-Math.pow((wz - 56 - Math.sin(wx * 0.08) * 3) / 2.2, 2)) *
        (1 - smoothstep(10, 26, Math.abs(wx - 10)));
      const trench2 = Math.exp(-Math.pow((wz - 8 + Math.cos(wx * 0.07) * 4) / 2.4, 2)) *
        (1 - smoothstep(12, 30, Math.abs(wx + 8)));
      h -= (trench1 + trench2) * 1.15;

      heights[gz * gridSize + gx] = h;
    }
  }

  // 2. Fast Hydraulic Droplet Erosion (only outside flat outpost/LZ pads so structures stay level!)
  const rng = mulberry32(seed + 777);
  const droplets = 14000;
  for (let d = 0; d < droplets; d++) {
    let px = 4 + rng() * (gridSize - 9);
    let pz = 4 + rng() * (gridSize - 9);
    let dirX = 0;
    let dirZ = 0;
    let speed = 1.0;
    let water = 1.0;
    let sediment = 0.0;

    for (let s = 0; s < 26; s++) {
      const ix = px | 0;
      const iz = pz | 0;
      if (ix < 2 || iz < 2 || ix >= gridSize - 3 || iz >= gridSize - 3) break;

      const wx = -half + px * step;
      const wz = -half + pz * step;
      // Protect outpost plateau & LZ pad from erosion
      if (Math.max(Math.abs(wx), Math.abs(wz + 34)) < 25) break;
      if (Math.hypot(wx + 46, wz + 88) < 12) break;

      const fx = px - ix;
      const fz = pz - iz;
      const idx = iz * gridSize + ix;
      const h00 = heights[idx];
      const h10 = heights[idx + 1];
      const h01 = heights[idx + gridSize];
      const h11 = heights[idx + gridSize + 1];

      const gradX = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
      const gradZ = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;

      dirX = dirX * 0.35 - gradX * 0.65;
      dirZ = dirZ * 0.35 - gradZ * 0.65;
      const len = Math.hypot(dirX, dirZ);
      if (len < 1e-5) break;
      dirX /= len;
      dirZ /= len;

      const nx = px + dirX;
      const nz = pz + dirZ;
      const nix = nx | 0;
      const niz = nz | 0;
      if (nix < 1 || niz < 1 || nix >= gridSize - 2 || niz >= gridSize - 2) break;

      const oldH = lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
      const nIdx = niz * gridSize + nix;
      const nfx = nx - nix;
      const nfz = nz - niz;
      const newH = lerp(
        lerp(heights[nIdx], heights[nIdx + 1], nfx),
        lerp(heights[nIdx + gridSize], heights[nIdx + gridSize + 1], nfx),
        nfz
      );

      const deltaH = newH - oldH;
      const capacity = Math.max(-deltaH, 0.015) * speed * water * 3.2;

      if (sediment > capacity || deltaH > 0) {
        const deposit = deltaH > 0 ? Math.min(deltaH, sediment) : (sediment - capacity) * 0.25;
        sediment -= deposit;
        heights[idx] += deposit * (1 - fx) * (1 - fz);
        heights[idx + 1] += deposit * fx * (1 - fz);
        heights[idx + gridSize] += deposit * (1 - fx) * fz;
        heights[idx + gridSize + 1] += deposit * fx * fz;
      } else {
        const erode = Math.min((capacity - sediment) * 0.22, -deltaH + 0.02);
        sediment += erode;
        heights[idx] -= erode * (1 - fx) * (1 - fz);
        heights[idx + 1] -= erode * fx * (1 - fz);
        heights[idx + gridSize] -= erode * (1 - fx) * fz;
        heights[idx + gridSize + 1] -= erode * fx * fz;
      }

      speed = Math.sqrt(Math.max(0.1, speed * speed + Math.max(0, -deltaH) * 4.0));
      water *= 0.94;
      px = nx;
      pz = nz;
    }
  }

  // 3. Gentle smoothing pass on trail & compute slope, puddle water depth, wetness, and splat map
  const waterDepth = new Float32Array(count);
  const wetness = new Float32Array(count);
  const splat = new Uint8Array(count * 4); // R=grass, G=mud, B=gravel, A=rock

  for (let gz = 0; gz < gridSize; gz++) {
    const wz = -half + gz * step;
    for (let gx = 0; gx < gridSize; gx++) {
      const wx = -half + gx * step;
      const idx = gz * gridSize + gx;
      const h = heights[idx];

      // Slope calculation via central differences
      const xm = Math.max(0, gx - 1);
      const xp = Math.min(gridSize - 1, gx + 1);
      const zm = Math.max(0, gz - 1);
      const zp = Math.min(gridSize - 1, gz + 1);
      const dhdx = (heights[gz * gridSize + xp] - heights[gz * gridSize + xm]) / (2 * step);
      const dhdz = (heights[zp * gridSize + gx] - heights[zm * gridSize + gx]) / (2 * step);
      const slope = Math.hypot(dhdx, dhdz);

      // Puddle basins: distinct localized rain puddles on flat trail depressions, spawn clearing & outpost yard
      const puddleNoise = fbm2D(wx * 0.14 + 4.2, wz * 0.14 - 2.8, 3, 2.0, 0.5, seed + 512);
      const roadX =
        wz > -34
          ? Math.sin(wz * 0.045) * 6.5 + smoothstep(92, 34, wz) * 4.0
          : lerp(0, -46, smoothstep(-34, -88, wz)) + Math.sin(wz * 0.06) * 4.0;
      const distToRoad = Math.abs(wx - roadX);
      const onTrail = 1.0 - smoothstep(1.8, 5.2, distToRoad);
      const inSpawnView = 1.0 - smoothstep(6, 22, Math.hypot(wx, wz - 80));
      const inOutpostYard = 1.0 - smoothstep(8, 22, Math.hypot(wx, wz + 34));

      const flatFactor = 1.0 - smoothstep(0.06, 0.19, slope);
      const creekZ = 22.0 + Math.sin(wx * 0.055) * 5.2;
      const inCreek = 1.0 - smoothstep(1.1, 2.8, Math.abs(wz - creekZ));
      const rutWater =
        wz > -16 && wz < 98
          ? Math.exp(-Math.pow(Math.abs(distToRoad - 1.05) / 0.42, 2)) * 0.16 * Math.max(0, puddleNoise + 0.35)
          : 0;
      const puddleBias = puddleNoise + onTrail * 0.15 + inSpawnView * 0.14 + inOutpostYard * 0.12;
      const pDepth = Math.max(0, (puddleBias - 0.22) * flatFactor) + inCreek * 0.18 + rutWater;
      waterDepth[idx] = pDepth;

      // Subtle micro-depression under puddles so water visually pools
      if (pDepth > 0.01) {
        heights[idx] -= Math.min(0.08, pDepth * 0.12);
      }

      // Surface wetness: smooth dark damp transition band around puddles & creek!
      const shoreBand = Math.max(inCreek * 0.85, 1.0 - smoothstep(0.0, 0.06, pDepth));
      wetness[idx] = Math.min(1.0, 0.40 + onTrail * 0.28 + flatFactor * 0.18 + pDepth * 2.5 + (1.0 - shoreBand) * 0.35);

      // Splat weights: R=grass, G=mud, B=gravel, A=rock
      let wRock = smoothstep(0.45, 0.92, slope);
      let wMud = Math.min(1, onTrail * 0.85 + pDepth * 2.2 + smoothstep(0.18, 0.42, slope) * 0.2);
      let wGravel = Math.min(1, onTrail * 0.35 + (1 - smoothstep(20, 32, Math.hypot(wx, wz + 34))) * 0.65);
      let wGrass = Math.max(0, 1.0 - wRock - wMud * 0.7 - wGravel * 0.6);

      const sum = wGrass + wMud + wGravel + wRock + 1e-4;
      const sIdx = idx * 4;
      splat[sIdx] = Math.round((wGrass / sum) * 255);
      splat[sIdx + 1] = Math.round((wMud / sum) * 255);
      splat[sIdx + 2] = Math.round((wGravel / sum) * 255);
      splat[sIdx + 3] = Math.round((wRock / sum) * 255);
    }
  }

  // 4. Generate Scatter Placements (Trees, Rocks, Bushes) respecting slopes, road & outpost!
  const sampleH = (wx: number, wz: number) => {
    const fx = (wx + half) / step;
    const fz = (wz + half) / step;
    const ix = Math.max(0, Math.min(gridSize - 2, fx | 0));
    const iz = Math.max(0, Math.min(gridSize - 2, fz | 0));
    const tx = fx - ix;
    const tz = fz - iz;
    const i = iz * gridSize + ix;
    return lerp(lerp(heights[i], heights[i + 1], tx), lerp(heights[i + gridSize], heights[i + gridSize + 1], tx), tz);
  };

  const sampleSlope = (wx: number, wz: number) => {
    const gx = Math.max(1, Math.min(gridSize - 2, Math.round((wx + half) / step)));
    const gz = Math.max(1, Math.min(gridSize - 2, Math.round((wz + half) / step)));
    const dhdx = (heights[gz * gridSize + gx + 1] - heights[gz * gridSize + gx - 1]) / (2 * step);
    const dhdz = (heights[(gz + 1) * gridSize + gx] - heights[(gz - 1) * gridSize + gx]) / (2 * step);
    return Math.hypot(dhdx, dhdz);
  };

  const isClearZone = (wx: number, wz: number, extraRoadMargin = 0) => {
    const roadX =
      wz > -34
        ? Math.sin(wz * 0.045) * 6.5 + smoothstep(92, 34, wz) * 4.0
        : lerp(0, -46, smoothstep(-34, -88, wz)) + Math.sin(wz * 0.06) * 4.0;
    if (Math.abs(wx - roadX) < 5.2 + extraRoadMargin) return true;
    if (Math.hypot(wx, wz - 92) < 9.5) return true; // Spawn
    if (Math.hypot(wx - 6, wz - 34) < 10.5) return true; // Checkpoint
    if (Math.max(Math.abs(wx), Math.abs(wz + 34)) < 25) return true; // Outpost
    if (Math.hypot(wx + 46, wz + 88) < 11) return true; // LZ
    return false;
  };

  const trees: number[] = [];
  for (let i = 0; i < 650 && trees.length < 180 * 5; i++) {
    const wx = (rng() - 0.5) * (worldSize - 18);
    const wz = (rng() - 0.5) * (worldSize - 18);
    if (isClearZone(wx, wz, 1.5)) continue;
    if (sampleSlope(wx, wz) > 0.55) continue;
    // Check spacing against existing trees
    let tooClose = false;
    for (let t = 0; t < trees.length; t += 5) {
      if (Math.hypot(wx - trees[t], wz - trees[t + 1]) < 6.5) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    trees.push(wx, wz, 0.85 + rng() * 0.65, rng() * Math.PI * 2, rng() * 1000);
  }

  const rocks: number[] = [];
  for (let i = 0; i < 350 && rocks.length < 110 * 7; i++) {
    const wx = (rng() - 0.5) * (worldSize - 20);
    const wz = (rng() - 0.5) * (worldSize - 20);
    if (isClearZone(wx, wz, -0.5)) continue;
    // Keep rocks clear of spawn sightline directly ahead
    if (Math.hypot(wx, wz - 84) < 6) continue;
    const sc = 0.75 + rng() * 1.45;
    rocks.push(
      wx,
      wz,
      sc * (0.85 + rng() * 0.4),
      sc * (0.55 + rng() * 0.45),
      sc * (0.85 + rng() * 0.4),
      rng() * Math.PI * 2,
      rng() * 1000
    );
  }

  const bushes: number[] = [];
  for (let i = 0; i < 500 && bushes.length < 220 * 4; i++) {
    const wx = (rng() - 0.5) * (worldSize - 18);
    const wz = (rng() - 0.5) * (worldSize - 18);
    if (isClearZone(wx, wz, 0.2)) continue;
    if (sampleSlope(wx, wz) > 0.6) continue;
    const h = sampleH(wx, wz);
    if (h < -3) continue;
    bushes.push(wx, wz, 0.7 + rng() * 0.8, rng() * Math.PI * 2);
  }

  const output: TerrainWorkerOutput = {
    gridSize,
    worldSize,
    heights,
    waterDepth,
    wetness,
    splat,
    treePlacements: new Float32Array(trees),
    rockPlacements: new Float32Array(rocks),
    bushPlacements: new Float32Array(bushes),
  };

  (self as unknown as Worker).postMessage(output, [
    output.heights.buffer,
    output.waterDepth.buffer,
    output.wetness.buffer,
    output.splat.buffer,
    output.treePlacements.buffer,
    output.rockPlacements.buffer,
    output.bushPlacements.buffer,
  ]);
};
