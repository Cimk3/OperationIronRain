import * as THREE from 'three';
import { QualityConfig } from '../types';
import { BattlefieldTerrain } from '../world/terrain';

export interface AtmosphereSystem {
  group: THREE.Group;
  skyMesh: THREE.Mesh;
  sunDirection: THREE.Vector3;
  sunLightColor: THREE.Color;
  lightningFlash: number;
  update(dt: number, elapsed: number, playerPos: THREE.Vector3): { thunderDelay?: number; thunderDist?: number };
  generateEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture;
}

export function buildAtmosphereSystem(
  quality: QualityConfig,
  terrain: BattlefieldTerrain
): AtmosphereSystem {
  const group = new THREE.Group();
  group.name = 'AtmosphereSystem';

  // Low-angle warm sun breaking subtly through dark storm clouds (North-West)
  const sunDirection = new THREE.Vector3(-0.36, 0.28, -0.89).normalize();
  const sunLightColor = new THREE.Color(0xe2be8e);

  // 1. PROCEDURAL STORMY SKY DOME WITH DYNAMIC CLOUDS & LIGHTNING
  const skyUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: sunDirection.clone() },
    uLightning: { value: 0 },
  };

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(position);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform float uLightning;
      varying vec3 vWorldDir;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p) {
        float s = 0.0;
        float a = 0.5;
        mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
        for (int i = 0; i < 5; i++) {
          s += a * noise(p);
          p = rot * p * 2.04;
          a *= 0.5;
        }
        return s;
      }

      void main() {
        vec3 dir = normalize(vWorldDir);
        float h = clamp(dir.y, -0.1, 1.0);
        vec3 sunD = normalize(uSunDir);
        float sunDot = max(0.0, dot(dir, sunD));

        // Moody CoD4 overcast storm slate-blue sky
        vec3 horizonCol = vec3(0.085, 0.112, 0.145);
        vec3 zenithCol = vec3(0.025, 0.038, 0.058);
        vec3 sky = mix(horizonCol, zenithCol, pow(max(0.0, h), 0.58));

        // Subtle warm amber break near sun (never nuclear overexposed!)
        sky += vec3(0.38, 0.24, 0.11) * pow(sunDot, 7.0) * 0.55;
        sky += vec3(1.15, 0.85, 0.50) * smoothstep(0.997, 0.9996, sunDot);

        if (dir.y > 0.01) {
          vec2 cloudUV = dir.xz / (dir.y + 0.18);
          float c1 = fbm(cloudUV * 0.55 + vec2(uTime * 0.022, uTime * 0.012));
          float c2 = fbm(cloudUV * 1.35 - vec2(uTime * 0.035, uTime * 0.018));
          float cloudDensity = smoothstep(0.28, 0.84, c1 * 0.7 + c2 * 0.35);

          vec3 cloudDark = vec3(0.035, 0.048, 0.068);
          vec3 cloudCoolRim = vec3(0.14, 0.18, 0.23);
          vec3 cloudWarmRim = vec3(0.42, 0.28, 0.14) * pow(sunDot, 5.0);
          vec3 cloudCol = mix(cloudCoolRim + cloudWarmRim, cloudDark, cloudDensity);

          cloudCol += vec3(0.65, 0.78, 1.0) * uLightning * (0.4 + 0.9 * (1.0 - cloudDensity));

          float horizonFade = smoothstep(0.01, 0.16, dir.y);
          sky = mix(sky, cloudCol, horizonFade * 0.92);
        }

        float mist = pow(1.0 - abs(dir.y), 6.5);
        vec3 mistCol = horizonCol + vec3(0.18, 0.12, 0.06) * pow(sunDot, 5.0);
        sky = mix(sky, mistCol * (1.0 + uLightning * 0.6), mist * 0.78);

        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });

  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(320, 48, 32), skyMat);
  skyMesh.name = 'StormSkyDome';
  group.add(skyMesh);

  // 2. GPU WIND-TILTED RAIN STREAKS (zero CPU loop per drop!)
  const rainCount = quality.rainCount;
  const rainPos = new Float32Array(rainCount * 6); // 2 vertices per streak
  const rainSeed = new Float32Array(rainCount * 2);
  for (let i = 0; i < rainCount; i++) {
    const rx = (Math.random() - 0.5) * 44;
    const ry = Math.random() * 24;
    const rz = (Math.random() - 0.5) * 44;
    const len = 0.65 + Math.random() * 0.55;
    const seed = Math.random() * 100;

    // Top vertex & bottom vertex of streak (tilted by wind!)
    rainPos[i * 6] = rx;
    rainPos[i * 6 + 1] = ry;
    rainPos[i * 6 + 2] = rz;
    rainPos[i * 6 + 3] = rx - 0.16;
    rainPos[i * 6 + 4] = ry - len;
    rainPos[i * 6 + 5] = rz - 0.10;

    rainSeed[i * 2] = seed;
    rainSeed[i * 2 + 1] = seed;
  }

  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(rainSeed, 1));

  const rainUniforms = {
    uTime: { value: 0 },
    uPlayerPos: { value: new THREE.Vector3() },
    uLightning: { value: 0 },
  };

  const rainMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: rainUniforms,
    vertexShader: `
      attribute float aSeed;
      uniform float uTime;
      uniform vec3 uPlayerPos;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        // Wrap drops seamlessly inside 44x24x44 volume around camera!
        float fallSpeed = 24.0 + fract(aSeed * 0.37) * 6.0;
        p.y = mod(p.y - uTime * fallSpeed + aSeed * 13.0, 24.0) - 4.0 + uPlayerPos.y;
        p.x = mod(p.x - uTime * 3.8 - uPlayerPos.x + 22.0, 44.0) - 22.0 + uPlayerPos.x;
        p.z = mod(p.z - uTime * 2.4 - uPlayerPos.z + 22.0, 44.0) - 22.0 + uPlayerPos.z;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = length(mv.xyz);
        // Hide rain drops right inside camera near plane or far away
        vAlpha = smoothstep(0.9, 2.5, dist) * (1.0 - smoothstep(14.0, 26.0, dist)) * 0.26;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uLightning;
      varying float vAlpha;
      void main() {
        vec3 col = vec3(0.62, 0.70, 0.78) * (1.0 + uLightning * 1.4);
        gl_FragColor = vec4(col, vAlpha);
      }
    `,
  });

  const rainLines = new THREE.LineSegments(rainGeo, rainMat);
  rainLines.frustumCulled = false;
  group.add(rainLines);

  // 3. GROUND RAIN SPLASH DROPLETS AROUND PLAYER
  const splashCount = Math.min(360, Math.floor(rainCount * 0.08));
  const splashPos = new Float32Array(splashCount * 3);
  const splashPhase = new Float32Array(splashCount);
  for (let i = 0; i < splashCount; i++) {
    splashPhase[i] = Math.random();
    splashPos[i * 3] = (Math.random() - 0.5) * 32;
    splashPos[i * 3 + 2] = (Math.random() - 0.5) * 32;
  }
  const splashGeo = new THREE.BufferGeometry();
  splashGeo.setAttribute('position', new THREE.BufferAttribute(splashPos, 3));
  const spCanvas = document.createElement('canvas');
  spCanvas.width = 32;
  spCanvas.height = 32;
  const sctx = spCanvas.getContext('2d')!;
  const sg = sctx.createRadialGradient(16, 16, 1, 16, 16, 15);
  sg.addColorStop(0, 'rgba(200,220,235,0.9)');
  sg.addColorStop(1, 'rgba(200,220,235,0.0)');
  sctx.fillStyle = sg;
  sctx.fillRect(0, 0, 32, 32);
  const splashTex = new THREE.CanvasTexture(spCanvas);

  const splashMat = new THREE.PointsMaterial({
    map: splashTex,
    color: 0x9bb2c4,
    size: 0.06,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  const splashes = new THREE.Points(splashGeo, splashMat);
  splashes.frustumCulled = false;
  group.add(splashes);

  let nextLightningTimer = 4.5;
  let lightningFlash = 0;

  return {
    group,
    skyMesh,
    sunDirection,
    sunLightColor,
    get lightningFlash() {
      return lightningFlash;
    },
    update(dt: number, elapsed: number, playerPos: THREE.Vector3) {
      skyUniforms.uTime.value = elapsed;
      rainUniforms.uTime.value = elapsed;
      rainUniforms.uPlayerPos.value.copy(playerPos);
      skyMesh.position.copy(playerPos);

      // Update splash particles on actual terrain height around player
      const sAttr = splashGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < splashCount; i++) {
        splashPhase[i] += dt * 3.8;
        if (splashPhase[i] >= 1.0) {
          splashPhase[i] -= 1.0;
          const sx = playerPos.x + (Math.random() - 0.5) * 30;
          const sz = playerPos.z + (Math.random() - 0.5) * 30;
          const sy = terrain.getHeightAt(sx, sz) + 0.05;
          sAttr.setXYZ(i, sx, sy, sz);
        } else {
          // Tiny upward hop
          sAttr.setY(i, sAttr.getY(i) + dt * (0.45 - splashPhase[i] * 0.9));
        }
      }
      sAttr.needsUpdate = true;

      // Lightning & Thunder scheduler
      let thunderResult: { thunderDelay?: number; thunderDist?: number } = {};
      nextLightningTimer -= dt;
      if (nextLightningTimer <= 0) {
        lightningFlash = 1.6 + Math.random() * 0.9;
        nextLightningTimer = 9 + Math.random() * 14;
        const dist = 350 + Math.random() * 900;
        thunderResult = {
          thunderDelay: dist / 343,
          thunderDist: dist,
        };
      }
      lightningFlash = Math.max(0, lightningFlash - dt * 5.2);
      // Double flicker realism
      const flicker =
        lightningFlash > 0.3 ? lightningFlash * (0.65 + 0.35 * Math.sin(elapsed * 58)) : lightningFlash;
      skyUniforms.uLightning.value = flicker;
      rainUniforms.uLightning.value = flicker;

      return thunderResult;
    },
    generateEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileCubemapShader();
      const envScene = new THREE.Scene();
      const envDome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 24), skyMat);
      envScene.add(envDome);
      const rt = pmrem.fromScene(envScene, 0.02);
      envDome.geometry.dispose();
      pmrem.dispose();
      return rt.texture;
    },
  };
}
