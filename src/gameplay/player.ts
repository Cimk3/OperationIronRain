import * as THREE from 'three';
import { ProceduralAudioEngine } from '../audio/ProceduralAudio';
import { WorldSurface } from '../types';
import { BoxCollider } from '../world/outpost';
import { CylinderCollider } from '../world/vegetation';

export class PlayerController {
  public position = new THREE.Vector3(0, 2, 92);
  public velocity = new THREE.Vector3();
  public yaw = 0; // 0 = looking -Z (North toward outpost!)
  public pitch = 0;
  public hp = 100;
  public maxHp = 100;

  public isGrounded = true;
  public isCrouching = false;
  public isSprinting = false;
  public isAiming = false;
  public moveSpeedNorm = 0;

  private eyeHeight = 1.68;
  private crouchEyeHeight = 1.08;
  private currentEyeHeight = 1.68;
  private radius = 0.56; // Keeps weapon barrel from ever poking into walls!

  private recoilPitchOffset = 0;
  private recoilYawOffset = 0;
  private hitPunchPitch = 0;
  private hitPunchRoll = 0;
  private stepAccum = 0;
  private healDelay = 0;
  private lastSafePos = new THREE.Vector3();

  public keys: Record<string, boolean> = {};

  constructor(spawnX: number, spawnZ: number, terrain: WorldSurface) {
    this.position.set(spawnX, terrain.getHeightAt(spawnX, spawnZ, 5), spawnZ);
    this.lastSafePos.copy(this.position);
    this.yaw = 0;
    this.pitch = -0.02;
  }

