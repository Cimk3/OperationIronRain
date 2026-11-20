import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { EnvironmentPBRAtlas } from './pbrGenerator';

export interface TerrainMaterialBundle {
  material: THREE.MeshStandardMaterial;
  timeUniform: { value: number };
  packVramBytes: number;
}

/**
 * Packs scalar R-channel maps from 4 PBR sets into a single RGBA DataTexture (1 sampler for 4 layers!).
 */
function packFourScalarMaps(
  t0: THREE.DataTexture,
  t1: THREE.DataTexture,
  t2: THREE.DataTexture,
  t3: THREE.DataTexture,
  anisotropy: number
): THREE.DataTexture {
  const size = t0.image.width as number;
  const d0 = t0.image.data as Uint8Array;
  const d1 = t1.image.data as Uint8Array;
  const d2 = t2.image.data as Uint8Array;
  const d3 = t3.image.data as Uint8Array;
  const out = new Uint8Array(size * size * 4);
  const pxCount = size * size;
  for (let i = 0; i < pxCount; i++) {
    const o = i * 4;
    out[o] = d0[o];
    out[o + 1] = d1[o];
    out[o + 2] = d2[o];
    out[o + 3] = d3[o];
  }
  const tex = new THREE.DataTexture(out, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates the physically-based multi-layer Terrain ShaderMaterial:
 * - World-space Triplanar + Stochastic Hex-Tile randomized sampling (zero visible tiling grid!)
 * - Height-Based Material Blending (gravel stones protrude naturally through mud, humus fills crevices)
 * - Distance Detail Texture blending (crisp micro-grit up close, clean anti-aliased mid/far)
 * - Height-modulated natural puddle shorelines with capillary wet-soil rim & fine rain micro-ripples
 */
export function createTerrainMaterial(
  atlas: EnvironmentPBRAtlas,
  renderer: THREE.WebGLRenderer,
  csm?: CSM
): TerrainMaterialBundle {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const timeUniform = { value: 0 };

  const tHeights = packFourScalarMaps(
    atlas.groundForest.heightMap,
    atlas.groundMud.heightMap,
    atlas.groundGravel.heightMap,
    atlas.groundRock.heightMap,
    aniso
  );
  const tRoughs = packFourScalarMaps(
    atlas.groundForest.roughnessMap,
    atlas.groundMud.roughnessMap,
    atlas.groundGravel.roughnessMap,
    atlas.groundRock.roughnessMap,
    aniso
  );

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.02,
    envMapIntensity: 0.82,
  });

  if (csm) {
    csm.setupMaterial(material);
  }
  const prevCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader, glRenderer) => {
    if (prevCompile) prevCompile.call(material, shader, glRenderer);

    shader.uniforms.uTime = timeUniform;
    shader.uniforms.tForest = { value: atlas.groundForest.map };
    shader.uniforms.tForestN = { value: atlas.groundForest.normalMap };
    shader.uniforms.tMud = { value: atlas.groundMud.map };
    shader.uniforms.tMudN = { value: atlas.groundMud.normalMap };
    shader.uniforms.tGravel = { value: atlas.groundGravel.map };
    shader.uniforms.tGravelN = { value: atlas.groundGravel.normalMap };
    shader.uniforms.tRock = { value: atlas.groundRock.map };
    shader.uniforms.tRockN = { value: atlas.groundRock.normalMap };
    shader.uniforms.tHeights = { value: tHeights };
    shader.uniforms.tRoughs = { value: tRoughs };
    shader.uniforms.tMicroN = { value: atlas.microDetailNormal };

    shader.vertexShader =
      `
      attribute vec4 aSplat;
      attribute vec2 aWet;
      varying vec4 vSplat;
      varying vec2 vWet;
      varying vec3 vWorldPosT;
      varying vec3 vWorldNormT;
      varying float vCamDistT;
      ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `
      #include <worldpos_vertex>
      vSplat = aSplat;
      vWet = aWet;
      vec4 wpT = modelMatrix * vec4(transformed, 1.0);
      vWorldPosT = wpT.xyz;
      vWorldNormT = normalize(mat3(modelMatrix) * objectNormal);
      vCamDistT = length((viewMatrix * wpT).xyz);
      `
    );

    shader.fragmentShader =
      `
      uniform float uTime;
      uniform sampler2D tForest;
      uniform sampler2D tForestN;
      uniform sampler2D tMud;
      uniform sampler2D tMudN;
      uniform sampler2D tGravel;
      uniform sampler2D tGravelN;
      uniform sampler2D tRock;
      uniform sampler2D tRockN;
      uniform sampler2D tHeights;
      uniform sampler2D tRoughs;
      uniform sampler2D tMicroN;

      varying vec4 vSplat;
      varying vec2 vWet;
      varying vec3 vWorldPosT;
      varying vec3 vWorldNormT;
      varying float vCamDistT;

      vec2 hash22T(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }

      // Smooth value noise for seamless macro organic variation (zero blocky grid artifacts!)
      float smoothNoise2D(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
        float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
        float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
        float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      // Stochastic Hex-Tile Texture Sampling: eliminates visible tiling grids at all distances!
      vec4 sampleStochastic(sampler2D tex, vec2 uv) {
        vec2 skew = mat2(1.0, 0.0, -0.57735027, 1.15470054) * (uv * 1.15);
        vec2 vx = floor(skew);
        vec2 fr = fract(skew);
        vec3 bw;
        vec2 i1, i2, i3;
        if (fr.x > fr.y) {
          i1 = vx;
          i2 = vx + vec2(1.0, 0.0);
          i3 = vx + vec2(1.0, 1.0);
          bw = vec3(1.0 - fr.x, fr.x - fr.y, fr.y);
        } else {
          i1 = vx;
          i2 = vx + vec2(1.0, 1.0);
          i3 = vx + vec2(0.0, 1.0);
          bw = vec3(1.0 - fr.y, fr.x, fr.y - fr.x);
        }
        // Sharpen blend weights smoothly to preserve crisp stone/particle shapes
        bw = pow(max(bw, vec3(0.0001)), vec3(3.5));
        bw /= (bw.x + bw.y + bw.z);

        vec2 o1 = hash22T(i1);
        vec2 o2 = hash22T(i2);
        vec2 o3 = hash22T(i3);

        // Preserve hardware mip derivatives cleanly across hex borders
        vec2 ddx = dFdx(uv);
        vec2 ddy = dFdy(uv);
        vec4 s1 = textureGrad(tex, uv + o1, ddx, ddy);
        vec4 s2 = textureGrad(tex, uv + o2, ddx, ddy);
        vec4 s3 = textureGrad(tex, uv + o3, ddx, ddy);
        return s1 * bw.x + s2 * bw.y + s3 * bw.z;
      }

      // World-Space Triplanar sampling for steep cliffs/ditches (falls back to fast stochastic XZ on flats)
      vec4 sampleWorldTerrain(sampler2D tex, vec3 wp, vec3 wN, float scale) {
        vec2 uvY = wp.xz * scale;
        vec4 cY = sampleStochastic(tex, uvY);
        if (wN.y > 0.84) return cY;
        vec3 b = pow(abs(wN), vec3(5.0));
        b /= max(0.0001, b.x + b.y + b.z);
        vec4 cX = texture2D(tex, wp.zy * scale);
        vec4 cZ = texture2D(tex, wp.xy * scale);
        return cX * b.x + cY * b.y + cZ * b.z;
      }

      // Height-Based Material Blending (crisp physical interpenetration instead of muddy linear fades!)
      vec4 computeHeightBlendWeights(vec4 splatW, vec4 layerHeights, float contrast) {
        vec4 h = layerHeights + splatW * 1.15;
        float maxH = max(max(h.r, h.g), max(h.b, h.a));
        vec4 w = max(vec4(0.0), h - (maxH - contrast)) * step(vec4(0.002), splatW);
        float sum = w.r + w.g + w.b + w.a;
        return sum > 0.0001 ? w / sum : splatW;
      }

      // Organic non-grid fine rain micro-ripples on standing water (zero periodic stripe waves!)
      vec2 computeFineWaterRipples(vec2 xz, float t) {
        vec2 acc = vec2(0.0);
        // Ultra-subtle multi-angle organic wind shimmer
        float n1 = smoothNoise2D(xz * 3.8 + vec2(t * 0.65, -t * 0.42)) - 0.5;
        float n2 = smoothNoise2D(xz * 6.4 - vec2(t * 0.48, t * 0.72)) - 0.5;
        acc.x += (n1 * 0.012 + n2 * 0.008);
        acc.y += (n2 * 0.012 - n1 * 0.008);
        for (int i = 0; i < 2; i++) {
          float fi = float(i);
          float sc = 2.8 + fi * 1.45;
          vec2 p = xz * sc + vec2(fi * 13.7, fi * 29.3);
          vec2 cell = floor(p);
          vec2 f = fract(p) - 0.5;
          vec2 rnd = hash22T(cell + fi * 19.0);
          vec2 center = (rnd - 0.5) * 0.48;
          vec2 d = f - center;
          float dist = length(d);
          float phase = fract(t * (1.15 + rnd.x * 0.65) + rnd.y * 7.0);
          float rad = phase * 0.34;
          float env = exp(-pow((dist - rad) * 38.0, 2.0)) * (1.0 - phase) * smoothstep(0.0, 0.14, phase);
          float wv = sin((dist - rad) * 90.0) * env;
          acc += (d / max(0.002, dist)) * wv * 0.14;
        }
        return acc;
      }

      // Shared per-fragment terrain material state passed between map/roughness/normal chunks
      vec4 gTerrBlendW;
      float gTerrBlendedH;
      float gTerrPuddleMask;
      float gTerrShoreWet;
      float gTerrRoughness;
      ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `
      vec3 wN = normalize(vWorldNormT);
      vec4 rawSplat = vSplat / max(0.0001, vSplat.r + vSplat.g + vSplat.b + vSplat.a);

      // Sample 4-layer packed Heights & Roughnesses via world-space stochastic sampling
      vec4 hSample = sampleWorldTerrain(tHeights, vWorldPosT, wN, 0.32);
      vec4 rSample = sampleWorldTerrain(tRoughs, vWorldPosT, wN, 0.32);

      // Height-Based Blending: stones & roots stand proud above mud/humus!
      gTerrBlendW = computeHeightBlendWeights(rawSplat, hSample, 0.24);
      gTerrBlendedH = dot(hSample, gTerrBlendW);
      gTerrRoughness = dot(rSample, gTerrBlendW);

      vec3 cForest = sampleWorldTerrain(tForest, vWorldPosT, wN, 0.32).rgb;
      vec3 cMud    = sampleWorldTerrain(tMud,    vWorldPosT, wN, 0.32).rgb;
      vec3 cGravel = sampleWorldTerrain(tGravel, vWorldPosT, wN, 0.38).rgb;
      vec3 cRock   = sampleWorldTerrain(tRock,   vWorldPosT, wN, 0.22).rgb;

      vec3 terrainCol = cForest * gTerrBlendW.r + cMud * gTerrBlendW.g + cGravel * gTerrBlendW.b + cRock * gTerrBlendW.a;

      // Smooth large-scale organic moisture & foliage shadow variation (100% grid-free!)
      float macroVar = smoothNoise2D(vWorldPosT.xz * 0.055) * 0.65 + smoothNoise2D(vWorldPosT.xz * 0.16) * 0.35;
      terrainCol *= mix(0.84, 1.14, macroVar);

      // Distance Detail Micro-Modulation (subtle gravel/dirt grit up close 0..16m, fades cleanly with distance)
      float closeMask = 1.0 - smoothstep(4.0, 18.0, vCamDistT);
      vec3 microN = texture2D(tMicroN, vWorldPosT.xz * 2.4).xyz;
      terrainCol *= mix(1.0, 0.92 + microN.z * 0.14, closeMask * 0.60);

      // Local height-based crevice ambient occlusion
      float microAO = mix(0.80, 1.05, clamp(gTerrBlendedH * 1.12, 0.0, 1.0));
      terrainCol *= microAO;

      // Height-Modulated Natural Puddle Shoreline & Capillary Wet Soil Rim!
      // Restrict standing puddles & capillary glossy rims strictly to flat ground (never glossy hillsides!).
      float flatSlope = smoothstep(0.915, 0.980, wN.y);
      float waterEff = vWet.x * flatSlope - gTerrBlendedH * 0.036;
      gTerrPuddleMask = smoothstep(0.012, 0.044, waterEff) * flatSlope;
      gTerrShoreWet = smoothstep(-0.036, 0.014, waterEff) * flatSlope;

      // Rain-damp earth darkens organically without turning grassy hills into shiny wet plastic
      float rainDamp = clamp(vWet.y * 0.42 + gTerrShoreWet * 0.85, 0.0, 1.0);
      terrainCol *= mix(1.0, 0.62, rainDamp * (1.0 - gTerrPuddleMask * 0.35));
      vec3 puddleTint = terrainCol * 0.42 + vec3(0.018, 0.024, 0.030);
      terrainCol = mix(terrainCol, puddleTint, gTerrPuddleMask * 0.80);

      diffuseColor.rgb *= terrainCol;
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `
      #include <roughnessmap_fragment>
      // Keep rain-damp grass, humus & gravel matte (0.78..0.94); only puddle shorelines & pools go glossy!
      float baseRough = clamp(gTerrRoughness, 0.78, 0.95);
      float shoreRough = mix(baseRough, max(0.38, baseRough * 0.52), gTerrShoreWet);
      roughnessFactor = mix(shoreRough, 0.05, gTerrPuddleMask);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `
      vec3 wnN = normalize(vWorldNormT);
      vec3 nForest = sampleWorldTerrain(tForestN, vWorldPosT, wnN, 0.32).xyz * 2.0 - 1.0;
      vec3 nMud    = sampleWorldTerrain(tMudN,    vWorldPosT, wnN, 0.32).xyz * 2.0 - 1.0;
      vec3 nGravel = sampleWorldTerrain(tGravelN, vWorldPosT, wnN, 0.38).xyz * 2.0 - 1.0;
      vec3 nRock   = sampleWorldTerrain(tRockN,   vWorldPosT, wnN, 0.22).xyz * 2.0 - 1.0;

      vec3 detailN = normalize(
        nForest * gTerrBlendW.r +
        nMud    * gTerrBlendW.g +
        nGravel * gTerrBlendW.b +
        nRock   * gTerrBlendW.a
      );

      // Blend subtle close-up detail normal (0..16m) without creating noisy cobble glare
      float closeN = 1.0 - smoothstep(3.5, 16.0, vCamDistT);
      vec3 microTan = texture2D(tMicroN, vWorldPosT.xz * 2.4).xyz * 2.0 - 1.0;
      detailN = normalize(detailN + vec3(microTan.xy * 0.24 * closeN, 0.0));

      vec2 ripple = gTerrPuddleMask > 0.03 ? computeFineWaterRipples(vWorldPosT.xz, uTime) : vec2(0.0);
      vec3 flatWaterWorldN = normalize(vec3(ripple.x, 1.0, ripple.y));
      vec3 perturbedWorldN = normalize(wnN + vec3(detailN.x, 0.0, detailN.y) * 0.56);
      vec3 finalWorldN = normalize(mix(perturbedWorldN, flatWaterWorldN, gTerrPuddleMask * 0.96));
      normal = normalize((viewMatrix * vec4(finalWorldN, 0.0)).xyz);
      `
    );
  };

  material.customProgramCacheKey = () => 'env-pbr-stochastic-heightblend-v2';

  const packSize = atlas.groundForest.size;
  const packVramBytes = Math.round(packSize * packSize * 4 * 1.3333 * 2);

  return { material, timeUniform, packVramBytes };
}
