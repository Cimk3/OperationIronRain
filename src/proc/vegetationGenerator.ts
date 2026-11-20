import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { mulberry32 } from './noise';
import { ellipseProfile, mergeParts, sweepProfileAlongCurve } from './modeling';

export interface GrassClumpLibrary {
  tallMeadow: THREE.BufferGeometry;
  broadWeed: THREE.BufferGeometry;
  denseTurf: THREE.BufferGeometry;
  dryOchre: THREE.BufferGeometry;
}

export interface MicroGroundAssetLibrary {
  deadTwig: THREE.BufferGeometry;
  fallenLeaves: THREE.BufferGeometry;
  gravelCluster: THREE.BufferGeometry;
  woodyShrubBranches: THREE.BufferGeometry;
  woodyShrubLeaves: THREE.BufferGeometry;
  leafSprigAlpha: THREE.DataTexture;
  leafSprigNormal: THREE.DataTexture;
}

interface BladeParams {
  ox: number;
  oz: number;
  yaw: number;
  height: number;
  baseWidth: number;
  lean: number;
  droop: number;
  twist: number;
  vFold: number;
  segs: number;
  rootCol: THREE.Color;
  midCol: THREE.Color;
  tipCol: THREE.Color;
}

/**
 * Appends a true 3D multi-segment curved, twisted, V-creased grass blade that tapers smoothly to a pointed tip.
 * Zero flat rectangular paper-card look!
 */
function appendCurvedGrassBlade(
  p: BladeParams,
  positions: number[],
  normals: number[],
  uvs: number[],
  colors: number[],
  indices: number[]
): void {
  const baseV = positions.length / 3;
  const cosY = Math.cos(p.yaw);
  const sinY = Math.sin(p.yaw);
  const cTmp = new THREE.Color();

  // Cross-section rows: 3 vertices per segment (left edge, center midrib crease, right edge)
  for (let i = 0; i < p.segs; i++) {
    const t = i / p.segs;
    // Smooth parabolic width taper
    const w = p.baseWidth * Math.pow(1 - t * 0.92, 0.72);
    // Natural upward growth + graceful outward arch + tip droop
    const y = p.height * (t - p.droop * t * t * t) - 0.025;
    const zCenter = p.lean * (t * t) + p.droop * p.height * 0.35 * t * t * t;
    const twistA = p.twist * t;
    const cosT = Math.cos(twistA);
    const sinT = Math.sin(twistA);

    // Root ambient occlusion + vertical color gradient
    const rootAO = 0.24 + 0.76 * Math.pow(t, 0.62);
    if (t < 0.55) {
      cTmp.copy(p.rootCol).lerp(p.midCol, t / 0.55);
    } else {
      cTmp.copy(p.midCol).lerp(p.tipCol, (t - 0.55) / 0.45);
    }
    cTmp.multiplyScalar(rootAO);

    // Tangent along blade for accurate smooth vertex normals
    const dyDt = Math.max(0.05, p.height * (1 - 3 * p.droop * t * t));
    const dzDt = 2 * p.lean * t + 1.05 * p.droop * p.height * t * t;
    const invT = 1 / Math.hypot(dyDt, dzDt);
    const nLocalY = -dzDt * invT;
    const nLocalZ = dyDt * invT;

    const offsets: Array<[number, number, number, number]> = [
      [-w, p.vFold * (1 - t * 0.6), -0.45, 0.0], // Left edge
      [0, 0, 0.0, 0.5],                          // Center midrib crease
      [w, p.vFold * (1 - t * 0.6), 0.45, 1.0],   // Right edge
    ];

    for (const [lxRaw, lzFold, nxTilt, uCoord] of offsets) {
      // Apply twist around blade axis
      const lx = lxRaw * cosT - lzFold * sinT;
      const lz = zCenter + lxRaw * sinT + lzFold * cosT;

      // Rotate by blade yaw and offset within clump
      const wx = p.ox + lx * cosY + lz * sinY;
      const wz = p.oz - lx * sinY + lz * cosY;

      positions.push(wx, y, wz);
      uvs.push(uCoord, t);

      // Slight lateral crease darkening at center fold
      const foldShade = nxTilt === 0 ? 0.90 : 1.03;
      colors.push(cTmp.r * foldShade, cTmp.g * foldShade, cTmp.b * foldShade);

      // Rotate normal into clump space
      const nlx = nxTilt * cosT - nLocalZ * sinT;
      const nlz = nxTilt * sinT + nLocalZ * cosT;
      const nwx = nlx * cosY + nlz * sinY;
      const nwz = -nlx * sinY + nlz * cosY;
      const nInv = 1 / Math.hypot(nwx, nLocalY, nwz);
      normals.push(nwx * nInv, nLocalY * nInv, nwz * nInv);
    }
  }

  // Pointed Tip Vertex (single vertex closing blade cleanly to a natural point!)
  const tipY = p.height * (1 - p.droop) - 0.025;
  const tipZ = p.lean + p.droop * p.height * 0.35;
  const tipWX = p.ox + tipZ * sinY;
  const tipWZ = p.oz + tipZ * cosY;
  const tipIdx = positions.length / 3;
  positions.push(tipWX, tipY, tipWZ);
  uvs.push(0.5, 1.0);
  colors.push(p.tipCol.r, p.tipCol.g, p.tipCol.b);
  normals.push(0, 1, 0);

  // Stitch segment quads (2 quads per vertical band across left-center & center-right)
  for (let i = 0; i < p.segs - 1; i++) {
    const r0 = baseV + i * 3;
    const r1 = baseV + (i + 1) * 3;
    // Left half
    indices.push(r0, r0 + 1, r1, r0 + 1, r1 + 1, r1);
    // Right half
    indices.push(r0 + 1, r0 + 2, r1 + 1, r0 + 2, r1 + 2, r1 + 1);
  }
  // Stitch final top triangles converging cleanly to pointed tip
  const lastRow = baseV + (p.segs - 1) * 3;
  indices.push(lastRow, lastRow + 1, tipIdx);
  indices.push(lastRow + 1, lastRow + 2, tipIdx);
}

