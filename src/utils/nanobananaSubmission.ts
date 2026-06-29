import { getTaskStorageKey } from '../app/storage';
import { loadTaskState } from '../components/imageTaskState';
import type { TaskConfig } from '../types/app';
import type { PersistedImageTaskState, PersistedSubTaskResult } from '../types/imageTask';
import { buildBackendImageUrl, fetchBackendTask } from './backendApi';
import { IMAGE_STORE_NAME, openImageDb } from './imageDb';
import { getTaskDisplayName, normalizeTaskName } from './taskName';

export const NANOBANANA_SUBMISSION_TARGET = {
  id: 'nanobanana-website',
  label: 'nanobanana-website',
} as const;

export interface NanobananaSubmissionPayload {
  title: string;
  content: string;
  tags: string[];
  images: string[];
  contributor: string;
  notes: string;
  action: 'create';
  targetId: null;
  variantIndex: null;
  originalTitle: null;
  submissionType: '全新投稿';
}

export type OneClickSubmissionStatus = 'draft' | 'submitting' | 'success' | 'error';

export interface OneClickSubmissionDraft {
  id: string;
  taskId: string;
  taskName: string;
  title: string;
  content: string;
  tags: string[];
  images: string[];
  contributor: string;
  notes: string;
  imageWarnings: string[];
  status: OneClickSubmissionStatus;
  error?: string;
}

export interface NanobananaApiResult {
  success: boolean;
  id?: string;
  url?: string;
  error?: string;
}

const isDataImageUrl = (value: string) => value.startsWith('data:image/');

const isBackendImageUrl = (value: string) => value.includes('/api/backend/image/');

const isLocalHostname = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

const isPublicHttpImageUrl = (value: string) => {
  if (!/^https?:\/\//i.test(value)) return false;
  if (isBackendImageUrl(value)) return false;
  try {
    const parsed = new URL(value);
    if (typeof window !== 'undefined') {
      const current = new URL(window.location.href);
      if (parsed.host === current.host) return false;
    }
    return !isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
};

const extractBackendImageKey = (value: string) => {
  const match = value.match(/\/api\/backend\/image\/([^?]+)/);
  return match ? decodeURIComponent(match[1]) : '';
};

const readJsonSafely = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { success: false, error: text } as T;
  }
};

export const submitNanobananaPrompt = async (
  payload: NanobananaSubmissionPayload,
): Promise<NanobananaApiResult> => {
  try {
    const response = await fetch('/api/nanobanana/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await readJsonSafely<NanobananaApiResult>(response);
    return response.ok ? result : { success: false, error: result.error || '投稿失败' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '投稿失败',
    };
  }
};

export const uploadNanobananaImage = async (image: string): Promise<NanobananaApiResult> => {
  try {
    const response = await fetch('/api/nanobanana/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    });
    const result = await readJsonSafely<NanobananaApiResult>(response);
    return response.ok ? result : { success: false, error: result.error || '图片上传失败' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '图片上传失败',
    };
  }
};

const readCachedImageBlob = async (key: string): Promise<Blob | null> => {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openImageDb();
    return await new Promise<Blob | null>((resolve) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
      const request = tx.objectStore(IMAGE_STORE_NAME).get(key);
      request.onsuccess = () => {
        const value = request.result as { blob?: Blob } | undefined;
        resolve(value?.blob || null);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('图片读取失败'));
      }
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });

const fetchImageBlob = async (url: string): Promise<Blob | null> => {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
};

const uploadDataImage = async (dataUrl: string) => {
  const result = await uploadNanobananaImage(dataUrl);
  if (!result.success || !result.url) {
    throw new Error(result.error || '图片上传失败');
  }
  return result.url;
};

const uploadBlobImage = async (blob: Blob) => uploadDataImage(await blobToDataUrl(blob));

const resolveRemoteSource = (sourceUrl: string) => {
  const backendKey = extractBackendImageKey(sourceUrl);
  if (backendKey) return buildBackendImageUrl(backendKey);
  return sourceUrl;
};

const resolveSubmissionImageUrl = async (
  result: PersistedSubTaskResult,
  backendMode: boolean,
) => {
  const sourceUrl = typeof result.sourceUrl === 'string' ? result.sourceUrl : '';
  if (sourceUrl && isPublicHttpImageUrl(sourceUrl)) {
    return sourceUrl;
  }
  if (sourceUrl && isDataImageUrl(sourceUrl)) {
    return await uploadDataImage(sourceUrl);
  }

  if (result.localKey) {
    const blob = backendMode
      ? await fetchImageBlob(buildBackendImageUrl(result.localKey))
      : await readCachedImageBlob(result.localKey);
    if (blob) return await uploadBlobImage(blob);
  }

  if (sourceUrl) {
    const blob = await fetchImageBlob(resolveRemoteSource(sourceUrl));
    if (blob) return await uploadBlobImage(blob);
  }

  throw new Error('未找到可读取的图片数据');
};

const loadTaskForSubmission = async (taskId: string, backendMode: boolean) => {
  if (backendMode) return await fetchBackendTask(taskId);
  return loadTaskState(getTaskStorageKey(taskId));
};

const buildDraftTitle = (task: TaskConfig, taskState?: PersistedImageTaskState | null) => {
  const explicitName = normalizeTaskName(taskState?.name) || normalizeTaskName(task.name);
  const prompt = taskState?.prompt || task.prompt || '';
  const promptLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (explicitName || promptLine || getTaskDisplayName(task)).slice(0, 48);
};

export const buildNanobananaSubmissionDrafts = async (
  tasks: TaskConfig[],
  backendMode: boolean,
): Promise<OneClickSubmissionDraft[]> => {
  const drafts: OneClickSubmissionDraft[] = [];

  for (const [index, task] of tasks.entries()) {
    let taskState: PersistedImageTaskState | null = null;
    const imageWarnings: string[] = [];

    try {
      taskState = await loadTaskForSubmission(task.id, backendMode);
      if (!taskState) {
        imageWarnings.push('任务缓存为空，只能使用任务列表中的基础信息。');
      }
    } catch (error) {
      imageWarnings.push(
        error instanceof Error ? `任务读取失败：${error.message}` : '任务读取失败。',
      );
    }

    const successResults = (taskState?.results || []).filter(
      (result) => result.status === 'success',
    );
    const images: string[] = [];

    for (const [resultIndex, result] of successResults.entries()) {
      try {
        const url = await resolveSubmissionImageUrl(result, backendMode);
        if (!images.includes(url)) images.push(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : '图片处理失败';
        imageWarnings.push(`图片 ${resultIndex + 1}：${message}`);
      }
    }

    if (successResults.length === 0) {
      imageWarnings.push('这个任务还没有成功生成的图片，可在投稿窗口手动添加图片链接或上传图片。');
    }

    const taskName = getTaskDisplayName({
      id: task.id,
      name: taskState?.name || task.name,
    });

    drafts.push({
      id: `${task.id}-${index}`,
      taskId: task.id,
      taskName,
      title: buildDraftTitle(task, taskState),
      content: taskState?.prompt || task.prompt || '',
      tags: [],
      images,
      contributor: '',
      notes: '',
      imageWarnings,
      status: 'draft',
    });
  }

  return drafts;
};
