import type * as THREE from 'three';

export type QualityPreset = 'low' | 'medium' | 'high';
export type WeaponId = 'm4a1' | 'm1911' | 'mp5sd' | 'ar15' | 'm7';
export type PrimaryWeaponId = 'm4a1' | 'ar15' | 'm7' | 'mp5sd';
export type LevelId = 'level1' | 'level2';
export type GamePhase = 'menu' | 'briefing' | 'gunsmith' | 'playing' | 'paused' | 'ended';

export type OpticAttachment = 'iron' | 'red_dot' | 'holo';
export type MuzzleAttachment = 'default' | 'suppressor' | 'brake';
export type UnderbarrelAttachment = 'none' | 'vertical' | 'angled';
export type SideAttachment = 'none' | 'flashlight';
export type MagAttachment = 'standard' | 'fast' | 'extended';
export type AttachmentSlot = 'optic' | 'muzzle' | 'underbarrel' | 'side' | 'mag';

export interface WeaponLoadoutConfig {
  optic: OpticAttachment;
  muzzle: MuzzleAttachment;
  underbarrel: UnderbarrelAttachment;
  side: SideAttachment;
  mag: MagAttachment;
}

export interface PlayerLoadoutSave {
  primary: PrimaryWeaponId;
  secondary: 'm1911';
  userSelectedPrimary: boolean;
  configs: Record<WeaponId, WeaponLoadoutConfig>;
}

export enum MaterialId {
  GRASS = 0,
  WET_MUD = 1,
  GRAVEL = 2,
  CONCRETE = 3,
  WOOD = 4,
  METAL = 5,
  WATER = 6,
  ROCK = 7,
  SANDBAG = 8,
}

export interface QualityConfig {
  preset: QualityPreset;
  resolutionScale: number; // 1.0 on high!
  csmCascades: number;
  csmMapSize: number;
  enableGTAO: boolean;
  enableSSR: boolean;
  enableBloom: boolean;
  grassCount: number;
  rainCount: number;
  treeCount: number;
}

export const QUALITY_CONFIGS: Record<QualityPreset, QualityConfig> = {
  high: {
    preset: 'high',
    resolutionScale: 1.0, // Strict 100% native resolution
    csmCascades: 3,
    csmMapSize: 2048,
    enableGTAO: true,
    enableSSR: true,
    enableBloom: true,
    grassCount: 19500,
    rainCount: 4500,
    treeCount: 150,
  },
  medium: {
    preset: 'medium',
    resolutionScale: 0.85,
    csmCascades: 3,
    csmMapSize: 1024,
    enableGTAO: true,
    enableSSR: true,
    enableBloom: true,
    grassCount: 15500,
    rainCount: 2800,
    treeCount: 115,
  },
  low: {
    preset: 'low',
    resolutionScale: 0.72,
    csmCascades: 2,
    csmMapSize: 1024,
    enableGTAO: false,
    enableSSR: false,
    enableBloom: true,
    grassCount: 8000,
    rainCount: 1600,
    treeCount: 80,
  },
};

export interface GameSettings {
  quality: QualityPreset;
  sensitivity: number;
  adsSensitivity: number;
  masterVolume: number;
  fov: number;
}

export interface GameStats {
  startTime: number;
  elapsedSeconds: number;
  kills: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  damageTaken: number;
  victory: boolean;
}

export interface TerrainWorkerOutput {
  gridSize: number;
  worldSize: number;
  heights: Float32Array;
  waterDepth: Float32Array; // > 0 means puddle/standing water
  wetness: Float32Array; // 0..1 surface wetness
  splat: Uint8Array; // RGBA: grass, mud, gravel, rock weights
  treePlacements: Float32Array; // x, z, scale, rotY, seed
  rockPlacements: Float32Array; // x, z, scaleX, scaleY, scaleZ, rotY, seed
  bushPlacements: Float32Array; // x, z, scale, rotY
}

export interface WorldSurface {
  mesh: THREE.Object3D;
  getHeightAt(wx: number, wz: number, refY?: number): number;
  getNormalAt(wx: number, wz: number, target?: THREE.Vector3): THREE.Vector3;
  getWaterDepthAt(wx: number, wz: number): number;
  getMaterialAt(wx: number, wz: number): MaterialId;
}
