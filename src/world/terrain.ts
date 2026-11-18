import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { TextureLibrary } from '../proc/textures';
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
  private readonly half: number;
  private readonly step: number;
  private readonly lods: THREE.LOD[] = [];
  public timeUniform = { value: 0 };

  constructor(data: TerrainWorkerOutput, textures: TextureLibrary, csm?: CSM) {
    this.gridSize = data.gridSize;
    this.worldSize = data.worldSize;
    this.heights = data.heights;
    this.waterDepth = data.waterDepth;
    this.wetness = data.wetness;
    this.splat = data.splat;
    this.half = data.worldSize * 0.5;
    this.step = data.worldSize / (data.gridSize - 1);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.04,
      envMapIntensity: 0.9,
    });

    if (csm) {
      csm.setupMaterial(this.material);
    }
    const prevCompile = this.material.onBeforeCompile;

    this.material.onBeforeCompile = (shader, renderer) => {
      if (prevCompile) {
        prevCompile.call(this.material, shader, renderer);
      }

      shader.uniforms.uTime = this.timeUniform;
      shader.uniforms.tGrass = { value: textures.terrainGrass.map };
      shader.uniforms.tGrassN = { value: textures.terrainGrass.normalMap };
      shader.uniforms.tMud = { value: textures.terrainMud.map };
      shader.uniforms.tMudN = { value: textures.terrainMud.normalMap };
      shader.uniforms.tGravel = { value: textures.terrainGravel.map };
      shader.uniforms.tGravelN = { value: textures.terrainGravel.normalMap };
      shader.uniforms.tRock = { value: textures.terrainRock.map };
      shader.uniforms.tRockN = { value: textures.terrainRock.normalMap };

      shader.vertexShader =
        `
        attribute vec4 aSplat;
        attribute vec2 aWet;
        varying vec4 vSplat;
        varying vec2 vWet;
        varying vec3 vWorldPosT;
        varying vec3 vWorldNormT;
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
        `
      );

      shader.fragmentShader =
        `
        uniform float uTime;
        uniform sampler2D tGrass;
        uniform sampler2D tGrassN;
        uniform sampler2D tMud;
        uniform sampler2D tMudN;
        uniform sampler2D tGravel;
        uniform sampler2D tGravelN;
        uniform sampler2D tRock;
        uniform sampler2D tRockN;
        varying vec4 vSplat;
        varying vec2 vWet;
        varying vec3 vWorldPosT;
        varying vec3 vWorldNormT;

        vec2 rot2(vec2 p, float a) {
          float s = sin(a), c = cos(a);
          return mat2(c, -s, s, c) * p;
        }

        // Anti-tiling dual-scale triplanar sample
        vec4 sampleTriplanar(sampler2D tex, vec3 wp, vec3 wNorm, float scale) {
          vec3 blend = pow(abs(wNorm), vec3(4.0));
          blend /= max(0.0001, blend.x + blend.y + blend.z);
          vec2 uvX = wp.zy * scale;
          vec2 uvY = wp.xz * scale;
          vec2 uvZ = wp.xy * scale;
          vec4 c1 = texture2D(tex, uvX) * blend.x + texture2D(tex, uvY) * blend.y + texture2D(tex, uvZ) * blend.z;
          vec4 c2 = texture2D(tex, rot2(uvY, 0.72) * 0.31 + 0.17);
          return mix(c1, c2, 0.28);
        }

        // Independent water surface micro-wave + raindrop concentric ripples
        vec2 computeRainRipples(vec2 uv, float time) {
          vec2 accum = vec2(
            sin(uv.x * 5.2 + time * 2.1) * cos(uv.y * 4.4 - time * 1.6),
            cos(uv.x * 4.8 - time * 1.8) * sin(uv.y * 5.6 + time * 2.3)
          ) * 0.08;
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            vec2 p = uv * (1.8 + fi * 0.85) + vec2(fi * 17.3, fi * 31.7);
            vec2 cell = floor(p);
            vec2 f = fract(p) - 0.5;
            float h1 = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
            float h2 = fract(sin(dot(cell, vec2(269.5, 183.3))) * 43758.5453);
            vec2 center = (vec2(h1, h2) - 0.5) * 0.52;
            vec2 d = f - center;
            float dist = length(d);
            float phase = fract(time * 1.45 + h1 * 4.0 + fi * 0.37);
            float radius = phase * 0.48;
            float ring = exp(-pow((dist - radius) * 26.0, 2.0)) * (1.0 - phase);
            float wave = sin((dist - radius) * 65.0) * ring;
            accum += (d / max(0.001, dist)) * wave * 0.45;
          }
          return accum;
        }
        ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `
        vec3 wN = normalize(vWorldNormT);
        vec4 cGrass = sampleTriplanar(tGrass, vWorldPosT, wN, 0.42);
        vec4 cGrassMicro = sampleTriplanar(tGrass, vWorldPosT, wN, 1.55);
        cGrass.rgb = mix(cGrass.rgb, cGrassMicro.rgb * 1.15, 0.36);

        vec4 cMud = sampleTriplanar(tMud, vWorldPosT, wN, 0.38);
        vec4 cGravel = sampleTriplanar(tGravel, vWorldPosT, wN, 0.48);
        vec4 cRock = sampleTriplanar(tRock, vWorldPosT, wN, 0.24);

        vec4 sw = vSplat / max(0.0001, vSplat.r + vSplat.g + vSplat.b + vSplat.a);
        vec3 terrainCol = cGrass.rgb * sw.r + cMud.rgb * sw.g + cGravel.rgb * sw.b + cRock.rgb * sw.a;

        // Subtle macro soil/moss patch modulation prevents uniform green plastic hills
        float macroBreak = 0.86 + 0.28 * fract(sin(dot(floor(vWorldPosT.xz * 0.25), vec2(12.9898, 78.233))) * 43758.5453);
        float microGrit = mix(0.88, 1.12, cMud.r);
        terrainCol *= mix(microGrit, macroBreak * microGrit, sw.r * 0.45);

        // Smooth shoreline dark wet mud gradient -> standing water depth tint
        float shoreWet = smoothstep(0.0, 0.035, vWet.x);
        float puddleMask = smoothstep(0.025, 0.085, vWet.x);
        float wetMask = clamp(vWet.y + shoreWet * 0.55, 0.0, 1.0);
        terrainCol *= mix(0.94, 0.42, wetMask * 0.78);
        terrainCol = mix(terrainCol, terrainCol * 0.38 + vec3(0.03, 0.048, 0.058), puddleMask * 0.84);

        diffuseColor.rgb *= terrainCol;
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `
        #include <roughnessmap_fragment>
        float shoreR = smoothstep(0.0, 0.035, vWet.x);
        float pMask = smoothstep(0.025, 0.068, vWet.x);
        float wMask = clamp(vWet.y + shoreR * 0.4, 0.0, 1.0);
        // Strict Dry/Wet separation: rough earth/mud/grass (0.76..0.90) vs mirror puddles (0.03)!
        roughnessFactor = mix(0.90, 0.75, wMask * 0.85);
        roughnessFactor = mix(roughnessFactor, 0.03, pMask);
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `
        vec3 wnN = normalize(vWorldNormT);
        vec3 nGrass = sampleTriplanar(tGrassN, vWorldPosT, wnN, 0.42).xyz * 2.0 - 1.0;
        vec3 nGrassDetail = sampleTriplanar(tGrassN, vWorldPosT, wnN, 1.55).xyz * 2.0 - 1.0;
        nGrass = normalize(nGrass + nGrassDetail * 0.65);
        vec3 nMud = sampleTriplanar(tMudN, vWorldPosT, wnN, 0.38).xyz * 2.0 - 1.0;
        vec3 nGravel = sampleTriplanar(tGravelN, vWorldPosT, wnN, 0.48).xyz * 2.0 - 1.0;
        vec3 nRock = sampleTriplanar(tRockN, vWorldPosT, wnN, 0.24).xyz * 2.0 - 1.0;

        vec4 swN = vSplat / max(0.0001, vSplat.r + vSplat.g + vSplat.b + vSplat.a);
        vec3 detailN = normalize(nGrass * swN.r + nMud * swN.g + nGravel * swN.b + nRock * swN.a);

        float pMaskN = smoothstep(0.02, 0.08, vWet.x);
        vec2 ripple = pMaskN > 0.02 ? computeRainRipples(vWorldPosT.xz, uTime) : vec2(0.0);

        vec3 flatWaterWorldN = normalize(vec3(ripple.x * 0.55, 1.0, ripple.y * 0.55));
        vec3 perturbedWorldN = normalize(wnN + vec3(detailN.x, 0.0, detailN.y) * 0.82);
        vec3 finalWorldN = normalize(mix(perturbedWorldN, flatWaterWorldN, pMaskN * 0.94));
        normal = normalize((viewMatrix * vec4(finalWorldN, 0.0)).xyz);
        `
      );
    };

    this.material.customProgramCacheKey = () => 'battlefield-triplanar-puddle-lod';

    this.mesh = new THREE.Group();
    this.mesh.name = 'BattlefieldTerrainLOD';

    // Build 8x8 Chunked LOD Grid over the 513x513 heightfield (0.488m core resolution!)
    const chunks = 8;
    const chunkQuads = (this.gridSize - 1) / chunks; // 64 quads per chunk at LOD0
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
        lod.addLevel(mesh1, 95);

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
    // Extra skirt vertices around all 4 edges to guarantee zero cracks between LOD0 and LOD1
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

      // Exact central-difference terrain normal from full heightfield
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

    // Add downward 0.65m edge skirts so LOD transitions never show sky cracks
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
