import * as THREE from 'three';
import {
  ANGLED_GRIP_LEFT_POSE,
  applyFingerPose,
  FirstPersonArmsSystem,
  M4_LEFT_POSE,
  M4_RIGHT_FIRE_POSE,
  M4_RIGHT_POSE,
  MAG_HOLD_POSE,
  PISTOL_LEFT_POSE,
  PISTOL_RIGHT_FIRE_POSE,
  PISTOL_RIGHT_POSE,
  solveArmIK,
  VERT_GRIP_LEFT_POSE,
} from '../proc/arms';
import { applyWeaponAttachments } from '../proc/attachments';
import { TextureLibrary } from '../proc/textures';
import {
  buildAR15,
  buildM1911,
  buildM4A1,
  buildM7,
  buildMP5SD,
  WeaponBuildResult,
} from '../proc/weapons';
import { PlayerLoadoutSave, WeaponId } from '../types';
import {
  BASE_WEAPON_STATS,
  ComputedWeaponStats,
  computeModifiedStats,
  createDefaultLoadoutSave,
  WeaponStats,
} from './loadouts';

export type { WeaponStats, ComputedWeaponStats };
export const WEAPON_CONFIGS = BASE_WEAPON_STATS;

/**
 * Second-order critically/under-damped Spring-Damper solver (no robotic linear lerp!).
 */
class Spring1 {
  public value = 0;
  public velocity = 0;
  public target = 0;
  constructor(public stiffness: number, public damping: number, initial = 0) {
    this.value = initial;
    this.target = initial;
  }
  public impulse(dv: number): void {
    this.velocity += dv;
  }
  public step(dt: number): number {
    const stepDt = Math.min(0.025, dt);
    const force = (this.target - this.value) * this.stiffness;
    this.velocity += (force - this.velocity * this.damping) * stepDt;
    this.value += this.velocity * stepDt;
    return this.value;
  }
}

class Spring3 {
  public value = new THREE.Vector3();
  public velocity = new THREE.Vector3();
  public target = new THREE.Vector3();
  constructor(public stiffness: number, public damping: number) {}
  public impulse(dx: number, dy: number, dz: number): void {
    this.velocity.x += dx;
    this.velocity.y += dy;
    this.velocity.z += dz;
  }
  public step(dt: number): THREE.Vector3 {
    const stepDt = Math.min(0.025, dt);
    const ax = (this.target.x - this.value.x) * this.stiffness - this.velocity.x * this.damping;
    const ay = (this.target.y - this.value.y) * this.stiffness - this.velocity.y * this.damping;
    const az = (this.target.z - this.value.z) * this.stiffness - this.velocity.z * this.damping;
    this.velocity.x += ax * stepDt;
    this.velocity.y += ay * stepDt;
    this.velocity.z += az * stepDt;
    this.value.x += this.velocity.x * stepDt;
    this.value.y += this.velocity.y * stepDt;
    this.value.z += this.velocity.z * stepDt;
    return this.value;
  }
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export interface WeaponRuntimeState {
  mag: number;
  reserve: number;
}

export class ViewmodelController {
  public root = new THREE.Group();
  public weaponPivot = new THREE.Group();
  public arms: FirstPersonArmsSystem;
  public weapons: Record<WeaponId, WeaponBuildResult>;
  public activeWeapon: WeaponId = 'm4a1';
  public loadouts: PlayerLoadoutSave = createDefaultLoadoutSave();
  public modifiedStats: Record<WeaponId, ComputedWeaponStats>;
  private textures: TextureLibrary;

  public state: Record<WeaponId, WeaponRuntimeState> = {
    m4a1: { mag: 30, reserve: 150 },
    ar15: { mag: 20, reserve: 100 },
    m7: { mag: 20, reserve: 120 },
    mp5sd: { mag: 30, reserve: 180 },
    m1911: { mag: 8, reserve: 48 },
  };

  public adsFactor = 0;
  public isReloading = false;
  public isEmptyReload = false;
  public reloadTimer = 0;
  private reloadStageFired = { out: false, in: false, rack: false };
  public switchTimer = 0;
  public slideLockedBack = false;

  // Spring-Damper Physics Channels
  private adsSpring = new Spring1(210, 25, 0);
  private sprintSpring = new Spring1(135, 19, 0);
  private wallTuckSpring = new Spring1(185, 22, 0);
  private equipSpring = new Spring1(180, 20, 0);
  private swaySpring = new Spring3(160, 18); // Angular velocity inertial lag
  private recoilPosSpring = new Spring3(310, 24);
  private recoilRotSpring = new Spring3(290, 22);
  private reloadPulseSpring = new Spring3(360, 22);
  private boltSpring = new Spring1(520, 26, 0);

