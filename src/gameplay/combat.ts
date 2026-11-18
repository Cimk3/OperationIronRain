import * as THREE from 'three';
import { ProceduralAudioEngine } from '../audio/ProceduralAudio';
import { createLatheZ } from '../proc/modeling';
import { MaterialId, WorldSurface } from '../types';
import { BoxCollider } from '../world/outpost';
import { CylinderCollider } from '../world/vegetation';
import { EnemyManager } from './enemies';

interface ShellCasing {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  angVel: THREE.Vector3;
  life: number;
  bounced: boolean;
}

interface SoftPuff {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  startScale: number;
  endScale: number;
  seed: number;
  life: number;
  maxLife: number;
}

interface MetalSpark {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  lenScale: number;
  life: number;
  maxLife: number;
}

interface DebrisChip {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  angVel: THREE.Vector3;
  scale: number;
  life: number;
}

interface WaterRipple {
  active: boolean;
  pos: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface TracerBolt {
  active: boolean;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  life: number;
  fromEnemy: boolean;
  damage: number;
}

export interface PlayerFireResult {
  hitEnemy: boolean;
  headshot: boolean;
  killed: boolean;
  hitLightId?: number;
  hitLightPos?: THREE.Vector3;
}

function makeConcreteDecalTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const cx = size * 0.5;
  const cy = size * 0.5;

  ctx.clearRect(0, 0, size, size);

