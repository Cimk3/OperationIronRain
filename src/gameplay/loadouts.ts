import {
  AttachmentSlot,
  MagAttachment,
  MuzzleAttachment,
  OpticAttachment,
  PlayerLoadoutSave,
  SideAttachment,
  UnderbarrelAttachment,
  WeaponId,
  WeaponLoadoutConfig,
} from '../types';

export interface WeaponStats {
  id: WeaponId;
  name: string;
  roleTag: string;
  caliber: string;
  magSize: number;
  reserveMax: number;
  rpm: number;
  damage: number;
  hipSpread: number;
  adsSpread: number;
  recoilPitch: number;
  recoilYaw: number;
  recoilKickZ: number;
  reloadDuration: number;
  tacticalReloadDuration: number;
  auto: boolean;
  adsFovScale: number;
  hearingRadius: number;
  baseMobility: number;
  baseAdsSpeed: number;
}

export interface ComputedWeaponStats extends WeaponStats {
  subtitle: string;
  isSuppressed: boolean;
  muzzleFlashScale: number;
  hasFlashlight: boolean;
  adsSpeedScale: number;
  moveSpeedScale: number;
  muzzleType: MuzzleAttachment;
  opticType: OpticAttachment;
  uiBars: {
    damage: number;
    fireRate: number;
    recoilControl: number;
    adsSpeed: number;
    mobility: number;
  };
}

export const BASE_WEAPON_STATS: Record<WeaponId, WeaponStats> = {
  m4a1: {
    id: 'm4a1',
    name: 'M4A1 SOPMOD',
    roleTag: '5.56mm 全自动卡宾',
    caliber: '5.56×45mm NATO • 全自动',
    magSize: 30,
    reserveMax: 180,
    rpm: 750,
    damage: 34,
    hipSpread: 0.025,
    adsSpread: 0.002,
    recoilPitch: 0.017,
    recoilYaw: 0.007,
    recoilKickZ: 0.026,
    reloadDuration: 2.25,
    tacticalReloadDuration: 1.55,
    auto: true,
    adsFovScale: 0.72,
    hearingRadius: 58,
    baseMobility: 78,
    baseAdsSpeed: 76,
  },
  ar15: {
    id: 'ar15',
    name: 'AR-15 MATCH DMR',
    roleTag: '半自动精确射手步枪',
    caliber: '5.56×45mm Mk262 • 半自动精确点射',
    magSize: 20,
    reserveMax: 120,
    rpm: 380,
    damage: 62,
    hipSpread: 0.021,
    adsSpread: 0.0005,
    recoilPitch: 0.021,
    recoilYaw: 0.0045,
    recoilKickZ: 0.028,
    reloadDuration: 2.15,
    tacticalReloadDuration: 1.5,
    auto: false,
    adsFovScale: 0.64,
    hearingRadius: 62,
    baseMobility: 70,
    baseAdsSpeed: 68,
  },
  m7: {
    id: 'm7',
    name: 'SIG M7 (XM7) 6.8mm',
    roleTag: '6.8mm 新一代全威力步枪',
    caliber: '6.8×51mm (.277 Fury) • 全自动重型',
    magSize: 20,
    reserveMax: 140,
    rpm: 650,
    damage: 48,
    hipSpread: 0.024,
    adsSpread: 0.0012,
    recoilPitch: 0.022,
    recoilYaw: 0.0078,
    recoilKickZ: 0.032,
    reloadDuration: 2.32,
    tacticalReloadDuration: 1.62,
    auto: true,
    adsFovScale: 0.70,
    hearingRadius: 66,
    baseMobility: 68,
    baseAdsSpeed: 66,
  },
  mp5sd: {
    id: 'mp5sd',
    name: 'MP5SD TACTICAL',
    roleTag: '9mm 战术潜行冲锋枪',
    caliber: '9×19mm Parabellum • 800 RPM',
    magSize: 30,
    reserveMax: 210,
    rpm: 800,
    damage: 27,
    hipSpread: 0.017,
    adsSpread: 0.0018,
    recoilPitch: 0.0095,
    recoilYaw: 0.0042,
    recoilKickZ: 0.014,
    reloadDuration: 2.15,
    tacticalReloadDuration: 1.45,
    auto: true,
    adsFovScale: 0.76,
    hearingRadius: 50, // Scaled dynamically down to ~15m when suppressor is mounted!
    baseMobility: 92,
    baseAdsSpeed: 88,
  },
  m1911: {
    id: 'm1911',
    name: 'M1911 TACTICAL',
    roleTag: '.45 ACP 备用手枪',
    caliber: '.45 ACP • 半自动',
    magSize: 8,
    reserveMax: 64,
    rpm: 360,
    damage: 46,
    hipSpread: 0.02,
    adsSpread: 0.0028,
    recoilPitch: 0.026,
    recoilYaw: 0.009,
    recoilKickZ: 0.032,
    reloadDuration: 1.85,
    tacticalReloadDuration: 1.3,
    auto: false,
    adsFovScale: 0.82,
    hearingRadius: 48,
    baseMobility: 98,
    baseAdsSpeed: 96,
  },
};

