import type { AppConfig, ApiProfile, NovelAiConfig, NovelAiOverrides } from '../types/app';

const NOVELAI_NUMBER_KEYS = new Set<keyof NovelAiConfig>([
  'width',
  'height',
  'steps',
  'scale',
  'seed',
  'ucPreset',
  'cfgRescale',
]);

const joinNovelAiUc = (...items: Array<unknown>) =>
  items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(', ');

export const isNovelAiProfile = (profile?: Partial<AppConfig> | Partial<ApiProfile> | null) =>
  profile?.apiFormat === 'novelai';

export const mergeNovelAiConfig = (
  defaultConfig: NovelAiConfig,
  overrides?: NovelAiOverrides,
): NovelAiConfig => {
  const clean = stripEmptyNovelAiOverrides(overrides);
  const merged: NovelAiConfig = {
    ...defaultConfig,
    ...clean,
  };
  if (typeof clean.uc === 'string') {
    merged.uc = joinNovelAiUc(defaultConfig.uc, clean.uc);
  }
  return merged;
};

export const stripEmptyNovelAiOverrides = (
  overrides?: NovelAiOverrides | null,
): NovelAiOverrides => {
  if (!overrides) return {};
  const next: NovelAiOverrides = {};
  (Object.entries(overrides) as Array<[keyof NovelAiConfig, unknown]>).forEach(([key, value]) => {
    if (typeof value === 'undefined' || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    if (key === 'seed' && (value === '' || !Number.isFinite(Number(value)))) return;
    if (NOVELAI_NUMBER_KEYS.has(key) && typeof value === 'number' && !Number.isFinite(value)) return;
    (next as Record<keyof NovelAiConfig, unknown>)[key] = value;
  });
  return next;
};

export const hasNovelAiOverrides = (overrides?: NovelAiOverrides | null) =>
  Object.keys(stripEmptyNovelAiOverrides(overrides)).length > 0;
