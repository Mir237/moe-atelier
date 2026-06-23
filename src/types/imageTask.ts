import type { TaskStats } from './stats';
import type { WorkflowState } from './workflow';
import type { NovelAiOverrides } from './app';

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
  workflowProjectId?: string;
  workflowNodeId?: string;
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
  workflowProjectId?: string;
  workflowNodeId?: string;
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
  workflowProjectId?: string;
  workflowNodeId?: string;
}

export interface PersistedImageTaskState {
  version: number;
  name?: string;
  prompt: string;
  concurrency: number;
  enableSound: boolean;
  retryInterval?: number;
  retryLimit?: number;
  results: PersistedSubTaskResult[];
  uploads?: PersistedUploadImage[];
  stats: TaskStats;
  apiProfileId?: string;
  novelAiOverrides?: NovelAiOverrides;
  workflow?: WorkflowState;
}
