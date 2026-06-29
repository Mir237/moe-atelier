import type { PromptData } from '../types/prompt';
import { safeStorageGet } from './storage';

export const DEFAULT_PROMPT_DATA_SOURCE =
  'https://raw.githubusercontent.com/unknowlei/nanobanana-website/refs/heads/main/public/data.json';
export const PROMPT_MANAGER_SOURCE = '/api/prompt-manager';
export const PROMPT_SOURCE_STORAGE_KEY = 'moe-atelier:prompt-source';

const PROMO_NOTE_PATTERNS = [
  /labnana/i,
  /aff=/i,
  /邀请链接/,
  /分享给你试试/,
  /通过我的邀请链接/,
];

const sanitizePromoNotes = (text?: string) => {
  if (!text) return '';
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !PROMO_NOTE_PATTERNS.some((pattern) => pattern.test(line)));
  return lines.join('\n');
};

const normalizePromptManagerRefs = (refs: unknown): string[] => {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) => {
      if (!ref || typeof ref !== 'object') return null;
      const record = ref as Record<string, unknown>;
      const filePath = typeof record.file_path === 'string' ? record.file_path : '';
      if (!filePath || record.is_placeholder === true || filePath.includes('{{')) return null;
      const position = typeof record.position === 'number' ? record.position : Number.POSITIVE_INFINITY;
      return { filePath, position };
    })
    .filter((value): value is { filePath: string; position: number } => Boolean(value))
    .sort((a, b) => a.position - b.position)
    .map((ref) => ref.filePath);
};

const normalizePromptManagerTimestamp = (createdAt?: string) => {
  if (!createdAt) return null;
  const normalized = createdAt.replace(/\.(\d{3})\d+/, '.$1');
  const iso = /Z|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
};

const buildPromptManagerId = (item: Record<string, unknown>, index: number) => {
  const createdAt = typeof item.created_at === 'string' ? item.created_at : '';
  const timestamp = normalizePromptManagerTimestamp(createdAt);
  const baseId = typeof item.id === 'string' || typeof item.id === 'number' ? item.id : index;
  if (timestamp) return `imported-${timestamp}-${baseId}`;
  return `pm-${baseId}`;
};

const normalizePromptManagerData = (payload: { data?: Record<string, unknown>[] }): PromptData => {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const prompts = items.map((item, index) => {
    const fallbackId = typeof item.id === 'string' || typeof item.id === 'number' ? item.id : index;
    const createdAt = normalizePromptManagerTimestamp(
      typeof item.created_at === 'string' ? item.created_at : '',
    );
    const notes = sanitizePromoNotes(typeof item.description === 'string' ? item.description : '');
    const imageUrl =
      (typeof item.file_path === 'string' && item.file_path) ||
      (typeof item.thumbnail_path === 'string' && item.thumbnail_path) ||
      '';
    const tags = Array.isArray(item.tags)
      ? item.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
      : undefined;
    const refImages = normalizePromptManagerRefs(item.refs);
    return {
      id: buildPromptManagerId(item, index),
      title: typeof item.title === 'string' && item.title ? item.title : `未命名-${fallbackId}`,
      content: typeof item.prompt === 'string' ? item.prompt : '',
      createdAt: createdAt ?? undefined,
      tags: tags && tags.length > 0 ? tags : undefined,
      contributor: typeof item.author === 'string' && item.author ? item.author : undefined,
      notes: notes || undefined,
      images: imageUrl ? [imageUrl] : undefined,
      refs: refImages.length > 0 ? refImages : undefined,
    };
  });
  return {
    sections: [
      {
        id: 'prompt-manager',
        title: 'Prompt-Manager',
        prompts,
      },
    ],
  };
};

const normalizePromptData = (payload: unknown, sourceUrl: string): PromptData => {
  if (sourceUrl === PROMPT_MANAGER_SOURCE) {
    return normalizePromptManagerData(payload as { data?: Record<string, unknown>[] });
  }
  if (payload && typeof payload === 'object' && Array.isArray((payload as PromptData).sections)) {
    return payload as PromptData;
  }
  return { sections: [] };
};

export const collectPromptSourceTags = (data: PromptData) => {
  const tags = new Set<string>();
  data.commonTags?.forEach((tag) => {
    const normalized = tag.trim();
    if (normalized) tags.add(normalized);
  });
  data.sections.forEach((section) => {
    section.prompts.forEach((prompt) => {
      prompt.tags?.forEach((tag) => {
        const normalized = tag.trim();
        if (normalized) tags.add(normalized);
      });
    });
  });
  return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
};

export const loadCurrentPromptSourceTags = async () => {
  const sourceUrl = safeStorageGet(PROMPT_SOURCE_STORAGE_KEY, 'prompt source') || DEFAULT_PROMPT_DATA_SOURCE;
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error('标签数据源读取失败');
  }
  const payload = await response.json();
  return collectPromptSourceTags(normalizePromptData(payload, sourceUrl));
};