function finalizeBladeClump(
  positions: number[],
  normals: number[],
  uvs: number[],
  colors: number[],
  indices: number[]
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Generates 4 ecologically distinct multi-segment curved grass clump varieties.
 */
export function buildGrassClumpLibrary(): GrassClumpLibrary {
  const buildVariety = (
    seed: number,
    bladeCount: number,
    radiusSpread: number,
    hMin: number,
    hMax: number,
    wMin: number,
    wMax: number,
    leanMin: number,
    leanMax: number,
    droopMin: number,
    droopMax: number,
    segs: number,
    rootHex: number,
    midHex: number,
    tipHex: number
  ): THREE.BufferGeometry => {
    const rng = mulberry32(seed);
    const pos: number[] = [];
    const norm: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];

    const rootCol = new THREE.Color(rootHex);
    const midCol = new THREE.Color(midHex);
    const tipCol = new THREE.Color(tipHex);

    for (let b = 0; b < bladeCount; b++) {
      // Golden-angle phyllotaxis with organic jitter so clump is lush from every 360° angle
      const radialAng = b * 2.39996 + (rng() - 0.5) * 0.55;
      const dist = Math.sqrt((b + 0.3) / bladeCount) * radiusSpread;
      const ox = Math.cos(radialAng) * dist;
      const oz = Math.sin(radialAng) * dist;
      // Blades tend to lean outward from clump center with natural variation
      const yaw = radialAng + (rng() - 0.5) * 0.95;

      const h = hMin + rng() * (hMax - hMin);
      const w = wMin + rng() * (wMax - wMin);
      const lean = leanMin + rng() * (leanMax - leanMin);
      const droop = droopMin + rng() * (droopMax - droopMin);
      const twist = (rng() - 0.5) * 1.1;

      // Subtle per-blade hue/value shift
      const shift = 0.86 + rng() * 0.28;
      appendCurvedGrassBlade(
        {
          ox,
          oz,
          yaw,
          height: h,
          baseWidth: w,
          lean,
          droop,
          twist,
          vFold: w * 0.42,
          segs,
          rootCol: rootCol.clone().multiplyScalar(shift),
          midCol: midCol.clone().multiplyScalar(shift),
          tipCol: tipCol.clone().multiplyScalar(shift),
        },
        pos,
        norm,
        uv,
        col,
        idx
      );
    }

    return finalizeBladeClump(pos, norm, uv, col, idx);
  };

  return {
    // 1. Tall rain-bent meadow grass (CoD4 muted overcast olive-sage!)
    tallMeadow: buildVariety(
      301, 13, 0.24,
      0.34, 0.58, 0.011, 0.017,
      0.14, 0.26, 0.14, 0.26, 5,
      0x272d1b, 0x455331, 0x6f7444
    ),
    // 2. Broadleaf woodland weed / sedge clump (wider arched leaves, deeper forest green)
    broadWeed: buildVariety(
      302, 10, 0.22,
      0.20, 0.34, 0.022, 0.034,
      0.16, 0.28, 0.18, 0.32, 5,
      0x1e2817, 0x364a27, 0x556639
    ),
    // 3. Dense low groundcover turf (16 fine blades filling bare ground seamlessly!)
    denseTurf: buildVariety(
      303, 16, 0.34,
      0.12, 0.24, 0.009, 0.014,
      0.07, 0.14, 0.06, 0.14, 4,
      0x262b1a, 0x3f4c2c, 0x5b653c
    ),
    // 4. Dry ochre / dead reed grass (breaks uniform green into realistic battlefield meadow!)
    dryOchre: buildVariety(
      304, 11, 0.25,
      0.28, 0.52, 0.010, 0.015,
      0.15, 0.28, 0.16, 0.30, 5,
      0x342c1c, 0x685937, 0x948153
    ),
  };
}

