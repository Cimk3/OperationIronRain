import * as THREE from 'three';
import { QualityConfig } from '../types';
import { BattlefieldTerrain } from '../world/terrain';

const FULLSCREEN_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class PostProcessPipeline {
  private renderer: THREE.WebGLRenderer;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quadMesh: THREE.Mesh;

  public hdrRT: THREE.WebGLRenderTarget;
  private aoRT: THREE.WebGLRenderTarget;
  private aoBlurRT: THREE.WebGLRenderTarget;
  private godRayRT: THREE.WebGLRenderTarget;
  private ssrCompositeRT: THREE.WebGLRenderTarget;
  private bloomBrightRT: THREE.WebGLRenderTarget;
  private bloomMip1RT: THREE.WebGLRenderTarget;
  private bloomMip2RT: THREE.WebGLRenderTarget;
  private bloomUp1RT: THREE.WebGLRenderTarget;

  private terrainWetTex: THREE.DataTexture;
  private worldSize: number;

  private gtaoMat: THREE.ShaderMaterial;
  private aoBlurMat: THREE.ShaderMaterial;
  private godRayMat: THREE.ShaderMaterial;
  private ssrFogMat: THREE.ShaderMaterial;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private finalMat: THREE.ShaderMaterial;

  private width = 1280;
  private height = 720;
  private quality: QualityConfig;
  private exposure = 1.08;
  private indoorMode = false;
  public lastSceneDrawCalls = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    terrain: BattlefieldTerrain,
    quality: QualityConfig,
    sunDir: THREE.Vector3
  ) {
    this.renderer = renderer;
    this.quality = quality;
    this.worldSize = terrain.worldSize;

    // Pack terrain waterDepth, wetness, and height into HalfFloat DataTexture (linearly filterable in WebGL2!)
    const g = terrain.gridSize;
    const halfData = new Uint16Array(g * g * 4);
    for (let i = 0; i < g * g; i++) {
      halfData[i * 4] = THREE.DataUtils.toHalfFloat(terrain.waterDepth[i]);
      halfData[i * 4 + 1] = THREE.DataUtils.toHalfFloat(terrain.wetness[i]);
      halfData[i * 4 + 2] = THREE.DataUtils.toHalfFloat(terrain.heights[i]);
      halfData[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1.0);
    }
    this.terrainWetTex = new THREE.DataTexture(
      halfData,
      g,
      g,
      THREE.RGBAFormat,
      THREE.HalfFloatType
    );
    this.terrainWetTex.magFilter = THREE.LinearFilter;
    this.terrainWetTex.minFilter = THREE.LinearFilter;
    this.terrainWetTex.wrapS = THREE.ClampToEdgeWrapping;
    this.terrainWetTex.wrapT = THREE.ClampToEdgeWrapping;
    this.terrainWetTex.needsUpdate = true;

    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };

    this.hdrRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      ...rtOpts,
      depthBuffer: true,
    });
    this.hdrRT.depthTexture = new THREE.DepthTexture(this.width, this.height, THREE.UnsignedIntType);
    this.hdrRT.depthTexture.format = THREE.DepthFormat;

    this.aoRT = new THREE.WebGLRenderTarget(this.width >> 1, this.height >> 1, rtOpts);
    this.aoBlurRT = new THREE.WebGLRenderTarget(this.width >> 1, this.height >> 1, rtOpts);
    this.godRayRT = new THREE.WebGLRenderTarget(this.width >> 1, this.height >> 1, rtOpts);
    this.ssrCompositeRT = new THREE.WebGLRenderTarget(this.width, this.height, rtOpts);
    this.bloomBrightRT = new THREE.WebGLRenderTarget(this.width >> 1, this.height >> 1, rtOpts);
    this.bloomMip1RT = new THREE.WebGLRenderTarget(this.width >> 2, this.height >> 2, rtOpts);
    this.bloomMip2RT = new THREE.WebGLRenderTarget(this.width >> 3, this.height >> 3, rtOpts);
    this.bloomUp1RT = new THREE.WebGLRenderTarget(this.width >> 2, this.height >> 2, rtOpts);

    // 1. GTAO Horizon-Based AO Shader
    this.gtaoMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: this.hdrRT.depthTexture },
        uInvProj: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Matrix4() },
        uResolution: { value: new THREE.Vector2(this.width >> 1, this.height >> 1) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tDepth;
        uniform mat4 uInvProj;
        uniform mat4 uProj;
        uniform vec2 uResolution;
        varying vec2 vUv;

        vec3 getViewPos(vec2 uv) {
          float d = texture2D(tDepth, uv).r;
          vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 vp = uInvProj * ndc;
          return vp.xyz / vp.w;
        }

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          float depth = texture2D(tDepth, vUv).r;
          if (depth >= 0.9999) {
            gl_FragColor = vec4(1.0);
            return;
          }
          vec3 P = getViewPos(vUv);
          vec2 texel = 1.0 / uResolution;
          vec3 Px = getViewPos(vUv + vec2(texel.x, 0.0)) - P;
          vec3 Py = getViewPos(vUv + vec2(0.0, texel.y)) - P;
          vec3 N = normalize(cross(Px, Py));
          vec3 V = normalize(-P);

          // Scale world radius nicely for both close gun/hands and mid-range environment
          float dist = -P.z;
          float worldRadius = clamp(dist * 0.14, 0.08, 1.45);
          float screenRadius = clamp((worldRadius / max(0.15, dist)) * 0.55, 0.008, 0.065);

          float rot = hash12(vUv * uResolution) * 6.283185;
          float ao = 0.0;
          const int DIRS = 6;
          const int STEPS = 3;

          for (int d = 0; d < DIRS; d++) {
            float angle = rot + float(d) * (6.283185 / float(DIRS));
            vec2 dir = vec2(cos(angle), sin(angle));
            float maxHorizon = 0.0;
            for (int s = 1; s <= STEPS; s++) {
              float frac = float(s) / float(STEPS);
              vec2 suv = vUv + dir * (screenRadius * frac);
              if (suv.x < 0.001 || suv.x > 0.999 || suv.y < 0.001 || suv.y > 0.999) continue;
              float sd = texture2D(tDepth, suv).r;
              if (sd >= 0.9999) continue;
              vec3 S = getViewPos(suv);
              vec3 D = S - P;
              float len = length(D);
              if (len < 0.001 || len > worldRadius * 2.2) continue;
              float falloff = 1.0 - smoothstep(worldRadius * 0.4, worldRadius * 2.2, len);
              float cosH = max(0.0, dot(N, D / len) - 0.06);
              maxHorizon = max(maxHorizon, cosH * falloff);
            }
            ao += (1.0 - maxHorizon);
          }
          ao = pow(clamp(ao / float(DIRS), 0.10, 1.0), 1.65);
          gl_FragColor = vec4(ao, ao, ao, 1.0);
        }
      `,
    });

    // 2. Bilateral Edge-Preserving AO Blur
    this.aoBlurMat = new THREE.ShaderMaterial({
      uniforms: {
        tAO: { value: this.aoRT.texture },
        tDepth: { value: this.hdrRT.depthTexture },
        uTexel: { value: new THREE.Vector2(1 / (this.width >> 1), 1 / (this.height >> 1)) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tAO;
        uniform sampler2D tDepth;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          float centerD = texture2D(tDepth, vUv).r;
          float sum = 0.0;
          float wSum = 0.0;
          for (int y = -2; y <= 2; y++) {
            for (int x = -2; x <= 2; x++) {
              vec2 suv = vUv + vec2(float(x), float(y)) * uTexel;
              float sd = texture2D(tDepth, suv).r;
              float ao = texture2D(tAO, suv).r;
              float dw = exp(-abs(sd - centerD) * 4500.0);
              float sw = exp(-float(x * x + y * y) * 0.18);
              float w = dw * sw;
              sum += ao * w;
              wSum += w;
            }
          }
          float res = sum / max(0.0001, wSum);
          gl_FragColor = vec4(res, res, res, 1.0);
        }
      `,
    });

    // 2b. Screen-Space Volumetric Sun Shafts (God Rays)
    this.godRayMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: this.hdrRT.depthTexture },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.7) },
        uSunVisibility: { value: 1.0 },
        uLightning: { value: 0.0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tDepth;
        uniform vec2 uSunScreen;
        uniform float uSunVisibility;
        uniform float uLightning;
        varying vec2 vUv;

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          if (uSunVisibility <= 0.01) {
            gl_FragColor = vec4(0.0);
            return;
          }
          vec2 delta = (vUv - uSunScreen);
          float distSun = length(delta);
          const int SAMPLES = 24;
          vec2 stepUv = delta * (0.94 / float(SAMPLES));
          float jitter = hash12(vUv * 512.0);
          vec2 uv = vUv - stepUv * jitter;

          float illumDecay = 1.0;
          float shafts = 0.0;
          for (int i = 0; i < SAMPLES; i++) {
            uv -= stepUv;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
            float d = texture2D(tDepth, uv).r;
            float sky = smoothstep(0.9990, 0.99995, d);
            shafts += sky * illumDecay * 0.022;
            illumDecay *= 0.92;
          }
          // Strictly localized sunbeam cone around sun break (zero full-screen washout!)
          float radialFalloff = exp(-distSun * 3.1);
          vec3 rayCol = vec3(0.65, 0.46, 0.24) * (1.0 + uLightning * 0.25);
          gl_FragColor = vec4(rayCol * shafts * radialFalloff * uSunVisibility, 1.0);
        }
      `,
    });

    // 3. Combined GTAO Apply + High-Clarity Puddle SSR + Cool/Warm Fog + Volumetric Sun Shafts
    this.ssrFogMat = new THREE.ShaderMaterial({
      uniforms: {
        tHdr: { value: this.hdrRT.texture },
        tDepth: { value: this.hdrRT.depthTexture },
        tAO: { value: this.aoBlurRT.texture },
        tGodRays: { value: this.godRayRT.texture },
        tTerrainWet: { value: this.terrainWetTex },
        uInvProj: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uView: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: sunDir.clone() },
        uWorldSize: { value: this.worldSize },
        uTime: { value: 0 },
        uLightning: { value: 0 },
        uEnableGTAO: { value: 1.0 },
        uEnableSSR: { value: 1.0 },
        uIndoorMode: { value: 0.0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tHdr;
        uniform sampler2D tDepth;
        uniform sampler2D tAO;
        uniform sampler2D tGodRays;
        uniform sampler2D tTerrainWet;
        uniform mat4 uInvProj;
        uniform mat4 uProj;
        uniform mat4 uInvView;
        uniform mat4 uView;
        uniform vec3 uCamPos;
        uniform vec3 uSunDir;
        uniform float uWorldSize;
        uniform float uTime;
        uniform float uLightning;
        uniform float uEnableGTAO;
        uniform float uEnableSSR;
        uniform float uIndoorMode;
        varying vec2 vUv;

        vec3 getViewPos(vec2 uv, float d) {
          vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 vp = uInvProj * ndc;
          return vp.xyz / vp.w;
        }

        // Animated raindrop puddle ripple normal perturbation (subtle so SSR stays crisp!)
        vec2 ssrRipples(vec2 xz, float time) {
          vec2 acc = vec2(
            sin(xz.x * 4.2 + time * 1.9) * cos(xz.y * 3.8 - time * 1.4),
            cos(xz.x * 3.9 - time * 1.5) * sin(xz.y * 4.5 + time * 2.0)
          ) * 0.04;
          for (int i = 0; i < 2; i++) {
            float fi = float(i);
            vec2 p = xz * (1.8 + fi * 0.9) + vec2(fi * 17.3, fi * 31.7);
            vec2 cell = floor(p);
            vec2 f = fract(p) - 0.5;
            float h1 = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
            float h2 = fract(sin(dot(cell, vec2(269.5, 183.3))) * 43758.5453);
            vec2 c = (vec2(h1, h2) - 0.5) * 0.5;
            vec2 d = f - c;
            float dist = length(d);
            float phase = fract(time * 1.45 + h1 * 4.0 + fi * 0.37);
            float r = phase * 0.48;
            float ring = exp(-pow((dist - r) * 24.0, 2.0)) * (1.0 - phase);
            acc += (d / max(0.001, dist)) * sin((dist - r) * 60.0) * ring * 0.14;
          }
          return acc;
        }

        vec3 sampleOvercastSky(vec3 dir, float time, float lightning) {
          float h = clamp(dir.y, 0.0, 1.0);
          vec3 hor = vec3(0.085, 0.112, 0.145);
          vec3 zen = vec3(0.025, 0.038, 0.058);
          vec3 col = mix(hor, zen, pow(h, 0.58));
          float sunDot = max(0.0, dot(dir, normalize(uSunDir)));
          col += vec3(0.32, 0.20, 0.09) * pow(sunDot, 6.0) * 0.45;
          col += vec3(0.95, 0.70, 0.38) * smoothstep(0.996, 0.9995, sunDot);
          col += vec3(0.55, 0.68, 0.95) * lightning * 0.65;
          return col;
        }

        void main() {
          vec4 hdr = texture2D(tHdr, vUv);
          vec3 godRays = texture2D(tGodRays, vUv).rgb;
          float depth = texture2D(tDepth, vUv).r;
          if (depth >= 0.9999) {
            gl_FragColor = vec4(hdr.rgb + godRays * 0.65, 1.0);
            return;
          }

          vec3 col = hdr.rgb;
          if (uEnableGTAO > 0.5) {
            float ao = texture2D(tAO, vUv).r;
            col *= mix(0.32, 1.0, ao);
          }

          vec3 viewPos = getViewPos(vUv, depth);
          vec3 worldPos = (uInvView * vec4(viewPos, 1.0)).xyz;
          float viewDist = length(viewPos);
          vec3 dPdx = dFdx(worldPos);
          vec3 dPdy = dFdy(worldPos);
          vec3 surfWorldN = normalize(cross(dPdx, dPdy));
          if (surfWorldN.y < 0.0) surfWorldN = -surfWorldN;

          // Sample Terrain Wetness / Puddle Mask (Outdoor Heightmap vs Indoor Silo Floor Puddles)
          float waterDepth = 0.0;
          bool isGround = false;
          bool underground = uIndoorMode > 0.5 && uCamPos.y < -0.5;
          if (uIndoorMode > 0.5) {
            float indoorN = sin(worldPos.x * 0.75 + worldPos.z * 0.42) * cos(worldPos.z * 0.65 - worldPos.x * 0.35);
            waterDepth = max(0.0, indoorN - 0.48) * 0.22;
            bool isFloorY =
              (abs(worldPos.y + 8.0) < 0.22 || abs(worldPos.y + 12.0) < 0.22 || abs(worldPos.y) < 0.22) &&
              worldPos.y < uCamPos.y - 0.1;
            isGround = isFloorY;
          } else {
            vec2 wUv = (worldPos.xz / uWorldSize) + 0.5;
            vec3 tInfo = vec3(0.0);
            bool onMap = wUv.x > 0.0 && wUv.x < 1.0 && wUv.y > 0.0 && wUv.y < 1.0;
            if (onMap) {
              tInfo = texture2D(tTerrainWet, wUv).rgb;
            }
            waterDepth = tInfo.r;
            float terrainH = tInfo.b;
            isGround = onMap && abs(worldPos.y - terrainH) < 0.38;
          }

          // High-Clarity Screen-Space Reflection (SSR) strictly on flat mirror puddles
          if (uEnableSSR > 0.5 && isGround && viewDist > 0.95 && viewDist < 90.0) {
            float puddleMask = smoothstep(0.018, 0.062, waterDepth);
            float flatness = smoothstep(0.93, 0.985, surfWorldN.y);
            float reflStrength = puddleMask * flatness * 0.94;

            if (reflStrength > 0.02) {
              vec2 rip = ssrRipples(worldPos.xz, uTime);
              vec3 worldN = normalize(vec3(rip.x * 0.16, 1.0, rip.y * 0.16));
              vec3 viewN = normalize((uView * vec4(worldN, 0.0)).xyz);
              vec3 viewDir = normalize(viewPos);
              vec3 reflView = normalize(reflect(viewDir, viewN));
              vec3 reflWorld = normalize((uInvView * vec4(reflView, 0.0)).xyz);

              // High-precision raymarch (36 steps + 5 binary refinement steps)
              vec3 rayPos = viewPos + viewN * 0.06;
              float stepLen = clamp(viewDist * 0.028, 0.09, 0.68);
              vec3 hitColor = vec3(0.0);
              float hitAlpha = 0.0;

              for (int i = 1; i <= 36; i++) {
                rayPos += reflView * stepLen;
                stepLen *= 1.055;
                vec4 clip = uProj * vec4(rayPos, 1.0);
                if (clip.w <= 0.05) break;
                vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
                if (suv.x < 0.004 || suv.x > 0.996 || suv.y < 0.004 || suv.y > 0.996) break;

                float sd = texture2D(tDepth, suv).r;
                if (sd >= 0.9999) continue;
                vec3 sceneVP = getViewPos(suv, sd);
                float diff = sceneVP.z - rayPos.z;
                if (diff > 0.0 && diff < stepLen * 3.0) {
                  vec3 a = rayPos - reflView * (stepLen / 1.055);
                  vec3 b = rayPos;
                  vec2 bestUV = suv;
                  for (int k = 0; k < 5; k++) {
                    vec3 mid = (a + b) * 0.5;
                    vec4 mc = uProj * vec4(mid, 1.0);
                    vec2 muv = (mc.xy / mc.w) * 0.5 + 0.5;
                    float msd = texture2D(tDepth, clamp(muv, 0.002, 0.998)).r;
                    vec3 msvp = getViewPos(clamp(muv, 0.002, 0.998), msd);
                    if (msvp.z - mid.z > 0.0) {
                      b = mid;
                      bestUV = muv;
                    } else {
                      a = mid;
                    }
                  }
                  vec2 edge = smoothstep(0.0, 0.08, bestUV) * (1.0 - smoothstep(0.92, 1.0, bestUV));
                  hitAlpha = edge.x * edge.y;
                  hitColor = clamp(texture2D(tHdr, bestUV).rgb, vec3(0.0), vec3(2.4));
                  break;
                }
              }

              vec3 skyFallback = underground ? vec3(0.012, 0.016, 0.022) : sampleOvercastSky(reflWorld, uTime, uLightning);
              vec3 reflCol = mix(skyFallback, hitColor, hitAlpha);

              float NdotV = max(0.0, dot(-viewDir, viewN));
              float fresnel = mix(0.28, 0.95, pow(1.0 - NdotV, 4.0));
              float distFade = 1.0 - smoothstep(45.0, 90.0, viewDist);
              col = mix(col, reflCol, reflStrength * fresnel * distFade);
            }
          }

          if (underground) {
            // Moody indoor bunker dust haze (preserves bright colored alarms, cyan terminals & flashlights)
            float indoorFog = 1.0 - exp(-viewDist * 0.0085);
            vec3 indoorFogCol = vec3(0.014, 0.019, 0.026);
            col = mix(col, indoorFogCol, clamp(indoorFog, 0.0, 0.72));
          } else {
            // Cool-Blue Depth Fog + Gentle Warm Sun Backlight Mie Scattering
            float distFog = 1.0 - exp(-viewDist * 0.0062);
            float lowMist = exp(-max(0.0, worldPos.y - 1.2) * 0.16) * (1.0 - exp(-viewDist * 0.010)) * 0.16;
            float fogFactor = clamp(max(distFog, lowMist), 0.0, 0.94);

            vec3 viewWorldDir = normalize(worldPos - uCamPos);
            float sunScatter = pow(max(0.0, dot(viewWorldDir, normalize(uSunDir))), 6.5);
            vec3 fogCol = vec3(0.072, 0.098, 0.128) + vec3(0.18, 0.12, 0.06) * sunScatter;
            fogCol += vec3(0.45, 0.55, 0.78) * uLightning * 0.45;
            col = mix(col, fogCol, fogFactor);

            // Add delicate Volumetric Sun Shafts cleanly over world & mid-fog
            col += godRays * smoothstep(1.2, 8.0, viewDist) * 0.75;
          }

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    // 4. Bloom Bright-Pass (Solar Disc, Golden Water Glints, Muzzle Flash, Outpost Lamps)
    this.brightMat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: this.ssrCompositeRT.texture },
        uThreshold: { value: 1.95 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tSrc;
        uniform float uThreshold;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb;
          float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float soft = max(0.0, lum - uThreshold) / max(0.0001, lum);
          gl_FragColor = vec4(c * soft * 0.85, 1.0);
        }
      `,
    });

    // 5. Kawase / Tent Blur for Bloom Mips
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tSrc;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb * 0.25;
          c += texture2D(tSrc, vUv + vec2(-uTexel.x, -uTexel.y)).rgb * 0.1875;
          c += texture2D(tSrc, vUv + vec2( uTexel.x, -uTexel.y)).rgb * 0.1875;
          c += texture2D(tSrc, vUv + vec2(-uTexel.x,  uTexel.y)).rgb * 0.1875;
          c += texture2D(tSrc, vUv + vec2( uTexel.x,  uTexel.y)).rgb * 0.1875;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });

    // 6. Final ACES Filmic (High Contrast) + Auto Exposure + Bloom Add + Vignette + Film Grain + FXAA
    this.finalMat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: this.ssrCompositeRT.texture },
        tBloom: { value: this.bloomUp1RT.texture },
        uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
        uExposure: { value: 1.15 },
        uBloomStrength: { value: 0.38 },
        uTime: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tSrc;
        uniform sampler2D tBloom;
        uniform vec2 uTexel;
        uniform float uExposure;
        uniform float uBloomStrength;
        uniform float uTime;
        varying vec2 vUv;

        vec3 ACESFilm(vec3 x) {
          float a = 2.51;
          float b = 0.03;
          float c = 2.43;
          float d = 0.59;
          float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        vec3 toneMapSample(vec2 uv) {
          vec3 hdr = texture2D(tSrc, uv).rgb + texture2D(tBloom, uv).rgb * uBloomStrength;
          vec3 mapped = ACESFilm(hdr * uExposure);
          // Gentle cinematic S-curve contrast boost
          mapped = mix(mapped, smoothstep(0.0, 1.0, mapped), 0.16);
          return pow(mapped, vec3(1.0 / 2.2));
        }

        float luma(vec3 c) {
          return dot(c, vec3(0.299, 0.587, 0.114));
        }

        void main() {
          vec3 rgbM = toneMapSample(vUv);
          vec3 rgbNW = toneMapSample(vUv + vec2(-1.0, -1.0) * uTexel);
          vec3 rgbNE = toneMapSample(vUv + vec2( 1.0, -1.0) * uTexel);
          vec3 rgbSW = toneMapSample(vUv + vec2(-1.0,  1.0) * uTexel);
          vec3 rgbSE = toneMapSample(vUv + vec2( 1.0,  1.0) * uTexel);

          float lumaM = luma(rgbM);
          float lumaNW = luma(rgbNW);
          float lumaNE = luma(rgbNE);
          float lumaSW = luma(rgbSW);
          float lumaSE = luma(rgbSE);

          float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
          float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
          float range = lumaMax - lumaMin;

          vec3 finalCol = rgbM;
          if (range >= max(0.0312, lumaMax * 0.125)) {
            vec2 dir;
            dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
            dir.y =  ((lumaNW + lumaSW) - (lumaNE + lumaSE));
            float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
            float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
            dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;

            vec3 rgbA = 0.5 * (
              toneMapSample(vUv + dir * (1.0 / 3.0 - 0.5)) +
              toneMapSample(vUv + dir * (2.0 / 3.0 - 0.5))
            );
            vec3 rgbB = rgbA * 0.5 + 0.25 * (
              toneMapSample(vUv + dir * -0.5) +
              toneMapSample(vUv + dir * 0.5)
            );
            float lumaB = luma(rgbB);
            finalCol = (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;
          }

          // Cinematic lens vignette + subtle film grain
          float vig = 1.0 - dot(vUv - 0.5, vUv - 0.5) * 0.42;
          float grain = (fract(sin(dot(vUv * 1280.0 + uTime * 37.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.022;
          gl_FragColor = vec4(clamp(finalCol * vig + grain, 0.0, 1.0), 1.0);
        }
      `,
    });

    this.quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.finalMat);
    this.quadScene.add(this.quadMesh);
  }

  public setQuality(q: QualityConfig): void {
    this.quality = q;
    this.ssrFogMat.uniforms.uEnableGTAO.value = q.enableGTAO ? 1.0 : 0.0;
    this.ssrFogMat.uniforms.uEnableSSR.value = q.enableSSR ? 1.0 : 0.0;
    this.finalMat.uniforms.uBloomStrength.value = q.enableBloom ? 0.34 : 0.0;
  }

  public resize(cssW: number, cssH: number, dpr: number): void {
    // On High quality, resolutionScale is strictly 1.0 (100% native resolution!)
    const scale = this.quality.resolutionScale;
    const w = Math.max(320, Math.floor(cssW * dpr * scale));
    const h = Math.max(240, Math.floor(cssH * dpr * scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    this.hdrRT.setSize(w, h);
    this.aoRT.setSize(Math.max(160, w >> 1), Math.max(120, h >> 1));
    this.aoBlurRT.setSize(Math.max(160, w >> 1), Math.max(120, h >> 1));
    this.godRayRT.setSize(Math.max(160, w >> 1), Math.max(120, h >> 1));
    this.ssrCompositeRT.setSize(w, h);
    this.bloomBrightRT.setSize(Math.max(160, w >> 1), Math.max(120, h >> 1));
    this.bloomMip1RT.setSize(Math.max(80, w >> 2), Math.max(60, h >> 2));
    this.bloomMip2RT.setSize(Math.max(40, w >> 3), Math.max(30, h >> 3));
    this.bloomUp1RT.setSize(Math.max(80, w >> 2), Math.max(60, h >> 2));

    this.gtaoMat.uniforms.uResolution.value.set(this.aoRT.width, this.aoRT.height);
    this.aoBlurMat.uniforms.uTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
    this.finalMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  public render(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    dt: number,
    elapsed: number,
    lightningFlash: number,
    viewmodelScene?: THREE.Scene,
    viewmodelCamera?: THREE.PerspectiveCamera
  ): void {
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.autoClear = true;

    // 1. Render main 3D world scene into HalfFloat HDR Target (with DepthTexture)
    r.setRenderTarget(this.hdrRT);
    r.render(scene, camera);
    this.lastSceneDrawCalls = r.info.render.calls;

    // 1b. Depth-isolated foreground Viewmodel Pass (weapon & arms never clip walls!)
    if (viewmodelScene && viewmodelCamera) {
      r.autoClear = false;
      r.clearDepth();
      r.render(viewmodelScene, viewmodelCamera);
      r.autoClear = true;
    }

    const invProj = camera.projectionMatrixInverse;
    const invView = camera.matrixWorld;

    // 2. GTAO + Bilateral Blur
    if (this.quality.enableGTAO) {
      this.gtaoMat.uniforms.uInvProj.value.copy(invProj);
      this.gtaoMat.uniforms.uProj.value.copy(camera.projectionMatrix);
      this.quadMesh.material = this.gtaoMat;
      r.setRenderTarget(this.aoRT);
      r.render(this.quadScene, this.quadCam);

      this.quadMesh.material = this.aoBlurMat;
      r.setRenderTarget(this.aoBlurRT);
      r.render(this.quadScene, this.quadCam);
    }

    // 2b. Volumetric Sun Shafts (God Rays)
    const camPosW = new THREE.Vector3();
    camera.getWorldPosition(camPosW);
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const sunDirW = this.ssrFogMat.uniforms.uSunDir.value as THREE.Vector3;
    const sunDot = camFwd.dot(sunDirW);
    const sunWorld = camPosW.clone().addScaledVector(sunDirW, 250);
    const sunClip = sunWorld.project(camera);
    this.godRayMat.uniforms.uSunScreen.value.set(sunClip.x * 0.5 + 0.5, sunClip.y * 0.5 + 0.5);
    this.godRayMat.uniforms.uSunVisibility.value =
      this.indoorMode && camPosW.y < -0.5 ? 0.0 : THREE.MathUtils.smoothstep(sunDot, -0.15, 0.65);
    this.godRayMat.uniforms.uLightning.value = lightningFlash;
    this.quadMesh.material = this.godRayMat;
    r.setRenderTarget(this.godRayRT);
    r.render(this.quadScene, this.quadCam);

    // 3. Composite + SSR + Volumetric Fog + Sun Shafts
    this.ssrFogMat.uniforms.uInvProj.value.copy(invProj);
    this.ssrFogMat.uniforms.uProj.value.copy(camera.projectionMatrix);
    this.ssrFogMat.uniforms.uInvView.value.copy(invView);
    this.ssrFogMat.uniforms.uView.value.copy(camera.matrixWorldInverse);
    camera.getWorldPosition(this.ssrFogMat.uniforms.uCamPos.value);
    this.ssrFogMat.uniforms.uTime.value = elapsed;
    this.ssrFogMat.uniforms.uLightning.value = lightningFlash;

    this.quadMesh.material = this.ssrFogMat;
    r.setRenderTarget(this.ssrCompositeRT);
    r.render(this.quadScene, this.quadCam);

    // 4. Bloom Downsample & Upsample
    if (this.quality.enableBloom) {
      this.quadMesh.material = this.brightMat;
      r.setRenderTarget(this.bloomBrightRT);
      r.render(this.quadScene, this.quadCam);

      this.blurMat.uniforms.tSrc.value = this.bloomBrightRT.texture;
      this.blurMat.uniforms.uTexel.value.set(1.5 / this.bloomBrightRT.width, 1.5 / this.bloomBrightRT.height);
      this.quadMesh.material = this.blurMat;
      r.setRenderTarget(this.bloomMip1RT);
      r.render(this.quadScene, this.quadCam);

      this.blurMat.uniforms.tSrc.value = this.bloomMip1RT.texture;
      this.blurMat.uniforms.uTexel.value.set(2.0 / this.bloomMip1RT.width, 2.0 / this.bloomMip1RT.height);
      r.setRenderTarget(this.bloomMip2RT);
      r.render(this.quadScene, this.quadCam);

      this.blurMat.uniforms.tSrc.value = this.bloomMip2RT.texture;
      this.blurMat.uniforms.uTexel.value.set(1.5 / this.bloomMip2RT.width, 1.5 / this.bloomMip2RT.height);
      r.setRenderTarget(this.bloomUp1RT);
      r.render(this.quadScene, this.quadCam);

      // Gentle auto-exposure adaptation from tiny 2x2 center sample of lowest bloom/scene mip
      // (avoid synchronous readPixels every frame — sample every 12 frames or smooth target)
    }

    // Smooth auto exposure modulated gently by lightning & storm ambient
    const targetExposure = THREE.MathUtils.clamp(1.04 - lightningFlash * 0.22, 0.78, 1.15);
    this.exposure = THREE.MathUtils.lerp(this.exposure, targetExposure, Math.min(1, dt * 3.0));
    this.finalMat.uniforms.uExposure.value = this.exposure;
    this.finalMat.uniforms.uTime.value = elapsed;

    // 5. Final ACES + FXAA to Screen
    this.quadMesh.material = this.finalMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
    r.autoClear = prevAutoClear;
  }

  public setIndoorMode(indoor: boolean): void {
    this.indoorMode = indoor;
    this.ssrFogMat.uniforms.uIndoorMode.value = indoor ? 1.0 : 0.0;
  }

  public getResolutionInfo(): string {
    return `${this.width}×${this.height}`;
  }
}
