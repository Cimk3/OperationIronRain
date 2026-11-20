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

  // Overcast storm-diffused daylight breaking faintly through heavy clouds (CoD4 realistic cool-grey tone!)
  const sunDirection = new THREE.Vector3(-0.34, 0.56, -0.75).normalize();
  const sunLightColor = new THREE.Color(0xcbd6df);

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

        // Authentic CoD4 overcast rainstorm sky (cool slate grey clouds, zero nuclear amber sunset!)
        vec3 horizonCol = vec3(0.22, 0.255, 0.295);
        vec3 zenithCol = vec3(0.085, 0.108, 0.138);
        vec3 sky = mix(horizonCol, zenithCol, pow(max(0.0, h), 0.62));

        // Subtle cool-silver cloud break near diffused sun direction
        sky += vec3(0.14, 0.155, 0.175) * pow(sunDot, 4.5) * 0.55;

        if (dir.y > 0.01) {
          vec2 cloudUV = dir.xz / (dir.y + 0.22);
          float c1 = fbm(cloudUV * 0.58 + vec2(uTime * 0.018, uTime * 0.010));
          float c2 = fbm(cloudUV * 1.45 - vec2(uTime * 0.028, uTime * 0.014));
          float cloudDensity = smoothstep(0.26, 0.84, c1 * 0.68 + c2 * 0.36);

          vec3 cloudDark = vec3(0.085, 0.104, 0.128);
          vec3 cloudLight = vec3(0.27, 0.305, 0.345) + vec3(0.08, 0.085, 0.09) * pow(sunDot, 4.0);
          vec3 cloudCol = mix(cloudLight, cloudDark, cloudDensity);

          cloudCol += vec3(0.55, 0.68, 0.88) * uLightning * (0.35 + 0.75 * (1.0 - cloudDensity));

          float horizonFade = smoothstep(0.01, 0.18, dir.y);
          sky = mix(sky, cloudCol, horizonFade * 0.90);
        }

        float mist = pow(1.0 - abs(dir.y), 5.5);
        vec3 mistCol = horizonCol * 0.96;
        sky = mix(sky, mistCol * (1.0 + uLightning * 0.45), mist * 0.72);

        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });

  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(320, 48, 32), skyMat);
  skyMesh.name = 'StormSkyDome';
  group.add(skyMesh);

  // 2. FINE REALISTIC RAIN DROPLETS (Short, subtle alpha-blended droplets — zero thick white needle lines!)
  const rainCount = quality.rainCount;
  const rainPos = new Float32Array(rainCount * 6);
  const rainSeed = new Float32Array(rainCount * 2);
  for (let i = 0; i < rainCount; i++) {
    const rx = (Math.random() - 0.5) * 34;
    const ry = Math.random() * 18;
    const rz = (Math.random() - 0.5) * 34;
    // Fine short raindrop streak (0.16..0.28m)
    const len = 0.16 + Math.random() * 0.12;
    const seed = Math.random() * 100;

    rainPos[i * 6] = rx;
    rainPos[i * 6 + 1] = ry;
    rainPos[i * 6 + 2] = rz;
    rainPos[i * 6 + 3] = rx - 0.032;
    rainPos[i * 6 + 4] = ry - len;
    rainPos[i * 6 + 5] = rz - 0.018;

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
    blending: THREE.NormalBlending,
    uniforms: rainUniforms,
    vertexShader: `
      attribute float aSeed;
      uniform float uTime;
      uniform vec3 uPlayerPos;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float fallSpeed = 16.5 + fract(aSeed * 0.37) * 4.5;
        p.y = mod(p.y - uTime * fallSpeed + aSeed * 13.0, 18.0) - 2.5 + uPlayerPos.y;
        p.x = mod(p.x - uTime * 2.1 - uPlayerPos.x + 17.0, 34.0) - 17.0 + uPlayerPos.x;
        p.z = mod(p.z - uTime * 1.2 - uPlayerPos.z + 17.0, 34.0) - 17.0 + uPlayerPos.z;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = length(mv.xyz);
        // Subtle natural opacity fading smoothly near camera and past 17m
        vAlpha = smoothstep(1.4, 3.2, dist) * (1.0 - smoothstep(10.0, 18.5, dist)) * (0.10 + fract(aSeed * 0.73) * 0.09);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uLightning;
      varying float vAlpha;
      void main() {
        vec3 col = vec3(0.68, 0.74, 0.80) * (1.0 + uLightning * 0.55);
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
    color: 0xa2b4c2,
    size: 0.032,
    transparent: true,
    opacity: 0.22,
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