/**
 * Creates the custom GPU-instanced Grass Material featuring:
 * - Root occlusion + per-blade color gradient + per-instance color variation
 * - Backlit Subsurface Translucency under overcast sky & directional key
 * - Dual-frequency Wind Gust Wave (anchored firmly at ground y=0)
 * - Smooth Distance LOD compression & fadeout
 */
export function createGrassMaterial(
  timeUniform: { value: number },
  camPosUniform: { value: THREE.Vector3 },
  sunDir: THREE.Vector3,
  fadeEndDist = 66.0,
  csm?: CSM
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.01,
    side: THREE.DoubleSide,
    vertexColors: true,
    envMapIntensity: 0.65,
  });

  if (csm) csm.setupMaterial(mat);
  const prev = mat.onBeforeCompile;

  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.uniforms.uTime = timeUniform;
    shader.uniforms.uCamPos = camPosUniform;
    shader.uniforms.uFadeDist = { value: fadeEndDist };
    shader.uniforms.uSunDir = { value: sunDir.clone().normalize() };

    shader.vertexShader =
      `
      uniform float uTime;
      uniform vec3 uCamPos;
      uniform float uFadeDist;
      varying float vBladeTip;
      varying vec3 vGrassWorldPos;
      ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 gInstPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 gInstPos = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
      #endif
      float hNorm = clamp((position.y + 0.025) / 0.45, 0.0, 1.0);
      vBladeTip = hNorm;

      // Distance LOD: gently squash & fade clumps past mid-range (zero sudden popping)
      if (uFadeDist > 1.0) {
        float distC = length(gInstPos - uCamPos);
        float lodScale = 1.0 - smoothstep(uFadeDist * 0.52, uFadeDist, distC);
        transformed *= lodScale;
      }

      // Dual-frequency Wind Field: sweeping gust wave + fine tip flutter (strictly quadratic in height so roots stay anchored!)
      float bendWeight = hNorm * hNorm;
      float macroWave = sin(uTime * 1.65 + gInstPos.x * 0.24 + gInstPos.z * 0.18) * 0.65
                      + sin(uTime * 0.85 - gInstPos.x * 0.11 + gInstPos.z * 0.21) * 0.35;
      float microFlutter = sin(uTime * 5.2 + gInstPos.x * 1.4 - gInstPos.z * 1.1 + position.x * 9.0) * 0.16;
      float gust = (macroWave * 0.085 + microFlutter * 0.028) * bendWeight;
      transformed.x += gust;
      transformed.z += gust * 0.62;
      transformed.y -= abs(gust) * 0.24;
      vGrassWorldPos = gInstPos + transformed;
      `
    );

    shader.fragmentShader =
      `
      uniform vec3 uCamPos;
      uniform vec3 uSunDir;
      varying float vBladeTip;
      varying vec3 vGrassWorldPos;
      ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
      #include <emissivemap_fragment>
      // Soft overcast translucency near blade tips (thin grass transmits filtered sky & backlight!)
      vec3 gViewDir = normalize(vGrassWorldPos - uCamPos);
      float backScatter = pow(max(0.0, dot(gViewDir, uSunDir)), 2.8);
      float skyTransmit = 0.14 + backScatter * 0.55;
      totalEmissiveRadiance += diffuseColor.rgb * vec3(1.05, 1.08, 0.72) * skyTransmit * smoothstep(0.18, 0.95, vBladeTip) * 0.42;
      `
    );
  };

  mat.customProgramCacheKey = () => `curved-grass-v2-${fadeEndDist}`;
  return mat;
}

