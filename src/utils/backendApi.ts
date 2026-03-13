import type { AppConfig } from '../types/app';
import type { CollectionItem } from '../types/collection';
import type { GlobalStats } from '../types/stats';
import type { PersistedImageTaskState } from '../types/imageTask';
import type { ApiFormat } from './apiUrl';
import type { FormatConfig } from '../app/storage';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './storage';
import { formatResponseErrorMessage } from './httpError';

export interface BackendState {
  config: AppConfig;
  configByFormat?: Partial<Record<ApiFormat, FormatConfig>>;
  tasksOrder: string[];
  globalStats: GlobalStats;
}

export interface BackendStateSnapshot extends BackendState {
  meta: {
    hasSavedState: boolean;
  };
}

const BACKEND_MODE_KEY = 'moe-image-backend-mode';
const BACKEND_TOKEN_KEY = 'moe-image-backend-token';

export const getBackendMode = () => safeStorageGet(BACKEND_MODE_KEY) === 'true';

export const setBackendMode = (enabled: boolean) => {
  if (enabled) {
    safeStorageSet(BACKEND_MODE_KEY, 'true', 'backend mode');
  } else {
    safeStorageRemove(BACKEND_MODE_KEY, 'backend mode');
  }
};

export const getBackendToken = () => safeStorageGet(BACKEND_TOKEN_KEY);

export const setBackendToken = (token: string) => {
  safeStorageSet(BACKEND_TOKEN_KEY, token, 'backend token');
};

export const clearBackendToken = () => {
  safeStorageRemove(BACKEND_TOKEN_KEY, 'backend token');
};

const buildBackendHeaders = (headers?: HeadersInit) => {
  const next = new Headers(headers);
  const token = getBackendToken();
  if (token) {
    next.set('X-Backend-Token', token);
  }
  return next;
};

const buildBackendHttpError = async (
  response: Response,
  code?: string,
) => {
  const error = new Error(
    await formatResponseErrorMessage(response, response.statusText || '请求失败'),
  ) as Error & { code?: string; status?: number };
  error.status = response.status;
  if (code) {
    error.code = code;
  }
  return error;
};

const backendFetch = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: buildBackendHeaders(options.headers),
  });
  if (response.status === 401) {
    throw await buildBackendHttpError(response, 'BACKEND_UNAUTHORIZED');
  }
  return response;
};

type BackendJsonOptions = Omit<RequestInit, 'body' | 'headers'> & {
  body?: unknown;
  headers?: HeadersInit;
};

const backendOk = async (
  path: string,
  options: BackendJsonOptions = {},
): Promise<void> => {
  const headers = new Headers(options.headers);
  if (typeof options.body !== 'undefined') {
    headers.set('Content-Type', 'application/json');
  }
  const response = await backendFetch(path, {
    ...options,
    headers,
    body: typeof options.body !== 'undefined' ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    throw await buildBackendHttpError(response);
  }
};

const backendJson = async <T>(
  path: string,
  options: BackendJsonOptions = {},
): Promise<T> => {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  const response = await backendFetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    throw await buildBackendHttpError(response);
  }
  return (await response.json()) as T;
};

export const authBackend = async (password: string) => {
  const data = await backendJson<{ token: string }>('/api/backend/auth', {
    method: 'POST',
    body: { password },
  });
  return data.token;
};

export const fetchBackendState = async () =>
  backendJson<BackendStateSnapshot>('/api/backend/state');

export const patchBackendState = async (payload: Partial<BackendState>) =>
  backendJson<BackendStateSnapshot>('/api/backend/state', {
    method: 'PATCH',
    body: payload,
  });

export const fetchBackendCollection = async () =>
  backendJson<CollectionItem[]>('/api/backend/collection');

export const putBackendCollection = async (items: CollectionItem[]) =>
  backendJson<CollectionItem[]>('/api/backend/collection', {
    method: 'PUT',
    body: items,
  });

export const fetchBackendTask = async (taskId: string) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`);

export const putBackendTask = async (taskId: string, state: PersistedImageTaskState) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'PUT',
    body: state,
  });

export const patchBackendTask = async (
  taskId: string,
  payload: Partial<PersistedImageTaskState>,
) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: payload,
  });

export const deleteBackendTask = async (taskId: string) =>
  backendJson<{ ok: true }>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });

export const deleteBackendImage = async (key: string) =>
  backendJson<{ ok: true }>(`/api/backend/image/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });

export const cleanupBackendImages = async (keys: string[]) =>
  backendJson<{ ok: true }>('/api/backend/images/cleanup', {
    method: 'POST',
    body: { keys },
  });

export const generateBackendTask = async (taskId: string) =>
  backendOk(`/api/backend/task/${encodeURIComponent(taskId)}/generate`, {
    method: 'POST',
  });

export const retryBackendSubTask = async (taskId: string, subTaskId: string) =>
  backendOk(`/api/backend/task/${encodeURIComponent(taskId)}/retry`, {
    method: 'POST',
    body: { subTaskId },
  });

export type BackendStopMode = 'pause' | 'abort';

export const stopBackendSubTask = async (
  taskId: string,
  subTaskId?: string,
  mode: BackendStopMode = 'pause',
) =>
  backendOk(`/api/backend/task/${encodeURIComponent(taskId)}/stop`, {
    method: 'POST',
    body: { subTaskId, mode },
  });

export const uploadBackendImage = async (
  blob: Blob,
  meta: { name?: string; lastModified?: number } = {},
) => {
  const headers: HeadersInit = {
    'Content-Type': blob.type || 'application/octet-stream',
  };
  if (typeof meta.lastModified === 'number') {
    headers['X-Upload-Last-Modified'] = String(meta.lastModified);
  }
  const response = await backendFetch('/api/backend/upload', {
    method: 'POST',
    headers,
    body: blob,
  });
  if (!response.ok) {
    throw await buildBackendHttpError(response);
  }
  return (await response.json()) as { key: string; url: string };
};

export const buildBackendImageUrl = (key: string) => {
  const token = getBackendToken();
  const encodedKey = encodeURIComponent(key);
  if (!token) {
    return `/api/backend/image/${encodedKey}`;
  }
  return `/api/backend/image/${encodedKey}?token=${encodeURIComponent(token)}`;
};

export const buildBackendStreamUrl = () => {
  const token = getBackendToken();
  if (!token) return '/api/backend/stream';
  return `/api/backend/stream?token=${encodeURIComponent(token)}`;
};

export const stripBackendToken = (url: string) =>
  url
    .replace(/[?&]token=[^&]+/g, '')
    .replace(/[?&]$/, '');