  public addLookDelta(
    dx: number,
    dy: number,
    hipSensitivity: number,
    adsSensitivity: number,
    adsFactor: number
  ): void {
    const sens = THREE.MathUtils.lerp(hipSensitivity, adsSensitivity, adsFactor);
    const sensScale = 0.0021 * sens;
    this.yaw -= dx * sensScale;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - dy * sensScale,
      -Math.PI * 0.46,
      Math.PI * 0.46
    );
  }

  public addRecoilKick(pitchKick: number, yawKick: number): void {
    this.recoilPitchOffset += pitchKick;
    this.recoilYawOffset += yawKick;
  }

  public addCameraPunch(pitchKick: number, rollKick: number): void {
    this.hitPunchPitch += pitchKick;
    this.hitPunchRoll += rollKick;
  }

  public takeDamage(amount: number): boolean {
    this.hp = Math.max(0, this.hp - amount);
    this.healDelay = 4.5;
    return this.hp <= 0;
  }

  public update(
    dt: number,
    terrain: WorldSurface,
    boxColliders: BoxCollider[],
    cylColliders: CylinderCollider[],
    camera: THREE.PerspectiveCamera,
    audio: ProceduralAudioEngine,
    allowMove: boolean
  ): void {
    // Passive tactical health regen after avoiding fire for 4.5s
    if (this.healDelay > 0) {
      this.healDelay -= dt;
    } else if (this.hp < this.maxHp && this.hp > 0) {
      this.hp = Math.min(this.maxHp, this.hp + dt * 7.5);
    }

    // Recoil & hit punch recovery
    this.recoilPitchOffset = THREE.MathUtils.lerp(this.recoilPitchOffset, 0, Math.min(1, dt * 10));
    this.recoilYawOffset = THREE.MathUtils.lerp(this.recoilYawOffset, 0, Math.min(1, dt * 10));
    this.hitPunchPitch = THREE.MathUtils.lerp(this.hitPunchPitch, 0, Math.min(1, dt * 14));
    this.hitPunchRoll = THREE.MathUtils.lerp(this.hitPunchRoll, 0, Math.min(1, dt * 14));

    // Input vectors
    const wantCrouch = !!(this.keys['KeyC'] || this.keys['ControlLeft'] || this.keys['ControlRight']);
    this.isCrouching = wantCrouch;

    let fwdInput = 0;
    let strafeInput = 0;
    if (allowMove) {
      if (this.keys['KeyW'] || this.keys['ArrowUp']) fwdInput += 1;
      if (this.keys['KeyS'] || this.keys['ArrowDown']) fwdInput -= 1;
      if (this.keys['KeyD'] || this.keys['ArrowRight']) strafeInput += 1;
      if (this.keys['KeyA'] || this.keys['ArrowLeft']) strafeInput -= 1;
    }

    const wantSprint =
      allowMove &&
      !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']) &&
      fwdInput > 0 &&
      !this.isCrouching &&
      !this.isAiming;
    this.isSprinting = wantSprint;

    const maxSpeed = this.isCrouching ? 2.8 : this.isSprinting ? 7.0 : this.isAiming ? 3.1 : 4.65;

    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    // Forward is (-sinY, 0, -cosY), Right is (cosY, 0, -sinY)
    const moveDirX = -sinY * fwdInput + cosY * strafeInput;
    const moveDirZ = -cosY * fwdInput - sinY * strafeInput;
    const len = Math.hypot(moveDirX, moveDirZ);
    const nx = len > 0.001 ? moveDirX / len : 0;
    const nz = len > 0.001 ? moveDirZ / len : 0;

    const targetVX = nx * maxSpeed;
    const targetVZ = nz * maxSpeed;
    const accel = this.isGrounded ? 14 : 4;
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, targetVX, Math.min(1, dt * accel));
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, targetVZ, Math.min(1, dt * accel));

    if (allowMove && this.isGrounded && this.keys['Space']) {
      this.velocity.y = 5.4;
      this.isGrounded = false;
    }

    this.velocity.y -= 16.5 * dt;

    // Proposed XZ step + smooth slope check
    const nextX = this.position.x + this.velocity.x * dt;
    const nextZ = this.position.z + this.velocity.z * dt;

    // Keep within playable valley bounds on outdoor terrain [-100, +100] (strictly below ±125m mountain rim!)
    const floorChecker = (terrain as unknown as { hasFloorAt?: (x: number, z: number, refY?: number) => boolean }).hasFloorAt;
    if (floorChecker) {
      this.position.x = nextX;
      this.position.z = nextZ;
    } else {
      this.position.x = THREE.MathUtils.clamp(nextX, -100, 100);
      this.position.z = THREE.MathUtils.clamp(nextZ, -100, 100);
    }
    this.position.y += this.velocity.y * dt;

    // Resolve horizontal sliding collisions against Outpost / Silo Walls & Cover (3 passes for crisp sealed corners!)
    const pTop = this.position.y + (this.isCrouching ? 1.25 : 1.78);
    const pBot = this.position.y + 0.35; // Step height tolerance 0.35m so low ledges don't snag feet!

    for (let pass = 0; pass < 3; pass++) {
      for (const c of boxColliders) {
        if (pTop < c.box.min.y || pBot > c.box.max.y) continue;
        const closestX = THREE.MathUtils.clamp(this.position.x, c.box.min.x, c.box.max.x);
        const closestZ = THREE.MathUtils.clamp(this.position.z, c.box.min.z, c.box.max.z);
        const dx = this.position.x - closestX;
        const dz = this.position.z - closestZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < this.radius * this.radius) {
          const dist = Math.sqrt(distSq);
          if (dist > 1e-5) {
            const push = this.radius - dist;
            this.position.x += (dx / dist) * push;
            this.position.z += (dz / dist) * push;
          } else {
            // Inside box center fallback: push out along shallowest axis
            const penX = Math.min(Math.abs(this.position.x - c.box.min.x), Math.abs(c.box.max.x - this.position.x));
            const penZ = Math.min(Math.abs(this.position.z - c.box.min.z), Math.abs(c.box.max.z - this.position.z));
            if (penX < penZ) {
              this.position.x = this.position.x < (c.box.min.x + c.box.max.x) * 0.5 ? c.box.min.x - this.radius : c.box.max.x + this.radius;
            } else {
              this.position.z = this.position.z < (c.box.min.z + c.box.max.z) * 0.5 ? c.box.min.z - this.radius : c.box.max.z + this.radius;
            }
          }
        }
      }

      for (const cyl of cylColliders) {
        if (pTop < cyl.bottomY || pBot > cyl.topY) continue;
        const dx = this.position.x - cyl.x;
        const dz = this.position.z - cyl.z;
        const minR = this.radius + cyl.radius;
        const dSq = dx * dx + dz * dz;
        if (dSq < minR * minR && dSq > 1e-6) {
          const d = Math.sqrt(dSq);
          const push = minR - d;
          this.position.x += (dx / d) * push;
          this.position.z += (dz / d) * push;
        }
      }
    }

    // Strict Anti-Out-of-Bounds / Inside-Wall Recovery (never escape playable floor zones or clip inside walls!)
    const corePt = new THREE.Vector3(this.position.x, this.position.y + 1.0, this.position.z);
    let insideSolidWall = false;
    for (const c of boxColliders) {
      if (c.blocksSight && c.box.containsPoint(corePt)) {
        insideSolidWall = true;
        break;
      }
    }
    const outsideFloor = floorChecker ? !floorChecker.call(terrain, this.position.x, this.position.z, this.position.y) : false;
    if (insideSolidWall || outsideFloor) {
      this.position.copy(this.lastSafePos);
      this.velocity.x = 0;
      this.velocity.z = 0;
    } else {
      this.lastSafePos.copy(this.position);
    }

    // Terrain & multi-level floor/ramp grounding (snap smoothly on downward ramps!)
    const prevGrounded = this.isGrounded;
    const groundY = terrain.getHeightAt(this.position.x, this.position.z, this.position.y);
    const snapDist = prevGrounded && this.velocity.y <= 0.1 ? 0.22 : 0.02;
    if (this.position.y <= groundY + snapDist) {
      this.position.y = groundY;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.isGrounded = true;
    } else {
      this.isGrounded = false;
    }

    // Smooth eye height crouch transition
    const targetEye = this.isCrouching ? this.crouchEyeHeight : this.eyeHeight;
    this.currentEyeHeight = THREE.MathUtils.lerp(this.currentEyeHeight, targetEye, Math.min(1, dt * 12));

    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveSpeedNorm = horizSpeed / 4.65;

    // Footstep sound synthesis matching ground material
    if (this.isGrounded && horizSpeed > 0.7) {
      this.stepAccum += horizSpeed * dt;
      const stepStride = this.isSprinting ? 2.35 : 1.85;
      if (this.stepAccum >= stepStride) {
        this.stepAccum -= stepStride;
        const mat = terrain.getMaterialAt(this.position.x, this.position.z);
        audio.playFootstep(mat, this.isSprinting);
      }
    } else {
      this.stepAccum = 0.8;
    }

    // Update Camera World Transform
    camera.position.set(this.position.x, this.position.y + this.currentEyeHeight, this.position.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw + this.recoilYawOffset;
    camera.rotation.x = THREE.MathUtils.clamp(
      this.pitch + this.recoilPitchOffset + this.hitPunchPitch,
      -Math.PI * 0.47,
      Math.PI * 0.47
    );
    camera.rotation.z = this.hitPunchRoll;
  }
}