/**
 * Generates a high-resolution 1024x1024 procedural branchlet + individual serrated leaves sprig texture
 * (Real botanical twig + clustered serrated leaves with midribs and veins — zero wire-mesh radial lines!)
 */
export function generateBotanicalLeafSprigTexture(aniso: number): {
  alpha: THREE.DataTexture;
  normal: THREE.DataTexture;
} {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  const rng = mulberry32(8842);

  // Draw central woody twig stem + 6 side branchlets
  const drawWoodTwig = (x0: number, y0: number, x1: number, y1: number, width: number) => {
    const cx = (x0 + x1) * 0.5 + (rng() - 0.5) * 45;
    const cy = (y0 + y1) * 0.5 + (rng() - 0.5) * 35;
    ctx.strokeStyle = '#3c3024';
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
    return { cx, cy };
  };

  const drawSingleLeaf = (x: number, y: number, ang: number, len: number, wid: number, depthShade: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);

    // Organic CoD4 overcast broadleaf palette (muted olive/moss/forest greens with subtle dry tips)
    const dryMix = rng() > 0.82 ? 0.35 : 0.0;
    const r = Math.round((46 + rng() * 24 + dryMix * 52) * depthShade);
    const g = Math.round((68 + rng() * 28 + dryMix * 24) * depthShade);
    const b = Math.round((34 + rng() * 14) * depthShade);

    const grad = ctx.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, `rgb(${Math.round(r * 0.72)}, ${Math.round(g * 0.76)}, ${Math.round(b * 0.72)})`);
    grad.addColorStop(0.65, `rgb(${r}, ${g}, ${b})`);
    grad.addColorStop(1, `rgb(${Math.min(180, Math.round(r * 1.18))}, ${Math.min(190, Math.round(g * 1.15))}, ${Math.round(b * 1.05)})`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.28, -wid, len * 0.72, -wid * 0.85, len, 0);
    ctx.bezierCurveTo(len * 0.72, wid * 0.85, len * 0.28, wid, 0, 0);
    ctx.closePath();
    ctx.fill();

    // Central vein & subtle lateral leaf veins
    ctx.strokeStyle = `rgba(${Math.round(r * 1.25)}, ${Math.round(g * 1.28)}, ${Math.round(b * 1.15)}, 0.45)`;
    ctx.lineWidth = Math.max(1.2, wid * 0.07);
    ctx.beginPath();
    ctx.moveTo(2, 0);
    ctx.lineTo(len * 0.88, 0);
    ctx.stroke();

    ctx.lineWidth = Math.max(0.8, wid * 0.04);
    for (let v = 1; v <= 3; v++) {
      const vx = len * (v * 0.22);
      const vw = wid * (0.65 - v * 0.12);
      ctx.beginPath();
      ctx.moveTo(vx, 0);
      ctx.lineTo(vx + len * 0.14, -vw);
      ctx.moveTo(vx, 0);
      ctx.lineTo(vx + len * 0.14, vw);
      ctx.stroke();
    }
    ctx.restore();
  };

  // Main stem from bottom center upward
  const mainX0 = size * 0.5;
  const mainY0 = size * 0.94;
  const mainX1 = size * 0.5 + (rng() - 0.5) * 40;
  const mainY1 = size * 0.10;
  drawWoodTwig(mainX0, mainY0, mainX1, mainY1, 10);

  // Side shoots branching off organically
  const shootSpecs: Array<[number, number, number]> = [
    [0.20, -0.78, 0.34],
    [0.24, 0.74, 0.34],
    [0.42, -0.68, 0.38],
    [0.46, 0.65, 0.37],
    [0.64, -0.58, 0.32],
    [0.68, 0.55, 0.31],
    [0.82, -0.45, 0.22],
    [0.85, 0.42, 0.22],
  ];

  // 2 passes: deeper darker shadow leaves first, brighter outer leaves on top
  for (let pass = 0; pass < 2; pass++) {
    const shadeBase = pass === 0 ? 0.72 : 1.02;
    for (const [t, angOff, lenFrac] of shootSpecs) {
      const sx = THREE.MathUtils.lerp(mainX0, mainX1, t);
      const sy = THREE.MathUtils.lerp(mainY0, mainY1, t);
      const shootAng = -Math.PI * 0.5 + angOff;
      const shootLen = size * lenFrac;
      const ex = sx + Math.cos(shootAng) * shootLen;
      const ey = sy + Math.sin(shootAng) * shootLen;
      if (pass === 0) drawWoodTwig(sx, sy, ex, ey, 5.5);

      const leavesPerShoot = pass === 0 ? 11 : 13;
      for (let l = 0; l < leavesPerShoot; l++) {
        const lt = 0.14 + (l / (leavesPerShoot - 1)) * 0.86;
        const lx = THREE.MathUtils.lerp(sx, ex, lt) + (rng() - 0.5) * 26;
        const ly = THREE.MathUtils.lerp(sy, ey, lt) + (rng() - 0.5) * 26;
        const side = l % 2 === 0 ? 1 : -1;
        const leafAng = shootAng + side * (0.45 + rng() * 0.75);
        const leafLen = (58 + rng() * 52) * (1.0 - lt * 0.24);
        const leafWid = leafLen * (0.28 + rng() * 0.14);
        drawSingleLeaf(lx, ly, leafAng, leafLen, leafWid, shadeBase * (0.85 + lt * 0.22));
      }
    }
    // Crown tip cluster at top of main twig
    for (let l = 0; l < 12; l++) {
      const lt = 0.72 + rng() * 0.26;
      const lx = THREE.MathUtils.lerp(mainX0, mainX1, lt) + (rng() - 0.5) * 48;
      const ly = THREE.MathUtils.lerp(mainY0, mainY1, lt) + (rng() - 0.5) * 42;
      const leafAng = -Math.PI * 0.5 + (rng() - 0.5) * 1.8;
      const leafLen = 54 + rng() * 44;
      drawSingleLeaf(lx, ly, leafAng, leafLen, leafLen * 0.34, shadeBase * 1.05);
    }
  }

  const imgData = ctx.getImageData(0, 0, size, size).data;
  const rgba = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    rgba[o] = imgData[o];
    rgba[o + 1] = imgData[o + 1];
    rgba[o + 2] = imgData[o + 2];
    rgba[o + 3] = imgData[o + 3];
    height[i] = imgData[o + 3] > 24 ? 0.35 + (imgData[o + 1] / 255) * 0.65 : 0.0;
  }

  // Sobel normal from leaf brightness/alpha relief
  const normalBytes = new Uint8Array(size * size * 4);
  const mask = size - 1;
  for (let y = 0; y < size; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(mask, y + 1);
    for (let x = 0; x < size; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(mask, x + 1);
      const dx = (height[y * size + xp] - height[y * size + xm]) * 2.8;
      const dy = (height[yp * size + x] - height[ym * size + x]) * 2.8;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      normalBytes[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      normalBytes[o + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      normalBytes[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      normalBytes[o + 3] = 255;
    }
  }

  const alpha = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  alpha.wrapS = THREE.ClampToEdgeWrapping;
  alpha.wrapT = THREE.ClampToEdgeWrapping;
  alpha.magFilter = THREE.LinearFilter;
  alpha.minFilter = THREE.LinearMipmapLinearFilter;
  alpha.generateMipmaps = true;
  alpha.anisotropy = aniso;
  alpha.colorSpace = THREE.SRGBColorSpace;
  alpha.needsUpdate = true;

  const normal = new THREE.DataTexture(normalBytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  normal.wrapS = THREE.ClampToEdgeWrapping;
  normal.wrapT = THREE.ClampToEdgeWrapping;
  normal.magFilter = THREE.LinearFilter;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.generateMipmaps = true;
  normal.anisotropy = aniso;
  normal.colorSpace = THREE.NoColorSpace;
  normal.needsUpdate = true;

  return { alpha, normal };
}

/**
 * Generates woody multi-branch shrubs + dead twigs + curved fallen leaves + angular ground gravel clusters.
 */
export function buildMicroGroundAssets(aniso: number): MicroGroundAssetLibrary {
  const leafTex = generateBotanicalLeafSprigTexture(aniso);

  // 1. Woody Shrub (curved woody branch skeleton + outward leaf sprigs!)
  const shrubRng = mulberry32(551);
  const shrubBranchParts: THREE.BufferGeometry[] = [];
  const shrubLeafParts: THREE.BufferGeometry[] = [];
  const numStems = 8;
  for (let s = 0; s < numStems; s++) {
    const az = (s / numStems) * Math.PI * 2 + (shrubRng() - 0.5) * 0.4;
    const len = 0.65 + shrubRng() * 0.45;
    const spread = 0.42 + shrubRng() * 0.35;
    const p0 = new THREE.Vector3(Math.cos(az) * 0.05, -0.06, Math.sin(az) * 0.05);
    const p1 = new THREE.Vector3(Math.cos(az) * spread * 0.5, len * 0.52, Math.sin(az) * spread * 0.5);
    const p2 = new THREE.Vector3(Math.cos(az) * spread, len, Math.sin(az) * spread);
    const curve = new THREE.CatmullRomCurve3([p0, p1, p2]);
    shrubBranchParts.push(
      sweepProfileAlongCurve(
        curve,
        ellipseProfile(1, 1, 6),
        6,
        (t) => ({ sx: THREE.MathUtils.lerp(0.024, 0.006, t), sy: THREE.MathUtils.lerp(0.024, 0.006, t) }),
        true
      )
    );

    // Attach 3 angled bent leaf-sprig cards along upper half of each woody stem
    for (let k = 0; k < 3; k++) {
      const pt = curve.getPoint(0.45 + k * 0.26);
      const sc = 0.48 + shrubRng() * 0.28;
      const card = new THREE.PlaneGeometry(sc, sc, 2, 2);
      const pa = card.attributes.position as THREE.BufferAttribute;
      const cols = new Float32Array(pa.count * 3);
      for (let v = 0; v < pa.count; v++) {
        const vx = pa.getX(v);
        const vy = pa.getY(v);
        const r = Math.hypot(vx, vy) / (sc * 0.7);
        pa.setZ(v, -r * r * 0.14);
        const ao = 0.38 + Math.min(1, r) * 0.68;
        cols[v * 3] = ao;
        cols[v * 3 + 1] = ao;
        cols[v * 3 + 2] = ao;
      }
      card.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      card.computeVertexNormals();
      card.rotateX((shrubRng() - 0.5) * 0.9 - 0.25);
      card.rotateY(az + (k - 1) * 0.95 + (shrubRng() - 0.5) * 0.4);
      card.rotateZ((shrubRng() - 0.5) * 0.7);
      card.translate(pt.x, pt.y, pt.z);
      shrubLeafParts.push(card);
    }
  }

  // 2. Dead Fallen Branched Twig
  const twigParts: THREE.BufferGeometry[] = [];
  const mainTwig = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.42, 0.02, 0.04),
    new THREE.Vector3(-0.12, 0.045, -0.05),
    new THREE.Vector3(0.18, 0.032, 0.03),
    new THREE.Vector3(0.46, 0.015, -0.02),
  ]);
  twigParts.push(
    sweepProfileAlongCurve(
      mainTwig,
      ellipseProfile(1, 1, 7),
      10,
      (t) => ({ sx: THREE.MathUtils.lerp(0.024, 0.008, t), sy: THREE.MathUtils.lerp(0.022, 0.007, t) }),
      true
    )
  );
  const subTwig = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.04, 0.04, -0.03),
    new THREE.Vector3(0.12, 0.06, -0.16),
    new THREE.Vector3(0.24, 0.03, -0.26),
  ]);
  twigParts.push(
    sweepProfileAlongCurve(
      subTwig,
      ellipseProfile(1, 1, 5),
      6,
      (t) => ({ sx: THREE.MathUtils.lerp(0.014, 0.005, t), sy: THREE.MathUtils.lerp(0.014, 0.005, t) }),
      true
    )
  );

  // 3. Curved 3D Fallen Leaf Cluster (sits right on ground)
  const leafRng = mulberry32(662);
  const fallenParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 11; i++) {
    const lLen = 0.075 + leafRng() * 0.065;
    const lWid = lLen * 0.52;
    const g = new THREE.PlaneGeometry(lLen, lWid, 2, 2);
    const pa = g.attributes.position as THREE.BufferAttribute;
    const cols = new Float32Array(pa.count * 3);
    const tone = leafRng();
    const c = new THREE.Color().setRGB(
      0.22 + tone * 0.14,
      0.16 + tone * 0.08,
      0.08 + tone * 0.04
    );
    for (let v = 0; v < pa.count; v++) {
      const px = pa.getX(v);
      const py = pa.getY(v);
      const nx = px / (lLen * 0.5);
      // Taper corners into leaf diamond + curl edges slightly upward
      pa.setY(v, py * (1 - nx * nx * 0.72));
      pa.setZ(v, (nx * nx) * 0.014 + Math.abs(py / lWid) * 0.010);
      cols[v * 3] = c.r;
      cols[v * 3 + 1] = c.g;
      cols[v * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    g.rotateX(-Math.PI * 0.5 + (leafRng() - 0.5) * 0.22);
    g.rotateY(leafRng() * Math.PI * 2);
    g.translate((leafRng() - 0.5) * 0.52, 0.012 + leafRng() * 0.012, (leafRng() - 0.5) * 0.52);
    g.computeVertexNormals();
    fallenParts.push(g);
  }

  // 4. Angular Surface Gravel Stones Cluster (4 sharp fractured stones embedded in earth)
  const stRng = mulberry32(773);
  const stoneParts: THREE.BufferGeometry[] = [];
  for (let s = 0; s < 5; s++) {
    const rad = 0.045 + stRng() * 0.075;
    const g = new THREE.IcosahedronGeometry(rad, 1);
    const pa = g.attributes.position as THREE.BufferAttribute;
    const p1x = stRng() - 0.5, p1y = stRng() - 0.5, p1z = stRng() - 0.5;
    for (let v = 0; v < pa.count; v++) {
      let vx = pa.getX(v);
      let vy = pa.getY(v) * (0.48 + stRng() * 0.12);
      let vz = pa.getZ(v);
      // Facet planar shear for crisp crushed rock feel
      const dot = vx * p1x + vy * p1y + vz * p1z;
      if (dot > rad * 0.15) {
        vx *= 0.76;
        vz *= 0.76;
      }
      pa.setXYZ(v, vx, vy, vz);
    }
    g.computeVertexNormals();
    g.rotateY(stRng() * Math.PI * 2);
    g.translate((stRng() - 0.5) * 0.34, rad * 0.22, (stRng() - 0.5) * 0.34);
    // Assign natural stone vertex colors so gravel clusters share vertex-colored rock materials cleanly!
    const gPos = g.attributes.position as THREE.BufferAttribute;
    const gCols = new Float32Array(gPos.count * 3);
    const shade = 0.62 + stRng() * 0.28;
    for (let v = 0; v < gPos.count; v++) {
      gCols[v * 3] = shade * 0.98;
      gCols[v * 3 + 1] = shade * 0.99;
      gCols[v * 3 + 2] = shade * 1.02;
    }
    g.setAttribute('color', new THREE.BufferAttribute(gCols, 3));
    stoneParts.push(g);
  }

  return {
    deadTwig: mergeParts(twigParts, false),
    fallenLeaves: mergeParts(fallenParts, false),
    gravelCluster: mergeParts(stoneParts, false),
    woodyShrubBranches: mergeParts(shrubBranchParts, false),
    woodyShrubLeaves: mergeParts(shrubLeafParts, false),
    leafSprigAlpha: leafTex.alpha,
    leafSprigNormal: leafTex.normal,
  };
}