  // Outer pale crushed cement spall ring with soft edge fade
  const outerGrad = ctx.createRadialGradient(cx, cy, 7, cx, cy, 48);
  outerGrad.addColorStop(0, 'rgba(182, 178, 168, 0.86)');
  outerGrad.addColorStop(0.5, 'rgba(148, 145, 138, 0.45)');
  outerGrad.addColorStop(0.85, 'rgba(90, 88, 84, 0.14)');
  outerGrad.addColorStop(1, 'rgba(40, 40, 40, 0)');
  ctx.fillStyle = outerGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 48, 0, Math.PI * 2);
  ctx.fill();

  // Radial hairline cracks radiating from bullet crater
  ctx.strokeStyle = 'rgba(20, 20, 22, 0.65)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.35;
    const len = 24 + ((i * 19) % 18);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8);
    ctx.lineTo(cx + Math.cos(a + 0.12) * (len * 0.55), cy + Math.sin(a + 0.12) * (len * 0.55));
    ctx.lineTo(cx + Math.cos(a - 0.08) * len, cy + Math.sin(a - 0.08) * len);
    ctx.stroke();
  }

  // Faux-depth shadow collar + jagged central hole
  const coreGrad = ctx.createRadialGradient(cx - 2, cy - 2, 2, cx, cy, 17);
  coreGrad.addColorStop(0, 'rgba(8, 8, 10, 0.98)');
  coreGrad.addColorStop(0.55, 'rgba(22, 22, 24, 0.92)');
  coreGrad.addColorStop(0.82, 'rgba(72, 70, 66, 0.55)');
  coreGrad.addColorStop(1, 'rgba(150, 146, 138, 0)');
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  for (let i = 0; i <= 14; i++) {
    const ang = (i / 14) * Math.PI * 2;
    const r = 13 + Math.sin(i * 3.7) * 3.2;
    const px = cx + Math.cos(ang) * r;
    const py = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMetalScorchTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const cx = size * 0.5;
  const cy = size * 0.5;

  ctx.clearRect(0, 0, size, size);

  // Dark carbonized heat scorch streak
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1.6, 0.72);
  const scorchGrad = ctx.createRadialGradient(0, 0, 3, 0, 0, 36);
  scorchGrad.addColorStop(0, 'rgba(12, 10, 10, 0.95)');
  scorchGrad.addColorStop(0.35, 'rgba(38, 26, 18, 0.72)');
  scorchGrad.addColorStop(0.7, 'rgba(60, 48, 36, 0.25)');
  scorchGrad.addColorStop(1, 'rgba(20, 20, 20, 0)');
  ctx.fillStyle = scorchGrad;
  ctx.beginPath();
  ctx.arc(0, 0, 36, 0, Math.PI * 2);
  ctx.fill();

  // Bright exposed steel gouge rim
  ctx.strokeStyle = 'rgba(210, 215, 224, 0.55)';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(0, 0, 9, -0.7, 2.2);
  ctx.stroke();
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class CombatSystem {
  public group = new THREE.Group();
  private raycaster = new THREE.Raycaster();

  // Instanced Shell Casings
  private shellMesh: THREE.InstancedMesh;
  private shells: ShellCasing[] = [];
  private shellIdx = 0;

  // 2a. Soft Radial Dust / Mist / Water / Blood Puffs (zero hard squares!)
  private puffCount = 140;
  private puffMesh: THREE.InstancedMesh;
  private puffs: SoftPuff[] = [];
  private puffIdx = 0;
  private puffParamsAttr: THREE.InstancedBufferAttribute;
  private puffColorAttr: THREE.InstancedBufferAttribute;

  // 2b. Velocity-Stretched Metal Sparks (HDR Bloom + elastic bounce)
  private sparkCount = 128;
  private sparkMesh: THREE.InstancedMesh;
  private sparks: MetalSpark[] = [];
  private sparkIdx = 0;
  private sparkVelAttr: THREE.InstancedBufferAttribute;
  private sparkLifeAttr: THREE.InstancedBufferAttribute;

  // 2c. Irregular Dark Debris Chips (tiny 1-2cm concrete fragments)
  private chipCount = 64;
  private chipMesh: THREE.InstancedMesh;
  private chips: DebrisChip[] = [];
  private chipIdx = 0;

  // 2d. Concentric Puddle Water Ripples
  private rippleCount = 32;
  private rippleMesh: THREE.InstancedMesh;
  private ripples: WaterRipple[] = [];
  private rippleIdx = 0;
  private rippleLifeAttr: THREE.InstancedBufferAttribute;

  // 3. Procedural Bullet Hole & Metal Scorch Decals (pooled)
  private concreteDecalMesh: THREE.InstancedMesh;
  private concreteDecalIdx = 0;
  private metalDecalMesh: THREE.InstancedMesh;
  private metalDecalIdx = 0;
  private maxDecals = 64;

  // 4. High-speed Tracer Bolts
  private tracerMesh: THREE.InstancedMesh;
  private tracers: TracerBolt[] = [];
  private tracerIdx = 0;

  private dummy = new THREE.Object3D();

  constructor() {
    this.group.name = 'CombatVFX';

    // 1. Brass Shell Casings Pool (64)
    const shellGeo = createLatheZ(
      [
        [0.0042, -0.012],
        [0.0045, -0.010],
        [0.0045, 0.006],
        [0.0032, 0.012],
        [0.0022, 0.012],
      ],
      10
    );
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0xd4a446,
      metalness: 0.92,
      roughness: 0.25,
    });
    this.shellMesh = new THREE.InstancedMesh(shellGeo, shellMat, 64);
    this.shellMesh.frustumCulled = false;
    for (let i = 0; i < 64; i++) {
      this.shells.push({
        active: false,
        pos: new THREE.Vector3(0, -999, 0),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        angVel: new THREE.Vector3(),
        life: 0,
        bounced: false,
      });
      this.dummy.position.set(0, -999, 0);
      this.dummy.scale.setScalar(0.001);
      this.dummy.updateMatrix();
      this.shellMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.shellMesh);

    // 2a. Soft Radial Billboarded Puff Shader
    const puffGeo = new THREE.PlaneGeometry(1, 1);
    const puffParamsArr = new Float32Array(this.puffCount * 4);
    const puffColorArr = new Float32Array(this.puffCount * 3);
    this.puffParamsAttr = new THREE.InstancedBufferAttribute(puffParamsArr, 4);
    this.puffColorAttr = new THREE.InstancedBufferAttribute(puffColorArr, 3);
    puffGeo.setAttribute('aPuffParams', this.puffParamsAttr);
    puffGeo.setAttribute('aPuffColor', this.puffColorAttr);

    const puffMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec4 aPuffParams;
        attribute vec3 aPuffColor;
        varying vec2 vUv;
        varying vec4 vParams;
        varying vec3 vTint;
        void main() {
          vUv = uv;
          vParams = aPuffParams;
          vTint = aPuffColor;
          float age = clamp(aPuffParams.x, 0.0, 1.0);
          float s = mix(aPuffParams.z, aPuffParams.w, sqrt(age));
          vec4 mvCenter = viewMatrix * modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mvCenter.xy += position.xy * s;
          gl_Position = projectionMatrix * mvCenter;
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying vec4 vParams;
        varying vec3 vTint;
        void main() {
          float age = clamp(vParams.x, 0.0, 1.0);
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float ang = atan(p.y, p.x);
          float wisp = 0.84 + 0.16 * sin(ang * 3.0 + vParams.y * 6.283 + age * 2.5) * cos(r * 4.5 - vParams.y * 3.0);
          float soft = smoothstep(0.96, 0.08, r / wisp);
          soft *= soft;
          float fade = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.28, 1.0, age));
          float alpha = soft * fade * 0.56;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(vTint, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.puffMesh = new THREE.InstancedMesh(puffGeo, puffMat, this.puffCount);
    this.puffMesh.frustumCulled = false;
    for (let i = 0; i < this.puffCount; i++) {
      this.puffs.push({
        active: false,
        pos: new THREE.Vector3(0, -999, 0),
        vel: new THREE.Vector3(),
        color: new THREE.Color(0.7, 0.7, 0.7),
        startScale: 0.1,
        endScale: 0.5,
        seed: i * 0.37,
        life: 0,
        maxLife: 0.45,
      });
      this.puffMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.puffMesh);

    // 2b. Velocity-Stretched Metal Sparks Shader (orange-yellow HDR trails)
    const sparkGeo = new THREE.PlaneGeometry(1, 1);
    const sparkVelArr = new Float32Array(this.sparkCount * 3);
    const sparkLifeArr = new Float32Array(this.sparkCount * 2);
    this.sparkVelAttr = new THREE.InstancedBufferAttribute(sparkVelArr, 3);
    this.sparkLifeAttr = new THREE.InstancedBufferAttribute(sparkLifeArr, 2);
    sparkGeo.setAttribute('aSparkVel', this.sparkVelAttr);
    sparkGeo.setAttribute('aSparkLife', this.sparkLifeAttr);

    const sparkMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 aSparkVel;
        attribute vec2 aSparkLife;
        varying vec2 vUv;
        varying float vAge;
        void main() {
          vUv = uv;
          vAge = clamp(aSparkLife.x, 0.0, 1.0);
          vec4 mvCenter = viewMatrix * modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec3 velV = (viewMatrix * vec4(aSparkVel, 0.0)).xyz;
          vec2 dir2 = velV.xy;
          float spd2 = length(dir2);
          vec2 axis = spd2 > 0.001 ? dir2 / spd2 : vec2(0.0, 1.0);
          vec2 perp = vec2(-axis.y, axis.x);
          float stretch = clamp(length(aSparkVel) * 0.025, 0.045, 0.34) * (1.0 - vAge * 0.4) * aSparkLife.y;
          float width = 0.0085 * (1.0 - vAge * 0.45);
          mvCenter.xy += axis * (position.y * stretch) + perp * (position.x * width);
          gl_Position = projectionMatrix * mvCenter;
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vAge;
        void main() {
          float xCore = pow(clamp(1.0 - abs(vUv.x * 2.0 - 1.0), 0.0, 1.0), 1.6);
          float yTaper = smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.42, vUv.y);
          float intensity = xCore * yTaper * (1.0 - smoothstep(0.48, 1.0, vAge));
          if (intensity < 0.01) discard;
          vec3 hot = mix(vec3(4.5, 2.3, 0.55), vec3(2.5, 0.65, 0.06), clamp(vAge * 1.15, 0.0, 1.0));
          gl_FragColor = vec4(hot * intensity, intensity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, this.sparkCount);
    this.sparkMesh.frustumCulled = false;
    for (let i = 0; i < this.sparkCount; i++) {
      this.sparks.push({
        active: false,
        pos: new THREE.Vector3(0, -999, 0),
        vel: new THREE.Vector3(),
        lenScale: 1,
        life: 0,
        maxLife: 0.32,
      });
      this.sparkMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.sparkMesh);

    // 2c. Irregular Dark Rock/Concrete Debris Chips (tiny fractured dodecahedron shards, NOT white boxes!)
    const chipGeo = new THREE.DodecahedronGeometry(0.014, 0);
    const chipPos = chipGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < chipPos.count; i++) {
      const rx = 0.65 + 0.55 * Math.abs(Math.sin(i * 12.7 + 1.3));
      const ry = 0.5 + 0.6 * Math.abs(Math.cos(i * 7.3 + 2.1));
      const rz = 0.65 + 0.5 * Math.abs(Math.sin(i * 19.1 + 0.7));
      chipPos.setXYZ(i, chipPos.getX(i) * rx, chipPos.getY(i) * ry, chipPos.getZ(i) * rz);
    }
    chipGeo.computeVertexNormals();
    const chipMat = new THREE.MeshStandardMaterial({
      color: 0x3b3d3e,
      roughness: 0.92,
      metalness: 0.04,
    });
    this.chipMesh = new THREE.InstancedMesh(chipGeo, chipMat, this.chipCount);
    this.chipMesh.frustumCulled = false;
    for (let i = 0; i < this.chipCount; i++) {
      this.chips.push({
        active: false,
        pos: new THREE.Vector3(0, -999, 0),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        angVel: new THREE.Vector3(),
        scale: 1,
        life: 0,
      });
      this.chipMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.chipMesh);

    // 2d. Concentric Puddle Water Ripples
    const rippleGeo = new THREE.PlaneGeometry(0.95, 0.95);
    rippleGeo.rotateX(-Math.PI * 0.5);
    const rippleLifeArr = new Float32Array(this.rippleCount);
    this.rippleLifeAttr = new THREE.InstancedBufferAttribute(rippleLifeArr, 1);
    rippleGeo.setAttribute('aRippleAge', this.rippleLifeAttr);

    const rippleMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aRippleAge;
        varying vec2 vUv;
        varying float vAge;
        void main() {
          vUv = uv;
          vAge = aRippleAge;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vAge;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          if (r > 0.98) discard;
          float wave1 = exp(-pow((r - vAge * 0.85) * 14.0, 2.0));
          float wave2 = exp(-pow((r - max(0.0, vAge - 0.16) * 0.8) * 16.0, 2.0)) * 0.65;
          float ring = (wave1 + wave2) * (1.0 - smoothstep(0.35, 1.0, vAge));
          if (ring < 0.015) discard;
          gl_FragColor = vec4(vec3(0.75, 0.85, 0.96), ring * 0.62);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    this.rippleMesh = new THREE.InstancedMesh(rippleGeo, rippleMat, this.rippleCount);
    this.rippleMesh.frustumCulled = false;
    for (let i = 0; i < this.rippleCount; i++) {
      this.ripples.push({
        active: false,
        pos: new THREE.Vector3(0, -999, 0),
        life: 0,
        maxLife: 0.65,
      });
      this.rippleMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.rippleMesh);

    // 3. Procedural Bullet Crater & Metal Scorch Decals
    const concreteDecalGeo = new THREE.PlaneGeometry(0.14, 0.14);
    const concreteDecalMat = new THREE.MeshBasicMaterial({
      map: makeConcreteDecalTexture(),
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    this.concreteDecalMesh = new THREE.InstancedMesh(concreteDecalGeo, concreteDecalMat, this.maxDecals);
    this.concreteDecalMesh.frustumCulled = false;
    for (let i = 0; i < this.maxDecals; i++) {
      this.concreteDecalMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.concreteDecalMesh);

    const metalDecalGeo = new THREE.PlaneGeometry(0.13, 0.13);
    const metalDecalMat = new THREE.MeshBasicMaterial({
      map: makeMetalScorchTexture(),
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    this.metalDecalMesh = new THREE.InstancedMesh(metalDecalGeo, metalDecalMat, this.maxDecals);
    this.metalDecalMesh.frustumCulled = false;
    for (let i = 0; i < this.maxDecals; i++) {
      this.metalDecalMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.metalDecalMesh);

    // 4. High-Speed Slim Tracer Bolts Pool (36)
    const tracerGeo = new THREE.BoxGeometry(0.008, 0.008, 1.05);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
    });
    this.tracerMesh = new THREE.InstancedMesh(tracerGeo, tracerMat, 36);
    this.tracerMesh.frustumCulled = false;
    for (let i = 0; i < 36; i++) {
      this.tracers.push({
        active: false,
        pos: new THREE.Vector3(0, -999, 0),
        dir: new THREE.Vector3(0, 0, -1),
        speed: 190,
        life: 0,
        fromEnemy: false,
        damage: 0,
      });
      this.tracerMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.group.add(this.tracerMesh);
  }

  private hideTracer(i: number): void {
    this.tracers[i].active = false;
    this.dummy.position.set(0, -999, 0);
    this.dummy.scale.setScalar(0.0001);
    this.dummy.updateMatrix();
    this.tracerMesh.setMatrixAt(i, this.dummy.matrix);
  }

  private pushPuff(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    color: THREE.Color,
    startScale: number,
    endScale: number,
    maxLife: number
  ): void {
    const p = this.puffs[this.puffIdx];
    this.puffIdx = (this.puffIdx + 1) % this.puffCount;
    p.active = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.color.copy(color);
    p.startScale = startScale;
    p.endScale = endScale;
    p.seed = Math.random();
    p.maxLife = maxLife;
    p.life = maxLife;
  }

  public spawnShell(ejectWorldPos: THREE.Vector3, camRight: THREE.Vector3, camUp: THREE.Vector3): void {
    const s = this.shells[this.shellIdx];
    this.shellIdx = (this.shellIdx + 1) % this.shells.length;
    s.active = true;
    s.pos.copy(ejectWorldPos);
    s.vel
      .copy(camRight)
      .multiplyScalar(2.4 + Math.random() * 0.9)
      .addScaledVector(camUp, 1.7 + Math.random() * 0.6);
    s.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    s.angVel.set((Math.random() - 0.5) * 28, (Math.random() - 0.5) * 28, (Math.random() - 0.5) * 28);
    s.life = 2.6;
    s.bounced = false;
  }

  public spawnImpact(pos: THREE.Vector3, normal: THREE.Vector3, mat: MaterialId): void {
    if (mat === MaterialId.METAL) {
      // High-luminance velocity-stretched orange-yellow sparks (HDR Bloom + bounce!)
      for (let i = 0; i < 14; i++) {
        const sp = this.sparks[this.sparkIdx];
        this.sparkIdx = (this.sparkIdx + 1) % this.sparkCount;
        sp.active = true;
        sp.pos.copy(pos).addScaledVector(normal, 0.02);
        sp.vel
          .copy(normal)
          .multiplyScalar(3.5 + Math.random() * 5.2)
          .add(new THREE.Vector3((Math.random() - 0.5) * 6.5, Math.random() * 3.8 + 0.5, (Math.random() - 0.5) * 6.5));
        sp.lenScale = 0.8 + Math.random() * 0.7;
        sp.maxLife = 0.24 + Math.random() * 0.16;
        sp.life = sp.maxLife;
      }
      // Subtle warm metallic smoke wisp
      const smokeCol = new THREE.Color(0.55, 0.48, 0.42);
      this.pushPuff(
        pos.clone().addScaledVector(normal, 0.04),
        normal.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.35, 0)),
        smokeCol,
        0.08,
        0.34,
        0.35
      );
      return;
    }

    if (mat === MaterialId.WATER) {
      // Translucent water splash mist plumes + expanding concentric surface ripple!
      const splashCol = new THREE.Color(0.72, 0.82, 0.92);
      for (let i = 0; i < 5; i++) {
        const vel = new THREE.Vector3(
          (Math.random() - 0.5) * 1.4,
          1.4 + Math.random() * 1.6,
          (Math.random() - 0.5) * 1.4
        );
        this.pushPuff(pos.clone().add(new THREE.Vector3(0, 0.04, 0)), vel, splashCol, 0.08, 0.38, 0.42);
      }
      const rip = this.ripples[this.rippleIdx];
      this.rippleIdx = (this.rippleIdx + 1) % this.rippleCount;
      rip.active = true;
      rip.pos.copy(pos).add(new THREE.Vector3(0, 0.015, 0));
      rip.maxLife = 0.65;
      rip.life = 0.65;
      return;
    }

    // Concrete / Rock / Wood / Sandbag / Dirt: Soft expanding dust puff + 3~5 tiny dark debris chips
    const dustCol =
      mat === MaterialId.WOOD
        ? new THREE.Color(0.46, 0.36, 0.25)
        : mat === MaterialId.CONCRETE || mat === MaterialId.ROCK
          ? new THREE.Color(0.70, 0.71, 0.69)
          : new THREE.Color(0.38, 0.33, 0.26);

    for (let i = 0; i < 5; i++) {
      const vel = normal
        .clone()
        .multiplyScalar(0.85 + Math.random() * 1.1)
        .add(new THREE.Vector3((Math.random() - 0.5) * 1.1, 0.25 + Math.random() * 0.55, (Math.random() - 0.5) * 1.1));
      this.pushPuff(
        pos.clone().addScaledVector(normal, 0.05),
        vel,
        dustCol,
        0.09 + Math.random() * 0.05,
        0.44 + Math.random() * 0.22,
        0.48 + Math.random() * 0.16
      );
    }

    // 4 tiny dark irregular debris chips (concrete fragments, never white squares!)
    for (let i = 0; i < 4; i++) {
      const ch = this.chips[this.chipIdx];
      this.chipIdx = (this.chipIdx + 1) % this.chipCount;
      ch.active = true;
      ch.pos.copy(pos).addScaledVector(normal, 0.025);
      ch.vel
        .copy(normal)
        .multiplyScalar(1.8 + Math.random() * 2.4)
        .add(new THREE.Vector3((Math.random() - 0.5) * 2.6, Math.random() * 1.8, (Math.random() - 0.5) * 2.6));
      ch.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      ch.angVel.set((Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24);
      ch.scale = 0.55 + Math.random() * 0.55;
      ch.life = 0.55 + Math.random() * 0.2;
    }
  }

  public spawnBloodImpact(pos: THREE.Vector3, normal: THREE.Vector3): void {
    // Short-lived dissipating dark crimson mist (NO white blocks!)
    const bloodCol = new THREE.Color(0.32, 0.02, 0.025);
    for (let i = 0; i < 5; i++) {
      const vel = normal
        .clone()
        .multiplyScalar(0.75 + Math.random() * 0.85)
        .add(new THREE.Vector3((Math.random() - 0.5) * 0.9, 0.1 + Math.random() * 0.45, (Math.random() - 0.5) * 0.9));
      this.pushPuff(
        pos.clone(),
        vel,
        bloodCol,
        0.06,
        0.24 + Math.random() * 0.08,
        0.26 + Math.random() * 0.08
      );
    }
  }

  public spawnDecal(pos: THREE.Vector3, normal: THREE.Vector3, mat: MaterialId = MaterialId.CONCRETE): void {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.dummy.position.copy(pos).addScaledVector(normal, 0.012);
    this.dummy.quaternion.copy(q);
    this.dummy.rotateZ(Math.random() * Math.PI * 2);
    this.dummy.scale.setScalar(0.85 + Math.random() * 0.45);
    this.dummy.updateMatrix();

    if (mat === MaterialId.METAL) {
      this.metalDecalMesh.setMatrixAt(this.metalDecalIdx, this.dummy.matrix);
      this.metalDecalMesh.instanceMatrix.needsUpdate = true;
      this.metalDecalIdx = (this.metalDecalIdx + 1) % this.maxDecals;
    } else {
      this.concreteDecalMesh.setMatrixAt(this.concreteDecalIdx, this.dummy.matrix);
      this.concreteDecalMesh.instanceMatrix.needsUpdate = true;
      this.concreteDecalIdx = (this.concreteDecalIdx + 1) % this.maxDecals;
    }
  }

  public spawnTracer(origin: THREE.Vector3, dir: THREE.Vector3, fromEnemy: boolean, damage = 9): void {
    const tr = this.tracers[this.tracerIdx];
    this.tracerIdx = (this.tracerIdx + 1) % this.tracers.length;
    tr.active = true;
    tr.pos.copy(origin);
    tr.dir.copy(dir).normalize();
    tr.speed = fromEnemy ? 135 : 240;
    tr.life = 0.095;
    tr.fromEnemy = fromEnemy;
    tr.damage = damage;
  }

  /**
   * Player Weapon Shot Resolution:
   * Checks Environment (terrain, outpost props, silo structures/pipes, lights) vs Enemy Hitboxes with exact occlusion!
   */
  public firePlayerShot(
    camOrigin: THREE.Vector3,
    camDir: THREE.Vector3,
    muzzleWorldPos: THREE.Vector3,
    spread: number,
    baseDamage: number,
    terrain: WorldSurface,
    envMeshes: THREE.Object3D[],
    boxColliders: BoxCollider[],
    enemies: EnemyManager,
    audio: ProceduralAudioEngine
  ): PlayerFireResult {
    const dir = camDir.clone();
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    this.raycaster.set(camOrigin, dir);
    this.raycaster.far = 220;

    // 1. Environment hit
    const envTargets = [terrain.mesh, ...envMeshes];
    const envHits = this.raycaster.intersectObjects(envTargets, true);
    const closestEnv = envHits.length > 0 ? envHits[0] : null;
    const envDist = closestEnv ? closestEnv.distance : 220;

    // 2. Enemy hitbox hit
    const enemyHitboxes = enemies.getAllHitboxes();
    const enemyHits = this.raycaster.intersectObjects(enemyHitboxes, false);
    const closestEnemy = enemyHits.length > 0 ? enemyHits[0] : null;

    // Tracer visually originates from gun muzzle toward hit point
    const targetPoint =
      closestEnemy && closestEnemy.distance < envDist
        ? closestEnemy.point
        : closestEnv
          ? closestEnv.point
          : camOrigin.clone().addScaledVector(dir, 140);
    const tracerDir = targetPoint.clone().sub(muzzleWorldPos).normalize();
    this.spawnTracer(muzzleWorldPos, tracerDir, false);

    // Enemy hit if strictly closer than any wall/terrain!
    if (closestEnemy && closestEnemy.distance < envDist) {
      const id = closestEnemy.object.userData.enemyId as number;
      const zone = closestEnemy.object.userData.hitZone as 'head' | 'torso' | 'limb';
      const mult = zone === 'head' ? 2.6 : zone === 'torso' ? 1.0 : 0.72;
      const enemy = enemies.enemies[id];
      const killed = enemy ? enemy.takeDamage(baseDamage * mult, camOrigin) : false;

      const norm = closestEnemy.face
        ? closestEnemy.face.normal.clone().transformDirection(closestEnemy.object.matrixWorld)
        : dir.clone().negate();
      this.spawnBloodImpact(closestEnemy.point, norm);
      audio.playHitConfirm(zone === 'head');
      return { hitEnemy: true, headshot: zone === 'head', killed };
    }

    // Environment impact
    if (closestEnv) {
      const lightId = closestEnv.object.userData.shootableLightId as number | undefined;
      const pt = closestEnv.point;
      const norm = closestEnv.face
        ? closestEnv.face.normal.clone().transformDirection(closestEnv.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);

      if (lightId !== undefined) {
        this.spawnImpact(pt, norm, MaterialId.METAL);
        return {
          hitEnemy: false,
          headshot: false,
          killed: false,
          hitLightId: lightId,
          hitLightPos: pt.clone(),
        };
      }

      let mat = MaterialId.CONCRETE;
      const udMat = closestEnv.object.userData.materialId as MaterialId | undefined;
      const isFloor = !!closestEnv.object.userData.isFloor;
      const isTerrainHit = !!closestEnv.object.userData.isTerrain;

      if (udMat !== undefined) {
        mat = udMat;
        if (mat === MaterialId.CONCRETE && isFloor && norm.y > 0.7 && terrain.getWaterDepthAt(pt.x, pt.z) > 0.02) {
          mat = MaterialId.WATER;
        }
      } else if (isTerrainHit) {
        mat = terrain.getMaterialAt(pt.x, pt.z);
      } else {
        for (const c of boxColliders) {
          if (c.box.distanceToPoint(pt) < 0.3) {
            mat = c.material;
            break;
          }
        }
      }

      this.spawnImpact(pt, norm, mat);
      if (!isTerrainHit && mat !== MaterialId.WATER) {
        this.spawnDecal(pt, norm, mat);
      }
      audio.playBulletImpact(mat, pt, false);
    }

    return { hitEnemy: false, headshot: false, killed: false };
  }

  public update(
    dt: number,
    terrain: WorldSurface,
    boxColliders: BoxCollider[],
    cylColliders: CylinderCollider[],
    playerPos: THREE.Vector3,
    audio: ProceduralAudioEngine,
    onPlayerHit: (damage: number, sourcePos: THREE.Vector3) => void
  ): void {
    // 1. Update Shells
    let shellsDirty = false;
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      if (!s.active) continue;
      shellsDirty = true;
      s.life -= dt;
      if (s.life <= 0) {
        s.active = false;
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.shellMesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      s.vel.y -= 9.8 * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.rot.x += s.angVel.x * dt;
      s.rot.y += s.angVel.y * dt;
      s.rot.z += s.angVel.z * dt;

      const groundY = terrain.getHeightAt(s.pos.x, s.pos.z, s.pos.y + 0.5) + 0.015;
      if (s.pos.y < groundY) {
        s.pos.y = groundY;
        s.vel.y = Math.abs(s.vel.y) * 0.35;
        s.vel.x *= 0.55;
        s.vel.z *= 0.55;
        s.angVel.multiplyScalar(0.5);
        if (!s.bounced) {
          s.bounced = true;
          audio.playShellClink(terrain.getMaterialAt(s.pos.x, s.pos.z), 0);
        }
      }

      this.dummy.position.copy(s.pos);
      this.dummy.rotation.copy(s.rot);
      this.dummy.scale.setScalar(1.0);
      this.dummy.updateMatrix();
      this.shellMesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (shellsDirty) this.shellMesh.instanceMatrix.needsUpdate = true;

    // 2a. Update Soft Puffs (Dust / Water Mist / Dark Crimson Mist)
    let puffsDirty = false;
    for (let i = 0; i < this.puffCount; i++) {
      const p = this.puffs[i];
      if (!p.active) continue;
      puffsDirty = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.puffMesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      p.vel.multiplyScalar(Math.max(0, 1 - dt * 3.4));
      p.vel.y += 0.25 * dt; // Subtle dust thermal lift
      p.pos.addScaledVector(p.vel, dt);
      const age01 = 1 - p.life / p.maxLife;
      this.dummy.position.copy(p.pos);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(1.0);
      this.dummy.updateMatrix();
      this.puffMesh.setMatrixAt(i, this.dummy.matrix);
      this.puffParamsAttr.setXYZW(i, age01, p.seed, p.startScale, p.endScale);
      this.puffColorAttr.setXYZ(i, p.color.r, p.color.g, p.color.b);
    }
    if (puffsDirty) {
      this.puffMesh.instanceMatrix.needsUpdate = true;
      this.puffParamsAttr.needsUpdate = true;
      this.puffColorAttr.needsUpdate = true;
    }

    // 2b. Update Velocity-Stretched Metal Sparks (gravity + elastic floor bounce)
    let sparksDirty = false;
    for (let i = 0; i < this.sparkCount; i++) {
      const sp = this.sparks[i];
      if (!sp.active) continue;
      sparksDirty = true;
      sp.life -= dt;
      if (sp.life <= 0) {
        sp.active = false;
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.sparkMesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      sp.vel.y -= 13.5 * dt;
      sp.pos.addScaledVector(sp.vel, dt);
      const groundY = terrain.getHeightAt(sp.pos.x, sp.pos.z, sp.pos.y + 0.5) + 0.015;
      if (sp.pos.y < groundY) {
        sp.pos.y = groundY;
        sp.vel.y = Math.abs(sp.vel.y) * 0.52;
        sp.vel.x *= 0.78;
        sp.vel.z *= 0.78;
      }
      const age01 = 1 - sp.life / sp.maxLife;
      this.dummy.position.copy(sp.pos);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(1.0);
      this.dummy.updateMatrix();
      this.sparkMesh.setMatrixAt(i, this.dummy.matrix);
      this.sparkVelAttr.setXYZ(i, sp.vel.x, sp.vel.y, sp.vel.z);
      this.sparkLifeAttr.setXY(i, age01, sp.lenScale);
    }
    if (sparksDirty) {
      this.sparkMesh.instanceMatrix.needsUpdate = true;
      this.sparkVelAttr.needsUpdate = true;
      this.sparkLifeAttr.needsUpdate = true;
    }

    // 2c. Update Irregular Concrete Debris Chips
    let chipsDirty = false;
    for (let i = 0; i < this.chipCount; i++) {
      const ch = this.chips[i];
      if (!ch.active) continue;
      chipsDirty = true;
      ch.life -= dt;
      if (ch.life <= 0) {
        ch.active = false;
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.chipMesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      ch.vel.y -= 12.8 * dt;
      ch.pos.addScaledVector(ch.vel, dt);
      ch.rot.x += ch.angVel.x * dt;
      ch.rot.y += ch.angVel.y * dt;
      ch.rot.z += ch.angVel.z * dt;
      const groundY = terrain.getHeightAt(ch.pos.x, ch.pos.z, ch.pos.y + 0.5) + 0.01;
      if (ch.pos.y < groundY) {
        ch.pos.y = groundY;
        ch.vel.y = Math.abs(ch.vel.y) * 0.3;
        ch.vel.x *= 0.6;
        ch.vel.z *= 0.6;
      }
      this.dummy.position.copy(ch.pos);
      this.dummy.rotation.copy(ch.rot);
      this.dummy.scale.setScalar(ch.scale);
      this.dummy.updateMatrix();
      this.chipMesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (chipsDirty) this.chipMesh.instanceMatrix.needsUpdate = true;

    // 2d. Update Puddle Water Ripples
    let ripplesDirty = false;
    for (let i = 0; i < this.rippleCount; i++) {
      const rip = this.ripples[i];
      if (!rip.active) continue;
      ripplesDirty = true;
      rip.life -= dt;
      if (rip.life <= 0) {
        rip.active = false;
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.rippleMesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      const age01 = 1 - rip.life / rip.maxLife;
      this.dummy.position.copy(rip.pos);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(0.6 + age01 * 0.9);
      this.dummy.updateMatrix();
      this.rippleMesh.setMatrixAt(i, this.dummy.matrix);
      this.rippleLifeAttr.setX(i, age01);
    }
    if (ripplesDirty) {
      this.rippleMesh.instanceMatrix.needsUpdate = true;
      this.rippleLifeAttr.needsUpdate = true;
    }

    // 3. Update Tracers & Enemy Projectile Cover Collision (ALWAYS hide matrix on deactivate!)
    let tracersDirty = false;
    const up = new THREE.Vector3(0, 0, 1);
    const hitPt = new THREE.Vector3();
    for (let i = 0; i < this.tracers.length; i++) {
      const tr = this.tracers[i];
      if (!tr.active) continue;
      tracersDirty = true;
      tr.life -= dt;
      if (tr.life <= 0) {
        this.hideTracer(i);
        continue;
      }

      const prevPos = tr.pos.clone();
      const stepDist = tr.speed * dt;
      tr.pos.addScaledVector(tr.dir, stepDist);

      // Check terrain hit (use prevPos.y as refY so multi-floor tracers never snap to upper catwalks)
      if (tr.pos.y <= terrain.getHeightAt(tr.pos.x, tr.pos.z, prevPos.y)) {
        this.spawnImpact(tr.pos, new THREE.Vector3(0, 1, 0), terrain.getMaterialAt(tr.pos.x, tr.pos.z));
        this.hideTracer(i);
        continue;
      }

      // Check solid cover boxes (prevents ANY tracer passing through or originating inside walls!)
      this.raycaster.set(prevPos, tr.dir);
      let blocked = false;
      for (const c of boxColliders) {
        if (
          c.box.containsPoint(prevPos) ||
          c.box.containsPoint(tr.pos) ||
          (this.raycaster.ray.intersectBox(c.box, hitPt) && hitPt.distanceTo(prevPos) <= stepDist)
        ) {
          this.spawnImpact(c.box.containsPoint(prevPos) ? prevPos : hitPt, tr.dir.clone().negate(), c.material);
          this.hideTracer(i);
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Check tree trunks/rocks
      for (const cyl of cylColliders) {
        const dx = tr.pos.x - cyl.x;
        const dz = tr.pos.z - cyl.z;
        if (dx * dx + dz * dz < cyl.radius * cyl.radius && tr.pos.y <= cyl.topY && tr.pos.y >= cyl.bottomY) {
          this.spawnImpact(tr.pos, tr.dir.clone().negate(), cyl.material);
          this.hideTracer(i);
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Enemy bullet hits player capsule?
      if (tr.fromEnemy) {
        const pDistXZ = Math.hypot(tr.pos.x - playerPos.x, tr.pos.z - playerPos.z);
        if (pDistXZ < 0.52 && tr.pos.y >= playerPos.y && tr.pos.y <= playerPos.y + 1.75) {
          onPlayerHit(tr.damage, prevPos);
          this.hideTracer(i);
          continue;
        }
      }

      // Hide tracer cleanly if within 1.4m of camera so it never sticks across the lens
      if (tr.pos.distanceTo(playerPos) < 1.35) {
        this.hideTracer(i);
        continue;
      }

      this.dummy.position.copy(tr.pos);
      this.dummy.quaternion.setFromUnitVectors(up, tr.dir);
      const lifeFade = Math.min(1, tr.life / 0.04);
      this.dummy.scale.set(1, 1, 0.35 + lifeFade * 0.65);
      this.dummy.updateMatrix();
      this.tracerMesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (tracersDirty) this.tracerMesh.instanceMatrix.needsUpdate = true;
  }
}
