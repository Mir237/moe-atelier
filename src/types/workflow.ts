import type { NovelAiOverrides } from './app';

export interface WorkflowPosition {
  x: number;
  y: number;
}

export interface WorkflowViewport {
  x: number;
  y: number;
  k: number;
}

export type WorkflowBackgroundMode = 'dots' | 'lines' | 'blank';

export type WorkflowNodeType = 'text' | 'image' | 'config' | 'save';

export type WorkflowNodeStatus = 'idle' | 'loading' | 'success' | 'error';

export type WorkflowGenerationType = 'generation' | 'edit';

export interface WorkflowNodeMetadata {
  content?: string;
  composerContent?: string;
  prompt?: string;
  status?: WorkflowNodeStatus;
  errorDetails?: string;
  apiProfileId?: string;
  count?: number;
  model?: string;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  novelAiOverrides?: NovelAiOverrides;
  settingsVersion?: number;
  settingsTouched?: boolean;
  titleLocked?: boolean;
  collapsed?: boolean;
  generationType?: WorkflowGenerationType;
  references?: string[];
  localKey?: string;
  sourceUrl?: string;
  mimeType?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  bytes?: number;
  uploadName?: string;
  savedCount?: number;
  lastSavedAt?: string;
}

export interface WorkflowNodeData {
  id: string;
  type: WorkflowNodeType;
  title: string;
  position: WorkflowPosition;
  width: number;
  height: number;
  metadata?: WorkflowNodeMetadata;
}

export interface WorkflowConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface WorkflowState {
  nodes: WorkflowNodeData[];
  connections: WorkflowConnection[];
  viewport: WorkflowViewport;
  backgroundMode: WorkflowBackgroundMode;
  showImageInfo: boolean;
  primaryConfigNodeId?: string;
}

export interface WorkflowProject {
  id: string;
  title: string;
  linkedTaskId?: string;
  createdAt: string;
  updatedAt: string;
  state: WorkflowState;
}

export interface WorkflowProjectSummary {
  id: string;
  title: string;
  linkedTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowGenerationOptions {
  size?: string;
  aspectRatio?: string;
  quality?: string;
}

export interface WorkflowReferenceImage {
  id: string;
  name: string;
  type: string;
  dataUrl?: string;
  localKey?: string;
  sourceUrl?: string;
}

export interface WorkflowGeneratedImage {
  localKey?: string;
  sourceUrl?: string;
  displayUrl?: string;
  mimeType?: string;
  bytes?: number;
}