export interface SlotOptionInfo<T extends string = string> {
  id: T;
  label: string;
  desc: string;
}

export const OPTIC_OPTIONS: SlotOptionInfo<OpticAttachment>[] = [
  { id: 'iron', label: '默认机瞄', desc: '极简机械照门准星，开镜更快 (+5% ADS 速度)' },
  { id: 'red_dot', label: '红点瞄准镜', desc: '开放式宽视野反射镜 + 发光红点 (+15% 精度)' },
  { id: 'holo', label: '全息瞄准镜', desc: '装甲护罩 + 红蓝抗反光镀膜 65MOA 圆环 (+25% 精度)' },
];

export const RIFLE_MUZZLE_OPTIONS: SlotOptionInfo<MuzzleAttachment>[] = [
  { id: 'default', label: '默认消焰器', desc: '原厂开槽消焰器，均衡枪口表现' },
  { id: 'suppressor', label: '战术消音器', desc: '大幅消除火光与枪声，AI 听觉警戒范围缩减 72%' },
  { id: 'brake', label: '多孔制退器', desc: '后坐力 -25%，增大枪口火焰与横向爆鸣' },
];

export const MP5_MUZZLE_OPTIONS: SlotOptionInfo<MuzzleAttachment>[] = [
  { id: 'suppressor', label: '一体式消音筒', desc: '默认低音压气动消音筒，AI 警戒半径降至 15m' },
  { id: 'brake', label: '短管多孔制退器', desc: '替换为紧凑前段开放制退器，提升射速稳定性与机动性' },
];

export const RIFLE_UNDER_OPTIONS: SlotOptionInfo<UnderbarrelAttachment>[] = [
  { id: 'none', label: '无下挂', desc: '保留标准护木 C-Clamp 握持手感' },
  { id: 'vertical', label: '垂直握把', desc: '垂直后坐力 -26%，左手 IK 切换为柱体紧握' },
];

export const MP5_UNDER_OPTIONS: SlotOptionInfo<UnderbarrelAttachment>[] = [
  { id: 'none', label: '无下挂', desc: '原厂橡胶棱纹握持护木' },
  { id: 'vertical', label: '垂直握把', desc: '垂直后坐力 -26%，左手切换垂直握持' },
  { id: 'angled', label: '直角握把', desc: '开镜速度 +16%，左手贴合直角斜面握持' },
];

export const SIDE_OPTIONS: SlotOptionInfo<SideAttachment>[] = [
  { id: 'none', label: '无挂载', desc: '移除侧挂手电以提升开镜灵活性（局内禁用 F 手电）' },
  { id: 'flashlight', label: '战术手电', desc: '高流明聚光手电模块（按 F 开关体积光手电筒）' },
];

export const MAG_OPTIONS: SlotOptionInfo<MagAttachment>[] = [
  { id: 'standard', label: '标准弹匣', desc: '原厂制式双排供弹弹匣，机动均衡' },
  { id: 'fast', label: '快速弹匣', desc: '加装战术快拔胶套环，换弹速度提升 28%' },
  { id: 'extended', label: '扩容弹匣', desc: '单匣容量 +50%，略微降低开镜速度与换弹速度' },
];

