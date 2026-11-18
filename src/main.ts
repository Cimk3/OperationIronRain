import './style.css';
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { ProceduralAudioEngine } from './audio/ProceduralAudio';
import { AtmosphereSystem, buildAtmosphereSystem } from './engine/atmosphere';
import { PostProcessPipeline } from './engine/postprocess';
import { CombatSystem } from './gameplay/combat';
import { EnemyManager } from './gameplay/enemies';
import { loadPlayerLoadout } from './gameplay/loadouts';
import { PlayerController } from './gameplay/player';
import { ViewmodelController } from './gameplay/viewmodel';
import { getTextureLibrary, TextureLibrary } from './proc/textures';
import { GunsmithController } from './ui/gunsmith';
import {
  GamePhase,
  GameSettings,
  GameStats,
  LevelId,
  PlayerLoadoutSave,
  QUALITY_CONFIGS,
  QualityPreset,
  TerrainWorkerOutput,
  WeaponId,
  WorldSurface,
} from './types';
import { buildMilitaryOutpost, BoxCollider, OutpostSystem } from './world/outpost';
import { SiloWorld } from './world/silo';
import { BattlefieldTerrain } from './world/terrain';
import { buildVegetationSystem, CylinderCollider, VegetationSystem } from './world/vegetation';

function applyCSMKeepCustom(csm: CSM, mat: THREE.Material): void {
  const flag = mat as unknown as Record<string, boolean>;
  if (flag.__csmApplied) return;
  flag.__csmApplied = true;
  const existing = mat.onBeforeCompile;
  const existingKey = mat.customProgramCacheKey;
  csm.setupMaterial(mat);
  const csmCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    csmCompile.call(mat, shader, renderer);
    if (existing) existing.call(mat, shader, renderer);
  };
  mat.customProgramCacheKey = () => `csm-${existingKey ? existingKey.call(mat) : 'std'}`;
}

class IronRainGame {
  private canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private viewmodelScene = new THREE.Scene();
  private viewmodelCamera: THREE.PerspectiveCamera;
  private vmHemiLight!: THREE.HemisphereLight;
  private vmSunLight!: THREE.DirectionalLight;

  private settings: GameSettings = {
    quality: 'high',
    sensitivity: 1.0,
    adsSensitivity: 0.6,
    masterVolume: 0.8,
    fov: 68,
  };

  private wallRaycaster = new THREE.Raycaster();
  private shelterRaycaster = new THREE.Raycaster();
  private shelterTimer = 0;
  private shelterAmount = 0;

  private phase: GamePhase = 'menu';
  private audio = new ProceduralAudioEngine();
  private textures!: TextureLibrary;
  private terrainData!: TerrainWorkerOutput;
  private terrain!: BattlefieldTerrain;
  private silo!: SiloWorld;
  private atmosphere!: AtmosphereSystem;
  private vegetation!: VegetationSystem;
  private outpost!: OutpostSystem;
  private csm!: CSM;
  private hemiLight!: THREE.HemisphereLight;
  private postProcess!: PostProcessPipeline;
  private viewmodel!: ViewmodelController;
  private gunsmith!: GunsmithController;
  private playerLoadout: PlayerLoadoutSave = loadPlayerLoadout();
  private player!: PlayerController;
  private enemies!: EnemyManager;
  private combat!: CombatSystem;

  private currentLevel: LevelId = 'level1';
  private flashlightOn = false;
  private flashlightSpot!: THREE.SpotLight;
  private flashlightCone!: THREE.Mesh;
  private hackTriggered = false;
  private alarmSoundTimer = 0;

  private worldReady = false;
  private buildDurationMs = 0;

  private missionStage: 'checkpoint' | 'outpost' | 'extract' = 'checkpoint';
  private commsHoldProgress = 0;
  private stats: GameStats = this.freshStats();

  private isFiringHeld = false;
  private fireCooldown = 0;
  private hitmarkerTimer = 0;
  private hitIndTimer = 0;
  private hitIndAngle = 0;
  private damageFlash = 0;

  private clock = new THREE.Clock();
  private elapsed = 0;
  private fpsFrames = 0;
  private fpsAccum = 0;
  private currentFps = 60;

  // UI Elements
  private ui = {
    menu: document.getElementById('menu-screen')!,
    briefing: document.getElementById('briefing-screen')!,
    gunsmith: document.getElementById('gunsmith-screen')!,
    hud: document.getElementById('hud')!,
    pause: document.getElementById('pause-screen')!,
    end: document.getElementById('end-screen')!,
    btnStart: document.getElementById('btn-start') as HTMLButtonElement,
    btnGunsmith: document.getElementById('btn-gunsmith') as HTMLButtonElement,
    btnBriefingGunsmith: document.getElementById('btn-briefing-gunsmith') as HTMLButtonElement,
    btnDeploy: document.getElementById('btn-deploy') as HTMLButtonElement,
    btnResume: document.getElementById('btn-resume') as HTMLButtonElement,
    btnRestart: document.getElementById('btn-restart') as HTMLButtonElement,
    btnToMenu: document.getElementById('btn-to-menu') as HTMLButtonElement,
    btnReplay: document.getElementById('btn-replay') as HTMLButtonElement,
    btnEndMenu: document.getElementById('btn-end-menu') as HTMLButtonElement,
    lvlBtn1: document.getElementById('lvl-btn-1') as HTMLButtonElement,
    lvlBtn2: document.getElementById('lvl-btn-2') as HTMLButtonElement,
    loadingStatus: document.getElementById('loading-status')!,
    loadingText: document.getElementById('loading-text')!,
    qualitySelect: document.getElementById('quality-select') as HTMLSelectElement,
    pauseQuality: document.getElementById('pause-quality') as HTMLSelectElement,
    sensRange: document.getElementById('sens-range') as HTMLInputElement,
    sensVal: document.getElementById('sens-val')!,
    adsSensRange: document.getElementById('ads-sens-range') as HTMLInputElement,
    adsSensVal: document.getElementById('ads-sens-val')!,
    pauseSens: document.getElementById('pause-sens') as HTMLInputElement,
    pauseSensVal: document.getElementById('pause-sens-val')!,
    pauseAdsSens: document.getElementById('pause-ads-sens') as HTMLInputElement,
    pauseAdsSensVal: document.getElementById('pause-ads-sens-val')!,
    volRange: document.getElementById('vol-range') as HTMLInputElement,
    volVal: document.getElementById('vol-val')!,
    fovRange: document.getElementById('fov-range') as HTMLInputElement,
    fovVal: document.getElementById('fov-val')!,
    compass: document.getElementById('compass-bar')!,
    objText: document.getElementById('obj-text')!,
    objDist: document.getElementById('obj-dist')!,
    fpsCounter: document.getElementById('fps-counter')!,
    resInfo: document.getElementById('res-info')!,
    crosshair: document.getElementById('crosshair')!,
    centerPrompt: document.getElementById('center-prompt')!,
    hpValue: document.getElementById('hp-value')!,
    hpBar: document.getElementById('hp-bar-fill')!,
    stanceText: document.getElementById('stance-text')!,
    weaponName: document.getElementById('weapon-name')!,
    ammoMag: document.getElementById('ammo-mag')!,
    ammoReserve: document.getElementById('ammo-reserve')!,
    weaponSub: document.getElementById('weapon-sub')!,
    hitmarker: document.getElementById('hitmarker')!,
    hitIndRing: document.getElementById('hit-indicator-ring')!,
    damageVig: document.getElementById('damage-vignette')!,
    lockHint: document.getElementById('lock-hint')!,
  };

  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.camera = new THREE.PerspectiveCamera(
      this.settings.fov,
      window.innerWidth / window.innerHeight,
      0.03,
      360
    );
    this.scene.add(this.camera);

