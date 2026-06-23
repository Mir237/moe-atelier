import type { AppConfig } from '../types/app';
import type { CollectionItem } from '../types/collection';
import type { GlobalStats } from '../types/stats';
import type { PersistedImageTaskState } from '../types/imageTask';
import type {
  WorkflowGenerationOptions,
  WorkflowProject,
  WorkflowReferenceImage,
  WorkflowState,
} from '../types/workflow';
import type { ApiFormat } from './apiUrl';
import type { FormatConfig } from '../app/storage';
import axios from 'axios';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './storage';
import { formatHttpErrorMessage, readResponseBodySafely } from './httpError';

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
  const body = await readResponseBodySafely(response);
  const error = new Error(
    formatHttpErrorMessage({
      status: response.status,
      statusText: response.statusText,
      body,
      fallback: response.statusText || '请求失败',
    }),
  ) as Error & {
    code?: string;
    status?: number;
    body?: unknown;
    workflowId?: string;
    workflowTitle?: string;
  };
  error.status = response.status;
  error.body = body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.workflowId === 'string') error.workflowId = record.workflowId;
    if (typeof record.workflowTitle === 'string') error.workflowTitle = record.workflowTitle;
  }
  if (code) {
    error.code = code;
  }
  return error;
};

const buildBackendAxiosError = (error: unknown) => {
  if (!axios.isAxiosError(error)) return error;
  const response = error.response;
  const next = new Error(
    formatHttpErrorMessage({
      status: response?.status,
      statusText: response?.statusText,
      body: response?.data,
      fallback: error.message || '请求失败',
    }),
  ) as Error & {
    code?: string;
    status?: number;
    body?: unknown;
    workflowId?: string;
    workflowTitle?: string;
  };
  next.status = response?.status;
  next.body = response?.data;
  if (response?.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
    const record = response.data as Record<string, unknown>;
    if (typeof record.workflowId === 'string') next.workflowId = record.workflowId;
    if (typeof record.workflowTitle === 'string') next.workflowTitle = record.workflowTitle;
  }
  if (response?.status === 401) {
    next.code = 'BACKEND_UNAUTHORIZED';
  }
  return next;
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

type BackendGenerationOptions = {
  runtimeConfig?: AppConfig;
};

export interface BackendWorkflowGeneratedImage {
  status: 'success' | 'error';
  localKey?: string;
  sourceUrl?: string;
  mimeType?: string;
  bytes?: number;
  duration?: number;
  error?: string;
}

export const generateBackendTask = async (
  taskId: string,
  options: BackendGenerationOptions = {},
) =>
  backendOk(`/api/backend/task/${encodeURIComponent(taskId)}/generate`, {
    method: 'POST',
    body: options,
  });

export const retryBackendSubTask = async (
  taskId: string,
  subTaskId: string,
  options: BackendGenerationOptions = {},
) =>
  backendOk(`/api/backend/task/${encodeURIComponent(taskId)}/retry`, {
    method: 'POST',
    body: { subTaskId, ...options },
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

export const generateBackendWorkflowNode = async (
  taskId: string,
  payload: {
    nodeId: string;
    apiProfileId?: string;
    prompt: string;
    referenceImages: WorkflowReferenceImage[];
    count: number;
    generationOptions?: WorkflowGenerationOptions;
    runtimeConfig?: AppConfig;
  },
) =>
  backendJson<{ images: BackendWorkflowGeneratedImage[] }>(
    `/api/backend/task/${encodeURIComponent(taskId)}/workflow/generate`,
    {
      method: 'POST',
      body: payload,
    },
	  );

export const fetchBackendWorkflowProjects = async () =>
  backendJson<WorkflowProject[]>('/api/backend/workflows');

export const createBackendWorkflowProject = async (payload: {
  id?: string;
  title?: string;
  linkedTaskId?: string;
  state?: WorkflowState;
}) =>
  backendJson<WorkflowProject>('/api/backend/workflows', {
    method: 'POST',
    body: payload,
  });

export const patchBackendWorkflowProject = async (
  projectId: string,
  payload: Partial<Pick<WorkflowProject, 'title' | 'state'>> & { linkedTaskId?: string | null },
) =>
  backendJson<WorkflowProject>(`/api/backend/workflow/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: payload,
  });

export const deleteBackendWorkflowProject = async (projectId: string) =>
  backendJson<{ ok: true }>(`/api/backend/workflow/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });

export const generateBackendWorkflowProjectNode = async (
  projectId: string,
  payload: {
    nodeId: string;
    apiProfileId?: string;
    prompt: string;
    referenceImages: WorkflowReferenceImage[];
    count: number;
    generationOptions?: WorkflowGenerationOptions;
    runtimeConfig?: AppConfig;
  },
) =>
  backendJson<{ images: BackendWorkflowGeneratedImage[] }>(
    `/api/backend/workflow/${encodeURIComponent(projectId)}/generate`,
    {
      method: 'POST',
      body: payload,
    },
	  );

export interface BackendUploadProgress {
  loaded: number;
  total?: number;
  percent?: number;
}

type BackendUploadOptions = {
  onUploadProgress?: (progress: BackendUploadProgress) => void;
};

export const uploadBackendImage = async (
  blob: Blob,
  meta: { name?: string; lastModified?: number } = {},
  options: BackendUploadOptions = {},
) => {
  const headers = buildBackendHeaders({
    'Content-Type': blob.type || 'application/octet-stream',
  });
  if (typeof meta.lastModified === 'number') {
    headers.set('X-Upload-Last-Modified', String(meta.lastModified));
  }
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });

  try {
    const response = await axios.post<{ key: string; url: string }>(
      '/api/backend/upload',
      blob,
      {
        headers: headerRecord,
        onUploadProgress: (event) => {
          const total = typeof event.total === 'number' && event.total > 0
            ? event.total
            : undefined;
          const percent = total
            ? (event.loaded / total) * 100
            : undefined;
          options.onUploadProgress?.({
            loaded: event.loaded,
            total,
            percent,
          });
        },
      },
    );
    return response.data;
  } catch (err) {
    throw buildBackendAxiosError(err);
  }
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
