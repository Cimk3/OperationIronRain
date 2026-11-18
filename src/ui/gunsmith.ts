import * as THREE from 'three';
import {
  BASE_WEAPON_STATS,
  computeModifiedStats,
  getSlotOptions,
  savePlayerLoadout,
  SLOT_NAMES,
  WEAPON_SLOTS,
} from '../gameplay/loadouts';
import { applyWeaponAttachments } from '../proc/attachments';
import { createChamferedBox } from '../proc/modeling';
import { TextureLibrary } from '../proc/textures';
import {
  buildAR15,
  buildM1911,
  buildM4A1,
  buildM7,
  buildMP5SD,
  WeaponBuildResult,
} from '../proc/weapons';
import {
  AttachmentSlot,
  LevelId,
  PlayerLoadoutSave,
  PrimaryWeaponId,
  WeaponId,
} from '../types';

const SLOT_SHORT_LABELS: Record<AttachmentSlot, string> = {
  optic: '瞄具',
  muzzle: '枪口',
  underbarrel: '下挂',
  side: '侧导轨',
  mag: '弹匣',
};

export class GunsmithController {
  public scene = new THREE.Scene();
  public camera: THREE.PerspectiveCamera;
  public inspectedWeapon: WeaponId = 'm7';
  public selectedSlot: AttachmentSlot = 'optic';

  private weaponPivot = new THREE.Group();
  private weapons: Record<WeaponId, WeaponBuildResult>;
  private textures: TextureLibrary;
  private loadout: PlayerLoadoutSave;

  // Orbit, Zoom & Mechanical Swap Vibration Springs
  private yaw = Math.PI * 0.42;
  private targetYaw = Math.PI * 0.42;
  private pitch = 0.08;
  private targetPitch = 0.08;
  private zoomDist = 0.72;
  private targetZoom = 0.72;
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private swapKick = 0;
  private swapKickVel = 0;

  private nodeLayer: HTMLElement;
  private nodeButtons: Map<AttachmentSlot, HTMLButtonElement> = new Map();
  private onSnapAudio: () => void;
  private onLoadoutChanged: (save: PlayerLoadoutSave) => void;
  private onQuickDeploy: (levelId: LevelId) => void;
  private onBackMenu: () => void;
  private activeLevel: LevelId = 'level2';

  constructor(
    textures: TextureLibrary,
    initialLoadout: PlayerLoadoutSave,
    envMap: THREE.Texture | null,
    callbacks: {
      onSnapAudio: () => void;
      onLoadoutChanged: (save: PlayerLoadoutSave) => void;
      onQuickDeploy: (levelId: LevelId) => void;
      onBackMenu: () => void;
    }
  ) {
    this.textures = textures;
    this.loadout = initialLoadout;
    this.onSnapAudio = callbacks.onSnapAudio;
    this.onLoadoutChanged = callbacks.onLoadoutChanged;
    this.onQuickDeploy = callbacks.onQuickDeploy;
    this.onBackMenu = callbacks.onBackMenu;

    this.scene.background = new THREE.Color(0x0b1016);
    if (envMap) this.scene.environment = envMap;

    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.04, 20);
    this.camera.position.set(0.06, 0.08, this.zoomDist);
    this.camera.lookAt(0, 0.01, 0);

    // Studio 3-Point Armory Lighting (highlights anodized edge wear & FDE vs Gunmetal two-tone!)
    const hemi = new THREE.HemisphereLight(0x526b88, 0x161a1f, 0.95);
    const keyLight = new THREE.DirectionalLight(0xffe1b8, 2.75);
    keyLight.position.set(1.6, 2.2, 2.1);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    const rimLight = new THREE.DirectionalLight(0x5da4ff, 1.9);
    rimLight.position.set(-2.0, 1.4, -1.8);
    const underFill = new THREE.PointLight(0x38b6ff, 1.4, 3.2, 1.6);
    underFill.position.set(0.0, -0.35, 0.45);
    this.scene.add(hemi, keyLight, rimLight, underFill);

    // Armored Matte Steel Workbench Top
    const benchMat = new THREE.MeshStandardMaterial({
      color: 0x262c34,
      map: textures.industrialMetal.map,
      normalMap: textures.industrialMetal.normalMap,
      roughnessMap: textures.industrialMetal.roughnessMap,
      roughness: 0.62,
      metalness: 0.72,
    });
    const bench = new THREE.Mesh(createChamferedBox(1.8, 0.08, 0.9, 0.015, 3, 3), benchMat);
    bench.position.set(0, -0.25, 0);
    bench.receiveShadow = true;
    this.scene.add(bench);