export const WEAPON_SLOTS: Record<WeaponId, AttachmentSlot[]> = {
  m4a1: ['optic', 'muzzle', 'underbarrel', 'side', 'mag'],
  ar15: ['optic', 'muzzle', 'underbarrel', 'side', 'mag'],
  m7: ['optic', 'muzzle', 'underbarrel', 'side', 'mag'],
  mp5sd: ['optic', 'muzzle', 'underbarrel', 'side'],
  m1911: [],
};

export function getSlotOptions(weaponId: WeaponId, slot: AttachmentSlot): SlotOptionInfo[] {
  if (slot === 'optic') return OPTIC_OPTIONS;
  if (slot === 'muzzle') return weaponId === 'mp5sd' ? MP5_MUZZLE_OPTIONS : RIFLE_MUZZLE_OPTIONS;
  if (slot === 'underbarrel') return weaponId === 'mp5sd' ? MP5_UNDER_OPTIONS : RIFLE_UNDER_OPTIONS;
  if (slot === 'side') return SIDE_OPTIONS;
  if (slot === 'mag') return MAG_OPTIONS;
  return [];
}

export const SLOT_NAMES: Record<AttachmentSlot, string> = {
  optic: '瞄具 (OPTIC)',
  muzzle: '枪口 (MUZZLE)',
  underbarrel: '下挂 (UNDERBARREL)',
  side: '侧导轨 (SIDE RAIL)',
  mag: '弹匣 (MAGAZINE)',
};

export function createDefaultLoadoutSave(): PlayerLoadoutSave {
  return {
    primary: 'm4a1',
    secondary: 'm1911',
    userSelectedPrimary: false,
    configs: {
      m4a1: { optic: 'holo', muzzle: 'default', underbarrel: 'none', side: 'flashlight', mag: 'standard' },
      ar15: { optic: 'holo', muzzle: 'default', underbarrel: 'none', side: 'none', mag: 'standard' },
      m7: { optic: 'holo', muzzle: 'default', underbarrel: 'none', side: 'flashlight', mag: 'standard' },
      mp5sd: { optic: 'holo', muzzle: 'suppressor', underbarrel: 'none', side: 'flashlight', mag: 'standard' },
      m1911: { optic: 'iron', muzzle: 'default', underbarrel: 'none', side: 'none', mag: 'standard' },
    },
  };
}

const STORAGE_KEY = 'iron_rain_gunsmith_loadout_v1';

export function loadPlayerLoadout(): PlayerLoadoutSave {
  const def = createDefaultLoadoutSave();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Partial<PlayerLoadoutSave>;
    const out = createDefaultLoadoutSave();
    if (parsed.primary && (['m4a1', 'ar15', 'm7', 'mp5sd'] as string[]).includes(parsed.primary)) {
      out.primary = parsed.primary;
    }
    if (typeof parsed.userSelectedPrimary === 'boolean') {
      out.userSelectedPrimary = parsed.userSelectedPrimary;
    }
    if (parsed.configs) {
      for (const k of ['m4a1', 'ar15', 'm7', 'mp5sd', 'm1911'] as WeaponId[]) {
        if (parsed.configs[k]) {
          out.configs[k] = { ...out.configs[k], ...parsed.configs[k] };
        }
      }
    }
    return out;
  } catch {
    return def;
  }
}

export function savePlayerLoadout(save: PlayerLoadoutSave): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
  } catch {
    // Ignore storage quota / sandbox restriction
  }
}

