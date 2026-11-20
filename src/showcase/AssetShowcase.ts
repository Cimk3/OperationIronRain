import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  appendCommandConsole,
  appendDetailedCableTray,
  appendDetailedPipeRun,
  appendGratingPlatform,
  appendIndustrialArchPortal,
  appendIndustrialGuardrail,
  appendIndustrialLightFixture,
  appendIndustrialStaircase,
  appendPowerCabinet,
  appendVentilationDuct,
  BatchPushFn,
  createIndustrialMaterials,
  IndustrialMatKey,
} from '../proc/industrialModules';
import { fbm2D, mulberry32 } from '../proc/noise';
import { EnvironmentPBRAtlas, getEnvironmentPBRAtlas, PBRMaterialPack } from '../proc/pbrGenerator';
import { buildRockLibrary, createRockMaterial, RockLibrary } from '../proc/rockGenerator';
import { createTerrainMaterial, TerrainMaterialBundle } from '../proc/terrainShader';
import { getTextureLibrary, TextureLibrary } from '../proc/textures';
import {
  createTreeFoliageMaterial,
  generateProceduralTreeVariant,
  ProceduralTreeVariant,
} from '../proc/treeGenerator';
import {
  buildGrassClumpLibrary,
  buildMicroGroundAssets,
  createGrassMaterial,
  GrassClumpLibrary,
  MicroGroundAssetLibrary,
} from '../proc/vegetationGenerator';

export type ShowcaseTabId = 'ground' | 'grass' | 'trees' | 'rocks' | 'industrial' | 'lighting';
export type ShowcaseViewMode = 'closeup' | 'fps';

interface CameraPose {
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

interface StageEntry {
  id: ShowcaseTabId;
  label: string;
  group: THREE.Group;
  closeup: CameraPose;
  fps: CameraPose;
  update?: (elapsed: number, camPos: THREE.Vector3) => void;
  vramExtraBytes?: number;
}

/**
 * Independent Procedural Art Lookdev Showcase (?showcase=1).
 * Evaluates Ground PBR, Grass/Foliage, L-System Trees, Eroded Rocks,
 * Underground Industrial Modules, and Overcast/Indoor Lighting in isolation
 * before integrating into production levels.
 */
export class AssetShowcase {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private atlas: EnvironmentPBRAtlas;
  private legacyTextures: TextureLibrary;
  private terrainBundle: TerrainMaterialBundle;
  private grassLib: GrassClumpLibrary;
  private microAssets: MicroGroundAssetLibrary;
  private rockLib: RockLibrary;
  private treeVariants: ProceduralTreeVariant[];
  private grassTimeUniform = { value: 0 };
  private grassCamPosUniform = { value: new THREE.Vector3() };

  private stages = new Map<ShowcaseTabId, StageEntry>();
  private activeTab: ShowcaseTabId = 'ground';
  private activeView: ShowcaseViewMode = 'closeup';

  private clock = new THREE.Clock();
  private elapsed = 0;
  private fpsFrames = 0;
  private fpsAccum = 0;
  private currentFps = 60;

  private sunLight!: THREE.DirectionalLight;
  private bounceLight!: THREE.DirectionalLight;
  private hemiLight!: THREE.HemisphereLight;
  private skyMesh!: THREE.Mesh;

  private uiRoot!: HTMLDivElement;
  private statsEl!: HTMLDivElement;
  private tabButtons = new Map<ShowcaseTabId, HTMLButtonElement>();
  private viewButtons = new Map<ShowcaseViewMode, HTMLButtonElement>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 220);

    // Hide standard game overlays cleanly
    for (const id of ['menu-screen', 'briefing-screen', 'gunsmith-screen', 'hud', 'pause-screen', 'end-screen']) {
      document.getElementById(id)?.classList.add('hidden');
    }

    // Generate Environment PBR Atlas & Procedural Vegetation / Tree / Rock Libraries
    this.atlas = getEnvironmentPBRAtlas(this.renderer, 1024, 1024);
    this.legacyTextures = getTextureLibrary(this.renderer, this.atlas);
    this.terrainBundle = createTerrainMaterial(this.atlas, this.renderer);
    this.grassLib = buildGrassClumpLibrary();
    this.microAssets = buildMicroGroundAssets(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.rockLib = buildRockLibrary();
    this.treeVariants = [
      generateProceduralTreeVariant(101, 'broadleaf'),
      generateProceduralTreeVariant(202, 'alder'),
      generateProceduralTreeVariant(303, 'windswept'),
    ];

    this.setupOvercastLighting();
    this.buildAllStages();
    this.buildUI();
    this.selectStage('ground', 'closeup');

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.loop();
  }

  private setupOvercastLighting(): void {
    // CoD4-style muted overcast storm sky dome (low saturation slate clouds, no nuclear sun!)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
        }
        float fbm(vec2 p){
          float s = 0.0, a = 0.5;
          for(int i=0;i<5;i++){ s += a*noise(p); p *= 2.05; a *= 0.5; }
          return s;
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 horizon = vec3(0.32, 0.36, 0.40);
          vec3 zenith  = vec3(0.16, 0.20, 0.25);
          vec3 col = mix(horizon, zenith, pow(h, 0.65));
          if (d.y > 0.02) {
            vec2 uv = d.xz / (d.y + 0.22);
            float c = fbm(uv * 0.75);
            vec3 cDark = vec3(0.14, 0.17, 0.20);
            vec3 cLite = vec3(0.38, 0.42, 0.46);
            col = mix(col, mix(cLite, cDark, smoothstep(0.30, 0.78, c)), smoothstep(0.02, 0.20, d.y) * 0.85);
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 20), skyMat);
    this.scene.add(this.skyMesh);