  private triggerPullTimer = 0;
  private muzzleFlashTimer = 0;
  private muzzleFlashMesh: THREE.Group;
  private muzzleLight: THREE.PointLight;
  private bobPhase = 0;

  // Reusable math objects
  private tmpRightTarget = new THREE.Vector3();
  private tmpLeftTarget = new THREE.Vector3();
  private tmpRightQuat = new THREE.Quaternion();
  private tmpLeftQuat = new THREE.Quaternion();
  private tmpMat = new THREE.Matrix4();
  private tmpVec = new THREE.Vector3();

  constructor(textures: TextureLibrary) {
    this.textures = textures;
    this.root.name = 'ViewmodelRoot';
    this.weaponPivot.name = 'WeaponPivot';
    this.root.add(this.weaponPivot);

    this.weapons = {
      m4a1: buildM4A1(textures),
      ar15: buildAR15(textures),
      m7: buildM7(textures),
      mp5sd: buildMP5SD(textures),
      m1911: buildM1911(textures),
    };

    const allIds: WeaponId[] = ['m4a1', 'ar15', 'm7', 'mp5sd', 'm1911'];
    for (const id of allIds) {
      const w = this.weapons[id];
      w.root.rotation.y = Math.PI;
      w.root.visible = id === this.activeWeapon;
      this.weaponPivot.add(w.root);
    }

    this.modifiedStats = {
      m4a1: computeModifiedStats('m4a1', this.loadouts.configs.m4a1),
      ar15: computeModifiedStats('ar15', this.loadouts.configs.ar15),
      m7: computeModifiedStats('m7', this.loadouts.configs.m7),
      mp5sd: computeModifiedStats('mp5sd', this.loadouts.configs.mp5sd),
      m1911: computeModifiedStats('m1911', this.loadouts.configs.m1911),
    };

    this.arms = new FirstPersonArmsSystem(textures);
    this.root.add(this.arms.group);

    // Soft Volumetric Starburst Muzzle Flash Texture + Dynamic Light
    this.muzzleFlashMesh = new THREE.Group();
    const mfCanvas = document.createElement('canvas');
    mfCanvas.width = 128;
    mfCanvas.height = 128;
    const mctx = mfCanvas.getContext('2d')!;
    mctx.clearRect(0, 0, 128, 128);
    const grad = mctx.createRadialGradient(24, 64, 2, 56, 64, 60);
    grad.addColorStop(0.0, 'rgba(255, 252, 230, 1.0)');
    grad.addColorStop(0.25, 'rgba(255, 195, 90, 0.85)');
    grad.addColorStop(0.65, 'rgba(255, 120, 30, 0.35)');
    grad.addColorStop(1.0, 'rgba(255, 80, 10, 0.0)');
    mctx.fillStyle = grad;
    mctx.beginPath();
    mctx.ellipse(58, 64, 56, 26, 0, 0, Math.PI * 2);
    mctx.fill();
    const mfTex = new THREE.CanvasTexture(mfCanvas);

    const flashMat = new THREE.MeshBasicMaterial({
      map: mfTex,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 3; i++) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.085), flashMat);
      plane.rotation.y = Math.PI * 0.5;
      plane.rotation.x = (i / 3) * Math.PI;
      plane.position.z = 0.065;
      this.muzzleFlashMesh.add(plane);
    }
    this.muzzleFlashMesh.visible = false;
    this.weapons.m4a1.muzzlePoint.add(this.muzzleFlashMesh);

