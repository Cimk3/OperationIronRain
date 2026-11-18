import * as THREE from 'three';
import { MaterialId, MuzzleAttachment, WeaponId } from '../types';

const WORKLET_CODE = `
class RainWindProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.b3 = 0; this.b4 = 0; this.b5 = 0; this.b6 = 0;
    this.windPhase = 0;
    this.seed = 1234567;
  }
  nextRand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return (this.seed / 4294967296) * 2 - 1;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out[1] || left;

    for (let i = 0; i < left.length; i++) {
      const white = this.nextRand();
      // Paul Kellet pink noise filter for natural rain hiss
      this.b0 = 0.99886 * this.b0 + white * 0.0555179;
      this.b1 = 0.99332 * this.b1 + white * 0.0750759;
      this.b2 = 0.96900 * this.b2 + white * 0.1538520;
      this.b3 = 0.86650 * this.b3 + white * 0.3104856;
      this.b4 = 0.55000 * this.b4 + white * 0.5329522;
      this.b5 = -0.7616 * this.b5 - white * 0.0168980;
      const pink = (this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362) * 0.08;
      this.b6 = white * 0.115926;

      this.windPhase += 0.000018;
      const gust = 0.72 + 0.28 * Math.sin(this.windPhase) + 0.12 * Math.sin(this.windPhase * 2.7);
      const dropPop = Math.abs(white) > 0.985 ? white * 0.18 : 0;

      const sampleL = (pink * gust + dropPop) * 0.55;
      const sampleR = (pink * gust - dropPop * 0.7 + this.nextRand() * 0.015) * 0.55;
      left[i] = sampleL;
      if (right !== left) right[i] = sampleR;
    }
    return true;
  }
}
registerProcessor('rain-wind-processor', RainWindProcessor);
`;