    // PMREM environment reflection from overcast dome
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(40, 24, 16), skyMat));
    this.scene.environment = pmrem.fromScene(envScene, 0.03).texture;
    pmrem.dispose();

    // Realistic overcast sky/ground hemisphere + subdued cloud-diffused directional + warm earth bounce
    this.hemiLight = new THREE.HemisphereLight(0x9fb0c2, 0x3b3830, 1.25);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xdce4ec, 1.15);
    this.sunLight.position.set(16, 22, 12);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 65;
    this.sunLight.shadow.camera.left = -16;
    this.sunLight.shadow.camera.right = 16;
    this.sunLight.shadow.camera.top = 16;
    this.sunLight.shadow.camera.bottom = -16;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.02;
    this.scene.add(this.sunLight);

    // Subtle indirect bounce light from opposite side to prevent pitch-black shadow crush
    this.bounceLight = new THREE.DirectionalLight(0x6e7874, 0.42);
    this.bounceLight.position.set(-14, 8, -12);
    this.scene.add(this.bounceLight);
  }

  private makePBRStandardMat(pack: PBRMaterialPack, repeat = 2): THREE.MeshStandardMaterial {
    const map = pack.map.clone();
    map.needsUpdate = true;
    map.repeat.set(repeat, repeat);
    const normalMap = pack.normalMap.clone();
    normalMap.needsUpdate = true;
    normalMap.repeat.set(repeat, repeat);
    const roughnessMap = pack.roughnessMap.clone();
    roughnessMap.needsUpdate = true;
    roughnessMap.repeat.set(repeat, repeat);
    const aoMap = pack.aoMap.clone();
    aoMap.needsUpdate = true;
    aoMap.repeat.set(repeat, repeat);

    const opts: THREE.MeshStandardMaterialParameters = {
      map,
      normalMap,
      normalScale: new THREE.Vector2(1.4, 1.4),
      roughnessMap,
      aoMap,
      aoMapIntensity: 1.0,
      roughness: 1.0,
      metalness: pack.metalnessMap ? 1.0 : 0.04,
    };
    if (pack.metalnessMap) {
      const metalnessMap = pack.metalnessMap.clone();
      metalnessMap.needsUpdate = true;
      metalnessMap.repeat.set(repeat, repeat);
      opts.metalnessMap = metalnessMap;
    }
    return new THREE.MeshStandardMaterial(opts);
  }

  private createSampleTerrainPatch(size: number, segs: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI * 0.5);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const count = pos.count;
    const splats = new Float32Array(count * 4);
    const wets = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);

      // Rolling micro-hills + muddy vehicle rut + shallow rain puddle basin in foreground!
      const hill = Math.sin(x * 0.24) * Math.cos(z * 0.21) * 0.42 + Math.sin((x + z) * 0.45) * 0.14;
      const rut = -Math.exp(-Math.pow((x - Math.sin(z * 0.28) * 1.1) / 1.45, 2)) * 0.24;
      const basin = -Math.exp(-((x - 0.2) ** 2 + (z - 1.2) ** 2) / 5.8) * 0.22;
      const y = hill + rut + basin;
      pos.setY(i, y);

      // Splat weights: R=Forest Humus/DryGrass, G=Wet Mud, B=Crushed Gravel, A=Bedrock
      const mudW = Math.max(0, Math.min(1, Math.exp(-Math.pow((x - Math.sin(z * 0.28) * 1.1) / 2.2, 2)) * 1.15));
      const gravelW = Math.max(0, Math.min(1, Math.exp(-((x + 3.2) ** 2 + (z - 0.5) ** 2) / 10.5) * 1.1 + (x > 2.2 ? (x - 2.2) * 0.22 : 0)));
      const rockW = Math.max(0, Math.min(1, (z < -3.5 ? (-3.5 - z) * 0.28 : 0) + (y > 0.35 ? (y - 0.35) * 1.8 : 0)));
      const forestW = Math.max(0.05, 1.0 - Math.min(1, mudW * 0.85 + gravelW * 0.8 + rockW * 0.9));

      splats[i * 4] = forestW;
      splats[i * 4 + 1] = mudW;
      splats[i * 4 + 2] = gravelW;
      splats[i * 4 + 3] = rockW;

      // Standing water inside rut & basin troughs
      const waterLevel = -0.20;
      const depth = Math.max(0, waterLevel - y);
      const wetness = Math.max(0, Math.min(1, (0.14 - (y - waterLevel)) * 3.5));
      wets[i * 2] = depth;
      wets[i * 2 + 1] = wetness;
    }

    geo.setAttribute('aSplat', new THREE.BufferAttribute(splats, 4));
    geo.setAttribute('aWet', new THREE.BufferAttribute(wets, 2));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this.terrainBundle.material);
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildGroundStage(): StageEntry {
    const group = new THREE.Group();
    const terrainPatch = this.createSampleTerrainPatch(24, 128);
    group.add(terrainPatch);

    // 4 Angled PBR Swatch Plinths in background for pure 1:1 material verification
    const swatches: Array<{ pack: PBRMaterialPack; x: number; label: string }> = [
      { pack: this.atlas.groundForest, x: -4.2, label: 'Forest Humus & Litter' },
      { pack: this.atlas.groundMud, x: -1.4, label: 'Wet Clay & Mud' },
      { pack: this.atlas.groundGravel, x: 1.4, label: 'Crushed Gravel' },
      { pack: this.atlas.groundRock, x: 4.2, label: 'Stratified Bedrock' },
    ];
    for (const sw of swatches) {
      const plateGeo = new THREE.BoxGeometry(2.2, 1.8, 0.16, 1, 1, 1);
      // Set uv2 for aoMap support
      plateGeo.setAttribute('uv2', plateGeo.attributes.uv);
      const mat = this.makePBRStandardMat(sw.pack, 1.5);
      const mesh = new THREE.Mesh(plateGeo, mat);
      mesh.position.set(sw.x, 1.15, -4.6);
      mesh.rotation.x = -0.22;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      // Sphere on plinth to inspect Fresnel/Roughness specular rolloff
      const sphGeo = new THREE.SphereGeometry(0.42, 32, 24);
      sphGeo.setAttribute('uv2', sphGeo.attributes.uv);
      const sph = new THREE.Mesh(sphGeo, mat);
      sph.position.set(sw.x, 0.58, -3.1);
      sph.castShadow = true;
      sph.receiveShadow = true;
      group.add(sph);
    }

    return {
      id: 'ground',
      label: '1. 地表 PBR 与高度混合',
      group,
      closeup: {
        pos: new THREE.Vector3(-1.35, 1.38, 3.65),
        look: new THREE.Vector3(-0.2, -0.18, 0.65),
      },
      fps: {
        pos: new THREE.Vector3(0.0, 1.68, 6.2),
        look: new THREE.Vector3(0.0, 0.62, -2.5),
      },
      update: (elapsed) => {
        this.terrainBundle.timeUniform.value = elapsed;
      },
      vramExtraBytes: this.terrainBundle.packVramBytes,
    };
  }

  private sampleShowcaseGroundY(x: number, z: number): number {
    const hill = Math.sin(x * 0.24) * Math.cos(z * 0.21) * 0.42 + Math.sin((x + z) * 0.45) * 0.14;
    const rut = -Math.exp(-Math.pow((x - Math.sin(z * 0.28) * 1.1) / 1.45, 2)) * 0.24;
    const basin = -Math.exp(-((x - 0.2) ** 2 + (z - 1.2) ** 2) / 5.8) * 0.22;
    return hill + rut + basin;
  }

  private buildGrassStage(): StageEntry {
    const group = new THREE.Group();
    const patch = this.createSampleTerrainPatch(24, 128);
    group.add(patch);

    const grassMat = createGrassMaterial(
      this.grassTimeUniform,
      this.grassCamPosUniform,
      new THREE.Vector3(16, 22, 12).normalize(),
      48.0
    );

    const rng = mulberry32(4401);
    const dummy = new THREE.Object3D();
    const colTmp = new THREE.Color();
    const varieties: Array<{
      geo: THREE.BufferGeometry;
      target: number;
      scaleMin: number;
      scaleMax: number;
      preferDry?: boolean;
    }> = [
      { geo: this.grassLib.denseTurf, target: 1650, scaleMin: 0.85, scaleMax: 1.35 },
      { geo: this.grassLib.tallMeadow, target: 980, scaleMin: 0.80, scaleMax: 1.30 },
      { geo: this.grassLib.broadWeed, target: 420, scaleMin: 0.78, scaleMax: 1.25 },
      { geo: this.grassLib.dryOchre, target: 520, scaleMin: 0.82, scaleMax: 1.28, preferDry: true },
    ];

    for (const v of varieties) {
      const matrices: THREE.Matrix4[] = [];
      const colors: THREE.Color[] = [];
      for (let attempt = 0; attempt < v.target * 3 && matrices.length < v.target; attempt++) {
        const wx = (rng() - 0.5) * 20;
        const wz = (rng() - 0.5) * 20;
        const wy = this.sampleShowcaseGroundY(wx, wz);
        // Leave muddy puddle trough naturally sparse while forming dense continuous meadow banks!
        if (wy < -0.18) continue;
        const meadowNoise = fbm2D(wx * 0.24, wz * 0.24, 3, 2.0, 0.5, 912) * 0.5 + 0.5;
        const edgeGrad = THREE.MathUtils.clamp((wy + 0.18) / 0.26, 0, 1);
        const density = meadowNoise * edgeGrad;
        if (rng() > density * 1.18) continue;

        dummy.position.set(wx, wy, wz);
        dummy.rotation.set((rng() - 0.5) * 0.14, rng() * Math.PI * 2, (rng() - 0.5) * 0.14);
        const s = v.scaleMin + rng() * (v.scaleMax - v.scaleMin);
        const hMod = (0.72 + edgeGrad * 0.42) * (0.85 + rng() * 0.32);
        dummy.scale.set(s, s * hMod, s);
        dummy.updateMatrix();
        matrices.push(dummy.matrix.clone());

        // Natural per-clump color shift (never uniform neon green)
        const tint = 0.82 + rng() * 0.34;
        const warm = v.preferDry ? 1.05 : 0.94 + rng() * 0.14;
        colTmp.setRGB(tint * warm, tint * (0.96 + rng() * 0.10), tint * 0.90);
        colors.push(colTmp.clone());
      }

      if (matrices.length > 0) {
        const inst = new THREE.InstancedMesh(v.geo, grassMat, matrices.length);
        inst.receiveShadow = true;
        inst.castShadow = false;
        for (let i = 0; i < matrices.length; i++) {
          inst.setMatrixAt(i, matrices[i]);
          inst.setColorAt(i, colors[i]);
        }
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        group.add(inst);
      }
    }

    // Woody Multi-Branch Shrubs along meadow edge (true branch skeleton + leaf sprigs!)
    const barkMat = new THREE.MeshStandardMaterial({
      color: 0x4b4034,
      roughness: 0.90,
      metalness: 0.02,
    });
    const sprigMat = new THREE.MeshStandardMaterial({
      map: this.microAssets.leafSprigAlpha,
      normalMap: this.microAssets.leafSprigNormal,
      alphaTest: 0.32,
      side: THREE.DoubleSide,
      roughness: 0.62,
      metalness: 0.01,
      vertexColors: true,
    });
    const shrubSpots: Array<[number, number, number]> = [
      [-3.4, -2.2, 1.05],
      [3.2, -2.6, 1.15],
      [-5.2, 1.5, 0.95],
      [4.6, 1.2, 1.0],
      [0.4, -4.4, 1.2],
    ];
    const sbInst = new THREE.InstancedMesh(this.microAssets.woodyShrubBranches, barkMat, shrubSpots.length);
    const slInst = new THREE.InstancedMesh(this.microAssets.woodyShrubLeaves, sprigMat, shrubSpots.length);
    sbInst.castShadow = true;
    slInst.castShadow = true;
    slInst.receiveShadow = true;
    shrubSpots.forEach(([sx, sz, sc], i) => {
      const sy = this.sampleShowcaseGroundY(sx, sz);
      dummy.position.set(sx, sy, sz);
      dummy.rotation.set(0, i * 1.4, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      sbInst.setMatrixAt(i, dummy.matrix);
      slInst.setMatrixAt(i, dummy.matrix);
    });
    sbInst.instanceMatrix.needsUpdate = true;
    slInst.instanceMatrix.needsUpdate = true;
    group.add(sbInst, slInst);

    // Ground Micro-Assets: Fallen Leaves, Dead Twigs & Surface Angular Gravel Clusters
    const leafMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      side: THREE.DoubleSide,
    });
    const rockClusterMat = this.makePBRStandardMat(this.atlas.groundRock, 1);

    const twigCount = 38;
    const twigInst = new THREE.InstancedMesh(this.microAssets.deadTwig, barkMat, twigCount);
    const flCount = 72;
    const flInst = new THREE.InstancedMesh(this.microAssets.fallenLeaves, leafMat, flCount);
    const grCount = 45;
    const grInst = new THREE.InstancedMesh(this.microAssets.gravelCluster, rockClusterMat, grCount);

    for (let i = 0; i < twigCount; i++) {
      const wx = (rng() - 0.5) * 14;
      const wz = (rng() - 0.5) * 14;
      dummy.position.set(wx, this.sampleShowcaseGroundY(wx, wz), wz);
      dummy.rotation.set((rng() - 0.5) * 0.15, rng() * Math.PI * 2, (rng() - 0.5) * 0.15);
      dummy.scale.setScalar(0.65 + rng() * 0.75);
      dummy.updateMatrix();
      twigInst.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < flCount; i++) {
      const wx = (rng() - 0.5) * 14;
      const wz = (rng() - 0.5) * 14;
      const wy = this.sampleShowcaseGroundY(wx, wz);
      dummy.position.set(wx, wy < -0.17 ? -5 : wy, wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.75 + rng() * 0.7);
      dummy.updateMatrix();
      flInst.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < grCount; i++) {
      const wx = (rng() - 0.5) * 14;
      const wz = (rng() - 0.5) * 14;
      dummy.position.set(wx, this.sampleShowcaseGroundY(wx, wz) - 0.015, wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.75 + rng() * 0.9);
      dummy.updateMatrix();
      grInst.setMatrixAt(i, dummy.matrix);
    }
    twigInst.instanceMatrix.needsUpdate = true;
    flInst.instanceMatrix.needsUpdate = true;
    grInst.instanceMatrix.needsUpdate = true;
    group.add(twigInst, flInst, grInst);

    return {
      id: 'grass',
      label: '2. 曲面草地与植被',
      group,
      closeup: {
        pos: new THREE.Vector3(2.35, 0.72, 2.35),
        look: new THREE.Vector3(1.55, 0.24, 0.55),
      },
      fps: {
        pos: new THREE.Vector3(2.6, 1.68, 5.8),
        look: new THREE.Vector3(0.4, 0.65, -2.5),
      },
      update: (elapsed, camPos) => {
        this.terrainBundle.timeUniform.value = elapsed;
        this.grassTimeUniform.value = elapsed;
        this.grassCamPosUniform.value.copy(camPos);
      },
      vramExtraBytes: this.terrainBundle.packVramBytes + Math.round(1024 * 1024 * 4 * 1.3333 * 2),
    };
  }

  private buildTreesStage(): StageEntry {
    const group = new THREE.Group();
    const patch = this.createSampleTerrainPatch(28, 96);
    group.add(patch);

    const barkMat = new THREE.MeshStandardMaterial({
      map: this.legacyTextures.bark.map,
      normalMap: this.legacyTextures.bark.normalMap,
      normalScale: new THREE.Vector2(1.5, 1.5),
      roughnessMap: this.legacyTextures.bark.roughnessMap,
      aoMap: this.legacyTextures.bark.aoMap,
      color: 0xc4beb4,
      roughness: 0.88,
      metalness: 0.02,
    });
    const foliageMat = createTreeFoliageMaterial(
      this.microAssets.leafSprigAlpha,
      this.microAssets.leafSprigNormal,
      this.grassTimeUniform,
      this.grassCamPosUniform,
      new THREE.Vector3(16, 22, 12).normalize()
    );

    const placements: Array<{ v: number; x: number; z: number; sc: number; ry: number }> = [
      { v: 0, x: 0.0, z: -1.5, sc: 1.05, ry: 0.4 },
      { v: 1, x: -5.2, z: -4.2, sc: 0.95, ry: 1.8 },
      { v: 2, x: 5.4, z: -3.8, sc: 1.0, ry: -0.9 },
    ];
    for (const p of placements) {
      const variant = this.treeVariants[p.v];
      const wy = this.sampleShowcaseGroundY(p.x, p.z);
      const bMesh = new THREE.Mesh(variant.barkLOD0, barkMat);
      bMesh.position.set(p.x, wy, p.z);
      bMesh.rotation.y = p.ry;
      bMesh.scale.setScalar(p.sc);
      bMesh.castShadow = true;
      bMesh.receiveShadow = true;

      const lMesh = new THREE.Mesh(variant.leavesLOD0, foliageMat);
      lMesh.position.set(p.x, wy, p.z);
      lMesh.rotation.y = p.ry;
      lMesh.scale.setScalar(p.sc);
      lMesh.castShadow = true;
      lMesh.receiveShadow = true;

      group.add(bMesh, lMesh);
    }

    // Add fallen twigs & leaf litter around exposed tree roots
    const rng = mulberry32(993);
    const dummy = new THREE.Object3D();
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, side: THREE.DoubleSide });
    const flInst = new THREE.InstancedMesh(this.microAssets.fallenLeaves, leafMat, 45);
    const twInst = new THREE.InstancedMesh(this.microAssets.deadTwig, barkMat, 22);
    for (let i = 0; i < 45; i++) {
      const a = rng() * Math.PI * 2;
      const r = 0.6 + rng() * 4.2;
      const wx = Math.cos(a) * r;
      const wz = -1.5 + Math.sin(a) * r;
      dummy.position.set(wx, this.sampleShowcaseGroundY(wx, wz), wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.8 + rng() * 0.6);
      dummy.updateMatrix();
      flInst.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < 22; i++) {
      const a = rng() * Math.PI * 2;
      const r = 0.8 + rng() * 4.5;
      const wx = Math.cos(a) * r;
      const wz = -1.5 + Math.sin(a) * r;
      dummy.position.set(wx, this.sampleShowcaseGroundY(wx, wz), wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.7 + rng() * 0.7);
      dummy.updateMatrix();
      twInst.setMatrixAt(i, dummy.matrix);
    }
    flInst.instanceMatrix.needsUpdate = true;
    twInst.instanceMatrix.needsUpdate = true;
    group.add(flInst, twInst);

    return {
      id: 'trees',
      label: '3. L-System 树木',
      group,
      closeup: {
        // Looking up close into root flare, furrowed bark & real 3-level branch/leaf cluster canopy!
        pos: new THREE.Vector3(2.2, 1.9, 1.9),
        look: new THREE.Vector3(-0.1, 3.2, -1.5),
      },
      fps: {
        pos: new THREE.Vector3(0.4, 1.68, 7.8),
        look: new THREE.Vector3(0.0, 2.9, -1.5),
      },
      update: (elapsed, camPos) => {
        this.terrainBundle.timeUniform.value = elapsed;
        this.grassTimeUniform.value = elapsed;
        this.grassCamPosUniform.value.copy(camPos);
      },
    };
  }

  private buildRocksStage(): StageEntry {
    const group = new THREE.Group();
    const patch = this.createSampleTerrainPatch(24, 96);
    group.add(patch);

    const rockMat = createRockMaterial(this.atlas.groundRock);
    const specs: Array<{ geo: THREE.BufferGeometry; x: number; z: number; sx: number; sy: number; sz: number; ry: number }> = [
      { geo: this.rockLib.boulderFractured, x: -2.2, z: -1.4, sx: 1.25, sy: 1.15, sz: 1.15, ry: 0.5 },
      { geo: this.rockLib.graniteCrag, x: 0.4, z: -2.0, sx: 1.1, sy: 1.35, sz: 1.0, ry: 1.7 },
      { geo: this.rockLib.lowMossSlab, x: 2.8, z: -1.1, sx: 1.35, sy: 0.95, sz: 1.25, ry: -0.8 },
      { geo: this.rockLib.boulderFractured, x: -0.7, z: -0.1, sx: 0.58, sy: 0.52, sz: 0.62, ry: 2.3 },
      { geo: this.rockLib.lowMossSlab, x: 1.6, z: 0.4, sx: 0.65, sy: 0.55, sz: 0.60, ry: 0.9 },
    ];
    for (const s of specs) {
      const m = new THREE.Mesh(s.geo, rockMat);
      const wy = this.sampleShowcaseGroundY(s.x, s.z);
      m.position.set(s.x, wy + s.sy * 0.16, s.z);
      m.rotation.y = s.ry;
      m.scale.set(s.sx, s.sy, s.sz);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }

    // Surround boulders with curved grass clumps, dead twigs, fallen leaves, angular gravel & woody shrub
    const grassMat = createGrassMaterial(
      this.grassTimeUniform,
      this.grassCamPosUniform,
      new THREE.Vector3(16, 22, 12).normalize(),
      48.0
    );
    const rng = mulberry32(612);
    const dummy = new THREE.Object3D();
    const turfInst = new THREE.InstancedMesh(this.grassLib.denseTurf, grassMat, 360);
    const tallInst = new THREE.InstancedMesh(this.grassLib.tallMeadow, grassMat, 180);
    const gravInst = new THREE.InstancedMesh(this.microAssets.gravelCluster, rockMat, 55);
    const barkMat = new THREE.MeshStandardMaterial({ color: 0x4b4034, roughness: 0.90 });
    const twigInst = new THREE.InstancedMesh(this.microAssets.deadTwig, barkMat, 28);
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, side: THREE.DoubleSide });
    const flInst = new THREE.InstancedMesh(this.microAssets.fallenLeaves, leafMat, 50);

    for (let i = 0; i < 360; i++) {
      const wx = (rng() - 0.5) * 11;
      const wz = -1.0 + (rng() - 0.5) * 9;
      const wy = this.sampleShowcaseGroundY(wx, wz);
      dummy.position.set(wx, wy < -0.18 ? -5 : wy, wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.85 + rng() * 0.5);
      dummy.updateMatrix();
      turfInst.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < 180; i++) {
      const wx = (rng() - 0.5) * 11;
      const wz = -1.0 + (rng() - 0.5) * 9;
      const wy = this.sampleShowcaseGroundY(wx, wz);
      dummy.position.set(wx, wy < -0.18 ? -5 : wy, wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.75 + rng() * 0.5);
      dummy.updateMatrix();
      tallInst.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < 55; i++) {
      const wx = (rng() - 0.5) * 9;
      const wz = -1.0 + (rng() - 0.5) * 7;
      dummy.position.set(wx, this.sampleShowcaseGroundY(wx, wz) - 0.015, wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.75 + rng() * 0.85);
      dummy.updateMatrix();
      gravInst.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < 28; i++) {
      const wx = (rng() - 0.5) * 9;
      const wz = -1.0 + (rng() - 0.5) * 7;
      dummy.position.set(wx, this.sampleShowcaseGroundY(wx, wz), wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.7 + rng() * 0.65);
      dummy.updateMatrix();
      twigInst.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < 50; i++) {
      const wx = (rng() - 0.5) * 9;
      const wz = -1.0 + (rng() - 0.5) * 7;
      const wy = this.sampleShowcaseGroundY(wx, wz);
      dummy.position.set(wx, wy < -0.17 ? -5 : wy, wz);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.8 + rng() * 0.6);
      dummy.updateMatrix();
      flInst.setMatrixAt(i, dummy.matrix);
    }
    turfInst.instanceMatrix.needsUpdate = true;
    tallInst.instanceMatrix.needsUpdate = true;
    gravInst.instanceMatrix.needsUpdate = true;
    twigInst.instanceMatrix.needsUpdate = true;
    flInst.instanceMatrix.needsUpdate = true;
    group.add(turfInst, tallInst, gravInst, twigInst, flInst);

    return {
      id: 'rocks',
      label: '4. 侵蚀岩石与微地景',
      group,
      closeup: {
        pos: new THREE.Vector3(-0.3, 1.25, 2.2),
        look: new THREE.Vector3(-0.2, 0.45, -1.2),
      },
      fps: {
        pos: new THREE.Vector3(0.4, 1.68, 4.8),
        look: new THREE.Vector3(0.1, 0.65, -1.5),
      },
      update: (elapsed, camPos) => {
        this.terrainBundle.timeUniform.value = elapsed;
        this.grassTimeUniform.value = elapsed;
        this.grassCamPosUniform.value.copy(camPos);
      },
    };
  }

  private buildIndustrialPreviewStage(): StageEntry {
    const group = new THREE.Group();
    const indMats = createIndustrialMaterials(this.atlas, this.legacyTextures.hazardTrim);
    const buckets = new Map<IndustrialMatKey, THREE.BufferGeometry[]>();

    const tmpM4 = new THREE.Matrix4();
    const tmpQ = new THREE.Quaternion();
    const tmpE = new THREE.Euler();
    const tmpP = new THREE.Vector3();
    const tmpS = new THREE.Vector3(1, 1, 1);

    const push: BatchPushFn = (matKey, geo, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) {
        g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      g.deleteAttribute('color');
      tmpP.set(x, y, z);
      tmpE.set(rx, ry, rz);
      tmpQ.setFromEuler(tmpE);
      tmpM4.compose(tmpP, tmpQ, tmpS);
      g.applyMatrix4(tmpM4);
      let arr = buckets.get(matKey);
      if (!arr) {
        arr = [];
        buckets.set(matKey, arr);
      }
      arr.push(g);
    };

    // Industrial Floor & Concrete Back/Side Bunker Bay (12m wide x 14m deep x 5.2m tall)
    const floorGeo = new THREE.PlaneGeometry(14, 16);
    floorGeo.rotateX(-Math.PI * 0.5);
    const fuv = floorGeo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < fuv.count; i++) fuv.setXY(i, fuv.getX(i) * 4, fuv.getY(i) * 4.5);
    push('floor', floorGeo, 0, 0, -2);

    const makeWall = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (Math.max(w, d) / 3.4), uv.getY(i) * (h / 3.4));
      push('concrete', g, x, y, z);
    };
    makeWall(14, 5.4, 0.5, 0, 2.7, -8.2); // Back wall
    makeWall(0.5, 5.4, 16, -6.4, 2.7, -1.0); // West wall
    makeWall(0.5, 5.4, 16, 6.4, 2.7, -1.0);  // East wall
    makeWall(14, 0.5, 16, 0, 5.4, -1.0);     // Concrete ceiling

    // 3 Structural Steel I-Beam + Bolted Gusset + Concrete Pilaster Arches!
    for (const az of [-6.5, -2.5, 1.5]) {
      appendIndustrialArchPortal(push, 0, 0, az, 12.2, 5.05, true, true, 0);
    }

    // Elevated Perforated Metal Grating Catwalk Balcony (Y = 2.65m) + Open Guardrails + Industrial Stairs
    appendGratingPlatform(push, 0, 2.65, -6.2, 11.4, 3.2);
    appendIndustrialGuardrail(push, -5.6, 2.65, -4.65, 1.2, 2.65, -4.65);
    appendIndustrialGuardrail(push, 3.0, 2.65, -4.65, 5.6, 2.65, -4.65);
    appendIndustrialStaircase(push, 2.1, 0.0, -1.1, 2.65, -4.65, 1.55);

    // Overhead Industrial Utility Runs: Ventilation Duct + Valve Fire Pipe + Coolant Pipe + Ladder Cable Tray
    appendVentilationDuct(push, -2.6, 4.45, -7.8, 3.5, 0.72, 0.40, 5.15);
    appendDetailedPipeRun(push, 3.6, 4.42, -7.8, 4.42, 3.5, 0.10, 'pipeRed', true);
    appendDetailedPipeRun(push, 4.15, 4.42, -7.8, 4.42, 3.5, 0.09, 'pipeBlue', false);
    appendDetailedCableTray(push, 0.4, 4.52, -7.8, 4.52, 3.5, 0.54);

    // Ground Floor Equipment: Dual Power Switchgear Cabinets + Main Command Console
    appendPowerCabinet(push, -4.2, 0, -5.6, 0.25, 1.25, 2.15, 0.78);
    appendPowerCabinet(push, -2.7, 0, -5.8, 0.10, 1.15, 2.05, 0.74);
    appendCommandConsole(push, -0.35, 0, -3.2, 0.08);

    // Visible Physical Explosion-Proof Wall Sconces, Ceiling Linear Fixtures & High-Bay Pendant Lights!
    appendIndustrialLightFixture(push, -6.12, 3.3, -2.5, Math.PI * 0.5, 'wallSconce', 'emissiveWarm');
    appendIndustrialLightFixture(push, 6.12, 3.3, -2.5, -Math.PI * 0.5, 'wallSconce', 'emissiveWarm');
    appendIndustrialLightFixture(push, -1.2, 4.82, -2.5, 0, 'ceilingLinear', 'emissiveCool');
    appendIndustrialLightFixture(push, 2.2, 4.82, -5.8, Math.PI * 0.5, 'highBay', 'emissiveWarm');

    // Merge all geometry per material bucket (<= 14 draw calls for the ENTIRE detailed industrial bay!)
    for (const [k, geos] of buckets) {
      if (geos.length === 0) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.setAttribute('uv2', merged.attributes.uv);
      const mesh = new THREE.Mesh(merged, indMats[k]);
      mesh.receiveShadow = true;
      mesh.castShadow = k !== 'floor' && k !== 'concrete' && !k.startsWith('emissive');
      group.add(mesh);
    }

    // Physical point lights seated directly at visible light fixtures (balanced warm/cool, zero pitch-black crush!)
    const lLinear = new THREE.PointLight(0xd4ebff, 22, 16, 1.5);
    lLinear.position.set(-1.2, 4.45, -2.5);
    const lWarmL = new THREE.PointLight(0xffb866, 14, 13, 1.5);
    lWarmL.position.set(-5.6, 3.15, -2.5);
    const lWarmR = new THREE.PointLight(0xffb866, 14, 13, 1.5);
    lWarmR.position.set(5.6, 3.15, -2.5);
    const lConsole = new THREE.PointLight(0x44ccff, 8, 7, 1.6);
    lConsole.position.set(-0.35, 1.8, -2.6);
    const lFill = new THREE.PointLight(0x9ab0c4, 12, 18, 1.4);
    lFill.position.set(0.5, 2.4, 2.5);
    group.add(lLinear, lWarmL, lWarmR, lConsole, lFill);

    return {
      id: 'industrial',
      label: '5. 地下工业 PBR 与模块',
      group,
      closeup: {
        // Close-up on Command Console, Switchgear Cabinets, Bolted I-Beam Gussets, Grating & Stairs!
        pos: new THREE.Vector3(-2.3, 1.55, 0.2),
        look: new THREE.Vector3(-0.9, 1.35, -4.2),
      },
      fps: {
        // First-Person Eye view across the full underground industrial bay
        pos: new THREE.Vector3(0.2, 1.68, 4.2),
        look: new THREE.Vector3(0.0, 1.95, -5.5),
      },
    };
  }

  private buildPlaceholderStage(id: ShowcaseTabId, label: string): StageEntry {
    const group = new THREE.Group();
    const patch = this.createSampleTerrainPatch(18, 64);
    group.add(patch);
    return {
      id,
      label,
      group,
      closeup: { pos: new THREE.Vector3(0, 1.4, 3.5), look: new THREE.Vector3(0, 0.5, 0) },
      fps: { pos: new THREE.Vector3(0, 1.68, 6.0), look: new THREE.Vector3(0, 1.0, 0) },
      update: (elapsed) => {
        this.terrainBundle.timeUniform.value = elapsed;
      },
    };
  }

  private buildAllStages(): void {
    const entries: StageEntry[] = [
      this.buildGroundStage(),
      this.buildGrassStage(),
      this.buildTreesStage(),
      this.buildRocksStage(),
      this.buildIndustrialPreviewStage(),
      this.buildPlaceholderStage('lighting', '6. 阴云光照与雨天'),
    ];
    for (const e of entries) {
      e.group.visible = false;
      this.scene.add(e.group);
      this.stages.set(e.id, e);
    }
  }

  private buildUI(): void {
    this.uiRoot = document.createElement('div');
    this.uiRoot.id = 'showcase-ui';
    this.uiRoot.style.cssText =
      'position:fixed;top:12px;left:12px;right:12px;display:flex;justify-content:space-between;align-items:flex-start;pointer-events:none;z-index:999;font-family:Consolas,monospace;color:#e4e9ee;';

    const leftBar = document.createElement('div');
    leftBar.style.cssText =
      'display:flex;flex-wrap:wrap;gap:6px;background:rgba(12,16,20,0.82);padding:8px 10px;border:1px solid rgba(255,255,255,0.16);border-radius:4px;pointer-events:auto;max-width:72%;';

    for (const [id, entry] of this.stages) {
      const btn = document.createElement('button');
      btn.id = `sc-tab-${id}`;
      btn.textContent = entry.label;
      btn.style.cssText =
        'padding:6px 10px;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,0.2);background:#1b232b;color:#d6dde4;border-radius:3px;';
      btn.onclick = () => this.selectStage(id, this.activeView);
      leftBar.appendChild(btn);
      this.tabButtons.set(id, btn);
    }

    const sep = document.createElement('span');
    sep.style.cssText = 'width:1px;background:rgba(255,255,255,0.22);margin:0 4px;';
    leftBar.appendChild(sep);

    for (const [mode, label] of [
      ['closeup', '近景特写'],
      ['fps', '第一人称平视'],
    ] as Array<[ShowcaseViewMode, string]>) {
      const btn = document.createElement('button');
      btn.id = `sc-view-${mode}`;
      btn.textContent = label;
      btn.style.cssText =
        'padding:6px 10px;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,0.2);background:#1b232b;color:#d6dde4;border-radius:3px;';
      btn.onclick = () => this.selectStage(this.activeTab, mode);
      leftBar.appendChild(btn);
      this.viewButtons.set(mode, btn);
    }

    this.statsEl = document.createElement('div');
    this.statsEl.id = 'showcase-stats';
    this.statsEl.style.cssText =
      'background:rgba(12,16,20,0.84);padding:8px 12px;border:1px solid rgba(255,255,255,0.18);border-radius:4px;font-size:12px;line-height:1.5;text-align:right;pointer-events:auto;';

    this.uiRoot.appendChild(leftBar);
    this.uiRoot.appendChild(this.statsEl);
    document.body.appendChild(this.uiRoot);
  }

  public selectStage(id: ShowcaseTabId, view: ShowcaseViewMode): void {
    this.activeTab = id;
    this.activeView = view;
    for (const [k, entry] of this.stages) {
      entry.group.visible = k === id;
      const btn = this.tabButtons.get(k);
      if (btn) {
        btn.style.background = k === id ? '#2f5e85' : '#1b232b';
        btn.style.color = k === id ? '#ffffff' : '#c8d2dc';
      }
    }
    for (const [m, btn] of this.viewButtons) {
      btn.style.background = m === view ? '#4a6b38' : '#1b232b';
      btn.style.color = m === view ? '#ffffff' : '#c8d2dc';
    }
    const st = this.stages.get(id)!;
    const pose = view === 'closeup' ? st.closeup : st.fps;
    this.camera.position.copy(pose.pos);
    this.camera.lookAt(pose.look);
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed += dt;

    const st = this.stages.get(this.activeTab);
    if (st?.update) st.update(this.elapsed, this.camera.position);

    this.renderer.render(this.scene, this.camera);

    this.fpsFrames++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.4) {
      this.currentFps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsFrames = 0;
      this.fpsAccum = 0;
      const info = this.renderer.info.render;
      const vramMB = ((this.atlas.totalVramBytes + (st?.vramExtraBytes ?? 0)) / (1024 * 1024)).toFixed(1);
      this.statsEl.innerHTML =
        `<div><b>LOOKDEV SHOWCASE</b> | ${this.activeTab.toUpperCase()} (${this.activeView})</div>` +
        `<div>${this.currentFps} FPS | ${info.calls} DC | ${(info.triangles / 1000).toFixed(1)}k Tris</div>` +
        `<div>PBR Atlas VRAM: ~${vramMB} MB | Gen: ${this.atlas.genTimeMs} ms</div>`;
    }
  };
}