    this.muzzleLight = new THREE.PointLight(0xffaa44, 0, 9, 2.0);
    this.weapons.m4a1.muzzlePoint.add(this.muzzleLight);
  }

  public getActiveBuild(): WeaponBuildResult {
    return this.weapons[this.activeWeapon];
  }

  public getActiveStats(): ComputedWeaponStats {
    return this.modifiedStats[this.activeWeapon];
  }

  public applyLoadouts(save: PlayerLoadoutSave, resetAmmo = false): void {
    this.loadouts = save;
    const allIds: WeaponId[] = ['m4a1', 'ar15', 'm7', 'mp5sd', 'm1911'];
    for (const id of allIds) {
      const cfg = save.configs[id];
      applyWeaponAttachments(id, this.weapons[id], cfg, this.textures);
      const stats = computeModifiedStats(id, cfg);
      this.modifiedStats[id] = stats;
      if (resetAmmo) {
        this.state[id] = {
          mag: stats.magSize,
          reserve: stats.reserveMax - stats.magSize,
        };
      } else {
        this.state[id].mag = Math.min(this.state[id].mag, stats.magSize);
      }
    }
  }

  public switchWeapon(id: WeaponId): boolean {
    if (this.activeWeapon === id) return false;
    this.cancelReload();
    this.weapons[this.activeWeapon].root.visible = false;
    this.activeWeapon = id;
    const next = this.weapons[id];
    next.root.visible = true;
    next.muzzlePoint.add(this.muzzleFlashMesh);
    next.muzzlePoint.add(this.muzzleLight);
    this.switchTimer = 0.34;
    this.equipSpring.value = 1.0;
    this.equipSpring.velocity = -2.2;
    this.adsSpring.value = 0;
    this.adsSpring.target = 0;
    this.adsFactor = 0;
    this.slideLockedBack = id === 'm1911' && this.state.m1911.mag === 0;
    return true;
  }

  public startReload(): boolean {
    const st = this.state[this.activeWeapon];
    const cfg = this.getActiveStats();
    if (this.isReloading || this.switchTimer > 0) return false;
    if (st.mag >= cfg.magSize || st.reserve <= 0) return false;

    this.isReloading = true;
    this.isEmptyReload = st.mag === 0;
    this.reloadTimer = 0;
    this.reloadStageFired = { out: false, in: false, rack: false };
    this.reloadPulseSpring.impulse(0, -0.18, 0);
    return true;
  }

  public cancelReload(): void {
    if (!this.isReloading) return;
    const w = this.weapons[this.activeWeapon];
    w.magazine.position.copy(w.magSocket.position);
    w.magazine.quaternion.identity();
    if (w.chargingHandle) {
      if (this.activeWeapon === 'm4a1' || this.activeWeapon === 'ar15') w.chargingHandle.position.z = -0.104;
      if (this.activeWeapon === 'm7') w.chargingHandle.position.z = -0.108;
      if (this.activeWeapon === 'mp5sd') {
        w.chargingHandle.position.z = 0.175;
        w.chargingHandle.rotation.z = 0;
      }
    }
    if (w.sideChargingHandle) {
      w.sideChargingHandle.position.z = 0.048;
    }
    this.isReloading = false;
    this.reloadTimer = 0;
  }

  public triggerFireVisuals(): void {
    const cfg = this.getActiveStats();
    const adsScale = 1.0 - this.adsFactor * 0.48;
    this.recoilPosSpring.impulse(
      (Math.random() - 0.5) * 0.14 * adsScale,
      0.16 * adsScale,
      cfg.recoilKickZ * 26 * adsScale
    );
    this.recoilRotSpring.impulse(
      cfg.recoilPitch * 32 * adsScale,
      (Math.random() - 0.5) * cfg.recoilYaw * 28 * adsScale,
      (Math.random() - 0.5) * 0.65
    );
    this.boltSpring.value = 1.0;
    this.boltSpring.velocity = -4.0;
    this.triggerPullTimer = 0.24;

    if (this.activeWeapon === 'm1911' && this.state.m1911.mag === 0) {
      this.slideLockedBack = true;
    }

    const flashScale = cfg.muzzleFlashScale;
    this.muzzleFlashTimer = cfg.isSuppressed ? 0.022 : 0.045;
    this.muzzleFlashMesh.visible = true;
    this.muzzleFlashMesh.rotation.z = Math.random() * Math.PI * 2;
    const s = (0.85 + Math.random() * 0.42) * flashScale;
    this.muzzleFlashMesh.scale.set(s, s, s);
    this.muzzleLight.intensity = 5.5 * flashScale;
  }

  /**
   * Drives Spring-Damper inertial lag from mouse angular velocity.
   */
  public addLookSway(dx: number, dy: number): void {
    this.swaySpring.impulse(-dx * 0.025, dy * 0.025, -dx * 0.045);
  }

  public getMuzzleWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    this.weapons[this.activeWeapon].muzzlePoint.getWorldPosition(out);
    return out;
  }

  public getEjectWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    this.weapons[this.activeWeapon].ejectPoint.getWorldPosition(out);
    return out;
  }

  public update(
    dt: number,
    elapsed: number,
    isAiming: boolean,
    moveSpeedNorm: number,
    isSprinting: boolean,
    isCrouching: boolean,
    wallProximity = 0,
    onReloadSound?: (stage: 'mag_out' | 'mag_in' | 'rack') => void
  ): void {
    const cfg = this.getActiveStats();
    const w = this.weapons[this.activeWeapon];
    const isM4 = this.activeWeapon === 'm4a1';
    const isAR15 = this.activeWeapon === 'ar15';
    const isM7 = this.activeWeapon === 'm7';
    const isMP5 = this.activeWeapon === 'mp5sd';
    const isRiflePlatform = isM4 || isAR15 || isM7;
    const isRifleOrSmg = isRiflePlatform || isMP5;

    if (this.triggerPullTimer > 0) this.triggerPullTimer = Math.max(0, this.triggerPullTimer - dt);

    // 1. Spring-Damper ADS (modulated by optic/underbarrel/mag adsSpeedScale!), Sprint, Wall-Tuck & Equip
    this.wallTuckSpring.target = THREE.MathUtils.clamp(wallProximity, 0, 1);
    const wallTuck = THREE.MathUtils.clamp(this.wallTuckSpring.step(dt), 0, 1.1);

    const canAim = isAiming && !this.isReloading && !isSprinting && this.switchTimer <= 0 && wallTuck < 0.25;
    this.adsSpring.target = canAim ? 1.0 : 0.0;
    this.adsFactor = THREE.MathUtils.clamp(this.adsSpring.step(dt * cfg.adsSpeedScale), 0, 1);

    this.sprintSpring.target = isSprinting && !this.isReloading ? 1.0 : 0.0;
    const sprintBlend = THREE.MathUtils.clamp(this.sprintSpring.step(dt), 0, 1.15);

    if (this.switchTimer > 0) this.switchTimer = Math.max(0, this.switchTimer - dt);
    this.equipSpring.target = 0;
    const equipDrop = Math.max(0, this.equipSpring.step(dt)) * 0.16;

    // 2. Reload Progress (Distinct Tactical Reload vs Empty Reload!)
    let reloadProg = 0;
    const totalReloadDur = this.isEmptyReload ? cfg.reloadDuration : cfg.tacticalReloadDuration;
    if (this.isReloading) {
      this.reloadTimer += dt;
      reloadProg = Math.min(1, this.reloadTimer / totalReloadDur);

      if (reloadProg >= 0.18 && !this.reloadStageFired.out) {
        this.reloadStageFired.out = true;
        this.reloadPulseSpring.impulse(0, -0.24, 0.08);
        onReloadSound?.('mag_out');
      }
      const seatTime = this.isEmptyReload ? 0.56 : 0.72;
      if (reloadProg >= seatTime && !this.reloadStageFired.in) {
        this.reloadStageFired.in = true;
        // Crisp upward seating detent click!
        this.reloadPulseSpring.impulse(0.05, 0.45, -0.14);
        onReloadSound?.('mag_in');
      }
      if (this.isEmptyReload && reloadProg >= 0.78 && !this.reloadStageFired.rack) {
        this.reloadStageFired.rack = true;
        // Classic crisp downward "HK Slap" impulse on MP5SD vs bolt rack on M4/M1911
        this.reloadPulseSpring.impulse(isMP5 ? 0.14 : -0.08, isMP5 ? -0.42 : -0.12, 0.25);
        if (!isRifleOrSmg) {
          this.slideLockedBack = false;
          this.boltSpring.value = 1.0;
          this.boltSpring.velocity = -14.0;
        }
        onReloadSound?.('rack');
      }

      if (reloadProg >= 1.0) {
        const st = this.state[this.activeWeapon];
        const needed = cfg.magSize - st.mag;
        const take = Math.min(needed, st.reserve);
        st.mag += take;
        st.reserve -= take;
        this.slideLockedBack = false;
        this.cancelReload();
      }
    }

    // 3. Spring-Damper Sway, Recoil, Reload Impulse
    const sway = this.swaySpring.step(dt);
    const recPos = this.recoilPosSpring.step(dt);
    const recRot = this.recoilRotSpring.step(dt);
    const relPulse = this.reloadPulseSpring.step(dt);

    // 4. Figure-8 Idle Breathing & Walk/Sprint Gait
    if (moveSpeedNorm > 0.05) {
      this.bobPhase += dt * (isSprinting ? 11.8 : 8.2) * Math.min(1.2, moveSpeedNorm);
    }
    const moveAtten = (1.0 - this.adsFactor * 0.88) * Math.min(1, moveSpeedNorm);
    const bobX = Math.sin(this.bobPhase * 0.5) * 0.011 * moveAtten + sprintBlend * Math.sin(this.bobPhase * 0.5) * 0.018;
    const bobY = Math.abs(Math.cos(this.bobPhase * 0.5)) * -0.011 * moveAtten - sprintBlend * Math.abs(Math.cos(this.bobPhase * 0.5)) * 0.015;

    // Lissajous Figure-8 Breathing Sway
    const breathAmp = 1.0 - this.adsFactor * 0.72;
    const fig8X = Math.sin(elapsed * 1.45) * 0.0022 * breathAmp;
    const fig8Y = Math.sin(elapsed * 2.90) * 0.0014 * breathAmp;

    // 5. Weapon Pivot Position & Orientation
    const hipPos = isRiflePlatform
      ? new THREE.Vector3(0.145, -0.155, -0.41)
      : isMP5
        ? new THREE.Vector3(0.140, -0.150, -0.39)
        : new THREE.Vector3(0.14, -0.145, -0.47);
    // Exact 1px ADS Alignment: active optic/iron centerline maps precisely to (0, 0) optical axis!
    const adsPos = new THREE.Vector3(
      -w.sightAlignOffset.x,
      isRifleOrSmg ? -w.sightAlignOffset.y : -w.sightAlignOffset.y + 0.005,
      isRiflePlatform ? -0.372 : isMP5 ? -0.365 : -0.48
    );

    const adsT = easeOutBack(this.adsFactor * 0.96 + (this.adsFactor > 0.99 ? 0.04 : 0));
    const basePos = hipPos.lerp(adsPos, THREE.MathUtils.clamp(adsT, 0, 1.02));

    // Tactical Cross-Chest Low-Ready Sprint Pose (clears center screen, zero chest clipping!)
    basePos.x -= sprintBlend * 0.14;
    basePos.y -= sprintBlend * 0.065;
    basePos.z += sprintBlend * 0.025;

    // Wall-Tuck High/Close CQB Pullback when standing within 0.85m of walls/trees/sandbags
    basePos.x -= wallTuck * 0.075;
    basePos.y += wallTuck * 0.025;
    basePos.z += wallTuck * 0.175;

    // Reload weapon cant
    let reloadRoll = 0;
    let reloadPitch = 0;
    if (this.isReloading) {
      const tiltEnv = Math.sin(reloadProg * Math.PI);
      reloadRoll = 0.25 * tiltEnv;
      reloadPitch = 0.20 * tiltEnv;
      basePos.x -= 0.036 * tiltEnv;
      basePos.y += 0.032 * tiltEnv;
    }

    const swayScale = 1.0 - this.adsFactor * 0.78;
    this.weaponPivot.position.set(
      basePos.x + THREE.MathUtils.clamp(sway.x * 0.02, -0.025, 0.025) * swayScale + bobX + fig8X + recPos.x + relPulse.x,
      basePos.y + THREE.MathUtils.clamp(sway.y * 0.02, -0.022, 0.022) * swayScale + bobY + fig8Y + recPos.y + relPulse.y - equipDrop,
      basePos.z + recPos.z + relPulse.z
    );

    const hipYaw = isRiflePlatform ? 0.024 : isMP5 ? 0.022 : 0.016;
    const baseRotY = THREE.MathUtils.lerp(hipYaw, 0.0, this.adsFactor) + sprintBlend * 0.68 + wallTuck * 0.58;
    const baseRotX = sprintBlend * -0.22 + wallTuck * 0.36 + reloadPitch - equipDrop * 1.4;
    const baseRotZ = (isCrouching ? 0.035 * (1 - this.adsFactor) : 0) + reloadRoll + sprintBlend * 0.28 + wallTuck * 0.22;

    this.weaponPivot.rotation.set(
      baseRotX + recRot.x + THREE.MathUtils.clamp(sway.y * 0.04, -0.05, 0.05) * swayScale,
      baseRotY + recRot.y + THREE.MathUtils.clamp(sway.x * 0.04, -0.05, 0.05) * swayScale,
      baseRotZ + recRot.z + THREE.MathUtils.clamp(sway.z * 0.03, -0.07, 0.07) * swayScale
    );

    // 6. Bolt / Slide / Charging Handle / Side Charging Handle / Muzzle Flash
    this.boltSpring.target = !isRifleOrSmg && this.slideLockedBack ? 1.0 : 0.0;
    const boltVal = Math.max(0, this.boltSpring.step(dt));

    if (isRiflePlatform) {
      w.boltOrSlide.position.z = (isM7 ? 0.024 : 0.022) - boltVal * 0.038;
      const rackPull =
        this.isReloading && this.isEmptyReload && reloadProg > 0.76 && reloadProg < 0.92
          ? Math.sin(((reloadProg - 0.76) / 0.16) * Math.PI) * 0.055
          : 0;
      if (isM7 && w.sideChargingHandle) {
        w.sideChargingHandle.position.z = 0.048 - rackPull;
      } else if (w.chargingHandle) {
        w.chargingHandle.position.z = (isM7 ? -0.108 : -0.104) - rackPull;
      }
    } else if (isMP5) {
      w.boltOrSlide.position.z = 0.002 - boltVal * 0.028;
      if (w.chargingHandle) {
        // MP5SD HK Slap: locks cocking handle back/up at start, then slaps down-forward at 0.80!
        if (this.isReloading && this.isEmptyReload) {
          if (reloadProg < 0.76) {
            w.chargingHandle.position.z = 0.125; // Locked back in notch
            w.chargingHandle.rotation.z = 0.48;
          } else if (reloadProg < 0.84) {
            const snap = (reloadProg - 0.76) / 0.08;
            w.chargingHandle.position.z = THREE.MathUtils.lerp(0.125, 0.175, snap * snap);
            w.chargingHandle.rotation.z = THREE.MathUtils.lerp(0.48, 0.0, snap);
          } else {
            w.chargingHandle.position.z = 0.175;
            w.chargingHandle.rotation.z = 0;
          }
        } else {
          w.chargingHandle.position.z = 0.175;
          w.chargingHandle.rotation.z = 0;
        }
      }
    } else {
      w.boltOrSlide.position.z = -boltVal * 0.036;
      if (w.hammer) {
        w.hammer.rotation.x = -(this.slideLockedBack ? 0.55 : boltVal * 0.55);
      }
    }

    if (this.muzzleFlashTimer > 0) {
      this.muzzleFlashTimer -= dt;
      if (this.muzzleFlashTimer <= 0) {
        this.muzzleFlashMesh.visible = false;
        this.muzzleLight.intensity = 0;
      }
    }

    this.root.updateMatrixWorld(true);
    const rootInv = this.tmpMat.copy(this.root.matrixWorld).invert();

    // 7. RIGHT ARM IK + TRIGGER DISCIPLINE FINGER POSE
    w.rightGripSocket.getWorldPosition(this.tmpRightTarget);
    this.tmpRightTarget.applyMatrix4(rootInv);

    const rWristOffset = isRifleOrSmg
      ? new THREE.Vector3(0.024, -0.016, 0.046)
      : new THREE.Vector3(0.022, -0.012, 0.044);

    const rZ = new THREE.Vector3(-0.42, -0.16, -0.89).normalize();
    const rY = new THREE.Vector3(0.89, 0.08, -0.44).normalize();
    const rX = new THREE.Vector3().crossVectors(rY, rZ).normalize();
    const rYOrtho = new THREE.Vector3().crossVectors(rZ, rX).normalize();
    const rPalmMat = new THREE.Matrix4().makeBasis(rX, rYOrtho, rZ);

    const weapWorldQ = new THREE.Quaternion();
    this.weaponPivot.getWorldQuaternion(weapWorldQ);
    const rootQInv = new THREE.Quaternion();
    this.root.getWorldQuaternion(rootQInv).invert();
    const weapLocalQ = rootQInv.multiply(weapWorldQ);

    rPalmMat.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(weapLocalQ));
    this.tmpRightQuat.setFromRotationMatrix(rPalmMat);

    const rWristPos = this.tmpRightTarget.clone().add(rWristOffset.clone().applyQuaternion(weapLocalQ));
    const rElbowPole = new THREE.Vector3(0.32, -0.45, 0.15);
    solveArmIK(this.arms.rightArm, rWristPos, this.tmpRightQuat, rElbowPole);

    // Index finger trigger discipline: snaps onto trigger on fire, rests along guard when idle!
    const firingRight = this.triggerPullTimer > 0;
    const rightPose = isRifleOrSmg
      ? firingRight ? M4_RIGHT_FIRE_POSE : M4_RIGHT_POSE
      : firingRight ? PISTOL_RIGHT_FIRE_POSE : PISTOL_RIGHT_POSE;
    applyFingerPose(this.arms.rightArm, rightPose, Math.min(1, dt * 24));

    // 8. LEFT ARM IK (Dynamically switches between Handguard C-clamp, Vertical Foregrip Fist, Angled Foregrip Cradle!)
    w.leftGripSocket.getWorldPosition(this.tmpLeftTarget);
    this.tmpLeftTarget.applyMatrix4(rootInv);

    let lWristPos: THREE.Vector3;
    let lFingerPose = !isRifleOrSmg
      ? PISTOL_LEFT_POSE
      : w.currentGripStyle === 'vertical'
        ? VERT_GRIP_LEFT_POSE
        : w.currentGripStyle === 'angled'
          ? ANGLED_GRIP_LEFT_POSE
          : M4_LEFT_POSE;

    const lZ = !isRifleOrSmg
      ? new THREE.Vector3(0.58, -0.15, -0.80).normalize()
      : w.currentGripStyle === 'vertical'
        ? new THREE.Vector3(0.46, -0.04, -0.88).normalize()
        : w.currentGripStyle === 'angled'
          ? new THREE.Vector3(0.50, 0.34, -0.80).normalize()
          : new THREE.Vector3(0.62, 0.36, -0.69).normalize();

    const lY = !isRifleOrSmg
      ? new THREE.Vector3(-0.82, -0.12, -0.56).normalize()
      : w.currentGripStyle === 'vertical'
        ? new THREE.Vector3(-0.88, 0.12, 0.46).normalize()
        : w.currentGripStyle === 'angled'
          ? new THREE.Vector3(-0.42, -0.84, -0.34).normalize()
          : new THREE.Vector3(-0.48, -0.78, 0.40).normalize();

    const lX = new THREE.Vector3().crossVectors(lY, lZ).normalize();
    const lYOrtho = new THREE.Vector3().crossVectors(lZ, lX).normalize();
    const lPalmMat = new THREE.Matrix4().makeBasis(lX, lYOrtho, lZ);
    lPalmMat.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(weapLocalQ));
    this.tmpLeftQuat.setFromRotationMatrix(lPalmMat);

    const lYWorld = new THREE.Vector3().setFromMatrixColumn(lPalmMat, 1).normalize();
    const lZWorld = new THREE.Vector3().setFromMatrixColumn(lPalmMat, 2).normalize();

    let defaultLeftWrist: THREE.Vector3;
    if (!isRifleOrSmg) {
      defaultLeftWrist = this.tmpLeftTarget.clone().add(new THREE.Vector3(-0.034, -0.012, 0.038).applyQuaternion(weapLocalQ));
    } else if (w.currentGripStyle === 'vertical') {
      // Locks curved fist palm tightly onto the downward vertical grip post (centered at x=0, radius 0.015)
      defaultLeftWrist = this.tmpLeftTarget.clone().addScaledVector(lZWorld, -0.068).addScaledVector(lYWorld, 0.025);
    } else if (w.currentGripStyle === 'angled') {
      // Cradles the 32-degree angled foregrip slope seamlessly
      defaultLeftWrist = this.tmpLeftTarget.clone().addScaledVector(lZWorld, -0.062).addScaledVector(lYWorld, 0.024);
    } else {
      defaultLeftWrist = this.tmpLeftTarget
        .clone()
        .add(new THREE.Vector3(isMP5 ? -0.046 : -0.042, -0.044, 0.036).applyQuaternion(weapLocalQ));
    }

    if (!this.isReloading) {
      lWristPos = defaultLeftWrist;
      w.magazine.position.copy(w.magSocket.position);
      w.magazine.quaternion.identity();
    } else {
      const magWorldPos = this.tmpVec;
      w.magSocket.getWorldPosition(magWorldPos);
      magWorldPos.applyMatrix4(rootInv);
      const clearPoint = defaultLeftWrist.clone().add(new THREE.Vector3(-0.045, -0.095, 0.06));
      const magGripWrist = magWorldPos.clone().add(new THREE.Vector3(-0.055, -0.095, 0.025));
      const magDropWrist = magGripWrist.clone().add(new THREE.Vector3(-0.05, -0.14, 0.03));

      if (this.isEmptyReload) {
        // Empty reload: mag out -> new mag vertical insert -> rack charging handle / MP5SD HK Slap / release M1911 slide!
        const rackAnchor = isM7
          ? new THREE.Vector3(-0.072, 0.008, -0.44) // M7 forward left-side folding charging handle!
          : isRiflePlatform
            ? new THREE.Vector3(-0.065, 0.005, -0.22)
            : isMP5
              ? new THREE.Vector3(-0.078, 0.042, -0.52) // Up above forward MP5SD cocking tube for HK Slap!
              : new THREE.Vector3(-0.055, 0.010, -0.39);
        if (reloadProg < 0.12) {
          lWristPos = defaultLeftWrist.clone().lerp(clearPoint, easeInOutQuad(reloadProg / 0.12));
          w.magazine.position.copy(w.magSocket.position);
        } else if (reloadProg < 0.22) {
          lWristPos = clearPoint.clone().lerp(magGripWrist, easeInOutQuad((reloadProg - 0.12) / 0.10));
          w.magazine.position.copy(w.magSocket.position);
        } else if (reloadProg < 0.40) {
          lWristPos = magGripWrist.clone().lerp(magDropWrist, easeInOutQuad((reloadProg - 0.22) / 0.18));
          lFingerPose = MAG_HOLD_POSE;
          const magWorld = lWristPos.clone().add(new THREE.Vector3(0.052, 0.055, -0.02));
          magWorld.applyMatrix4(this.root.matrixWorld);
          w.root.worldToLocal(magWorld);
          w.magazine.position.copy(magWorld);
        } else if (reloadProg < 0.58) {
          lWristPos = magDropWrist.clone().lerp(magGripWrist, easeOutBack((reloadProg - 0.40) / 0.18));
          lFingerPose = MAG_HOLD_POSE;
          const magWorld = lWristPos.clone().add(new THREE.Vector3(0.052, 0.055, -0.02));
          magWorld.applyMatrix4(this.root.matrixWorld);
          w.root.worldToLocal(magWorld);
          w.magazine.position.copy(magWorld);
        } else if (reloadProg < 0.74) {
          w.magazine.position.copy(w.magSocket.position);
          lWristPos = magGripWrist.clone().lerp(rackAnchor, easeInOutQuad((reloadProg - 0.58) / 0.16));
        } else if (reloadProg < 0.88) {
          w.magazine.position.copy(w.magSocket.position);
          if (isMP5) {
            // Crisp downward palm HK Slap strike!
            const slapPhase = (reloadProg - 0.74) / 0.14;
            const slapY = slapPhase < 0.45 ? 0.035 * (slapPhase / 0.45) : -0.068 * ((slapPhase - 0.45) / 0.55);
            lWristPos = rackAnchor.clone().add(new THREE.Vector3(0.025, slapY, 0));
          } else {
            const pull = Math.sin(((reloadProg - 0.74) / 0.14) * Math.PI);
            lWristPos = rackAnchor.clone().add(new THREE.Vector3(0, 0, isRiflePlatform ? pull * 0.055 : pull * 0.022));
          }
        } else {
          w.magazine.position.copy(w.magSocket.position);
          lWristPos = rackAnchor.clone().lerp(defaultLeftWrist, easeOutBack((reloadProg - 0.88) / 0.12));
        }
      } else {
        // Tactical reload (faster, skips bolt rack / slide release!)
        if (reloadProg < 0.16) {
          lWristPos = defaultLeftWrist.clone().lerp(clearPoint, easeInOutQuad(reloadProg / 0.16));
          w.magazine.position.copy(w.magSocket.position);
        } else if (reloadProg < 0.30) {
          lWristPos = clearPoint.clone().lerp(magGripWrist, easeInOutQuad((reloadProg - 0.16) / 0.14));
          w.magazine.position.copy(w.magSocket.position);
        } else if (reloadProg < 0.52) {
          lWristPos = magGripWrist.clone().lerp(magDropWrist, easeInOutQuad((reloadProg - 0.30) / 0.22));
          lFingerPose = MAG_HOLD_POSE;
          const magWorld = lWristPos.clone().add(new THREE.Vector3(0.052, 0.055, -0.02));
          magWorld.applyMatrix4(this.root.matrixWorld);
          w.root.worldToLocal(magWorld);
          w.magazine.position.copy(magWorld);
        } else if (reloadProg < 0.74) {
          lWristPos = magDropWrist.clone().lerp(magGripWrist, easeOutBack((reloadProg - 0.52) / 0.22));
          lFingerPose = MAG_HOLD_POSE;
          const magWorld = lWristPos.clone().add(new THREE.Vector3(0.052, 0.055, -0.02));
          magWorld.applyMatrix4(this.root.matrixWorld);
          w.root.worldToLocal(magWorld);
          w.magazine.position.copy(magWorld);
        } else {
          w.magazine.position.copy(w.magSocket.position);
          lWristPos = magGripWrist.clone().lerp(defaultLeftWrist, easeOutBack((reloadProg - 0.74) / 0.26));
        }
      }
    }

    const lElbowPole = new THREE.Vector3(-0.32, -0.45, 0.15);
    solveArmIK(this.arms.leftArm, lWristPos, this.tmpLeftQuat, lElbowPole);
    applyFingerPose(this.arms.leftArm, lFingerPose, Math.min(1, dt * 18));
  }
}