export function computeModifiedStats(
  weaponId: WeaponId,
  config: WeaponLoadoutConfig
): ComputedWeaponStats {
  const base = BASE_WEAPON_STATS[weaponId];
  let damage = base.damage;
  let rpm = base.rpm;
  let magSize = base.magSize;
  let reserveMax = base.reserveMax;
  let hipSpread = base.hipSpread;
  let adsSpread = base.adsSpread;
  let recoilPitch = base.recoilPitch;
  let recoilYaw = base.recoilYaw;
  let recoilKickZ = base.recoilKickZ;
  let reloadDuration = base.reloadDuration;
  let tacticalReloadDuration = base.tacticalReloadDuration;
  let adsFovScale = base.adsFovScale;
  let hearingRadius = base.hearingRadius;
  let adsSpeedScale = 1.0;
  let moveSpeedScale = 1.0;
  let muzzleFlashScale = 1.0;
  let isSuppressed = false;
  const hasFlashlight = config.side === 'flashlight';

  // 1. Optic
  if (config.optic === 'iron') {
    adsSpeedScale *= 1.05;
    adsFovScale = Math.min(0.86, base.adsFovScale + 0.03);
  } else if (config.optic === 'red_dot') {
    adsSpread *= 0.85;
  } else if (config.optic === 'holo') {
    adsSpread *= 0.72;
    adsFovScale = Math.max(0.58, base.adsFovScale - 0.03);
    adsSpeedScale *= 0.96;
  }

  // 2. Muzzle
  const effMuzzle: MuzzleAttachment =
    weaponId === 'mp5sd' && config.muzzle === 'default' ? 'suppressor' : config.muzzle;
  if (effMuzzle === 'suppressor') {
    isSuppressed = true;
    hearingRadius = weaponId === 'mp5sd' ? 14 : Math.round(base.hearingRadius * 0.28);
    muzzleFlashScale = 0.25;
    recoilPitch *= 0.94;
    adsSpeedScale *= 0.96;
  } else if (effMuzzle === 'brake') {
    isSuppressed = false;
    hearingRadius = Math.round(base.hearingRadius * 1.18);
    muzzleFlashScale = 1.45;
    recoilPitch *= 0.76;
    recoilYaw *= 0.72;
    recoilKickZ *= 0.80;
    if (weaponId === 'mp5sd') {
      rpm = 850;
      moveSpeedScale *= 1.03;
    }
  }

  // 3. Underbarrel
  if (config.underbarrel === 'vertical') {
    recoilPitch *= 0.74;
    recoilYaw *= 0.85;
    adsSpeedScale *= 0.92;
  } else if (config.underbarrel === 'angled') {
    adsSpeedScale *= 1.16;
    recoilYaw *= 0.78;
    recoilPitch *= 0.92;
    hipSpread *= 0.92;
  }

  // 4. Side Rail
  if (hasFlashlight) {
    adsSpeedScale *= 0.98;
  }

  // 5. Magazine
  if (config.mag === 'fast') {
    reloadDuration *= 0.72;
    tacticalReloadDuration *= 0.72;
  } else if (config.mag === 'extended') {
    magSize = Math.round(base.magSize * 1.5);
    reserveMax += base.magSize;
    reloadDuration *= 1.18;
    tacticalReloadDuration *= 1.18;
    adsSpeedScale *= 0.93;
    moveSpeedScale *= 0.95;
  }

  // 0..100 UI comparison meters
  const dmgBar = Math.min(100, Math.round((damage / 68) * 100));
  const rateBar = Math.min(100, Math.round((rpm / 900) * 100));
  const recoilCtrl = Math.max(
    10,
    Math.min(100, Math.round(100 - (recoilPitch * 2200 + recoilYaw * 1600)))
  );
  const adsBar = Math.max(15, Math.min(100, Math.round(base.baseAdsSpeed * adsSpeedScale)));
  const mobBar = Math.max(15, Math.min(100, Math.round(base.baseMobility * moveSpeedScale)));

  const muzzleTag = isSuppressed ? '消音' : effMuzzle === 'brake' ? '制退' : '标准';
  const opticTag = config.optic === 'holo' ? '全息' : config.optic === 'red_dot' ? '红点' : '机瞄';

  return {
    ...base,
    subtitle: `${base.caliber} • ${opticTag}/${muzzleTag} • [1] 主武器 [2] 手枪${hasFlashlight ? ' • [F] 手电' : ''}`,
    damage,
    rpm,
    magSize,
    reserveMax,
    hipSpread,
    adsSpread,
    recoilPitch,
    recoilYaw,
    recoilKickZ,
    reloadDuration,
    tacticalReloadDuration,
    adsFovScale,
    hearingRadius,
    isSuppressed,
    muzzleFlashScale,
    hasFlashlight,
    adsSpeedScale,
    moveSpeedScale,
    muzzleType: effMuzzle,
    opticType: config.optic,
    uiBars: {
      damage: dmgBar,
      fireRate: rateBar,
      recoilControl: recoilCtrl,
      adsSpeed: adsBar,
      mobility: mobBar,
    },
  };
}