    this.viewmodelCamera = new THREE.PerspectiveCamera(
      this.settings.fov,
      window.innerWidth / window.innerHeight,
      0.02,
      2.5
    );
    this.viewmodelScene.add(this.viewmodelCamera);

    this.bindUIEvents();
    this.bindInputEvents();
    this.bootProceduralWorld();
    this.loop();
  }

  private freshStats(): GameStats {
    return {
      startTime: performance.now(),
      elapsedSeconds: 0,
      kills: 0,
      headshots: 0,
      shotsFired: 0,
      shotsHit: 0,
      damageTaken: 0,
      victory: false,
    };
  }

  private async bootProceduralWorld(): Promise<void> {
    const t0 = performance.now();
    this.ui.loadingStatus.classList.remove('hidden');
    this.ui.btnStart.disabled = true;
    this.ui.loadingText.textContent = 'Web Worker 正在生成 250m 水力侵蚀战场...';

    // 1. Run Terrain & Scatter Generation in Web Worker
    this.terrainData = await new Promise<TerrainWorkerOutput>((resolve) => {
      const worker = new Worker(new URL('./workers/terrain.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e: MessageEvent<TerrainWorkerOutput>) => {
        worker.terminate();
        resolve(e.data);
      };
      worker.postMessage({ gridSize: 513, worldSize: 250, seed: 4219 });
    });

    this.ui.loadingText.textContent = '正在合成 2048×2048 PBR 贴图与高精度枪械...';
    await new Promise((r) => setTimeout(r, 10));

    // 2. Generate all 1024/2048 procedural PBR texture sets
    this.textures = getTextureLibrary(this.renderer);

    // 3. Setup Quality, CSM, Hemisphere IBL & Atmosphere
    const q = QUALITY_CONFIGS[this.settings.quality];
    this.terrain = new BattlefieldTerrain(this.terrainData, this.textures);
    this.atmosphere = buildAtmosphereSystem(q, this.terrain);
    this.scene.add(this.atmosphere.group);
    this.scene.environment = this.atmosphere.generateEnvMap(this.renderer);

    this.hemiLight = new THREE.HemisphereLight(0x425b78, 0x171b18, 0.95);
    this.scene.add(this.hemiLight);

    this.initCSM(q.csmCascades, q.csmMapSize);

    // Re-wire terrain with CSM safely chaining triplanar shader!
    this.scene.remove(this.terrain.mesh);
    this.terrain = new BattlefieldTerrain(this.terrainData, this.textures, this.csm);
    this.scene.add(this.terrain.mesh);

    // 4. Vegetation & Military Outpost
    this.vegetation = buildVegetationSystem(this.terrainData, this.terrain, this.textures, q, this.csm);
    this.scene.add(this.vegetation.group);

    this.outpost = buildMilitaryOutpost(this.terrain, this.textures, this.csm);
    this.scene.add(this.outpost.group);

    // 4b. Level 2 Underground Missile Silo Facility (hidden while playing Level 1)
    this.silo = new SiloWorld(this.textures, this.csm);
    this.silo.group.visible = false;
    this.scene.add(this.silo.group);

    // 4c. Camera-Mounted Tactical Flashlight (SpotLight + Volumetric Dust Cone)
    this.buildFlashlight();

    // 5. High-poly Viewmodel (M4A1, AR-15, SIG M7, MP5SD, M1911 + Skinned Arms) in Depth-Isolated Foreground Scene
    this.viewmodel = new ViewmodelController(this.textures);
    this.viewmodel.applyLoadouts(this.playerLoadout, true);
    this.viewmodelScene.environment = this.scene.environment;
    this.vmHemiLight = new THREE.HemisphereLight(0x4f6885, 0x1e221e, 0.95);
    this.vmSunLight = new THREE.DirectionalLight(0xe6c496, 1.85);
    this.viewmodelScene.add(this.vmHemiLight);
    this.viewmodelScene.add(this.vmSunLight);
    this.viewmodelScene.add(this.viewmodel.root);

    // 5b. 3D Real-Time Gunsmith Workbench
    this.gunsmith = new GunsmithController(
      this.textures,
      this.playerLoadout,
      this.scene.environment,
      {
        onSnapAudio: () => {
          this.audio.init().then(() => {
            this.audio.setVolume(this.settings.masterVolume);
            this.audio.playGunsmithSnap();
          });
        },
        onLoadoutChanged: (save) => {
          this.playerLoadout = save;
          this.viewmodel.applyLoadouts(save, false);
        },
        onQuickDeploy: async (lvl) => {
          await this.audio.init();
          this.audio.setVolume(this.settings.masterVolume);
          this.currentLevel = lvl;
          this.ui.lvlBtn1.classList.toggle('active', lvl === 'level1');
          this.ui.lvlBtn2.classList.toggle('active', lvl === 'level2');
          this.resetMissionState();
          this.setPhase('playing');
          this.requestPointerLock();
        },
        onBackMenu: () => {
          this.setPhase('menu');
        },
      }
    );

    // 6. Combat VFX & Enemy Squad & Player
    this.combat = new CombatSystem();
    this.scene.add(this.combat.group);

    this.resetMissionState();

    // 7. Half-Float HDR + GTAO + SSR + Volumetric Fog + Bloom + ACES + FXAA Pipeline
    this.postProcess = new PostProcessPipeline(
      this.renderer,
      this.terrain,
      q,
      this.atmosphere.sunDirection
    );
    this.handleResize();

    this.buildDurationMs = Math.round(performance.now() - t0);
    this.worldReady = true;
    this.ui.loadingStatus.classList.add('hidden');
    this.ui.btnStart.disabled = false;

    const m4Tris = this.viewmodel.weapons.m4a1.triangleCount;
    const ar15Tris = this.viewmodel.weapons.ar15.triangleCount;
    const m7Tris = this.viewmodel.weapons.m7.triangleCount;
    const mp5Tris = this.viewmodel.weapons.mp5sd.triangleCount;
    const pTris = this.viewmodel.weapons.m1911.triangleCount;
    const armTris = this.viewmodel.arms.triangleCount;
    const soldierTris = this.enemies.soldierTriangleCount;
    const treeTris = this.vegetation.treeTrisAvg;
    const groundInst = this.vegetation.groundInstances;

    const techEl = document.getElementById('menu-tech-info');
    if (techEl) {
      techEl.textContent = `M4A1 ${m4Tris.toLocaleString()} | AR15 ${ar15Tris.toLocaleString()} | M7 ${m7Tris.toLocaleString()} | MP5SD ${mp5Tris.toLocaleString()} | M1911 ${pTris.toLocaleString()} | Arms ${armTris.toLocaleString()} | Init ${this.buildDurationMs}ms`;
    }

    console.info(
      `[IronRain] Ready in ${this.buildDurationMs}ms | M4A1=${m4Tris} | AR15=${ar15Tris} | M7=${m7Tris} | MP5SD=${mp5Tris} | M1911=${pTris} | Arms=${armTris} | Soldier=${soldierTris}`
    );

    // Expose read-only telemetry for inspection & verification
    (window as unknown as Record<string, unknown>).__GAME_DEBUG__ = {
      getStats: () => ({
        ready: this.worldReady,
        level: this.currentLevel,
        buildMs: this.buildDurationMs,
        fps: this.currentFps,
        drawCalls: this.postProcess.lastSceneDrawCalls,
        resolution: this.postProcess.getResolutionInfo(),
        m4a1Tris: m4Tris,
        ar15Tris,
        m7Tris,
        mp5sdTris: mp5Tris,
        m1911Tris: pTris,
        armsTris: armTris,
        soldierTris,
        treeTris,
        groundInstances: groundInst,
        phase: this.phase,
        weapon: this.viewmodel.activeWeapon,
        primaryEquipped: this.playerLoadout.primary,
        gripStyle: this.viewmodel.getActiveBuild().currentGripStyle,
        hasFlashlight: this.viewmodel.getActiveStats().hasFlashlight,
        flashlight: this.flashlightOn,
        alarmActive: this.silo?.alarmActive ?? false,
        brokenLights: this.silo?.shootableLights.filter((l) => l.broken).length ?? 0,
        ads: this.viewmodel.adsFactor,
        reloading: this.viewmodel.isReloading,
        playerPos: this.player.position.toArray(),
        aliveEnemies: this.enemies.getAliveCount(),
        missionStage: this.missionStage,
      }),
      inspectAt: (x: number, y: number, z: number, yaw?: number, pitch?: number) => {
        this.player.position.set(x, y, z);
        if (yaw !== undefined) this.player.yaw = yaw;
        if (pitch !== undefined) this.player.pitch = pitch;
        this.player.hp = 100;
      },
      restoreHealth: () => {
        this.player.hp = 100;
      },
      getEnemiesSummary: () =>
        this.enemies.enemies.map((e) => ({
          id: e.id,
          state: e.state,
          pos: [Number(e.position.x.toFixed(2)), Number(e.position.y.toFixed(2)), Number(e.position.z.toFixed(2))],
          yaw: Number(e.yaw.toFixed(3)),
          hp: e.hp,
        })),
      killEnemy: (id?: number) => {
        const target =
          id !== undefined
            ? this.enemies.enemies.find((e) => e.id === id && e.state !== 'dead')
            : this.enemies.enemies
                .filter((e) => e.state !== 'dead')
                .sort((a, b) => a.position.distanceToSquared(this.player.position) - b.position.distanceToSquared(this.player.position))[0];
        if (!target) return false;
        target.takeDamage(250, this.player.position);
        return true;
      },
    };
  }

  private initCSM(cascades: number, mapSize: number): void {
    if (this.csm) {
      this.csm.remove();
      this.csm.dispose();
    }
    this.csm = new CSM({
      maxFar: 165,
      cascades,
      mode: 'practical',
      parent: this.scene,
      shadowMapSize: mapSize,
      shadowBias: -0.00012,
      lightDirection: this.atmosphere.sunDirection.clone().negate(),
      lightIntensity: 2.1,
      lightNear: 1,
      lightFar: 320,
      lightMargin: 45,
      camera: this.camera,
    });
    this.csm.fade = true;
    this.csm.lights.forEach((light, idx) => {
      light.color.copy(this.atmosphere.sunLightColor);
      light.shadow.normalBias = 0.015 + idx * 0.018;
    });
  }

  private buildFlashlight(): void {
    this.flashlightSpot = new THREE.SpotLight(0xfff1d6, 44, 46, Math.PI * 0.21, 0.56, 1.4);
    this.flashlightSpot.position.set(0.12, -0.09, -0.22);
    this.flashlightSpot.castShadow = true;
    this.flashlightSpot.shadow.mapSize.set(512, 512);
    this.flashlightSpot.shadow.bias = -0.00025;
    this.flashlightSpot.shadow.camera.near = 0.2;
    this.flashlightSpot.shadow.camera.far = 46;
    this.flashlightSpot.target.position.set(0, -0.04, -12);
    this.camera.add(this.flashlightSpot);
    this.camera.add(this.flashlightSpot.target);

    // Volumetric Dust Cone Beam (additive subtle air scattering)
    const coneGeo = new THREE.ConeGeometry(2.4, 11.5, 24, 1, true);
    coneGeo.translate(0, -5.75, 0);
    coneGeo.rotateX(Math.PI * 0.5);
    const coneMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xfff1d6) },
      },
      vertexShader: `
        varying vec3 vNormalV;
        varying vec3 vPos;
        void main() {
          vPos = position;
          vNormalV = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying vec3 vNormalV;
        varying vec3 vPos;
        void main() {
          float axial = clamp(-vPos.z / 11.5, 0.0, 1.0);
          float distFade = pow(1.0 - axial, 1.8) * smoothstep(0.0, 0.12, axial);
          float rim = pow(abs(vNormalV.z), 1.35);
          float alpha = distFade * rim * 0.085;
          gl_FragColor = vec4(uColor * 1.15, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.flashlightCone = new THREE.Mesh(coneGeo, coneMat);
    this.flashlightCone.position.set(0.14, -0.11, -0.35);
    this.camera.add(this.flashlightCone);
    this.setFlashlight(false);
  }

  private setFlashlight(on: boolean): void {
    this.flashlightOn = on;
    if (this.flashlightSpot) this.flashlightSpot.visible = on;
    if (this.flashlightCone) this.flashlightCone.visible = on;
  }

  private getActiveSurface(): WorldSurface {
    return this.currentLevel === 'level2' ? this.silo : this.terrain;
  }

  private getActiveColliders(): BoxCollider[] {
    return this.currentLevel === 'level2' ? this.silo.colliders : this.outpost.colliders;
  }

  private getActiveCylColliders(): CylinderCollider[] {
    return this.currentLevel === 'level2' ? [] : this.vegetation.colliders;
  }

  private getActiveEnvMeshes(): THREE.Object3D[] {
    return this.currentLevel === 'level2'
      ? this.silo.meshesForRaycast
      : [...this.outpost.meshesForRaycast, ...this.vegetation.meshesForRaycast];
  }

  private applyLevelVisibility(): void {
    const isL2 = this.currentLevel === 'level2';
    if (this.terrain) this.terrain.mesh.visible = !isL2;
    if (this.vegetation) this.vegetation.group.visible = !isL2;
    if (this.outpost) this.outpost.group.visible = !isL2;
    if (this.silo) this.silo.group.visible = isL2;
    if (this.atmosphere) this.atmosphere.group.visible = true;
    if (this.postProcess) this.postProcess.setIndoorMode(isL2);
  }

  private updateBriefingUI(): void {
    const titleEl = document.querySelector('#briefing-screen h2');
    const bodyEl = document.querySelector('#briefing-screen .briefing-body');
    if (!titleEl || !bodyEl) return;

    if (this.currentLevel === 'level1') {
      titleEl.textContent = '任务简报：暗夜突袭';
      bodyEl.innerHTML = `
        <p><strong>作战区域：</strong>北纬 54° 暴雨山谷前哨站（250m × 250m）</p>
        <p><strong>战场情报：</strong>敌方精锐步兵班组占领了山脊废弃混凝土哨站，并部署了外围巡逻哨与通讯终端。</p>
        <p><strong>行动阶段：</strong></p>
        <ol>
          <li>突破外围雨林防线，清除前沿巡逻兵。</li>
          <li>攻入敌方哨站，消灭守军并靠近占领中央通讯台。</li>
          <li>前往西北山脊撤离点，完成撤离。</li>
        </ol>
        <p class="tip">提示：善用掩体与右键机械瞄准（ADS），暴雨和雷声可掩护你的推进。</p>
      `;
    } else {
      titleEl.textContent = '任务简报：地下发射井夜袭';
      bodyEl.innerHTML = `
        <p><strong>作战区域：</strong>东翼绝密地下导弹发射井（全长 180m • -12m 三层井筒）</p>
        <p><strong>战场情报：</strong>主通道宽阔但灯光闪烁、敌兵重兵把守；西侧电缆暗道昏暗狭长适合消音绕后。</p>
        <p><strong>行动阶段：</strong></p>
        <ol>
          <li>突破暴雨地面防爆门，沿斜坡渗入平行管廊（可射击头顶灯管潜行）。</li>
          <li>进入三层导弹发射井大厅，靠近主控终端按 [E] 触发系统黑入与红色警报。</li>
          <li>在全区红灯警报与增援追击下，沿东侧逃生斜坡冲出地面撤离点。</li>
        </ol>
        <p class="tip">装备提示：默认配备 [3] MP5SD 整体消音冲锋枪（沙漠战术手套，枪声半径 15m）与 [F] 战术手电筒。</p>
      `;
    }
  }

  private resetMissionState(): void {
    this.applyLevelVisibility();
    const isL2 = this.currentLevel === 'level2';
    if (isL2 && this.silo) {
      this.silo.reset();
    }

    const surface = this.getActiveSurface();
    if (this.enemies) {
      this.scene.remove(this.enemies.group);
    }
    this.enemies = new EnemyManager(surface, this.textures, this.currentLevel, this.getActiveColliders());
    this.enemies.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = (obj as THREE.Mesh).material;
        if (m && !Array.isArray(m) && !(m instanceof THREE.MeshBasicMaterial)) {
          applyCSMKeepCustom(this.csm, m);
        }
      }
    });
    this.scene.add(this.enemies.group);

    this.player = new PlayerController(0, isL2 ? 82 : 92, surface);
    this.viewmodel.applyLoadouts(this.playerLoadout, true);
    const startPrimary: WeaponId = this.playerLoadout.userSelectedPrimary
      ? this.playerLoadout.primary
      : isL2
        ? 'mp5sd'
        : 'm4a1';
    this.viewmodel.switchWeapon(startPrimary);
    this.viewmodel.cancelReload();
    this.setFlashlight(false);
    this.missionStage = 'checkpoint';
    this.commsHoldProgress = 0;
    this.hackTriggered = false;
    this.alarmSoundTimer = 0;
    this.stats = this.freshStats();
    this.damageFlash = 0;
    this.hitmarkerTimer = 0;
    this.hitIndTimer = 0;
  }

  private switchToWeapon(id: WeaponId): void {
    this.viewmodel.switchWeapon(id);
    if (!this.viewmodel.getActiveStats().hasFlashlight) {
      this.setFlashlight(false);
    }
  }

  private applyQuality(preset: QualityPreset): void {
    this.settings.quality = preset;
    this.ui.qualitySelect.value = preset;
    this.ui.pauseQuality.value = preset;
    const q = QUALITY_CONFIGS[preset];
    if (this.postProcess) {
      this.postProcess.setQuality(q);
      this.handleResize();
    }
  }

  private handleResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = w / h;
    this.viewmodelCamera.updateProjectionMatrix();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    if (this.postProcess) {
      this.postProcess.resize(w, h, dpr);
    }
    if (this.csm) {
      this.csm.updateFrustums();
    }
  }

  private bindUIEvents(): void {
    window.addEventListener('resize', () => this.handleResize());

    this.ui.qualitySelect.addEventListener('change', () => {
      this.applyQuality(this.ui.qualitySelect.value as QualityPreset);
    });
    this.ui.pauseQuality.addEventListener('change', () => {
      this.applyQuality(this.ui.pauseQuality.value as QualityPreset);
    });

    const syncSensUI = () => {
      this.ui.sensRange.value = String(this.settings.sensitivity);
      this.ui.pauseSens.value = String(this.settings.sensitivity);
      this.ui.sensVal.textContent = this.settings.sensitivity.toFixed(1);
      this.ui.pauseSensVal.textContent = this.settings.sensitivity.toFixed(1);

      this.ui.adsSensRange.value = String(this.settings.adsSensitivity);
      this.ui.pauseAdsSens.value = String(this.settings.adsSensitivity);
      this.ui.adsSensVal.textContent = this.settings.adsSensitivity.toFixed(1);
      this.ui.pauseAdsSensVal.textContent = this.settings.adsSensitivity.toFixed(1);
    };

    this.ui.sensRange.addEventListener('input', () => {
      this.settings.sensitivity = parseFloat(this.ui.sensRange.value);
      syncSensUI();
    });
    this.ui.pauseSens.addEventListener('input', () => {
      this.settings.sensitivity = parseFloat(this.ui.pauseSens.value);
      syncSensUI();
    });
    this.ui.adsSensRange.addEventListener('input', () => {
      this.settings.adsSensitivity = parseFloat(this.ui.adsSensRange.value);
      syncSensUI();
    });
    this.ui.pauseAdsSens.addEventListener('input', () => {
      this.settings.adsSensitivity = parseFloat(this.ui.pauseAdsSens.value);
      syncSensUI();
    });

    this.ui.volRange.addEventListener('input', () => {
      this.settings.masterVolume = parseFloat(this.ui.volRange.value);
      this.ui.volVal.textContent = `${Math.round(this.settings.masterVolume * 100)}%`;
      this.audio.setVolume(this.settings.masterVolume);
    });

    this.ui.fovRange.addEventListener('input', () => {
      this.settings.fov = parseInt(this.ui.fovRange.value, 10);
      this.ui.fovVal.textContent = `${this.settings.fov}°`;
    });

    this.ui.lvlBtn1.addEventListener('click', () => {
      this.currentLevel = 'level1';
      this.ui.lvlBtn1.classList.add('active');
      this.ui.lvlBtn2.classList.remove('active');
      this.gunsmith?.setLevel('level1');
      this.applyLevelVisibility();
      this.updateBriefingUI();
    });

    this.ui.lvlBtn2.addEventListener('click', () => {
      this.currentLevel = 'level2';
      this.ui.lvlBtn2.classList.add('active');
      this.ui.lvlBtn1.classList.remove('active');
      this.gunsmith?.setLevel('level2');
      this.applyLevelVisibility();
      this.updateBriefingUI();
    });

    this.ui.btnStart.addEventListener('click', async () => {
      if (!this.worldReady) return;
      await this.audio.init();
      this.audio.setVolume(this.settings.masterVolume);
      this.updateBriefingUI();
      this.setPhase('briefing');
    });

    const openGunsmith = async () => {
      if (!this.worldReady) return;
      await this.audio.init();
      this.audio.setVolume(this.settings.masterVolume);
      this.gunsmith.setLevel(this.currentLevel);
      this.gunsmith.syncLoadout(this.playerLoadout);
      this.setPhase('gunsmith');
    };
    this.ui.btnGunsmith.addEventListener('click', openGunsmith);
    this.ui.btnBriefingGunsmith.addEventListener('click', openGunsmith);

    this.ui.btnDeploy.addEventListener('click', () => {
      this.resetMissionState();
      this.setPhase('playing');
      this.requestPointerLock();
    });

    this.ui.btnResume.addEventListener('click', () => {
      this.setPhase('playing');
      this.requestPointerLock();
    });

    this.ui.btnRestart.addEventListener('click', () => {
      this.resetMissionState();
      this.setPhase('playing');
      this.requestPointerLock();
    });

    this.ui.btnToMenu.addEventListener('click', () => {
      this.setPhase('menu');
    });

    this.ui.btnReplay.addEventListener('click', () => {
      this.resetMissionState();
      this.setPhase('playing');
      this.requestPointerLock();
    });

    this.ui.btnEndMenu.addEventListener('click', () => {
      this.setPhase('menu');
    });
  }

  private requestPointerLock(): void {
    try {
      const maybePromise = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {
          // Pointer lock may be unavailable inside sandboxed frames
        });
      }
    } catch {
      // Ignored if headless or unsupported
    }
  }

  private setPhase(p: GamePhase): void {
    this.phase = p;
    this.ui.menu.classList.toggle('hidden', p !== 'menu');
    this.ui.briefing.classList.toggle('hidden', p !== 'briefing');
    this.ui.gunsmith.classList.toggle('hidden', p !== 'gunsmith');
    this.ui.hud.classList.toggle('hidden', p !== 'playing');
    this.ui.pause.classList.toggle('hidden', p !== 'paused');
    this.ui.end.classList.toggle('hidden', p !== 'ended');

    if (this.postProcess) {
      this.postProcess.setIndoorMode(p !== 'gunsmith' && this.currentLevel === 'level2');
    }

    if (p !== 'playing' && document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }

  private bindInputEvents(): void {
    window.addEventListener('keydown', (e) => {
      if (!this.player) return;
      this.player.keys[e.code] = true;

      if (this.phase === 'playing') {
        if (e.code === 'Digit1') this.switchToWeapon(this.playerLoadout.primary);
        if (e.code === 'Digit2') this.switchToWeapon('m1911');
        if (e.code === 'Digit3') this.switchToWeapon('mp5sd');
        if (e.code === 'Digit4') this.switchToWeapon('ar15');
        if (e.code === 'Digit5') this.switchToWeapon('m7');
        if (e.code === 'KeyQ') {
          const next =
            this.viewmodel.activeWeapon === 'm1911' ? this.playerLoadout.primary : 'm1911';
          this.switchToWeapon(next);
        }
        if (e.code === 'KeyF') {
          if (this.viewmodel.getActiveStats().hasFlashlight) {
            this.setFlashlight(!this.flashlightOn);
            this.audio.playSwitchClick();
          } else {
            this.setFlashlight(false);
          }
        }
        if (e.code === 'KeyE' && this.currentLevel === 'level2' && !this.silo.alarmActive) {
          if (this.player.position.distanceTo(this.silo.terminalPos) < 4.5) {
            this.hackTriggered = true;
            this.audio.playTerminalBeep(false);
          }
        }
        if (e.code === 'KeyR') this.viewmodel.startReload();
        if (e.code === 'KeyP') this.setPhase('paused');

        // QA-only inspection shortcuts (strictly disabled unless ?qa=1 is in URL)
        if (window.location.search.includes('qa=1')) {
          if (e.code === 'F7') {
            e.preventDefault();
            const target = this.enemies.enemies.find((en) => en.state !== 'dead');
            if (target) {
              const ex = target.position.x + Math.sin(target.yaw) * 3.0;
              const ez = target.position.z + Math.cos(target.yaw) * 3.0;
              this.player.position.set(ex, target.position.y, ez);
              this.player.yaw = target.yaw + Math.PI;
              this.player.pitch = -0.04;
              this.player.hp = 100;
            }
          } else if (e.code === 'F8') {
            e.preventDefault();
            const target = this.enemies.enemies
              .filter((en) => en.state !== 'dead')
              .sort((a, b) => a.position.distanceToSquared(this.player.position) - b.position.distanceToSquared(this.player.position))[0];
            if (target) {
              target.takeDamage(250, this.player.position);
              const ex = target.position.x + Math.sin(target.yaw) * 2.4;
              const ez = target.position.z + Math.cos(target.yaw) * 2.4;
              this.player.position.set(ex, target.position.y, ez);
              this.player.yaw = target.yaw + Math.PI;
              this.player.pitch = -0.36;
              this.player.hp = 100;
            }
          } else if (e.code === 'F9' && this.currentLevel === 'level2') {
            e.preventDefault();
            this.player.position.set(0, -8.0, -26.0);
            this.player.yaw = 0;
            this.player.pitch = -0.05;
            this.player.hp = 100;
          } else if (e.code === 'F10' && this.currentLevel === 'level2') {
            e.preventDefault();
            this.player.position.set(22.15, -1.2, 10.5);
            this.player.yaw = Math.PI;
            this.player.pitch = 0.08;
            this.player.hp = 100;
          }
        }
      } else if (this.phase === 'paused' && e.code === 'KeyP') {
        this.setPhase('playing');
        this.requestPointerLock();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (this.player) this.player.keys[e.code] = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.phase !== 'playing' || !this.player) return;
      if (document.pointerLockElement === this.canvas || e.buttons === 1) {
        this.player.addLookDelta(
          e.movementX,
          e.movementY,
          this.settings.sensitivity,
          this.settings.adsSensitivity,
          this.viewmodel.adsFactor
        );
        this.viewmodel.addLookSway(e.movementX, e.movementY);
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (this.phase !== 'playing') return;
      if (document.pointerLockElement !== this.canvas) {
        this.requestPointerLock();
      }
      if (e.button === 0) {
        this.isFiringHeld = true;
        this.tryFireWeapon();
      } else if (e.button === 2 && this.player) {
        this.player.isAiming = true;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.isFiringHeld = false;
      if (e.button === 2 && this.player) this.player.isAiming = false;
    });

    window.addEventListener('contextmenu', (e) => {
      if (this.phase === 'playing') e.preventDefault();
    });

    window.addEventListener('wheel', (e) => {
      if (this.phase === 'playing' && Math.abs(e.deltaY) > 5) {
        const next =
          this.viewmodel.activeWeapon === 'm1911' ? this.playerLoadout.primary : 'm1911';
        this.switchToWeapon(next);
      }
    });

    document.addEventListener('pointerlockchange', () => {
      if (this.phase === 'playing') {
        this.ui.lockHint.classList.toggle('hidden', document.pointerLockElement === this.canvas);
      }
    });
  }

  private tryFireWeapon(): void {
    if (this.phase !== 'playing' || !this.viewmodel || !this.player) return;
    if (this.viewmodel.isReloading || this.viewmodel.switchTimer > 0 || this.fireCooldown > 0) return;

    const wId = this.viewmodel.activeWeapon;
    const cfg = this.viewmodel.getActiveStats();
    const st = this.viewmodel.state[wId];

    if (st.mag <= 0) {
      this.viewmodel.startReload();
      return;
    }

    st.mag--;
    this.fireCooldown = 60 / cfg.rpm;
    this.stats.shotsFired++;

    // Visuals + Recoil + Audio + Shell Casing
    this.viewmodel.triggerFireVisuals();
    const adsScale = 1.0 - this.viewmodel.adsFactor * 0.45;
    this.player.addRecoilKick(
      cfg.recoilPitch * adsScale,
      (Math.random() - 0.5) * cfg.recoilYaw * adsScale
    );
    this.audio.playGunshot(wId, undefined, false, cfg.muzzleType);

    this.camera.updateMatrixWorld();
    const ejectPos = this.viewmodel.getEjectWorldPosition().applyMatrix4(this.camera.matrixWorld);
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.combat.spawnShell(ejectPos, camRight, camUp);

    // Ballistics Raycast
    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const muzzlePos = this.viewmodel.getMuzzleWorldPosition().applyMatrix4(this.camera.matrixWorld);
    const moveSpread = this.player.moveSpeedNorm * 0.012 * (1 - this.viewmodel.adsFactor * 0.8);
    const spread = THREE.MathUtils.lerp(cfg.hipSpread, cfg.adsSpread, this.viewmodel.adsFactor) + moveSpread;

    const envMeshes = this.getActiveEnvMeshes();
    const res = this.combat.firePlayerShot(
      this.camera.position,
      camDir,
      muzzlePos,
      spread,
      cfg.damage,
      this.getActiveSurface(),
      envMeshes,
      this.getActiveColliders(),
      this.enemies,
      this.audio
    );

    if (res.hitLightId !== undefined && this.currentLevel === 'level2') {
      const brokenPos = this.silo.breakLight(res.hitLightId);
      if (brokenPos) {
        this.audio.playGlassBreak(brokenPos);
      }
    }

    if (res.hitEnemy) {
      this.stats.shotsHit++;
      this.hitmarkerTimer = 0.14;
      this.ui.hitmarker.classList.toggle('kill', res.headshot || res.killed);
      if (res.killed) {
        this.stats.kills++;
        if (res.headshot) this.stats.headshots++;
      }
    }

    this.enemies.notifyPlayerGunshot(this.player.position, cfg.hearingRadius);

    if (!cfg.auto) {
      this.isFiringHeld = false;
    }
  }

  private updateMissionObjectives(dt: number): void {
    const p = this.player.position;
    let targetPos = this.outpost.checkpointPos;
    let prompt = '';

    if (this.currentLevel === 'level2') {
      if (this.missionStage === 'checkpoint') {
        targetPos = new THREE.Vector3(0, -8, -22);
        const dist = p.distanceTo(targetPos);
        this.ui.objText.textContent = '阶段 1/3：突破地面防爆门，沿斜坡/管廊潜入发射井';
        this.ui.objDist.textContent = `距离发射井入口: ${Math.round(dist)}m | 剩余敌军: ${this.enemies.getAliveCount()}`;
        if (p.z < -20) {
          this.missionStage = 'outpost';
        }
      } else if (this.missionStage === 'outpost') {
        targetPos = this.silo.terminalPos;
        const dist = p.distanceTo(targetPos);
        this.ui.objText.textContent = '阶段 2/3：攻入三层导弹发射井大厅，按 [E] 黑入主控终端';
        this.ui.objDist.textContent = `距离主控终端: ${Math.round(dist)}m | 剩余敌军: ${this.enemies.getAliveCount()}`;

        if (dist < 4.5 && !this.silo.alarmActive) {
          if (!this.hackTriggered && !this.player.keys['KeyE']) {
            prompt = '按 [E] 黑入导弹发射井主控终端';
          } else {
            const speed = this.player.keys['KeyE'] ? 1.0 : 0.72;
            const prevTick = Math.floor(this.commsHoldProgress * 6);
            this.commsHoldProgress += (dt / 1.5) * speed;
            const nextTick = Math.floor(this.commsHoldProgress * 6);
            if (nextTick > prevTick && nextTick < 6) {
              this.audio.playTerminalBeep(false);
            }
            prompt = `正在覆写发射井自毁锁协议... ${Math.min(100, Math.round(this.commsHoldProgress * 100))}%`;
            if (this.commsHoldProgress >= 1.0) {
              this.audio.playTerminalBeep(true);
              this.silo.triggerAlarm();
              this.enemies.spawnBatch(
                this.silo,
                [
                  { pos: [10.5, -55], patrol: [[10.5, -55], [10.5, -36]], refY: -7.5 },
                  { pos: [-10.0, -56], patrol: [[-10.0, -56], [4.0, -56]], refY: -7.5 },
                  { pos: [22.2, -10], patrol: [[22.2, -10], [22.2, -24]], refY: -4.0 },
                  { pos: [20.5, 20.0], patrol: [[20.5, 20.0], [25.0, 26.0]], refY: 0.5 },
                ],
                true
              );
              this.enemies.group.traverse((obj) => {
                if ((obj as THREE.Mesh).isMesh) {
                  const m = (obj as THREE.Mesh).material;
                  if (m && !Array.isArray(m) && !(m instanceof THREE.MeshBasicMaterial)) {
                    applyCSMKeepCustom(this.csm, m);
                  }
                }
              });
              this.missionStage = 'extract';
            }
          }
        }
      } else {
        targetPos = p.x < 18 ? new THREE.Vector3(18.5, -8.0, -33.5) : this.silo.extractionPos;
        const dist = p.distanceTo(this.silo.extractionPos);
        this.ui.objText.textContent = '阶段 3/3：红色警报！沿东侧逃生斜坡冲出地面撤离点';
        this.ui.objDist.textContent = `距离撤离点: ${Math.round(dist)}m`;
        if (dist < 5.5) {
          this.finishGame(true);
        }
      }
    } else if (this.missionStage === 'checkpoint') {
      const dist = p.distanceTo(this.outpost.checkpointPos);
      this.ui.objText.textContent = '阶段 1/3：突破外围巡逻哨，推进至前哨检查点';
      this.ui.objDist.textContent = `距离检查点: ${Math.round(dist)}m | 剩余敌军: ${this.enemies.getAliveCount()}`;
      if (dist < 14 || p.z < 20) {
        this.missionStage = 'outpost';
      }
    } else if (this.missionStage === 'outpost') {
      targetPos = this.outpost.commsTerminalPos;
      const dist = p.distanceTo(targetPos);
      // Count enemies still defending outpost area
      let outpostEnemies = 0;
      for (const e of this.enemies.enemies) {
        if (e.state !== 'dead' && e.position.z > -58 && e.position.z < -8) {
          outpostEnemies++;
        }
      }
      this.ui.objText.textContent =
        outpostEnemies > 0
          ? `阶段 2/3：肃清哨站守军 (${outpostEnemies}人) 并占领中央通讯台`
          : '阶段 2/3：靠近中央通讯台完成占领';
      this.ui.objDist.textContent = `距离通讯台: ${Math.round(dist)}m`;

      if (dist < 5.0) {
        if (outpostEnemies > 1) {
          prompt = `哨站仍有 ${outpostEnemies} 名敌军抵抗 — 肃清守军后自动入侵终端`;
        } else {
          this.commsHoldProgress += dt / 2.5;
          prompt = `正在同步通讯情报... ${Math.min(100, Math.round(this.commsHoldProgress * 100))}%`;
          if (this.commsHoldProgress >= 1.0) {
            this.missionStage = 'extract';
            this.audio.playReloadStage('rack');
          }
        }
      }
    } else {
      targetPos = this.outpost.extractionPos;
      const dist = p.distanceTo(targetPos);
      this.ui.objText.textContent = '阶段 3/3：前往西北山脊撤离点 (LZ) 脱离战场';
      this.ui.objDist.textContent = `距离撤离点: ${Math.round(dist)}m`;
      if (dist < 6.0) {
        this.finishGame(true);
      }
    }

    if (this.viewmodel.state[this.viewmodel.activeWeapon].mag <= 5 && !this.viewmodel.isReloading && !prompt) {
      prompt = '弹药不足 — 按 [R] 换弹';
    }
    this.ui.centerPrompt.textContent = prompt;
    this.ui.centerPrompt.classList.toggle('hidden', !prompt);

    // Compass bearing + relative turn chevron
    const deg = ((THREE.MathUtils.radToDeg(-this.player.yaw) % 360) + 360) % 360;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(deg / 45) % 8;
    const toTargetAngle = Math.atan2(targetPos.x - p.x, -(targetPos.z - p.z));
    const targetDeg = ((THREE.MathUtils.radToDeg(toTargetAngle) % 360) + 360) % 360;
    let delta = ((targetDeg - deg + 540) % 360) - 180;
    const chevron = Math.abs(delta) < 12 ? '▲ 正前方' : delta > 0 ? `▶ 右偏 ${Math.round(delta)}°` : `◀ 左偏 ${Math.round(-delta)}°`;
    this.ui.compass.textContent = `${dirs[idx]} ${Math.round(deg)}°  |  目标 ${chevron}`;
  }

  private finishGame(victory: boolean): void {
    this.stats.victory = victory;
    this.stats.elapsedSeconds = (performance.now() - this.stats.startTime) / 1000;
    this.setPhase('ended');

    const mins = Math.floor(this.stats.elapsedSeconds / 60);
    const secs = Math.floor(this.stats.elapsedSeconds % 60);
    const acc =
      this.stats.shotsFired > 0
        ? Math.round((this.stats.shotsHit / this.stats.shotsFired) * 100)
        : 0;

    document.getElementById('end-tag')!.textContent = victory ? 'MISSION ACCOMPLISHED' : 'KIA // MISSION FAILED';
    document.getElementById('end-title')!.textContent = victory ? '撤离成功 — 任务完成' : '任务失败 — 阵亡';
    document.getElementById('stat-time')!.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    document.getElementById('stat-kills')!.textContent = String(this.stats.kills);
    document.getElementById('stat-headshots')!.textContent = String(this.stats.headshots);
    document.getElementById('stat-accuracy')!.textContent = `${acc}%`;
    document.getElementById('stat-damage')!.textContent = String(Math.round(this.stats.damageTaken));

    const score = this.stats.kills * 100 + this.stats.headshots * 60 + acc * 2 - this.stats.damageTaken * 0.5;
    const rank = !victory ? 'F' : score > 1100 ? 'S' : score > 800 ? 'A' : score > 500 ? 'B' : 'C';
    document.getElementById('stat-rank')!.textContent = rank;
  }

  private updateHUD(dt: number): void {
    const wId = this.viewmodel.activeWeapon;
    const cfg = this.viewmodel.getActiveStats();
    const st = this.viewmodel.state[wId];

    this.ui.weaponName.textContent = cfg.name;
    this.ui.weaponSub.textContent = cfg.subtitle;
    this.ui.ammoMag.textContent = String(st.mag);
    this.ui.ammoReserve.textContent = String(st.reserve);

    const hp = Math.ceil(this.player.hp);
    this.ui.hpValue.textContent = String(hp);
    this.ui.hpBar.style.width = `${Math.max(0, hp)}%`;
    this.ui.hpBar.style.background =
      hp < 35
        ? 'linear-gradient(90deg, #e63946, #ff6b6b)'
        : 'linear-gradient(90deg, #52b788, #95d5b2)';

    const flashHint = cfg.hasFlashlight ? (this.flashlightOn ? '开' : '关') + '[F]' : '未装配';
    this.ui.stanceText.textContent = `${this.player.isCrouching ? '蹲姿' : '站姿'} | ${
      this.player.isSprinting ? '冲刺' : this.player.isAiming ? '精准瞄准' : '战术戒备'
    } | 手电:${flashHint}`;

    // Crosshair spreads on movement & hides cleanly during ADS
    this.ui.crosshair.style.opacity = String(Math.max(0, 1 - this.viewmodel.adsFactor * 1.35));
    const spreadPx = 8 + this.player.moveSpeedNorm * 14 + this.fireCooldown * 55;
    const lines = this.ui.crosshair.children;
    (lines[0] as HTMLElement).style.bottom = `${spreadPx}px`;
    (lines[1] as HTMLElement).style.top = `${spreadPx}px`;
    (lines[2] as HTMLElement).style.right = `${spreadPx}px`;
    (lines[3] as HTMLElement).style.left = `${spreadPx}px`;

    // Hitmarker & Damage Indicators
    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      this.ui.hitmarker.classList.remove('hidden');
    } else {
      this.ui.hitmarker.classList.add('hidden');
    }

    if (this.hitIndTimer > 0) {
      this.hitIndTimer -= dt;
      this.ui.hitIndRing.style.opacity = String(Math.min(1, this.hitIndTimer * 1.5));
      this.ui.hitIndRing.style.transform = `rotate(${this.hitIndAngle}rad)`;
    } else {
      this.ui.hitIndRing.style.opacity = '0';
    }

    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    const lowHpVig = this.player.hp < 40 ? (1 - this.player.hp / 40) * 0.55 : 0;
    this.ui.damageVig.style.opacity = String(Math.min(1, Math.max(this.damageFlash, lowHpVig)));

    this.ui.fpsCounter.textContent = `${this.currentFps} FPS`;
    this.ui.resInfo.textContent = `${this.postProcess.getResolutionInfo()} | ${this.postProcess.lastSceneDrawCalls} DC`;
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed += dt;

    // FPS Counter
    this.fpsFrames++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.currentFps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsFrames = 0;
      this.fpsAccum = 0;
    }

    if (!this.worldReady) {
      this.renderer.setClearColor(0x0b1014, 1);
      this.renderer.clear();
      return;
    }

    if (this.phase === 'gunsmith') {
      this.gunsmith.update(dt, window.innerWidth, window.innerHeight);
      this.postProcess.render(this.gunsmith.scene, this.gunsmith.camera, dt, this.elapsed, 0);
      return;
    }

    // Atmosphere & Lightning
    const isL2 = this.currentLevel === 'level2';
    const isUnderground =
      isL2 && (this.phase === 'menu' || this.phase === 'briefing' || this.player.position.y < -0.5);
    if (isL2) {
      this.atmosphere.group.visible = !isUnderground;
    }

    const thunder = this.atmosphere.update(dt, this.elapsed, this.camera.position);
    if (!isUnderground && thunder.thunderDelay && thunder.thunderDist) {
      this.audio.playThunder(thunder.thunderDelay, thunder.thunderDist);
    }
    const flash = isUnderground ? 0 : this.atmosphere.lightningFlash;
    this.csm.lights.forEach((l, idx) => {
      l.intensity = isUnderground ? 0.06 : isL2 ? 0.55 + flash * 1.4 : 2.1 + flash * 2.4;
      // Strict <= 2 real-time shadow lights in Level 2 (only flashlight + 1 exterior sun cascade when outside!)
      l.castShadow = isL2 ? !isUnderground && idx === 0 : true;
    });
    this.hemiLight.intensity = isUnderground ? 0.14 : isL2 ? 0.35 + flash * 0.25 : 0.92 + flash * 0.45;

    if (isL2) {
      const refPos = this.phase === 'playing' ? this.player.position : this.camera.position;
      this.silo.update(dt, this.elapsed, refPos);
      if (this.silo.alarmActive && this.phase === 'playing') {
        this.alarmSoundTimer -= dt;
        if (this.alarmSoundTimer <= 0) {
          this.alarmSoundTimer = 1.15;
          this.audio.playAlarmPulse();
        }
      }
    } else {
      this.terrain.update(this.elapsed, this.camera);
      this.vegetation.update(this.elapsed, this.camera.position);
      this.outpost.update(this.elapsed);
    }

    if (this.phase === 'menu' || this.phase === 'briefing') {
      if (isL2) {
        // Cinematic preview inside the 3-story Missile Silo Hall!
        const camX = Math.sin(this.elapsed * 0.22) * 11.5;
        const camY = -1.5 + Math.cos(this.elapsed * 0.16) * 2.2;
        const camZ = -32.0 - Math.cos(this.elapsed * 0.18) * 10.0;
        this.camera.position.set(camX, camY, camZ);
        this.camera.lookAt(0, -4.5, -44);
      } else {
        // Slow cinematic flyover preview behind Main Menu / Briefing
        const camX = Math.sin(this.elapsed * 0.12) * 14;
        const camZ = 65 - Math.cos(this.elapsed * 0.08) * 18;
        this.camera.position.set(camX, this.terrain.getHeightAt(camX, camZ) + 4.5, camZ);
        this.camera.lookAt(0, this.terrain.getHeightAt(0, -34) + 3.0, -34);
      }
      this.viewmodel.root.visible = false;
    } else if (this.phase === 'playing') {
      const surface = this.getActiveSurface();
      const boxCols = this.getActiveColliders();
      const cylCols = this.getActiveCylColliders();
      this.viewmodel.root.visible = true;

      if (this.fireCooldown > 0) this.fireCooldown -= dt;
      if (this.isFiringHeld && this.viewmodel.getActiveStats().auto) {
        this.tryFireWeapon();
      }

      this.player.update(dt, surface, boxCols, cylCols, this.camera, this.audio, true);
      this.camera.updateMatrixWorld();

      // Forward Wall Proximity Check (0.85m) for automatic CQB rifle tuck-in
      const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.wallRaycaster.set(this.camera.position, camFwd);
      this.wallRaycaster.far = 0.88;
      let minWallDist = 0.88;
      const tmpHit = new THREE.Vector3();
      for (const c of boxCols) {
        if (this.wallRaycaster.ray.intersectBox(c.box, tmpHit)) {
          const d = tmpHit.distanceTo(this.camera.position);
          if (d < minWallDist) minWallDist = d;
        }
      }
      for (const cyl of cylCols) {
        if (this.camera.position.y < cyl.bottomY || this.camera.position.y > cyl.topY) continue;
        const ox = cyl.x - this.camera.position.x;
        const oz = cyl.z - this.camera.position.z;
        const proj = ox * camFwd.x + oz * camFwd.z;
        if (proj > 0 && proj < minWallDist) {
          const cx = this.camera.position.x + camFwd.x * proj - cyl.x;
          const cz = this.camera.position.z + camFwd.z * proj - cyl.z;
          if (cx * cx + cz * cz < (cyl.radius + 0.14) * (cyl.radius + 0.14)) {
            minWallDist = proj;
          }
        }
      }
      const wallProx = THREE.MathUtils.clamp((0.88 - minWallDist) / 0.50, 0, 1);

      // Update Viewmodel & Foreground Camera FOV + Sun Alignment
      this.viewmodel.update(
        dt,
        this.elapsed,
        this.player.isAiming,
        this.player.moveSpeedNorm,
        this.player.isSprinting,
        this.player.isCrouching,
        wallProx,
        (stage) => this.audio.playReloadStage(stage)
      );

      const activeCfg = this.viewmodel.getActiveStats();
      const targetFov = THREE.MathUtils.lerp(
        this.settings.fov,
        this.settings.fov * activeCfg.adsFovScale,
        this.viewmodel.adsFactor
      );
      if (Math.abs(this.camera.fov - targetFov) > 0.05) {
        this.camera.fov = targetFov;
        this.camera.updateProjectionMatrix();
        this.viewmodelCamera.fov = targetFov;
        this.viewmodelCamera.updateProjectionMatrix();
      }
      const invCamQ = this.camera.quaternion.clone().invert();
      this.vmSunLight.position.copy(this.atmosphere.sunDirection).multiplyScalar(10).applyQuaternion(invCamQ);
      this.vmSunLight.intensity = isUnderground ? 0.55 + (this.flashlightOn ? 0.65 : 0) : 1.85 + flash * 2.0;
      this.vmHemiLight.intensity = isUnderground ? 0.52 + (this.flashlightOn ? 0.35 : 0) : 0.95 + flash * 0.40;

      // Shelter / Underground Audio Occlusion & Reverb Check + Low-HP Heartbeat
      this.shelterTimer -= dt;
      if (this.shelterTimer <= 0) {
        this.shelterTimer = 0.12;
        let coverHits = 0;
        const testDirs = [
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(1, 0.25, 0).normalize(),
          new THREE.Vector3(-1, 0.25, 0).normalize(),
          new THREE.Vector3(0, 0.25, 1).normalize(),
          new THREE.Vector3(0, 0.25, -1).normalize(),
        ];
        const origin = this.camera.position;
        for (let di = 0; di < testDirs.length; di++) {
          this.shelterRaycaster.set(origin, testDirs[di]);
          const maxD = di === 0 ? 4.5 : 2.6;
          for (const c of boxCols) {
            if (this.shelterRaycaster.ray.intersectBox(c.box, tmpHit) && tmpHit.distanceTo(origin) < maxD) {
              coverHits += di === 0 ? 2 : 1; // Overhead roof counts heavily!
              break;
            }
          }
        }
        this.shelterAmount = Math.min(1, coverHits / 3.0);
        const underground01 = isL2 ? THREE.MathUtils.clamp((-this.player.position.y - 0.3) / 3.5, 0, 1) : 0;
        this.audio.setEnvironmentAcoustic(underground01, Math.max(this.shelterAmount, underground01 * 0.85));
      }
      this.audio.updatePlayerVitals(this.player.hp, dt);

      // Stealth Visibility Coupling (Flashlight ON/OFF + Shot-out Lights + Dark Flank Tunnel)
      let maxSightDist = 78;
      if (isL2) {
        const p = this.player.position;
        if (p.z > 60 || p.y > -1.0) {
          maxSightDist = 36;
        } else if (this.silo.isNearBrokenLight(p)) {
          maxSightDist = 8.5;
        } else if (p.x < -6.5) {
          maxSightDist = 9.0;
        } else if (p.z < -21) {
          maxSightDist = this.silo.alarmActive ? 34 : 26;
        } else {
          maxSightDist = 14.5;
        }
        if (this.flashlightOn) {
          maxSightDist = Math.max(maxSightDist + 18, 30);
        }
        if (this.silo.alarmActive) {
          maxSightDist = Math.max(maxSightDist, 32);
        }
      }

      // Enemy AI & Fire
      this.enemies.update(
        dt,
        this.player.position,
        surface,
        boxCols,
        cylCols,
        (ev) => {
          this.combat.spawnTracer(ev.origin, ev.dir, true, ev.damage);
          this.audio.playGunshot('m4a1', ev.origin, this.shelterAmount > 0.5);
        },
        maxSightDist
      );

      // Combat Ballistics, Shells & Particles
      this.combat.update(
        dt,
        surface,
        boxCols,
        cylCols,
        this.player.position,
        this.audio,
        (dmg, sourcePos) => {
          this.stats.damageTaken += dmg;
          this.damageFlash = 0.85;
          this.player.addCameraPunch((Math.random() - 0.3) * 0.032, (Math.random() - 0.5) * 0.045);
          const dx = sourcePos.x - this.player.position.x;
          const dz = sourcePos.z - this.player.position.z;
          const worldAngle = Math.atan2(dx, -dz);
          this.hitIndAngle = worldAngle + this.player.yaw;
          this.hitIndTimer = 0.9;
          const dead = this.player.takeDamage(dmg);
          if (dead) this.finishGame(false);
        }
      );

      // Spatial Audio Listener Sync
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.audio.updateListener(this.camera.position, fwd, up);

      this.updateMissionObjectives(dt);
      this.updateHUD(dt);
    }

    if (!isL2 || !isUnderground) {
      this.csm.update();
    }
    this.postProcess.render(
      this.scene,
      this.camera,
      dt,
      this.elapsed,
      flash,
      this.phase === 'playing' ? this.viewmodelScene : undefined,
      this.phase === 'playing' ? this.viewmodelCamera : undefined
    );
  };
}

new IronRainGame();