export class ProceduralAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterLowpass: BiquadFilterNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private rainDuckGain: GainNode | null = null;
  private reverbNode: ConvolverNode | null = null;
  private reverbSend: GainNode | null = null;
  private indoorReverbNode: ConvolverNode | null = null;
  private indoorReverbSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private volume = 0.8;
  private initialized = false;
  private workletStarted = false;
  private heartbeatTimer = 0;

  public async init(): Promise<void> {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;

    // Master lowpass for critical low-HP muffled stress effect
    this.masterLowpass = this.ctx.createBiquadFilter();
    this.masterLowpass.type = 'lowpass';
    this.masterLowpass.frequency.value = 19000;

    // Dynamics compressor to keep intense firefights crisp without clipping
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 14;
    comp.ratio.value = 7;
    comp.attack.value = 0.002;
    comp.release.value = 0.16;

    this.masterGain.connect(this.masterLowpass);
    this.masterLowpass.connect(comp);
    comp.connect(this.ctx.destination);

    // Build shared 1.5s stereo noise buffer
    const sr = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, sr * 1.5, sr);
    const ch = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      ch[i] = Math.random() * 2 - 1;
    }

    // Build procedural woodland/outpost outdoor Convolution Impulse Response
    const irLen = Math.floor(sr * 1.45);
    const irBuf = this.ctx.createBuffer(2, irLen, sr);
    for (let c = 0; c < 2; c++) {
      const data = irBuf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        const env = Math.exp(-t * 4.8) * (i < 120 ? i / 120 : 1);
        const raw = (Math.random() * 2 - 1) * env;
        lp = lp * 0.72 + raw * 0.28; // Damp high frequencies in wet forest air
        data[i] = lp;
      }
    }
    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = irBuf;
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.34;
    this.reverbNode.connect(this.reverbSend);
    this.reverbSend.connect(this.masterGain);

    // Build Underground Concrete Silo Hall Convolution Impulse Response (metallic slapback + deep 1.9s decay)
    const inLen = Math.floor(sr * 1.9);
    const inBuf = this.ctx.createBuffer(2, inLen, sr);
    for (let c = 0; c < 2; c++) {
      const data = inBuf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < inLen; i++) {
        const t = i / inLen;
        const early = i === Math.floor(sr * 0.028) || i === Math.floor(sr * 0.055) ? 0.55 : 0;
        const env = Math.exp(-t * 3.1) * (i < 80 ? i / 80 : 1);
        const raw = (Math.random() * 2 - 1) * env + early * (c === 0 ? 1 : -0.8);
        lp = lp * 0.55 + raw * 0.45;
        data[i] = lp;
      }
    }
    this.indoorReverbNode = this.ctx.createConvolver();
    this.indoorReverbNode.buffer = inBuf;
    this.indoorReverbSend = this.ctx.createGain();
    this.indoorReverbSend.gain.value = 0.0;
    this.indoorReverbNode.connect(this.indoorReverbSend);
    this.indoorReverbSend.connect(this.masterGain);

    // Start AudioWorklet rain & wind bed
    try {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const rainNode = new AudioWorkletNode(this.ctx, 'rain-wind-processor');
      const rainBP = this.ctx.createBiquadFilter();
      rainBP.type = 'bandpass';
      rainBP.frequency.value = 1350;
      rainBP.Q.value = 0.45;

      this.rainFilter = this.ctx.createBiquadFilter();
      this.rainFilter.type = 'lowpass';
      this.rainFilter.frequency.value = 18500;

      this.rainDuckGain = this.ctx.createGain();
      this.rainDuckGain.gain.value = 0.22;

      rainNode.connect(rainBP);
      rainBP.connect(this.rainFilter);
      this.rainFilter.connect(this.rainDuckGain);
      this.rainDuckGain.connect(this.masterGain);
      this.workletStarted = true;
    } catch {
      // Fallback noise loop if AudioWorklet restricted
      this.startFallbackRain();
    }

    this.initialized = true;
  }

  private startFallbackRain(): void {
    if (!this.ctx || !this.noiseBuffer || !this.masterGain || this.workletStarted) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.value = 0.08;
    src.connect(bp);
    bp.connect(g);
    g.connect(this.masterGain);
    src.start();
  }

  public setVolume(v: number): void {
    this.volume = v;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    }
  }

  public updateListener(pos: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.y, t);
      l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(forward.x, t);
      l.forwardY.setValueAtTime(forward.y, t);
      l.forwardZ.setValueAtTime(forward.z, t);
      l.upX.setValueAtTime(up.x, t);
      l.upY.setValueAtTime(up.y, t);
      l.upZ.setValueAtTime(up.z, t);
    }
  }

  private createSpatialChain(worldPos?: THREE.Vector3, occluded = false): AudioNode | null {
    if (!this.ctx || !this.masterGain) return null;
    const occFilter = this.ctx.createBiquadFilter();
    occFilter.type = 'lowpass';
    occFilter.frequency.value = occluded ? 780 : 18500;

    if (worldPos) {
      const panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 4;
      panner.maxDistance = 140;
      panner.rolloffFactor = 1.15;
      panner.positionX.value = worldPos.x;
      panner.positionY.value = worldPos.y;
      panner.positionZ.value = worldPos.z;
      occFilter.connect(panner);
      panner.connect(this.masterGain);
      if (this.reverbNode) panner.connect(this.reverbNode);
      if (this.indoorReverbNode) panner.connect(this.indoorReverbNode);
    } else {
      occFilter.connect(this.masterGain);
      if (this.reverbNode) occFilter.connect(this.reverbNode);
      if (this.indoorReverbNode) occFilter.connect(this.indoorReverbNode);
    }
    return occFilter;
  }

  /**
   * Layered Gunshot Synthesis: Supports M4A1 / AR-15 DMR / SIG M7 6.8mm / MP5SD / M1911 + Suppressor & Muzzle Brake!
   */
  public playGunshot(
    weapon: WeaponId,
    worldPos?: THREE.Vector3,
    occluded = false,
    muzzleType: MuzzleAttachment = 'default'
  ): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dest = this.createSpatialChain(worldPos, occluded);
    if (!dest) return;

    const isSuppressed =
      muzzleType === 'suppressor' || (weapon === 'mp5sd' && muzzleType === 'default');
    const isBrake = muzzleType === 'brake';
    const isAR15 = weapon === 'ar15';
    const isM7 = weapon === 'm7';
    const isRifle = weapon === 'm4a1' || isAR15 || isM7;
    const volScale = (worldPos ? 0.85 : 1.0) * (isBrake ? 1.15 : 1.0);

    // Sidechain ducking on player shot
    if (!worldPos && this.rainDuckGain && !isSuppressed) {
      this.rainDuckGain.gain.cancelScheduledValues(now);
      this.rainDuckGain.gain.setValueAtTime(this.rainDuckGain.gain.value, now);
      this.rainDuckGain.gain.linearRampToValueAtTime(0.06, now + 0.015);
      this.rainDuckGain.gain.linearRampToValueAtTime(0.22, now + 0.30);
    }

    if (isSuppressed) {
      const subPitch = isM7 ? 110 : isAR15 ? 128 : 140;
      const puff = this.ctx.createBufferSource();
      puff.buffer = this.noiseBuffer;
      const puffFilter = this.ctx.createBiquadFilter();
      puffFilter.type = 'bandpass';
      puffFilter.frequency.setValueAtTime(isM7 ? 820 : 980, now);
      puffFilter.frequency.exponentialRampToValueAtTime(isM7 ? 180 : 220, now + 0.06);
      puffFilter.Q.value = 1.5;
      const puffGain = this.ctx.createGain();
      puffGain.gain.setValueAtTime((isM7 ? 0.56 : 0.46) * volScale, now);
      puffGain.gain.exponentialRampToValueAtTime(0.001, now + 0.072);
      puff.connect(puffFilter);
      puffFilter.connect(puffGain);
      puffGain.connect(dest);
      puff.start(now);
      puff.stop(now + 0.08);

      const thump = this.ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(subPitch, now);
      thump.frequency.exponentialRampToValueAtTime(42, now + 0.055);
      const tGain = this.ctx.createGain();
      tGain.gain.setValueAtTime((isM7 ? 0.52 : 0.42) * volScale, now);
      tGain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
      thump.connect(tGain);
      tGain.connect(dest);
      thump.start(now);
      thump.stop(now + 0.07);

      const bolt = this.ctx.createBufferSource();
      bolt.buffer = this.noiseBuffer;
      const boltF = this.ctx.createBiquadFilter();
      boltF.type = 'bandpass';
      boltF.frequency.value = 3300;
      boltF.Q.value = 2.6;
      const boltG = this.ctx.createGain();
      boltG.gain.setValueAtTime(0.24 * volScale, now + 0.01);
      boltG.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      bolt.connect(boltF);
      boltF.connect(boltG);
      boltG.connect(dest);
      bolt.start(now);
      bolt.stop(now + 0.05);
      return;
    }

    // Layer 1: Supersonic Transient Crack
    const crack = this.ctx.createBufferSource();
    crack.buffer = this.noiseBuffer;
    const crackFilter = this.ctx.createBiquadFilter();
    crackFilter.type = 'bandpass';
    const startFreq = isAR15 ? 3400 : isM7 ? 2150 : isRifle ? 2600 : isBrake ? 2400 : 1450;
    const endFreq = isAR15 ? 680 : isM7 ? 380 : isRifle ? 520 : 340;
    crackFilter.frequency.setValueAtTime(startFreq, now);
    crackFilter.frequency.exponentialRampToValueAtTime(endFreq, now + 0.09);
    crackFilter.Q.value = isAR15 ? 1.15 : isM7 ? 0.75 : isRifle ? 0.9 : 0.7;

    const crackGain = this.ctx.createGain();
    crackGain.gain.setValueAtTime((isM7 ? 1.2 : isRifle ? 1.05 : 0.85) * volScale, now);
    crackGain.gain.exponentialRampToValueAtTime(0.001, now + (isM7 ? 0.17 : isRifle ? 0.14 : 0.11));

    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(dest);
    crack.start(now);
    crack.stop(now + 0.19);

    // Layer 2: Muzzle Chest-Punch Boom (heavy sub thump for 6.8mm M7!)
    const boomOsc = this.ctx.createOscillator();
    boomOsc.type = isRifle ? 'triangle' : 'sine';
    boomOsc.frequency.setValueAtTime(isM7 ? 142 : isAR15 ? 185 : isRifle ? 165 : 125, now);
    boomOsc.frequency.exponentialRampToValueAtTime(isM7 ? 32 : 38, now + (isM7 ? 0.15 : isRifle ? 0.11 : 0.14));

    const boomGain = this.ctx.createGain();
    boomGain.gain.setValueAtTime((isM7 ? 1.15 : isRifle ? 0.85 : 0.98) * volScale, now);
    boomGain.gain.exponentialRampToValueAtTime(0.001, now + (isM7 ? 0.20 : 0.16));

    boomOsc.connect(boomGain);
    boomGain.connect(dest);
    boomOsc.start(now);
    boomOsc.stop(now + 0.21);

    // Layer 3: Mechanical Bolt / Buffer Ping
    const mech = this.ctx.createBufferSource();
    mech.buffer = this.noiseBuffer;
    const mechFilter = this.ctx.createBiquadFilter();
    mechFilter.type = 'highpass';
    mechFilter.frequency.value = isAR15 ? 3900 : isRifle ? 3400 : 2200;
    const mechGain = this.ctx.createGain();
    mechGain.gain.setValueAtTime(0.001, now);
    mechGain.gain.setValueAtTime((isRifle ? 0.28 : 0.35) * volScale, now + 0.018);
    mechGain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
    mech.connect(mechFilter);
    mechFilter.connect(mechGain);
    mechGain.connect(dest);
    mech.start(now);
    mech.stop(now + 0.07);
  }

  /**
   * Metallic Shell Casing Clink on Ground
   */
  public playShellClink(mat: MaterialId, delay = 0.35): void {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime + delay;
    const baseFreq = mat === MaterialId.CONCRETE || mat === MaterialId.ROCK ? 5200 : 2800;
    const gainScale = mat === MaterialId.GRASS || mat === MaterialId.WET_MUD ? 0.04 : 0.11;

    for (let b = 0; b < 2; b++) {
      const bt = t + b * 0.085;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq + Math.random() * 900, bt);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gainScale * (b === 0 ? 1 : 0.45), bt);
      g.gain.exponentialRampToValueAtTime(0.0001, bt + 0.045);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(bt);
      osc.stop(bt + 0.05);
    }
  }

  /**
   * Weapon Reload Mechanical Foley (Mag Out / Mag In / Bolt Rack)
   */
  public playReloadStage(stage: 'mag_out' | 'mag_in' | 'rack'): void {
    if (!this.ctx || !this.noiseBuffer || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = stage === 'rack' ? 2.4 : 3.2;
    bp.frequency.value = stage === 'mag_out' ? 1900 : stage === 'mag_in' ? 1400 : 2800;

    const g = this.ctx.createGain();
    const dur = stage === 'rack' ? 0.12 : 0.07;
    g.gain.setValueAtTime(0.28, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.masterGain);
    src.start(now);
    src.stop(now + dur + 0.01);
  }

  /**
   * Unified Material Acoustic System: Footsteps
   */
  public playFootstep(mat: MaterialId, sprint = false): void {
    if (!this.ctx || !this.noiseBuffer || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    const vol = sprint ? 0.24 : 0.15;

    switch (mat) {
      case MaterialId.WATER: {
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(950, now);
        filter.frequency.exponentialRampToValueAtTime(2400, now + 0.12);
        filter.Q.value = 1.8;
        g.gain.setValueAtTime(vol * 1.25, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        break;
      }
      case MaterialId.WET_MUD: {
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(620, now);
        filter.frequency.exponentialRampToValueAtTime(220, now + 0.11);
        g.gain.setValueAtTime(vol * 1.1, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
        break;
      }
      case MaterialId.GRAVEL: {
        filter.type = 'bandpass';
        filter.frequency.value = 2600 + Math.random() * 600;
        filter.Q.value = 1.1;
        g.gain.setValueAtTime(vol * 0.9, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        break;
      }
      case MaterialId.CONCRETE:
      case MaterialId.ROCK: {
        filter.type = 'bandpass';
        filter.frequency.value = 850;
        filter.Q.value = 1.4;
        g.gain.setValueAtTime(vol * 0.95, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        break;
      }
      case MaterialId.WOOD: {
        filter.type = 'bandpass';
        filter.frequency.value = 340;
        filter.Q.value = 3.0;
        g.gain.setValueAtTime(vol * 1.1, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        break;
      }
      default: {
        // GRASS
        filter.type = 'bandpass';
        filter.frequency.value = 1500;
        filter.Q.value = 0.65;
        g.gain.setValueAtTime(vol * 0.72, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.10);
      }
    }

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(now);
    src.stop(now + 0.22);
  }

  /**
   * Unified Material Acoustic System: 3D Bullet Impact Sounds
   */
  public playBulletImpact(mat: MaterialId, worldPos: THREE.Vector3, occluded = false): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dest = this.createSpatialChain(worldPos, occluded);
    if (!dest) return;

    if (mat === MaterialId.METAL) {
      // Metallic ricochet ping
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(2900 + Math.random() * 800, now);
      osc.frequency.exponentialRampToValueAtTime(1400, now + 0.18);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.32, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(g);
      g.connect(dest);
      osc.start(now);
      osc.stop(now + 0.22);
    } else {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value =
        mat === MaterialId.WATER
          ? 1200
          : mat === MaterialId.WOOD
            ? 540
            : mat === MaterialId.CONCRETE || mat === MaterialId.ROCK
              ? 1850
              : 780;
      f.Q.value = mat === MaterialId.WATER ? 1.2 : 1.8;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.36, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + (mat === MaterialId.WATER ? 0.19 : 0.08));
      src.connect(f);
      f.connect(g);
      g.connect(dest);
      src.start(now);
      src.stop(now + 0.21);
    }
  }

  /**
   * Hitmarker Confirmation: Crisp metallic helmet crack (headshot) vs Kevlar torso thud (body)
   */
  public playHitConfirm(headshot: boolean): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = headshot ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(headshot ? 2750 : 210, now);
    osc.frequency.exponentialRampToValueAtTime(headshot ? 1350 : 82, now + (headshot ? 0.075 : 0.055));
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(headshot ? 0.24 : 0.22, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + (headshot ? 0.085 : 0.06));
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.09);

    if (headshot && this.noiseBuffer) {
      const crack = this.ctx.createBufferSource();
      crack.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 3400;
      bp.Q.value = 2.2;
      const cg = this.ctx.createGain();
      cg.gain.setValueAtTime(0.18, now);
      cg.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      crack.connect(bp);
      bp.connect(cg);
      cg.connect(this.masterGain);
      crack.start(now);
      crack.stop(now + 0.05);
    }
  }

  /**
   * Underground Concrete Reverb & Rain Transition (0 = exterior rain, 1 = deep underground concrete)
   */
  public setEnvironmentAcoustic(underground01: number, sheltered01: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.reverbSend) {
      this.reverbSend.gain.setTargetAtTime(THREE.MathUtils.lerp(0.36, 0.02, underground01), t, 0.12);
    }
    if (this.indoorReverbSend) {
      this.indoorReverbSend.gain.setTargetAtTime(THREE.MathUtils.lerp(0.0, 0.56, underground01), t, 0.12);
    }
    if (this.rainDuckGain) {
      this.rainDuckGain.gain.setTargetAtTime(THREE.MathUtils.lerp(0.22, 0.018, underground01), t, 0.15);
    }
    if (this.rainFilter) {
      const muffle = Math.max(sheltered01, underground01);
      this.rainFilter.frequency.setTargetAtTime(THREE.MathUtils.lerp(18500, 520, muffle), t, 0.12);
    }
  }

  public playSwitchClick(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(2400, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.025);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.035);
  }

  /**
   * Crisp Gunsmith Metal Latch Snap + Detent Clack when swapping weapon parts
   */
  public playGunsmithSnap(): void {
    if (!this.ctx || !this.noiseBuffer || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // 1. Sharp metallic rail slide tick
    const tick = this.ctx.createOscillator();
    tick.type = 'triangle';
    tick.frequency.setValueAtTime(3200, now);
    tick.frequency.exponentialRampToValueAtTime(950, now + 0.024);
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(0.18, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.028);
    tick.connect(tg);
    tg.connect(this.masterGain);
    tick.start(now);
    tick.stop(now + 0.032);

    // 2. Solid detent locking pin snap 28ms later
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 3.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.setValueAtTime(0.32, now + 0.026);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.masterGain);
    src.start(now + 0.024);
    src.stop(now + 0.085);
  }

  public playTerminalBeep(complete = false): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const freqs = complete ? [880, 1320] : [1100];
    freqs.forEach((f, idx) => {
      const t = now + idx * 0.09;
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
      osc.connect(g);
      g.connect(this.masterGain!);
      osc.start(t);
      osc.stop(t + 0.11);
    });
  }

  /**
   * Shattering Fluorescent Tube Glass + Electrical Arc Spark
   */
  public playGlassBreak(worldPos: THREE.Vector3): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dest = this.createSpatialChain(worldPos, false);
    if (!dest) return;

    for (let i = 0; i < 4; i++) {
      const t = now + i * 0.032;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(3400 + Math.random() * 3200, t);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.connect(g);
      g.connect(dest);
      osc.start(t);
      osc.stop(t + 0.13);
    }

    const spark = this.ctx.createBufferSource();
    spark.buffer = this.noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2800;
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.32, now);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    spark.connect(hp);
    hp.connect(sg);
    sg.connect(dest);
    spark.start(now);
    spark.stop(now + 0.20);
  }

  /**
   * Underground Red Klaxon Alarm Pulse
   */
  public playAlarmPulse(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    for (const freq of [520, 390]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.linearRampToValueAtTime(freq * 0.88, now + 0.42);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1100;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.075, now + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.46);
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.48);
    }
  }

  /**
   * Low-HP Muffled Stress Filter & Rhythmic Heartbeat
   */
  public updatePlayerVitals(hp: number, dt: number): void {
    if (!this.ctx || !this.masterLowpass || !this.masterGain) return;
    const critical = hp > 0 && hp < 38 ? 1 - hp / 38 : 0;
    const cutoff = THREE.MathUtils.lerp(19000, 1350, critical);
    this.masterLowpass.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.12);

    if (critical > 0.05) {
      this.heartbeatTimer -= dt;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = THREE.MathUtils.lerp(0.85, 0.52, critical);
        const now = this.ctx.currentTime;
        for (const offset of [0, 0.16]) {
          const osc = this.ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(62, now + offset);
          osc.frequency.exponentialRampToValueAtTime(36, now + offset + 0.11);
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.28 * critical, now + offset);
          g.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.13);
          osc.connect(g);
          g.connect(this.masterGain);
          osc.start(now + offset);
          osc.stop(now + offset + 0.14);
        }
      }
    }
  }

  /**
   * Procedural Distant Rolling Thunder synced with Lightning distance
   */
  public playThunder(delaySec: number, distMeters: number): void {
    if (!this.ctx || !this.noiseBuffer || !this.masterGain) return;
    const start = this.ctx.currentTime + delaySec;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(340, start);
    lp.frequency.exponentialRampToValueAtTime(65, start + 2.8);

    const amp = THREE.MathUtils.clamp(1.2 - distMeters / 1200, 0.25, 0.75);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, start);
    g.gain.linearRampToValueAtTime(amp, start + 0.14);
    g.gain.exponentialRampToValueAtTime(amp * 0.45, start + 0.9);
    g.gain.exponentialRampToValueAtTime(0.001, start + 3.2);

    src.connect(lp);
    lp.connect(g);
    g.connect(this.masterGain);
    src.start(start);
    src.stop(start + 3.3);
  }
}
