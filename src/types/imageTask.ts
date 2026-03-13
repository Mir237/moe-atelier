import type { TaskStats } from './stats';

export interface SubTaskResult {
  id: string;
  displayUrl?: string;
  localKey?: string;
  sourceUrl?: string;
  savedLocal?: boolean;
  autoRetry?: boolean;
  status: 'pending' | 'loading' | 'success' | 'error';
  error?: string;
  retryCount: number;
  startTime?: number;
  endTime?: number;
  duration?: number;
}

export interface PersistedSubTaskResult {
  id: string;
  status: SubTaskResult['status'];
  error?: string;
  autoRetry?: boolean;
  retryCount: number;
  startTime?: number;
  endTime?: number;
  duration?: number;
  localKey?: string;
  sourceUrl?: string;
  savedLocal?: boolean;
}

export interface PersistedUploadImage {
  uid: string;
  name: string;
  type?: string;
  size?: number;
  lastModified?: number;
  localKey: string;
  fromCollection?: boolean;
  sourceSignature?: string;
}

export interface PersistedImageTaskState {
  version: number;
  prompt: string;
  concurrency: number;
  enableSound: boolean;
  retryInterval?: number;
  retryLimit?: number;
  results: PersistedSubTaskResult[];
  uploads?: PersistedUploadImage[];
  stats: TaskStats;
  apiProfileId?: string;
}
