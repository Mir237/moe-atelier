import type {
  PersistedImageTaskState,
  PersistedSubTaskResult,
  SubTaskResult,
} from '../types/imageTask';
import type { TaskStats } from '../types/stats';
import { safeStorageGet, safeStorageSet } from '../utils/storage';

export const TASK_STATE_VERSION = 1;

export const DEFAULT_TASK_STATS: TaskStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};

export const loadTaskState = (storageKey: string): PersistedImageTaskState | null => {
  const raw = safeStorageGet(storageKey, 'task cache');
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedImageTaskState;
    if (!data || data.version !== TASK_STATE_VERSION) return null;
    return data;
  } catch (err) {
    console.warn('Failed to parse task cache:', err);
    return null;
  }
};

export const saveTaskState = (storageKey: string, state: PersistedImageTaskState) => {
  safeStorageSet(storageKey, JSON.stringify(state), 'task cache');
};

export const serializeResults = (results: SubTaskResult[]): PersistedSubTaskResult[] =>
  results.map((result: SubTaskResult) => {
    const sourceUrl =
      result.sourceUrl ||
      (result.displayUrl && !result.displayUrl.startsWith('blob:')
        ? result.displayUrl
        : undefined);
    const shouldStoreSource =
      !sourceUrl ||
      !sourceUrl.startsWith('data:image') ||
      !result.localKey;
    return {
      id: result.id,
      status: result.status,
      error: result.error,
      autoRetry: result.autoRetry,
      retryCount: result.retryCount,
      startTime: result.startTime,
      endTime: result.endTime,
      duration: result.duration,
      localKey: result.localKey,
      sourceUrl: shouldStoreSource ? sourceUrl : undefined,
      savedLocal: result.savedLocal,
      workflowProjectId: result.workflowProjectId,
      workflowNodeId: result.workflowNodeId,
    };
  });