    // Faint cyan calibration rule strip on armory desk
    const rulerMat = new THREE.MeshBasicMaterial({ color: 0x38b6ff, transparent: true, opacity: 0.32 });
    const ruler = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.004), rulerMat);
    ruler.rotation.x = -Math.PI * 0.5;
    ruler.position.set(0, -0.209, 0.22);
    this.scene.add(ruler);

    this.scene.add(this.weaponPivot);

    // Build high-poly showcase copies of all 5 weapons
    this.weapons = {
      m4a1: buildM4A1(textures),
      ar15: buildAR15(textures),
      m7: buildM7(textures),
      mp5sd: buildMP5SD(textures),
      m1911: buildM1911(textures),
    };

    for (const id of ['m4a1', 'ar15', 'm7', 'mp5sd', 'm1911'] as WeaponId[]) {
      const b = this.weapons[id];
      b.root.rotation.y = Math.PI * 0.5; // Side profile facing camera at yaw=0
      b.root.position.set(0, -0.01, id === 'm1911' ? 0 : -0.10);
      b.root.visible = id === this.inspectedWeapon;
      applyWeaponAttachments(id, b, this.loadout.configs[id], textures);
      this.weaponPivot.add(b.root);
    }

    this.nodeLayer = document.getElementById('gs-node-layer')!;
    this.createOverlayNodes();
    this.bindDOM();
    this.refreshUI();
  }

  public setLevel(level: LevelId): void {
    this.activeLevel = level;
    const lvlSelect = document.getElementById('gs-level-select') as HTMLSelectElement | null;
    if (lvlSelect) lvlSelect.value = level;
  }

  public syncLoadout(save: PlayerLoadoutSave): void {
    this.loadout = save;
    for (const id of ['m4a1', 'ar15', 'm7', 'mp5sd', 'm1911'] as WeaponId[]) {
      applyWeaponAttachments(id, this.weapons[id], this.loadout.configs[id], this.textures);
    }
    this.refreshUI();
  }

  private createOverlayNodes(): void {
    this.nodeLayer.innerHTML = '';
    this.nodeButtons.clear();
    const slots: AttachmentSlot[] = ['optic', 'muzzle', 'underbarrel', 'side', 'mag'];
    for (const slot of slots) {
      const btn = document.createElement('button');
      btn.className = 'gs-node';
      btn.dataset.slot = slot;
      btn.innerHTML = `<span class="gs-node-dot"></span><span class="gs-node-label">${SLOT_SHORT_LABELS[slot]}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedSlot = slot;
        this.onSnapAudio();
        this.refreshUI();
      });
      this.nodeLayer.appendChild(btn);
      this.nodeButtons.set(slot, btn);
    }
  }

  private bindDOM(): void {
    const stage = document.getElementById('gs-stage-area')!;

    stage.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.isDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.targetYaw += dx * 0.011;
      this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + dy * 0.008, -0.58, 0.58);
    });
    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.targetZoom = THREE.MathUtils.clamp(this.targetZoom + e.deltaY * 0.0006, 0.44, 1.08);
      },
      { passive: false }
    );

    // Weapon switcher tabs
    document.querySelectorAll<HTMLButtonElement>('.gs-weap-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.weapon as WeaponId;
        this.selectWeapon(id);
      });
    });

    const equipBtn = document.getElementById('gs-btn-equip-primary')!;
    equipBtn.addEventListener('click', () => {
      if (this.inspectedWeapon !== 'm1911') {
        this.loadout.primary = this.inspectedWeapon as PrimaryWeaponId;
        this.loadout.userSelectedPrimary = true;
        savePlayerLoadout(this.loadout);
        this.onLoadoutChanged(this.loadout);
        this.onSnapAudio();
        this.triggerSwapJolt();
        this.refreshUI();
      }
    });

    const resetViewBtn = document.getElementById('gs-btn-reset-view');
    resetViewBtn?.addEventListener('click', () => {
      this.targetYaw = Math.PI * 0.42;
      this.targetPitch = 0.08;
      this.targetZoom = 0.72;
    });

    const lvlSelect = document.getElementById('gs-level-select') as HTMLSelectElement | null;
    lvlSelect?.addEventListener('change', () => {
      this.activeLevel = lvlSelect.value as LevelId;
    });

    document.getElementById('gs-btn-back')!.addEventListener('click', () => this.onBackMenu());
    document.getElementById('gs-btn-deploy')!.addEventListener('click', () => {
      // Automatically equip currently viewed primary rifle/SMG when jumping straight into range/mission!
      if (this.inspectedWeapon !== 'm1911') {
        this.loadout.primary = this.inspectedWeapon as PrimaryWeaponId;
        this.loadout.userSelectedPrimary = true;
        savePlayerLoadout(this.loadout);
        this.onLoadoutChanged(this.loadout);
      }
      this.onQuickDeploy(this.activeLevel);
    });
  }

  public selectWeapon(id: WeaponId): void {
    this.weapons[this.inspectedWeapon].root.visible = false;
    this.inspectedWeapon = id;
    this.weapons[id].root.visible = true;
    const allowed = WEAPON_SLOTS[id];
    if (allowed.length > 0 && !allowed.includes(this.selectedSlot)) {
      this.selectedSlot = allowed[0];
    }
    this.onSnapAudio();
    this.triggerSwapJolt();
    this.refreshUI();
  }

  private triggerSwapJolt(): void {
    this.swapKickVel = 0.35;
  }

  public refreshUI(): void {
    const id = this.inspectedWeapon;
    const baseStats = BASE_WEAPON_STATS[id];
    const modStats = computeModifiedStats(id, this.loadout.configs[id]);
    const allowedSlots = WEAPON_SLOTS[id];

    document.querySelectorAll<HTMLButtonElement>('.gs-weap-btn').forEach((btn) => {
      const wid = btn.dataset.weapon as WeaponId;
      btn.classList.toggle('active', wid === id);
      btn.classList.toggle('equipped', wid === this.loadout.primary || wid === this.loadout.secondary);
    });

    document.getElementById('gs-weapon-title')!.textContent = baseStats.name;
    document.getElementById('gs-weapon-role')!.textContent = `${baseStats.roleTag} • ${baseStats.caliber} • ${this.weapons[id].triangleCount.toLocaleString()} 三角面`;

    const equipBtn = document.getElementById('gs-btn-equip-primary') as HTMLButtonElement;
    if (id === 'm1911') {
      equipBtn.textContent = '副武器已默认携带';
      equipBtn.disabled = true;
    } else if (this.loadout.primary === id) {
      equipBtn.textContent = '✓ 已设为主武器';
      equipBtn.disabled = false;
    } else {
      equipBtn.textContent = '设为主武器带入战斗';
      equipBtn.disabled = false;
    }

    // Slot Tabs
    const slotTabsEl = document.getElementById('gs-slot-tabs')!;
    slotTabsEl.innerHTML = '';
    if (allowedSlots.length === 0) {
      slotTabsEl.innerHTML = '<div class="gs-empty-note">副武器手枪采用固定战术出厂配置</div>';
      document.getElementById('gs-options-list')!.innerHTML = '';
    } else {
      for (const slot of allowedSlots) {
        const tab = document.createElement('button');
        tab.className = `gs-slot-tab${slot === this.selectedSlot ? ' active' : ''}`;
        tab.textContent = SLOT_NAMES[slot];
        tab.addEventListener('click', () => {
          this.selectedSlot = slot;
          this.onSnapAudio();
          this.refreshUI();
        });
        slotTabsEl.appendChild(tab);
      }

      // Options for selected slot
      const optsEl = document.getElementById('gs-options-list')!;
      optsEl.innerHTML = '';
      const opts = getSlotOptions(id, this.selectedSlot);
      const currentVal = this.loadout.configs[id][this.selectedSlot];

      for (const opt of opts) {
        const card = document.createElement('button');
        card.className = `gs-opt-card${opt.id === currentVal ? ' active' : ''}`;
        card.innerHTML = `<div class="gs-opt-name">${opt.label}</div><div class="gs-opt-desc">${opt.desc}</div>`;
        card.addEventListener('click', () => {
          (this.loadout.configs[id] as unknown as Record<string, string>)[this.selectedSlot] = opt.id;
          applyWeaponAttachments(id, this.weapons[id], this.loadout.configs[id], this.textures);
          if (id !== 'm1911') {
            this.loadout.primary = id as PrimaryWeaponId;
            this.loadout.userSelectedPrimary = true;
          }
          savePlayerLoadout(this.loadout);
          this.onLoadoutChanged(this.loadout);
          this.onSnapAudio();
          this.triggerSwapJolt();
          this.refreshUI();
        });
        optsEl.appendChild(card);
      }
    }

    // Update 5 Live Stat Bars with Base vs Modified Comparison
    const baseBars = computeModifiedStats(id, {
      optic: 'iron',
      muzzle: id === 'mp5sd' ? 'suppressor' : 'default',
      underbarrel: 'none',
      side: 'none',
      mag: 'standard',
    }).uiBars;

    const metrics: Array<{ key: keyof typeof modStats.uiBars; label: string; idPrefix: string }> = [
      { key: 'damage', label: '伤害 (DAMAGE)', idPrefix: 'stat-dmg' },
      { key: 'fireRate', label: '射速 (FIRE RATE)', idPrefix: 'stat-rpm' },
      { key: 'recoilControl', label: '后坐力控制 (CONTROL)', idPrefix: 'stat-rec' },
      { key: 'adsSpeed', label: '开镜速度 (ADS SPEED)', idPrefix: 'stat-ads' },
      { key: 'mobility', label: '机动性 (MOBILITY)', idPrefix: 'stat-mob' },
    ];

    for (const m of metrics) {
      const val = modStats.uiBars[m.key];
      const baseV = baseBars[m.key];
      const delta = val - baseV;
      const barEl = document.getElementById(`${m.idPrefix}-bar`);
      const valEl = document.getElementById(`${m.idPrefix}-val`);
      if (barEl) barEl.style.width = `${val}%`;
      if (valEl) {
        const dStr =
          delta > 0
            ? `<span class="delta-pos">+${delta}</span>`
            : delta < 0
              ? `<span class="delta-neg">${delta}</span>`
              : '';
        valEl.innerHTML = `${val} ${dStr}`;
      }
    }

    const ammoHint = document.getElementById('gs-ammo-summary');
    if (ammoHint) {
      ammoHint.textContent = `弹匣容量: ${modStats.magSize} 发 | 声学半径: ${modStats.hearingRadius}m | 手电: ${modStats.hasFlashlight ? '已挂载' : '未安装'}`;
    }
  }

  public update(dt: number, width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    // Smooth camera/model orbit & swap jolt spring
    this.yaw = THREE.MathUtils.lerp(this.yaw, this.targetYaw, Math.min(1, dt * 11));
    this.pitch = THREE.MathUtils.lerp(this.pitch, this.targetPitch, Math.min(1, dt * 11));
    this.zoomDist = THREE.MathUtils.lerp(this.zoomDist, this.targetZoom, Math.min(1, dt * 10));

    // Critically damped swap detent pulse
    const springF = -this.swapKick * 340 - this.swapKickVel * 22;
    this.swapKickVel += springF * Math.min(0.03, dt);
    this.swapKick += this.swapKickVel * Math.min(0.03, dt);

    this.weaponPivot.rotation.set(this.pitch + this.swapKick * 0.45, this.yaw, this.swapKick * 0.65);
    this.weaponPivot.position.set(0, this.swapKick * 0.08, 0);
    this.camera.position.set(0, 0.04, this.zoomDist);
    this.camera.lookAt(0, 0.0, 0);
    this.scene.updateMatrixWorld(true);

    // Project 3D attachment socket anchors onto screen pixel coordinates
    const allowed = WEAPON_SLOTS[this.inspectedWeapon];
    const build = this.weapons[this.inspectedWeapon];
    const s = build.sockets;

    const slotLocalCoords: Record<AttachmentSlot, THREE.Vector3> = {
      optic: new THREE.Vector3(0, s.opticMountY + 0.015, s.opticMountZ),
      muzzle: new THREE.Vector3(0, s.muzzleMountY, s.muzzleMountZ + 0.04),
      underbarrel: new THREE.Vector3(0, s.underMountY - 0.025, s.underMountZ),
      side: new THREE.Vector3(s.sideMountX, s.sideMountY, s.sideMountZ),
      mag: build.magSocket.position.clone().add(new THREE.Vector3(0, -0.07, 0)),
    };

    const tmp = new THREE.Vector3();
    for (const [slot, btn] of this.nodeButtons.entries()) {
      if (!allowed.includes(slot)) {
        btn.classList.add('hidden');
        continue;
      }
      btn.classList.remove('hidden');
      btn.classList.toggle('active', slot === this.selectedSlot);

      tmp.copy(slotLocalCoords[slot]).applyMatrix4(build.root.matrixWorld).project(this.camera);
      const sx = (tmp.x * 0.5 + 0.5) * width;
      const sy = (-tmp.y * 0.5 + 0.5) * height;
      btn.style.left = `${Math.round(sx)}px`;
      btn.style.top = `${Math.round(sy)}px`;
    }
  }
}
