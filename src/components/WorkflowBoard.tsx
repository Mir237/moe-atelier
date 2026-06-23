import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Button,
  Input,
  InputNumber,
  Modal,
  Popover,
  Select,
  Space,
  Spin,
  Switch,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  BgColorsOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteFilled,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextFilled,
  FolderOpenOutlined,
  FullscreenOutlined,
  MinusOutlined,
  PictureFilled,
  PlayCircleFilled,
  PlusOutlined,
  RedoOutlined,
	  ReloadOutlined,
	  SettingFilled,
	  SlidersOutlined,
	  LinkOutlined,
  UndoOutlined,
  UploadOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig, TaskConfig } from '../types/app';
import type {
  WorkflowConnection,
  WorkflowBackgroundMode,
  WorkflowGenerationOptions,
  WorkflowGeneratedImage,
  WorkflowNodeData,
  WorkflowNodeMetadata,
  WorkflowNodeStatus,
  WorkflowNodeType,
  WorkflowPosition,
  WorkflowProject,
  WorkflowReferenceImage,
  WorkflowState,
  WorkflowViewport,
} from '../types/workflow';
import type { PersistedImageTaskState, PersistedSubTaskResult, PersistedUploadImage } from '../types/imageTask';
import {
  cleanupWorkflowProjectCache,
  collectTaskImageKeys,
  getTaskStorageKey,
  loadWorkflowProjects,
  saveWorkflowProjects,
} from '../app/storage';
import {
  DEFAULT_TASK_STATS,
  TASK_STATE_VERSION,
  loadTaskState,
  saveTaskState,
} from './imageTaskState';
import { openImageDb, IMAGE_STORE_NAME } from '../utils/imageDb';
import {
  buildBackendImageUrl,
  createBackendWorkflowProject,
  deleteBackendWorkflowProject,
  fetchBackendTask,
  fetchBackendWorkflowProjects,
  generateBackendWorkflowProjectNode,
  patchBackendWorkflowProject,
  patchBackendTask,
  stripBackendToken,
  uploadBackendImage,
} from '../utils/backendApi';
import { formatUnknownErrorMessage } from '../utils/httpError';
import { requestWorkflowImage } from '../utils/workflowImageGeneration';
import UploadProgressOverlay from '../shared/ui/UploadProgressOverlay';
import NovelAiParameterPanel from './NovelAiParameterPanel';
import {
  hasNovelAiOverrides,
  isNovelAiProfile,
  mergeNovelAiConfig,
  stripEmptyNovelAiOverrides,
} from '../utils/novelAiConfig';

const { Text } = Typography;

const NODE_STATUS_LOADING = 'loading' as const;
const NODE_STATUS_SUCCESS = 'success' as const;
const NODE_STATUS_ERROR = 'error' as const;
const WORKFLOW_SAVE_DELAY_MS = 400;
const HISTORY_DELAY_MS = 180;
const WORKFLOW_SETTINGS_VERSION = 2;
const WORKFLOW_VIEW_ANIMATION_MS = 350;
const WORKFLOW_MIN_ZOOM = 0.05;
const WORKFLOW_MAX_ZOOM = 5;
const WORKFLOW_FIT_MAX_ZOOM = 0.75;
const WORKFLOW_FIT_PADDING = 96;
const WORKFLOW_COLLAPSED_NODE_HEIGHT = 52;

const NODE_SPECS: Record<WorkflowNodeType, { width: number; height: number; title: string }> = {
  text: { width: 320, height: 220, title: '提示词' },
  image: { width: 320, height: 240, title: '图片' },
  config: { width: 380, height: 330, title: '生成配置' },
  save: { width: 320, height: 180, title: '保存图像' },
};

type WorkflowSnapshot = Pick<WorkflowState, 'nodes' | 'connections' | 'backgroundMode' | 'showImageInfo' | 'primaryConfigNodeId'>;

type DragState = {
  active: boolean;
  startX: number;
  startY: number;
  initialNodes: Array<{ id: string; x: number; y: number }>;
  moved: boolean;
};

type PanState = {
  active: boolean;
  startX: number;
  startY: number;
  initialX: number;
  initialY: number;
  moved: boolean;
};

type SelectionState = {
  active: boolean;
  start: WorkflowPosition;
  current: WorkflowPosition;
  additive: boolean;
  initialIds: string[];
};

type ConnectingState = {
  nodeId: string;
  handleType: 'source' | 'target';
};

type PendingNodePicker =
  | {
      type: 'loose-connection';
      x: number;
      y: number;
      position: WorkflowPosition;
      connection: ConnectingState;
    }
  | {
      type: 'insert-connection';
      x: number;
      y: number;
      position: WorkflowPosition;
      connectionId: string;
    };

type WorkflowContextMenu =
  | { type: 'node'; x: number; y: number; nodeId: string }
  | { type: 'connection'; x: number; y: number; connectionId: string };

type UploadProgressValue = number | null;

interface WorkflowBoardProps {
  tasks: TaskConfig[];
  config: AppConfig;
  backendMode: boolean;
  openProjectIds: string[];
  activeProjectId: string | null;
  onOpenProjectIdsChange: React.Dispatch<React.SetStateAction<string[]>>;
  onActiveProjectIdChange: React.Dispatch<React.SetStateAction<string | null>>;
  onCreateTask: () => void;
  onStatsUpdate: (type: 'request' | 'success' | 'fail', duration?: number) => void;
		}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const easeInOutCubic = (value: number) =>
  value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;

const cloneWorkflow = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeAutoValue = (value?: string) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed !== 'auto' ? trimmed : undefined;
};

const buildWorkflowGenerationOptions = (metadata: WorkflowNodeMetadata = {}) => {
  const options: WorkflowGenerationOptions = {};
  const size = normalizeAutoValue(metadata.size);
  const aspectRatio = normalizeAutoValue(metadata.aspectRatio);
  const quality = normalizeAutoValue(metadata.quality);
  if (size) options.size = size;
  if (aspectRatio) options.aspectRatio = aspectRatio;
  if (quality) options.quality = quality;
  return Object.keys(options).length > 0 ? options : undefined;
};

const getWorkflowLinkConflictMessage = (error: unknown, fallback: string) => {
  const candidate = error as { status?: unknown; workflowTitle?: unknown };
  if (candidate?.status === 409 && typeof candidate.workflowTitle === 'string' && candidate.workflowTitle) {
    return `任务卡已绑定「${candidate.workflowTitle}」，请先在该工作流解除绑定`;
  }
  return formatUnknownErrorMessage(error, fallback);
};

const createDefaultConfigMetadata = (apiProfileId?: string): WorkflowNodeMetadata => ({
  apiProfileId: apiProfileId || 'default',
  count: 1,
  prompt: '',
  composerContent: '',
  size: 'auto',
  aspectRatio: 'auto',
  quality: 'auto',
  settingsVersion: WORKFLOW_SETTINGS_VERSION,
  settingsTouched: false,
});

const normalizeConfigMetadata = (
  metadata: WorkflowNodeMetadata = {},
  apiProfileId?: string,
): WorkflowNodeMetadata => {
  const count = clamp(Math.floor(Number(metadata.count) || 1), 1, 16);
  const legacyDefaultSize =
    !metadata.settingsVersion &&
    !metadata.settingsTouched &&
    (!metadata.size || metadata.size === '2K') &&
    (!metadata.aspectRatio || metadata.aspectRatio === 'auto') &&
    (!metadata.quality || metadata.quality === 'auto');
  return {
    ...metadata,
    apiProfileId: metadata.apiProfileId || apiProfileId || 'default',
    count,
    size: legacyDefaultSize ? 'auto' : metadata.size || 'auto',
    aspectRatio: metadata.aspectRatio || 'auto',
    quality: metadata.quality || 'auto',
    settingsVersion: metadata.settingsVersion || WORKFLOW_SETTINGS_VERSION,
    settingsTouched: Boolean(metadata.settingsTouched),
  };
};

const createWorkflowNode = (
  type: WorkflowNodeType,
  position: WorkflowPosition,
  metadata: WorkflowNodeMetadata = {},
): WorkflowNodeData => {
  const spec = NODE_SPECS[type];
  return {
    id: `${type}-${uuidv4()}`,
    type,
    title: metadata.prompt?.slice(0, 24) || spec.title,
    position: {
      x: position.x - spec.width / 2,
      y: position.y - spec.height / 2,
    },
    width: spec.width,
    height: spec.height,
    metadata: {
      status: 'idle',
      ...metadata,
    },
  };
};

const createDefaultWorkflow = (apiProfileId?: string): WorkflowState => {
  const textNode = createWorkflowNode('text', { x: 220, y: 240 }, { content: '' });
  const configNode = createWorkflowNode('config', { x: 650, y: 240 }, createDefaultConfigMetadata(apiProfileId));
  return {
    nodes: [textNode, configNode],
    connections: [{ id: `conn-${uuidv4()}`, fromNodeId: textNode.id, toNodeId: configNode.id }],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: 'dots',
    showImageInfo: false,
    primaryConfigNodeId: configNode.id,
  };
};

const normalizeWorkflow = (value: WorkflowState | undefined, apiProfileId?: string) => {
  if (!value || !Array.isArray(value.nodes)) return createDefaultWorkflow(apiProfileId);
  const nodes = value.nodes.map((node) =>
    node.type === 'config'
      ? { ...node, metadata: normalizeConfigMetadata(node.metadata, apiProfileId) }
      : node,
  );
  const primaryConfigNodeId =
    value.primaryConfigNodeId ||
    nodes.find((node) => node.type === 'config')?.id;
  return {
    nodes,
    connections: Array.isArray(value.connections) ? value.connections : [],
    viewport: value.viewport || { x: 0, y: 0, k: 1 },
    backgroundMode: value.backgroundMode === 'blank' || value.backgroundMode === 'lines' ? value.backgroundMode : 'dots',
    showImageInfo: Boolean(value.showImageInfo),
    primaryConfigNodeId,
  } satisfies WorkflowState;
};

const createWorkflowProject = (title: string, apiProfileId?: string, linkedTaskId?: string, state?: WorkflowState): WorkflowProject => {
  const now = new Date().toISOString();
  return {
    id: `workflow-${uuidv4()}`,
    title,
    linkedTaskId,
    createdAt: now,
    updatedAt: now,
    state: normalizeWorkflow(state, apiProfileId),
  };
};

const serializeWorkflow = (state: WorkflowState): WorkflowState => ({
  ...state,
  nodes: state.nodes.map((node) => {
    const metadata = { ...(node.metadata || {}) };
    if (node.type === 'image') {
      if (metadata.content?.startsWith('blob:')) delete metadata.content;
      if (metadata.content?.startsWith('data:image') && metadata.localKey) delete metadata.content;
      if (metadata.content?.includes('/api/backend/image/')) {
        metadata.content = stripBackendToken(metadata.content);
      }
      if (metadata.sourceUrl?.includes('/api/backend/image/')) {
        metadata.sourceUrl = stripBackendToken(metadata.sourceUrl);
      }
    }
    return { ...node, metadata };
  }),
});

const emptyTaskState = (workflow: WorkflowState): PersistedImageTaskState => ({
  version: TASK_STATE_VERSION,
  prompt: '',
  concurrency: 2,
  enableSound: true,
  retryInterval: 1000,
  retryLimit: -1,
  results: [],
  uploads: [],
  stats: { ...DEFAULT_TASK_STATS },
  apiProfileId: 'default',
  workflow,
});

const saveImageBlob = async (key: string, blob: Blob) => {
  const db = await openImageDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
    tx.objectStore(IMAGE_STORE_NAME).put({ blob, createdAt: Date.now() }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const readImageBlob = async (key: string) => {
  const db = await openImageDb();
  return new Promise<Blob | null>((resolve) => {
    const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
    const request = tx.objectStore(IMAGE_STORE_NAME).get(key);
    request.onsuccess = () => {
      const value = request.result as { blob?: Blob } | undefined;
      resolve(value?.blob || null);
    };
    request.onerror = () => resolve(null);
  });
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const readImageMeta = (src: string) =>
  new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || image.width || 1, height: image.naturalHeight || image.height || 1 });
    image.onerror = () => resolve({ width: 1, height: 1 });
    image.src = src;
  });

const fitNodeSize = (width: number, height: number, maxWidth = 360, maxHeight = 320) => {
  const scale = Math.min(1, maxWidth / Math.max(1, width), maxHeight / Math.max(1, height));
  return { width: Math.max(180, width * scale), height: Math.max(140, height * scale) };
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const nodeIcon = (type: WorkflowNodeType) => {
  if (type === 'text') return <FileTextFilled />;
  if (type === 'config') return <SettingFilled />;
  if (type === 'save') return <DownloadOutlined />;
  return <PictureFilled />;
};

const getEffectiveNodeHeight = (node: WorkflowNodeData) =>
  node.metadata?.collapsed ? WORKFLOW_COLLAPSED_NODE_HEIGHT : node.height;

const getNodeInputAnchor = (node: WorkflowNodeData) => ({
  x: node.position.x,
  y: node.position.y + getEffectiveNodeHeight(node) / 2,
});

const getNodeOutputAnchor = (node: WorkflowNodeData) => ({
  x: node.position.x + node.width,
  y: node.position.y + getEffectiveNodeHeight(node) / 2,
});

const getNodeBounds = (nodes: WorkflowNodeData[]) => {
  if (nodes.length === 0) return null;
  return nodes.reduce(
    (bounds, node) => {
      const right = node.position.x + node.width;
      const bottom = node.position.y + getEffectiveNodeHeight(node);
      return {
        left: Math.min(bounds.left, node.position.x),
        top: Math.min(bounds.top, node.position.y),
        right: Math.max(bounds.right, right),
        bottom: Math.max(bounds.bottom, bottom),
      };
    },
    {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
};

const getBezierMidpoint = (
  start: WorkflowPosition,
  end: WorkflowPosition,
  curve: number,
) => {
  const cp1 = { x: start.x + curve, y: start.y };
  const cp2 = { x: end.x - curve, y: end.y };
  const t = 0.5;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * start.x + 3 * mt * mt * t * cp1.x + 3 * mt * t * t * cp2.x + t * t * t * end.x,
    y: mt * mt * mt * start.y + 3 * mt * mt * t * cp1.y + 3 * mt * t * t * cp2.y + t * t * t * end.y,
  };
};

const getNodeInputSummary = (
  nodeId: string,
  nodes: WorkflowNodeData[],
  connections: WorkflowConnection[],
) => {
  const upstreamIds = connections
    .filter((connection) => connection.toNodeId === nodeId)
    .map((connection) => connection.fromNodeId);
  const upstream = upstreamIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is WorkflowNodeData => Boolean(node));
  return {
    textCount: upstream.filter((node) => node.type === 'text').length,
    imageCount: upstream.filter((node) => node.type === 'image' && node.metadata?.content).length,
	  };
	};

const getSaveNodeImageInputs = (
  nodeId: string,
  nodes: WorkflowNodeData[],
  connections: WorkflowConnection[],
) => {
  const upstreamIds = connections
    .filter((connection) => connection.toNodeId === nodeId)
    .map((connection) => connection.fromNodeId);
  return upstreamIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is WorkflowNodeData =>
      Boolean(
        node &&
          node.type === 'image' &&
          (node.metadata?.content || node.metadata?.localKey || node.metadata?.sourceUrl),
      ),
    );
};

const sanitizeWorkflowFilename = (value: string) =>
  (value || 'workflow-image')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'workflow-image';

const getImageExtension = (metadata: WorkflowNodeMetadata = {}, source = '') => {
  const mime = metadata.mimeType || '';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('avif')) return 'avif';
  const match = source.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1] || 'png';
};

const getPrimaryConfigNode = (state: WorkflowState) =>
  state.nodes.find((node) => node.id === state.primaryConfigNodeId && node.type === 'config') ||
  state.nodes.find((node) => node.type === 'config') ||
  null;

const buildWorkflowPromptFromState = (state: WorkflowState) => {
  const node = getPrimaryConfigNode(state);
  if (!node) return '';
  const ownPrompt = (node.metadata?.composerContent || node.metadata?.prompt || '').trim();
  const upstreamText = state.connections
    .filter((connection) => connection.toNodeId === node.id)
    .map((connection) => state.nodes.find((item) => item.id === connection.fromNodeId))
    .filter((item): item is WorkflowNodeData => Boolean(item && item.type === 'text'))
    .map((item) => (item.metadata?.content || item.metadata?.prompt || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return [ownPrompt, upstreamText].filter(Boolean).join('\n\n');
};

const buildWorkflowTaskProjection = (
  project: WorkflowProject,
  state: WorkflowState,
): Pick<PersistedImageTaskState, 'prompt' | 'results' | 'uploads'> => {
  const prompt = buildWorkflowPromptFromState(state);
  const results: PersistedSubTaskResult[] = [];
  const uploads: PersistedUploadImage[] = [];

  state.nodes.forEach((node) => {
    if (node.type !== 'image') return;
    const metadata = node.metadata || {};
    const localKey = metadata.localKey;
    if (!localKey) return;
    const isGenerated = metadata.generationType === 'generation' || metadata.generationType === 'edit';
    if (isGenerated) {
      results.push({
        id: `workflow:${project.id}:${node.id}`,
        status: metadata.status === 'loading' ? 'loading' : metadata.status === 'error' ? 'error' : 'success',
        error: metadata.errorDetails,
        retryCount: 0,
        localKey,
        sourceUrl: metadata.sourceUrl,
        savedLocal: false,
        workflowProjectId: project.id,
        workflowNodeId: node.id,
      });
      return;
    }

    uploads.push({
      uid: `workflow:${project.id}:${node.id}`,
      name: metadata.uploadName || `${node.title || 'workflow-image'}.png`,
      type: metadata.mimeType,
      size: metadata.bytes,
      localKey,
      lastModified: Date.now(),
      workflowProjectId: project.id,
      workflowNodeId: node.id,
    });
  });

  return { prompt, results, uploads };
};

export default function WorkflowBoard({
  tasks,
  config,
  backendMode,
  openProjectIds,
  activeProjectId,
  onOpenProjectIdsChange,
  onActiveProjectIdChange,
  onCreateTask,
  onStatsUpdate,
}: WorkflowBoardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetNodeIdRef = useRef<string | null>(null);
  const objectUrlMapRef = useRef<Map<string, string>>(new Map());
  const saveTimerRef = useRef<number | null>(null);
  const historyTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const viewportAnimationRef = useRef<number | null>(null);
  const nodesRef = useRef<WorkflowNodeData[]>([]);
  const connectionsRef = useRef<WorkflowConnection[]>([]);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const viewportRef = useRef<WorkflowViewport>({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<DragState>({ active: false, startX: 0, startY: 0, initialNodes: [], moved: false });
  const panRef = useRef<PanState>({ active: false, startX: 0, startY: 0, initialX: 0, initialY: 0, moved: false });
  const selectionRef = useRef<SelectionState | null>(null);
  const connectingRef = useRef<ConnectingState | null>(null);
  const applyingHistoryRef = useRef(false);
  const lastSnapshotRef = useRef<WorkflowSnapshot | null>(null);
  const historyRef = useRef<{ past: WorkflowSnapshot[]; future: WorkflowSnapshot[] }>({ past: [], future: [] });
  const activeProjectIdRef = useRef<string | null>(null);
  const hydratedRef = useRef(false);
  const projectsRef = useRef<WorkflowProject[]>([]);
  const tasksRef = useRef<TaskConfig[]>(tasks);
  const flushCurrentProjectRef = useRef<(() => Promise<void>) | null>(null);
  const activeUploadCountRef = useRef(0);

  const [nodes, setNodes] = useState<WorkflowNodeData[]>([]);
  const [connections, setConnections] = useState<WorkflowConnection[]>([]);
  const [viewport, setViewport] = useState<WorkflowViewport>({ x: 0, y: 0, k: 1 });
  const [backgroundMode, setBackgroundMode] = useState<WorkflowBackgroundMode>('dots');
  const [showImageInfo, setShowImageInfo] = useState(false);
  const [primaryConfigNodeId, setPrimaryConfigNodeId] = useState<string | undefined>();
  const [hydrated, setHydrated] = useState(false);
  const [projectsHydrated, setProjectsHydrated] = useState(false);
  const [projects, setProjects] = useState<WorkflowProject[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionState | null>(null);
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [mouseWorld, setMouseWorld] = useState<WorkflowPosition>({ x: 0, y: 0 });
  const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [contextMenu, setContextMenu] = useState<WorkflowContextMenu | null>(null);
  const [pendingNodePicker, setPendingNodePicker] = useState<PendingNodePicker | null>(null);
  const [uploadProgressByNodeId, setUploadProgressByNodeId] = useState<Record<string, UploadProgressValue>>({});

  const activeProject = activeProjectId ? projects.find((project) => project.id === activeProjectId) || null : null;
  const uploadMessageKey = activeProjectId
    ? `workflow-image-upload-${activeProjectId}`
    : 'workflow-image-upload';
  const openProjects = openProjectIds
    .map((id) => projects.find((project) => project.id === id))
    .filter((project): project is WorkflowProject => Boolean(project));
  const linkedTaskId = activeProject?.linkedTaskId || '';
  const linkedTask = linkedTaskId ? tasks.find((task) => task.id === linkedTaskId) || null : null;
  const profileOptions = useMemo(
    () => {
      const profiles = config.apiProfiles && config.apiProfiles.length > 0
        ? config.apiProfiles
        : [{ id: 'default', name: '默认配置', model: config.model }];
      return profiles.map((profile) => ({
        label: profile.name || profile.model || '未命名配置',
        value: profile.id,
        model: profile.model || '',
      }));
    },
    [config.apiProfiles, config.model],
  );
  const taskOptions = useMemo(
    () => [
      { label: '不绑定任务卡', value: '' },
      ...tasks.map((task, index) => ({
        label: (() => {
          const owner = projects.find((project) => project.linkedTaskId === task.id);
          if (!owner) return `任务 ${index + 1} · ${task.id.slice(0, 6).toUpperCase()}`;
          if (owner.id === activeProjectId) return `任务 ${index + 1} · 当前绑定`;
          return `任务 ${index + 1} · 已绑定「${owner.title}」`;
        })(),
        value: task.id,
      })),
    ],
    [activeProjectId, projects, tasks],
  );
  const previewNode = previewNodeId ? nodes.find((node) => node.id === previewNodeId) : null;

  const showUploadLoadingMessage = (count: number) => {
    activeUploadCountRef.current += count;
    const activeCount = activeUploadCountRef.current;
    message.open({
      key: uploadMessageKey,
      type: 'loading',
      content: activeCount > 1 ? `正在上传 ${activeCount} 张图片` : '正在上传图片',
      duration: 0,
    });
  };

  const finishUploadMessage = (completed: number, failed: number) => {
    activeUploadCountRef.current = Math.max(
      0,
      activeUploadCountRef.current - completed - failed,
    );
    if (activeUploadCountRef.current > 0) {
      const activeCount = activeUploadCountRef.current;
      message.open({
        key: uploadMessageKey,
        type: 'loading',
        content: activeCount > 1 ? `正在上传 ${activeCount} 张图片` : '正在上传图片',
        duration: 0,
      });
      return;
    }
    message.open({
      key: uploadMessageKey,
      type: failed > 0 && completed === 0 ? 'error' : 'success',
      content: failed > 0 && completed === 0 ? '图片上传失败' : '图片上传完成',
      duration: failed > 0 && completed === 0 ? 3 : 2,
    });
  };

  const setUploadProgress = (nodeId: string, percent: UploadProgressValue) => {
    setUploadProgressByNodeId((prev) => ({ ...prev, [nodeId]: percent }));
  };

  const clearUploadProgress = (nodeId: string) => {
    setUploadProgressByNodeId((prev) => {
      if (!(nodeId in prev)) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
  };

  const registerObjectUrl = useCallback((key: string, url: string) => {
    const existing = objectUrlMapRef.current.get(key);
    if (existing && existing !== url) URL.revokeObjectURL(existing);
    objectUrlMapRef.current.set(key, url);
  }, []);

  const clearObjectUrls = useCallback(() => {
    objectUrlMapRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlMapRef.current.clear();
  }, []);

  const hydrateWorkflowImages = useCallback(
    async (state: WorkflowState) => {
      const nextNodes = await Promise.all(
        state.nodes.map(async (node) => {
          if (node.type !== 'image') return node;
          const metadata = node.metadata || {};
          if (backendMode && metadata.localKey) {
            return {
              ...node,
              metadata: {
                ...metadata,
                content: buildBackendImageUrl(metadata.localKey),
                sourceUrl: metadata.sourceUrl || `/api/backend/image/${encodeURIComponent(metadata.localKey)}`,
              },
            };
          }
          if (!backendMode && metadata.localKey) {
            const blob = await readImageBlob(metadata.localKey).catch(() => null);
            if (!blob) return node;
            const objectUrl = URL.createObjectURL(blob);
            registerObjectUrl(metadata.localKey, objectUrl);
            return { ...node, metadata: { ...metadata, content: objectUrl } };
          }
          return node;
        }),
      );
      return { ...state, nodes: nextNodes };
    },
    [backendMode, registerObjectUrl],
  );

  const currentWorkflow = useCallback(
    (): WorkflowState => ({
      nodes: nodesRef.current,
      connections: connectionsRef.current,
      viewport: viewportRef.current,
      backgroundMode,
      showImageInfo,
      primaryConfigNodeId,
    }),
    [backgroundMode, primaryConfigNodeId, showImageInfo],
  );

  const createSnapshot = useCallback(
    (): WorkflowSnapshot => ({
      nodes: cloneWorkflow(nodesRef.current),
      connections: cloneWorkflow(connectionsRef.current),
      backgroundMode,
      showImageInfo,
      primaryConfigNodeId,
    }),
    [backgroundMode, primaryConfigNodeId, showImageInfo],
  );

  const applySnapshot = useCallback((snapshot: WorkflowSnapshot) => {
    applyingHistoryRef.current = true;
    setNodes(cloneWorkflow(snapshot.nodes));
    setConnections(cloneWorkflow(snapshot.connections));
    setBackgroundMode(snapshot.backgroundMode);
    setShowImageInfo(snapshot.showImageInfo);
    setPrimaryConfigNodeId(snapshot.primaryConfigNodeId);
    setSelectedNodeIds(new Set());
    setSelectedConnectionId(null);
    setTimeout(() => {
      lastSnapshotRef.current = createSnapshot();
      applyingHistoryRef.current = false;
      setHistoryState({
        canUndo: historyRef.current.past.length > 0,
        canRedo: historyRef.current.future.length > 0,
      });
    });
  }, [createSnapshot]);

  const screenToCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const localX = clientX - (rect?.left || 0);
    const localY = clientY - (rect?.top || 0);
    const currentViewport = viewportRef.current;
    return {
      x: (localX - currentViewport.x) / currentViewport.k,
      y: (localY - currentViewport.y) / currentViewport.k,
    };
  }, []);

  const getCanvasCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    return screenToCanvas((rect?.left || 0) + (rect?.width || 0) / 2, (rect?.top || 0) + (rect?.height || 0) / 2);
  }, [screenToCanvas]);

  useLayoutEffect(() => {
    nodesRef.current = nodes;
    connectionsRef.current = connections;
    selectedIdsRef.current = selectedNodeIds;
    viewportRef.current = viewport;
    connectingRef.current = connecting;
    selectionRef.current = selectionBox;
    activeProjectIdRef.current = activeProjectId;
    hydratedRef.current = hydrated;
    projectsRef.current = projects;
    tasksRef.current = tasks;
  }, [nodes, connections, selectedNodeIds, viewport, connecting, selectionBox, activeProjectId, hydrated, projects, tasks]);

	  const syncLinkedTask = useCallback(
	    async (project: WorkflowProject, workflow: WorkflowState) => {
      if (!project.linkedTaskId) return;
      const projection = buildWorkflowTaskProjection(project, workflow);
      try {
        const existing = backendMode
          ? await fetchBackendTask(project.linkedTaskId).catch(() => null)
          : loadTaskState(getTaskStorageKey(project.linkedTaskId));
        const base = existing || emptyTaskState(workflow);
	        const results = [
	          ...(Array.isArray(base.results) ? base.results.filter((item) => item.workflowProjectId !== project.id) : []),
	          ...(projection.results || []),
	        ];
	        const uploads = [
	          ...(Array.isArray(base.uploads) ? base.uploads.filter((item) => item.workflowProjectId !== project.id) : []),
	          ...(projection.uploads || []),
	        ];
        if (backendMode) {
          await patchBackendTask(project.linkedTaskId, {
            prompt: projection.prompt,
            results,
            uploads,
          });
          return;
        }
        saveTaskState(getTaskStorageKey(project.linkedTaskId), {
          ...base,
          prompt: projection.prompt,
          results,
          uploads,
        });
      } catch (err) {
        console.warn('工作流同步到任务卡失败:', err);
      }
    },
	    [backendMode],
	  );

	  const clearLinkedTaskProjection = useCallback(
	    async (project: WorkflowProject, taskId: string) => {
	      try {
	        const existing = backendMode
	          ? await fetchBackendTask(taskId).catch(() => null)
	          : loadTaskState(getTaskStorageKey(taskId));
	        if (!existing) return;
	        const results = Array.isArray(existing.results)
	          ? existing.results.filter((item) => item.workflowProjectId !== project.id)
	          : [];
	        const uploads = Array.isArray(existing.uploads)
	          ? existing.uploads.filter((item) => item.workflowProjectId !== project.id)
	          : [];
	        if (backendMode) {
	          await patchBackendTask(taskId, { results, uploads });
	        } else {
	          saveTaskState(getTaskStorageKey(taskId), { ...existing, results, uploads });
	        }
	      } catch (err) {
	        console.warn('清理任务卡工作流投影失败:', err);
	      }
	    },
	    [backendMode],
	  );

  const flushCurrentProject = useCallback(async () => {
    const projectId = activeProjectIdRef.current;
    if (!projectId || !hydratedRef.current) return;
    const workflow = serializeWorkflow(currentWorkflow());
    const now = new Date().toISOString();
    let projectForSync: WorkflowProject | null = null;
    const nextProjects = projectsRef.current.map((project) => {
      if (project.id !== projectId) return project;
      projectForSync = { ...project, state: workflow, updatedAt: now };
      return projectForSync;
    });
    if (!projectForSync) return;
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    if (backendMode) {
      await patchBackendWorkflowProject(projectId, { state: workflow }).catch((err) => {
        console.warn('工作流后端保存失败:', err);
      });
    } else {
      saveWorkflowProjects(nextProjects);
    }
    await syncLinkedTask(projectForSync, workflow);
  }, [backendMode, currentWorkflow, syncLinkedTask]);

  useEffect(() => {
    flushCurrentProjectRef.current = flushCurrentProject;
  }, [flushCurrentProject]);

  useEffect(() => {
    let cancelled = false;
    const restoreProjects = async () => {
      setProjectsHydrated(false);
      setHydrated(false);
      clearObjectUrls();
      try {
        const migratedProjects: WorkflowProject[] = [];
        let loadedProjects = backendMode
          ? await fetchBackendWorkflowProjects()
          : loadWorkflowProjects();

        if (loadedProjects.length === 0) {
          for (const task of tasksRef.current) {
            const stored = backendMode
              ? await fetchBackendTask(task.id).catch(() => null)
              : loadTaskState(getTaskStorageKey(task.id));
            if (!stored?.workflow) continue;
            const title = `任务 ${task.id.slice(0, 6).toUpperCase()} 工作流`;
            if (backendMode) {
              migratedProjects.push(await createBackendWorkflowProject({
                title,
                linkedTaskId: task.id,
                state: stored.workflow,
              }));
            } else {
              migratedProjects.push(createWorkflowProject(title, config.activeApiProfileId, task.id, stored.workflow));
            }
          }
          if (migratedProjects.length === 0) {
            if (backendMode) {
              migratedProjects.push(await createBackendWorkflowProject({
                title: '工作流 1',
                state: createDefaultWorkflow(config.activeApiProfileId),
              }));
            } else {
              migratedProjects.push(createWorkflowProject('工作流 1', config.activeApiProfileId));
            }
          }
          loadedProjects = migratedProjects;
          if (!backendMode) saveWorkflowProjects(loadedProjects);
        }

        if (cancelled) return;
        const normalizedProjects = loadedProjects.map((project) => ({
          ...project,
          state: normalizeWorkflow(project.state, config.activeApiProfileId),
        }));
        projectsRef.current = normalizedProjects;
        setProjects(normalizedProjects);
        onOpenProjectIdsChange((current) => current.filter((id) => normalizedProjects.some((project) => project.id === id)));
        onActiveProjectIdChange((current) =>
          current && normalizedProjects.some((project) => project.id === current) ? current : null,
        );
        setProjectsHydrated(true);
      } catch (err) {
        console.error(err);
        message.error(formatUnknownErrorMessage(err, '工作流项目加载失败'));
        const fallback = [createWorkflowProject('工作流 1', config.activeApiProfileId)];
        projectsRef.current = fallback;
        setProjects(fallback);
        onOpenProjectIdsChange([]);
        onActiveProjectIdChange(null);
        setProjectsHydrated(true);
      }
    };
    void restoreProjects();
    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [backendMode, clearObjectUrls, config.activeApiProfileId, onActiveProjectIdChange, onOpenProjectIdsChange]);

  useEffect(() => {
    if (!projectsHydrated) return;
    if (!activeProjectId) {
      clearObjectUrls();
      setNodes([]);
      setConnections([]);
      setViewport({ x: 0, y: 0, k: 1 });
      viewportRef.current = { x: 0, y: 0, k: 1 };
      setBackgroundMode('dots');
      setShowImageInfo(false);
      setPrimaryConfigNodeId(undefined);
      setSelectedNodeIds(new Set());
      setSelectedConnectionId(null);
      setContextMenu(null);
      setPendingNodePicker(null);
      setHydrated(false);
      return;
    }
    let cancelled = false;
    setHydrated(false);
    clearObjectUrls();
    const restore = async () => {
      try {
        const project = projectsRef.current.find((item) => item.id === activeProjectId);
        const normalized = normalizeWorkflow(project?.state, config.activeApiProfileId);
        const hydratedState = await hydrateWorkflowImages(normalized);
        if (cancelled) return;
	        setNodes(hydratedState.nodes);
	        setConnections(hydratedState.connections);
	        viewportRef.current = hydratedState.viewport;
	        setViewport(hydratedState.viewport);
        setBackgroundMode(hydratedState.backgroundMode);
        setShowImageInfo(hydratedState.showImageInfo);
        setPrimaryConfigNodeId(hydratedState.primaryConfigNodeId);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
	        historyRef.current = { past: [], future: [] };
	        setHistoryState({ canUndo: false, canRedo: false });
	        setHydrated(true);
	        const restoredSnapshot: WorkflowSnapshot = {
	          nodes: cloneWorkflow(hydratedState.nodes),
	          connections: cloneWorkflow(hydratedState.connections),
	          backgroundMode: hydratedState.backgroundMode,
	          showImageInfo: hydratedState.showImageInfo,
	          primaryConfigNodeId: hydratedState.primaryConfigNodeId,
	        };
	        setTimeout(() => {
	          lastSnapshotRef.current = restoredSnapshot;
	        });
	      } catch (err) {
	        console.error(err);
        const fallback = normalizeWorkflow(undefined, config.activeApiProfileId);
	        setNodes(fallback.nodes);
	        setConnections(fallback.connections);
	        viewportRef.current = fallback.viewport;
	        setViewport(fallback.viewport);
        setBackgroundMode(fallback.backgroundMode);
        setShowImageInfo(fallback.showImageInfo);
        setPrimaryConfigNodeId(fallback.primaryConfigNodeId);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setHydrated(true);
	        message.error(formatUnknownErrorMessage(err, '工作流加载失败，已打开默认画板'));
	      }
	    };
	    void restore();
    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
	      clearObjectUrls();
	    };
	  }, [activeProjectId, clearObjectUrls, config.activeApiProfileId, hydrateWorkflowImages, projectsHydrated]);

  useEffect(() => {
    if (!hydrated || !activeProjectId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushCurrentProjectRef.current?.();
    }, WORKFLOW_SAVE_DELAY_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [activeProjectId, hydrated, nodes, connections, viewport, backgroundMode, showImageInfo, primaryConfigNodeId]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void flushCurrentProjectRef.current?.();
      clearObjectUrls();
    },
    [clearObjectUrls],
  );

  useEffect(() => {
    if (!hydrated || applyingHistoryRef.current) return;
    const next = createSnapshot();
    const previous = lastSnapshotRef.current;
    if (
      previous &&
      previous.nodes === next.nodes &&
	      previous.connections === next.connections &&
	      previous.backgroundMode === next.backgroundMode &&
	      previous.showImageInfo === next.showImageInfo &&
	      previous.primaryConfigNodeId === next.primaryConfigNodeId
	    ) {
      return;
    }
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyTimerRef.current = window.setTimeout(() => {
      const current = createSnapshot();
      const last = lastSnapshotRef.current;
      if (last) {
        historyRef.current.past = [...historyRef.current.past.slice(-49), last];
        historyRef.current.future = [];
        setHistoryState({ canUndo: true, canRedo: false });
      }
      lastSnapshotRef.current = current;
      historyTimerRef.current = null;
    }, HISTORY_DELAY_MS);
    return () => {
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    };
	  }, [backgroundMode, connections, createSnapshot, hydrated, nodes, primaryConfigNodeId, showImageInfo]);

  const cancelViewportAnimation = useCallback(() => {
    if (viewportAnimationRef.current) {
      cancelAnimationFrame(viewportAnimationRef.current);
      viewportAnimationRef.current = null;
    }
  }, []);

  const setViewportImmediate = useCallback((nextViewport: WorkflowViewport) => {
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }, []);

  const animateViewportTo = useCallback(
    (nextViewport: WorkflowViewport, duration = WORKFLOW_VIEW_ANIMATION_MS) => {
      cancelViewportAnimation();
      const from = viewportRef.current;
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = clamp((now - startedAt) / duration, 0, 1);
        const eased = easeInOutCubic(progress);
        const frame = {
          x: from.x + (nextViewport.x - from.x) * eased,
          y: from.y + (nextViewport.y - from.y) * eased,
          k: from.k + (nextViewport.k - from.k) * eased,
        };
        setViewportImmediate(frame);
        if (progress < 1) {
          viewportAnimationRef.current = requestAnimationFrame(tick);
          return;
        }
        viewportAnimationRef.current = null;
        setViewportImmediate(nextViewport);
      };
      viewportAnimationRef.current = requestAnimationFrame(tick);
    },
    [cancelViewportAnimation, setViewportImmediate],
  );

  const getViewportForScale = useCallback((scale: number, anchor?: WorkflowPosition) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const width = rect?.width || 1;
    const height = rect?.height || 1;
    const nextScale = clamp(scale, WORKFLOW_MIN_ZOOM, WORKFLOW_MAX_ZOOM);
    const currentViewport = viewportRef.current;
    const localX = anchor?.x ?? width / 2;
    const localY = anchor?.y ?? height / 2;
    return {
      x: localX - ((localX - currentViewport.x) / currentViewport.k) * nextScale,
      y: localY - ((localY - currentViewport.y) / currentViewport.k) * nextScale,
      k: nextScale,
    };
  }, []);

  const setZoomScale = useCallback((scale: number, animated = true) => {
    const nextViewport = getViewportForScale(scale);
    if (animated) animateViewportTo(nextViewport);
    else {
      cancelViewportAnimation();
      setViewportImmediate(nextViewport);
    }
  }, [animateViewportTo, cancelViewportAnimation, getViewportForScale, setViewportImmediate]);

  const fitViewport = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const bounds = getNodeBounds(nodesRef.current);
    if (!rect || !bounds) {
      animateViewportTo({ x: 0, y: 0, k: 1 });
      return;
    }
    const boundsWidth = Math.max(1, bounds.right - bounds.left);
    const boundsHeight = Math.max(1, bounds.bottom - bounds.top);
    const availableWidth = Math.max(1, rect.width - WORKFLOW_FIT_PADDING * 2);
    const availableHeight = Math.max(1, rect.height - WORKFLOW_FIT_PADDING * 2);
    const nextScale = clamp(
      Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight, WORKFLOW_FIT_MAX_ZOOM),
      WORKFLOW_MIN_ZOOM,
      WORKFLOW_MAX_ZOOM,
    );
    animateViewportTo({
      x: rect.width / 2 - ((bounds.left + bounds.right) / 2) * nextScale,
      y: rect.height / 2 - ((bounds.top + bounds.bottom) / 2) * nextScale,
      k: nextScale,
    });
  }, [animateViewportTo]);

  const resetViewport = useCallback(() => {
    animateViewportTo({ x: 0, y: 0, k: 1 });
  }, [animateViewportTo]);

  useEffect(() => () => cancelViewportAnimation(), [cancelViewportAnimation]);

  const undoCanvas = useCallback(() => {
    const previous = historyRef.current.past.pop();
    const current = lastSnapshotRef.current;
    if (!previous || !current) return;
    historyRef.current.future.push(current);
    applySnapshot(previous);
  }, [applySnapshot]);

  const redoCanvas = useCallback(() => {
    const next = historyRef.current.future.pop();
    const current = lastSnapshotRef.current;
    if (!next || !current) return;
    historyRef.current.past.push(current);
    applySnapshot(next);
  }, [applySnapshot]);

  const addNode = useCallback((type: WorkflowNodeType, position?: WorkflowPosition) => {
    const center = position || getCanvasCenter();
    const node = createWorkflowNode(
      type,
      center,
      type === 'config' ? createDefaultConfigMetadata(config.activeApiProfileId) : {},
    );
    setNodes((prev) => [...prev, node]);
    if (type === 'config' && !primaryConfigNodeId) {
      setPrimaryConfigNodeId(node.id);
    }
    setSelectedNodeIds(new Set([node.id]));
    setSelectedConnectionId(null);
    setContextMenu(null);
  }, [config.activeApiProfileId, getCanvasCenter, primaryConfigNodeId]);

  const createNodeForPicker = useCallback((type: WorkflowNodeType, position: WorkflowPosition) => {
    const node = createWorkflowNode(
      type,
      position,
      type === 'config' ? createDefaultConfigMetadata(config.activeApiProfileId) : {},
    );
    setNodes((prev) => [...prev, node]);
    if (type === 'config' && !primaryConfigNodeId) {
      setPrimaryConfigNodeId(node.id);
    }
    setSelectedNodeIds(new Set([node.id]));
    setSelectedConnectionId(null);
    setContextMenu(null);
    return node;
  }, [config.activeApiProfileId, primaryConfigNodeId]);

  const deleteSelected = useCallback(() => {
    const ids = selectedIdsRef.current;
    if (!ids.size && !selectedConnectionId) return;
    if (selectedConnectionId) {
      setConnections((prev) => prev.filter((connection) => connection.id !== selectedConnectionId));
      setSelectedConnectionId(null);
      setContextMenu(null);
      return;
    }
    if (primaryConfigNodeId && ids.has(primaryConfigNodeId)) {
      const nextConfig = nodesRef.current.find((node) => node.type === 'config' && !ids.has(node.id));
      setPrimaryConfigNodeId(nextConfig?.id);
    }
    setNodes((prev) => prev.filter((node) => !ids.has(node.id)));
    setConnections((prev) => prev.filter((connection) => !ids.has(connection.fromNodeId) && !ids.has(connection.toNodeId)));
    setSelectedNodeIds(new Set());
    setContextMenu(null);
  }, [primaryConfigNodeId, selectedConnectionId]);

  const deleteConnection = useCallback((connectionId: string) => {
    setConnections((prev) => prev.filter((connection) => connection.id !== connectionId));
    setSelectedConnectionId((current) => (current === connectionId ? null : current));
    setContextMenu(null);
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    const ids = new Set([nodeId]);
    if (primaryConfigNodeId === nodeId) {
      const nextConfig = nodesRef.current.find((node) => node.type === 'config' && node.id !== nodeId);
      setPrimaryConfigNodeId(nextConfig?.id);
    }
    setNodes((prev) => prev.filter((node) => !ids.has(node.id)));
    setConnections((prev) => prev.filter((connection) => !ids.has(connection.fromNodeId) && !ids.has(connection.toNodeId)));
    setSelectedNodeIds(new Set());
    setSelectedConnectionId(null);
    setContextMenu(null);
  }, [primaryConfigNodeId]);

  const duplicateNode = useCallback((nodeId: string) => {
    const source = nodesRef.current.find((node) => node.id === nodeId);
    if (!source) return;
    const copy: WorkflowNodeData = {
      ...cloneWorkflow(source),
      id: `${source.type}-${uuidv4()}`,
      position: { x: source.position.x + 36, y: source.position.y + 36 },
      title: `${source.title} 副本`,
    };
    setNodes((prev) => [...prev, copy]);
    setSelectedNodeIds(new Set([copy.id]));
    setSelectedConnectionId(null);
    setContextMenu(null);
  }, []);

  const updateNode = useCallback((nodeId: string, patch: Partial<WorkflowNodeData>) => {
    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)));
  }, []);

  const updateNodeMetadata = useCallback((nodeId: string, patch: Partial<WorkflowNodeMetadata>) => {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.id !== nodeId) return node;
        const metadata = { ...(node.metadata || {}), ...patch };
        const titleSource = patch.composerContent || patch.prompt || '';
        const nextTitle =
          titleSource && !metadata.titleLocked
            ? titleSource.slice(0, 24) || node.title
            : node.title;
        return {
          ...node,
          title: nextTitle,
          metadata,
        };
      }),
    );
  }, []);

  const updateNodeTitle = useCallback((nodeId: string, title: string) => {
    const trimmed = title.trim();
    setNodes((prev) =>
      prev.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              title: trimmed || node.title || NODE_SPECS[node.type].title,
              metadata: { ...(node.metadata || {}), titleLocked: true },
            }
          : node,
      ),
    );
  }, []);

  const downloadWorkflowImage = useCallback((source: string, filename: string) => {
    const anchor = document.createElement('a');
    anchor.href = source;
    anchor.download = filename;
    anchor.rel = 'noreferrer';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  const handleSaveNodeImages = useCallback(
    async (nodeId: string) => {
      const imageNodes = getSaveNodeImageInputs(nodeId, nodesRef.current, connectionsRef.current);
      if (imageNodes.length === 0) {
        message.warning('请先连接图片节点');
        return;
      }

      updateNodeMetadata(nodeId, { status: NODE_STATUS_LOADING });
      const revokeUrls: string[] = [];
      let savedCount = 0;
      try {
        for (const [index, imageNode] of imageNodes.entries()) {
          const metadata = imageNode.metadata || {};
          let source = metadata.content || '';
          if (!source && backendMode && metadata.localKey) {
            source = buildBackendImageUrl(metadata.localKey);
          }
          if (!source && metadata.sourceUrl) {
            source = metadata.sourceUrl;
          }
          if (!source && !backendMode && metadata.localKey) {
            const blob = await readImageBlob(metadata.localKey).catch(() => null);
            if (blob) {
              source = URL.createObjectURL(blob);
              revokeUrls.push(source);
            }
          }
          if (!source) continue;

          const extension = getImageExtension(metadata, source);
          const rawName = metadata.uploadName || imageNode.title || imageNode.id;
          const baseName = sanitizeWorkflowFilename(rawName.replace(/\.[a-z0-9]{2,5}$/i, ''));
          const suffix = imageNodes.length > 1 ? `-${index + 1}` : '';
          downloadWorkflowImage(source, `${baseName}${suffix}.${extension}`);
          savedCount += 1;
          await new Promise((resolve) => window.setTimeout(resolve, 80));
        }

        if (savedCount === 0) {
          throw new Error('没有可下载的图片');
        }
        updateNodeMetadata(nodeId, {
          status: NODE_STATUS_SUCCESS,
          errorDetails: undefined,
          savedCount,
          lastSavedAt: new Date().toISOString(),
        });
        message.success(`已下载 ${savedCount} 张图片`);
      } catch (err) {
        updateNodeMetadata(nodeId, {
          status: NODE_STATUS_ERROR,
          errorDetails: formatUnknownErrorMessage(err, '保存图片失败'),
        });
        message.error(formatUnknownErrorMessage(err, '保存图片失败'));
      } finally {
        window.setTimeout(() => revokeUrls.forEach((url) => URL.revokeObjectURL(url)), 1200);
      }
    },
    [backendMode, downloadWorkflowImage, updateNodeMetadata],
  );

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-workflow-no-zoom]')) return;
    event.preventDefault();
    cancelViewportAnimation();
    const factor = Math.pow(1.1, -event.deltaY / 100);
    const currentViewport = viewportRef.current;
    const nextScale = clamp(currentViewport.k * factor, WORKFLOW_MIN_ZOOM, WORKFLOW_MAX_ZOOM);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const worldX = (mouseX - currentViewport.x) / currentViewport.k;
    const worldY = (mouseY - currentViewport.y) / currentViewport.k;
    setViewportImmediate({
      x: mouseX - worldX * nextScale,
      y: mouseY - worldY * nextScale,
      k: nextScale,
    });
  }, [cancelViewportAnimation, setViewportImmediate]);

  const handleCanvasPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-node-id],[data-workflow-no-pan]')) return;
    if (event.button !== 0) return;
    cancelViewportAnimation();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.ctrlKey || event.metaKey) {
      const world = screenToCanvas(event.clientX, event.clientY);
      const next: SelectionState = {
        active: true,
        start: world,
        current: world,
        additive: event.shiftKey,
        initialIds: event.shiftKey ? Array.from(selectedIdsRef.current) : [],
      };
      selectionRef.current = next;
      setSelectionBox(next);
      if (!event.shiftKey) setSelectedNodeIds(new Set());
      setSelectedConnectionId(null);
      return;
    }
    panRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      initialX: viewportRef.current.x,
      initialY: viewportRef.current.y,
      moved: false,
    };
  }, [screenToCanvas]);

  const handleNodeMouseDown = useCallback((event: React.MouseEvent, nodeId: string) => {
    event.stopPropagation();
    setSelectedConnectionId(null);
    const currentSelected = selectedIdsRef.current;
    const nextSelected = new Set(currentSelected);
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
      else nextSelected.add(nodeId);
    } else if (!nextSelected.has(nodeId)) {
      nextSelected.clear();
      nextSelected.add(nodeId);
    }
    setSelectedNodeIds(nextSelected);
    const dragIds = new Set(nextSelected);
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      initialNodes: nodesRef.current
        .filter((node) => dragIds.has(node.id))
        .map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
      moved: false,
    };
  }, []);

  const connectNodes = useCallback((fromNodeId: string, toNodeId: string) => {
    if (fromNodeId === toNodeId) return;
    const exists = connectionsRef.current.some((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId);
    if (exists) return;
    setConnections((prev) => [...prev, { id: `conn-${uuidv4()}`, fromNodeId, toNodeId }]);
  }, []);

  const handlePickNodeType = useCallback((type: WorkflowNodeType) => {
    const picker = pendingNodePicker;
    if (!picker) return;
    const node = createNodeForPicker(type, picker.position);
    if (picker.type === 'loose-connection') {
      if (picker.connection.handleType === 'source') {
        connectNodes(picker.connection.nodeId, node.id);
      } else {
        connectNodes(node.id, picker.connection.nodeId);
      }
    } else {
      const targetConnection = connectionsRef.current.find((connection) => connection.id === picker.connectionId);
      if (targetConnection) {
        setConnections((prev) => [
          ...prev.filter((connection) => connection.id !== picker.connectionId),
          { id: `conn-${uuidv4()}`, fromNodeId: targetConnection.fromNodeId, toNodeId: node.id },
          { id: `conn-${uuidv4()}`, fromNodeId: node.id, toNodeId: targetConnection.toNodeId },
        ]);
      }
    }
    setPendingNodePicker(null);
  }, [connectNodes, createNodeForPicker, pendingNodePicker]);

  const handleConnectStart = useCallback((event: React.MouseEvent, nodeId: string, handleType: 'source' | 'target') => {
    event.preventDefault();
    event.stopPropagation();
    const next = { nodeId, handleType };
    connectingRef.current = next;
    setConnecting(next);
    setPendingNodePicker(null);
    setContextMenu(null);
    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
  }, [screenToCanvas]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const currentViewport = viewportRef.current;
      if (dragRef.current.active) {
        const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
        const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          const initialNodes = dragRef.current.initialNodes;
          setNodes((prev) =>
            prev.map((node) => {
              const initial = initialNodes.find((item) => item.id === node.id);
              return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
            }),
          );
          rafRef.current = null;
        });
        return;
      }

      if (panRef.current.active) {
        const dx = event.clientX - panRef.current.startX;
        const dy = event.clientY - panRef.current.startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) panRef.current.moved = true;
        setViewportImmediate({ x: panRef.current.initialX + dx, y: panRef.current.initialY + dy, k: currentViewport.k });
        return;
      }

      if (selectionRef.current?.active) {
        const current = screenToCanvas(event.clientX, event.clientY);
        const selection = { ...selectionRef.current, current };
        selectionRef.current = selection;
        const rectX = Math.min(selection.start.x, selection.current.x);
        const rectY = Math.min(selection.start.y, selection.current.y);
        const rectW = Math.abs(selection.current.x - selection.start.x);
        const rectH = Math.abs(selection.current.y - selection.start.y);
        const nextSelected = new Set(selection.additive ? selection.initialIds : []);
        nodesRef.current.forEach((node) => {
          const intersects =
            rectX < node.position.x + node.width &&
            rectX + rectW > node.position.x &&
            rectY < node.position.y + getEffectiveNodeHeight(node) &&
            rectY + rectH > node.position.y;
          if (intersects) nextSelected.add(node.id);
        });
        setSelectionBox(selection);
        setSelectedNodeIds(nextSelected);
        return;
      }

      if (connectingRef.current) {
        setMouseWorld(screenToCanvas(event.clientX, event.clientY));
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      dragRef.current.active = false;
      if (panRef.current.active) {
        if (!panRef.current.moved) {
          setSelectedNodeIds(new Set());
          setSelectedConnectionId(null);
        }
        panRef.current.active = false;
      }
      selectionRef.current = null;
      setSelectionBox(null);
      const currentConnecting = connectingRef.current;
      if (currentConnecting) {
        const target = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest('[data-node-id]') as HTMLElement | null;
	        const targetNodeId = target?.dataset.nodeId;
	        if (targetNodeId) {
	          if (currentConnecting.handleType === 'source') {
	            connectNodes(currentConnecting.nodeId, targetNodeId);
	          } else {
	            connectNodes(targetNodeId, currentConnecting.nodeId);
	          }
	          setPendingNodePicker(null);
	        } else {
	          const rect = containerRef.current?.getBoundingClientRect();
	          const isInsideCanvas = rect &&
	            event.clientX >= rect.left &&
	            event.clientX <= rect.right &&
	            event.clientY >= rect.top &&
	            event.clientY <= rect.bottom;
	          if (isInsideCanvas) {
	            setPendingNodePicker({
	              type: 'loose-connection',
	              x: event.clientX,
	              y: event.clientY,
	              position: screenToCanvas(event.clientX, event.clientY),
	              connection: currentConnecting,
	            });
	          }
	        }
	      }
	      connectingRef.current = null;
      setConnecting(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [connectNodes, screenToCanvas, setViewportImmediate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"], [data-workflow-no-keybind]')) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (!selectedIdsRef.current.size && !selectedConnectionId) return;
      event.preventDefault();
      deleteSelected();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelected, selectedConnectionId]);

  const visibleNodes = useMemo(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const width = rect?.width || 1200;
    const height = rect?.height || 800;
    const padding = 360;
    const viewLeft = -viewport.x / viewport.k - padding;
    const viewTop = -viewport.y / viewport.k - padding;
    const viewRight = viewLeft + width / viewport.k + padding * 2;
    const viewBottom = viewTop + height / viewport.k + padding * 2;
    return nodes.filter(
      (node) =>
        node.position.x + node.width > viewLeft &&
        node.position.x < viewRight &&
        node.position.y + node.height > viewTop &&
        node.position.y < viewBottom,
    );
  }, [nodes, viewport]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const buildWorkflowReferences = useCallback(
    async (configNodeId: string, forBackend: boolean) => {
      const upstreamImageNodes = connectionsRef.current
        .filter((connection) => connection.toNodeId === configNodeId)
        .map((connection) => nodesRef.current.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is WorkflowNodeData => Boolean(node && node.type === 'image' && (node.metadata?.localKey || node.metadata?.content)));
      const references: WorkflowReferenceImage[] = [];
      for (const node of upstreamImageNodes) {
        const metadata = node.metadata || {};
        const base = {
          id: node.id,
          name: metadata.uploadName || `${node.title || node.id}.png`,
          type: metadata.mimeType || 'image/png',
          localKey: metadata.localKey,
          sourceUrl: metadata.sourceUrl || metadata.content,
        };
        if (forBackend) {
          references.push(base);
          continue;
        }
        if (metadata.localKey) {
          const blob = await readImageBlob(metadata.localKey).catch(() => null);
          if (blob) {
            references.push({ ...base, dataUrl: await blobToDataUrl(blob), type: blob.type || base.type });
            continue;
          }
        }
        if (metadata.content?.startsWith('data:image')) {
          references.push({ ...base, dataUrl: metadata.content });
        }
      }
      return references;
    },
    [],
  );

	const buildWorkflowPrompt = useCallback((nodeId: string) => {
	    const node = nodesRef.current.find((item) => item.id === nodeId);
	    const ownPrompt = (node?.metadata?.composerContent || node?.metadata?.prompt || '').trim();
    const upstreamText = connectionsRef.current
      .filter((connection) => connection.toNodeId === nodeId)
      .map((connection) => nodesRef.current.find((item) => item.id === connection.fromNodeId))
      .filter((item): item is WorkflowNodeData => Boolean(item && item.type === 'text'))
      .map((item) => (item.metadata?.content || item.metadata?.prompt || '').trim())
      .filter(Boolean)
      .join('\n\n');
    return [ownPrompt, upstreamText].filter(Boolean).join('\n\n');
  }, []);

  const persistGeneratedImageLocally = useCallback(
    async (sourceUrl: string, key: string): Promise<WorkflowGeneratedImage> => {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('图片下载失败');
      const blob = await response.blob();
      await saveImageBlob(key, blob);
      const displayUrl = URL.createObjectURL(blob);
      registerObjectUrl(key, displayUrl);
      return {
        displayUrl,
        localKey: key,
        sourceUrl,
        mimeType: blob.type || 'image/png',
        bytes: blob.size,
      };
    },
    [registerObjectUrl],
  );

  const applyGeneratedImage = useCallback(
	    async (targetId: string, generated: WorkflowGeneratedImage, prompt: string, references: WorkflowReferenceImage[], model?: string) => {
      const content = generated.displayUrl || (generated.localKey && backendMode ? buildBackendImageUrl(generated.localKey) : generated.sourceUrl);
      if (!content) throw new Error('图片地址为空');
      const meta = await readImageMeta(content);
      const size = fitNodeSize(meta.width, meta.height);
      setNodes((prev) =>
        prev.map((node) => {
          if (node.id !== targetId) return node;
          const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
          return {
            ...node,
            title: prompt.slice(0, 24) || '生成图片',
            position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: {
              ...node.metadata,
              content,
              prompt,
              status: NODE_STATUS_SUCCESS,
              errorDetails: undefined,
	              generationType: references.length > 0 ? 'edit' : 'generation',
	              references: references.map((reference) => reference.localKey || reference.sourceUrl || '').filter(Boolean),
	              model,
	              localKey: generated.localKey,
              sourceUrl: generated.sourceUrl,
              mimeType: generated.mimeType,
              naturalWidth: meta.width,
              naturalHeight: meta.height,
              bytes: generated.bytes,
            },
          };
        }),
      );
    },
    [backendMode],
  );

  const createPendingImageNodes = useCallback((sourceNode: WorkflowNodeData, prompt: string, count: number) => {
    const imageSpec = NODE_SPECS.image;
    const ids = Array.from({ length: count }, () => `image-${uuidv4()}`);
    const parentRight = sourceNode.position.x + sourceNode.width;
    const startY = sourceNode.position.y + sourceNode.height / 2 - ((count - 1) * (imageSpec.height + 28)) / 2 - imageSpec.height / 2;
    const newNodes = ids.map((id, index): WorkflowNodeData => ({
      id,
      type: 'image',
      title: prompt.slice(0, 24) || '生成图片',
      position: {
        x: parentRight + 96,
        y: startY + index * (imageSpec.height + 28),
      },
      width: imageSpec.width,
      height: imageSpec.height,
      metadata: { prompt, status: NODE_STATUS_LOADING },
    }));
    setNodes((prev) => [...prev, ...newNodes]);
    setConnections((prev) => [
      ...prev,
      ...ids.map((id) => ({ id: `conn-${uuidv4()}`, fromNodeId: sourceNode.id, toNodeId: id })),
    ]);
    setSelectedNodeIds(new Set(ids));
    setSelectedConnectionId(null);
    return ids;
  }, []);

  const markNodeStatus = useCallback((nodeIds: string[], status: WorkflowNodeStatus, errorDetails?: string) => {
    setNodes((prev) =>
      prev.map((node) =>
        nodeIds.includes(node.id)
          ? { ...node, metadata: { ...(node.metadata || {}), status, errorDetails } }
          : node,
      ),
    );
  }, []);

	  const resolveProfile = useCallback((profileId?: string) => {
	    const selected = config.apiProfiles?.find((profile) => profile.id === profileId);
	    return selected || config;
	  }, [config]);

	  const buildRuntimeProfile = useCallback((profileId: string | undefined, metadata: WorkflowNodeMetadata = {}) => {
	    const profile = resolveProfile(profileId);
	    const generationOptions = buildWorkflowGenerationOptions(metadata);
	    const imageConfig = {
	      ...(profile.imageConfig || config.imageConfig),
	      imageSize: generationOptions?.size || 'auto',
	      aspectRatio: generationOptions?.aspectRatio || 'auto',
	    };
	    const runtimeProfile = {
	      ...profile,
	      includeImageConfig: Boolean(generationOptions?.size || generationOptions?.aspectRatio),
	      imageConfig,
	      ...(generationOptions?.quality ? { quality: generationOptions.quality } : {}),
	    };
	    if (!isNovelAiProfile(profile)) return runtimeProfile;
	    return {
	      ...runtimeProfile,
	      novelAiConfig: mergeNovelAiConfig(
	        profile.novelAiConfig || config.novelAiConfig,
	        metadata.novelAiOverrides,
	      ),
	    };
	  }, [config.imageConfig, config.novelAiConfig, resolveProfile]);

	  const handleGenerateNode = useCallback(
	    async (nodeId: string) => {
	      if (!activeProjectId) return;
	      const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
	      if (!sourceNode || sourceNode.type !== 'config') return;
	      const prompt = buildWorkflowPrompt(nodeId);
	      const count = clamp(Math.floor(Number(sourceNode.metadata?.count) || 1), 1, 16);
	      const apiProfileId = sourceNode.metadata?.apiProfileId || config.activeApiProfileId || 'default';
	      const generationOptions = buildWorkflowGenerationOptions(sourceNode.metadata);
	      const profile = buildRuntimeProfile(apiProfileId, sourceNode.metadata);
	      if (!profile.apiKey) {
	        message.warning('请先配置 API Key');
        return;
      }
      if (!profile.model) {
        message.warning('请先配置模型名称');
        return;
      }
      const references = await buildWorkflowReferences(nodeId, backendMode);
      if (!prompt.trim() && references.length === 0) {
        message.warning('请连接提示词节点、填写配置提示词或连接参考图');
        return;
      }

      setRunningNodeId(nodeId);
      updateNodeMetadata(nodeId, { status: NODE_STATUS_LOADING, errorDetails: undefined });
      const targetIds = createPendingImageNodes(sourceNode, prompt, count);
	      try {
	        if (backendMode) {
	          const runtimeConfig = {
	            ...config,
	            ...profile,
	            activeApiProfileId: apiProfileId,
	            apiProfiles: (config.apiProfiles || []).map((item) =>
	              item.id === apiProfileId ? { ...item, ...profile } : item,
	            ),
	          };
	          const response = await generateBackendWorkflowProjectNode(activeProjectId, {
	            nodeId,
	            apiProfileId,
	            prompt,
	            referenceImages: references,
	            count,
	            generationOptions,
	            runtimeConfig,
	          });
          let successCount = 0;
          await Promise.all(
            response.images.map(async (item, index) => {
              const targetId = targetIds[index];
              if (!targetId) return;
              if (item.status === 'success' && item.localKey) {
                successCount += 1;
                await applyGeneratedImage(
                  targetId,
                  {
                    localKey: item.localKey,
                    sourceUrl: item.sourceUrl,
                    displayUrl: buildBackendImageUrl(item.localKey),
                    mimeType: item.mimeType,
                    bytes: item.bytes,
	                  },
	                  prompt,
	                  references,
	                  profile.model,
	                );
              } else {
                markNodeStatus([targetId], NODE_STATUS_ERROR, item.error || '生成失败');
              }
            }),
          );
          updateNodeMetadata(nodeId, {
            status: successCount > 0 ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
            errorDetails: successCount > 0 ? undefined : '全部图片生成失败',
            model: profile.model,
          });
          if (successCount === 0) message.error('全部图片生成失败');
          else if (successCount < targetIds.length) message.error('部分图片生成失败');
          return;
        }

        let successCount = 0;
        await Promise.all(
          targetIds.map(async (targetId) => {
            const startTime = Date.now();
            onStatsUpdate('request');
            try {
		              const imageUrl = await requestWorkflowImage(profile, prompt, references, {
		                stream: config.stream,
		                generationOptions,
		              });
	              if (!imageUrl) throw new Error('未在响应中找到图片数据');
	              const generated = await persistGeneratedImageLocally(imageUrl, `workflow:${activeProjectId}:${targetId}`);
	              await applyGeneratedImage(targetId, generated, prompt, references, profile.model);
              successCount += 1;
              onStatsUpdate('success', Date.now() - startTime);
            } catch (err) {
              const errorDetails = formatUnknownErrorMessage(err, '生成失败');
              markNodeStatus([targetId], NODE_STATUS_ERROR, errorDetails);
              onStatsUpdate('fail');
            }
          }),
        );
        updateNodeMetadata(nodeId, {
          status: successCount === targetIds.length ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
          errorDetails: successCount > 0 ? undefined : '全部图片生成失败',
          model: profile.model,
        });
      } catch (err) {
        const errorDetails = formatUnknownErrorMessage(err, '工作流生成失败');
        message.error(errorDetails);
        markNodeStatus([nodeId, ...targetIds], NODE_STATUS_ERROR, errorDetails);
      } finally {
        setRunningNodeId(null);
      }
    },
	    [
	      activeProjectId,
	      applyGeneratedImage,
	      backendMode,
	      buildRuntimeProfile,
	      buildWorkflowPrompt,
	      buildWorkflowReferences,
	      config,
	      createPendingImageNodes,
	      markNodeStatus,
	      onStatsUpdate,
	      persistGeneratedImageLocally,
	      updateNodeMetadata,
	    ],
	  );

  const handleRetryNode = useCallback((node: WorkflowNodeData) => {
    const sourceConnection = connectionsRef.current.find((connection) => connection.toNodeId === node.id);
    if (!sourceConnection) {
      message.warning('找不到来源配置节点');
      return;
    }
    void handleGenerateNode(sourceConnection.fromNodeId);
  }, [handleGenerateNode]);

  const handleUploadRequest = useCallback((nodeId?: string) => {
    uploadTargetNodeIdRef.current = nodeId || null;
    imageInputRef.current?.click();
  }, []);

	  const handleImageInputChange = useCallback(
	    async (event: React.ChangeEvent<HTMLInputElement>) => {
	      const file = event.target.files?.[0];
	      if (!file || !activeProjectId) {
	        uploadTargetNodeIdRef.current = null;
	        if (event.target) event.target.value = '';
	        return;
	      }
	      const targetId = uploadTargetNodeIdRef.current;
	      uploadTargetNodeIdRef.current = null;
	      let previewUrl = '';
	      let keepPreviewUrl = false;
	      let progressNodeId = targetId || '';
	      let createdPlaceholder = false;
	      try {
	        previewUrl = URL.createObjectURL(file);
	        const meta = await readImageMeta(previewUrl);
	        const size = fitNodeSize(meta.width, meta.height);
	        if (!targetId) {
	          const center = getCanvasCenter();
	          const placeholder = createWorkflowNode('image', center, {
	            content: previewUrl,
	            status: NODE_STATUS_LOADING,
	            uploadName: file.name,
	            mimeType: file.type || 'image/png',
	            naturalWidth: meta.width,
	            naturalHeight: meta.height,
	            bytes: file.size,
	          });
	          placeholder.title = file.name;
	          placeholder.width = size.width;
	          placeholder.height = size.height;
	          placeholder.position = {
	            x: center.x - size.width / 2,
	            y: center.y - size.height / 2,
	          };
	          progressNodeId = placeholder.id;
	          createdPlaceholder = true;
	          setNodes((prev) => [...prev, placeholder]);
	          setSelectedNodeIds(new Set([placeholder.id]));
	        }
	        setUploadProgress(progressNodeId, backendMode ? 0 : null);
	        showUploadLoadingMessage(1);
	        let content = '';
	        let localKey = '';
	        let sourceUrl = '';
	        if (backendMode) {
	          const uploaded = await uploadBackendImage(file, {
	            name: file.name,
	            lastModified: file.lastModified,
	          }, {
	            onUploadProgress: (progress) => {
	              setUploadProgress(progressNodeId, progress.percent ?? null);
	            },
	          });
	          localKey = uploaded.key;
	          sourceUrl = uploaded.url;
	          content = buildBackendImageUrl(uploaded.key);
	        } else {
	          localKey = `workflow:${activeProjectId}:upload:${uuidv4()}`;
	          await saveImageBlob(localKey, file);
	          content = previewUrl;
	          keepPreviewUrl = true;
	          registerObjectUrl(localKey, content);
	        }
	        const metadata: WorkflowNodeMetadata = {
          content,
          localKey,
          sourceUrl,
          status: NODE_STATUS_SUCCESS,
          uploadName: file.name,
          mimeType: file.type || 'image/png',
          naturalWidth: meta.width,
          naturalHeight: meta.height,
          bytes: file.size,
        };
	        if (targetId) {
	          updateNode(targetId, {
	            title: file.name,
	            width: size.width,
	            height: size.height,
	            metadata,
	          });
	        } else {
	          updateNode(progressNodeId, {
	            title: file.name,
	            width: size.width,
	            height: size.height,
	            metadata,
	          });
	        }
	        finishUploadMessage(1, 0);
	      } catch (err) {
	        console.error(err);
	        const errorMessage = formatUnknownErrorMessage(err, '图片上传失败');
	        if (createdPlaceholder && progressNodeId) {
	          updateNode(progressNodeId, {
	            metadata: {
	              status: NODE_STATUS_ERROR,
	              errorDetails: errorMessage,
	              uploadName: file.name,
	              mimeType: file.type || 'image/png',
	              bytes: file.size,
	            },
	          });
	        }
	        message.error(errorMessage);
	        finishUploadMessage(0, 1);
	      } finally {
	        if (progressNodeId) clearUploadProgress(progressNodeId);
	        if (previewUrl && !keepPreviewUrl) {
	          URL.revokeObjectURL(previewUrl);
	        }
	        if (event.target) event.target.value = '';
	      }
	    },
	    [activeProjectId, backendMode, getCanvasCenter, registerObjectUrl, updateNode],
	  );

  const openProject = useCallback((projectId: string) => {
    if (!projectsRef.current.some((project) => project.id === projectId)) return;
    void flushCurrentProjectRef.current?.();
    onOpenProjectIdsChange((current) => (current.includes(projectId) ? current : [...current, projectId]));
    onActiveProjectIdChange(projectId);
    setPendingNodePicker(null);
    setContextMenu(null);
  }, [onActiveProjectIdChange, onOpenProjectIdsChange]);

  const closeProjectTab = useCallback((projectId: string) => {
    void flushCurrentProjectRef.current?.();
    const index = openProjectIds.indexOf(projectId);
    if (index < 0) return;
    const nextOpen = openProjectIds.filter((id) => id !== projectId);
    onOpenProjectIdsChange(nextOpen);
    if (activeProjectIdRef.current === projectId) {
      onActiveProjectIdChange(nextOpen[index] || nextOpen[index - 1] || null);
    }
    setPendingNodePicker(null);
    setContextMenu(null);
  }, [onActiveProjectIdChange, onOpenProjectIdsChange, openProjectIds]);

  const showProjectHome = useCallback(() => {
    void flushCurrentProjectRef.current?.();
    onActiveProjectIdChange(null);
    setPendingNodePicker(null);
    setContextMenu(null);
  }, [onActiveProjectIdChange]);

  const patchActiveProject = useCallback(
	    async (patch: Partial<Pick<WorkflowProject, 'title' | 'linkedTaskId'>>) => {
	      if (!activeProject) return;
	      const linkedTaskChanged = Object.prototype.hasOwnProperty.call(patch, 'linkedTaskId') &&
	        patch.linkedTaskId !== activeProject.linkedTaskId;
	      const previousLinkedTaskId = activeProject.linkedTaskId;
	      const previousProjects = projectsRef.current;
	      const nextProject = { ...activeProject, ...patch, updatedAt: new Date().toISOString() };
	      const nextProjects = projectsRef.current.map((project) => (project.id === activeProject.id ? nextProject : project));
	      projectsRef.current = nextProjects;
	      setProjects(nextProjects);
	      if (backendMode) {
	        const backendPatch = {
	          ...patch,
	          ...(linkedTaskChanged ? { linkedTaskId: patch.linkedTaskId || null } : {}),
	        };
	        try {
	          await patchBackendWorkflowProject(activeProject.id, backendPatch);
	        } catch (err) {
	          projectsRef.current = previousProjects;
	          setProjects(previousProjects);
	          message.error(getWorkflowLinkConflictMessage(err, '工作流项目保存失败'));
	          return;
	        }
	      } else {
	        saveWorkflowProjects(nextProjects);
	      }
      if (linkedTaskChanged && previousLinkedTaskId) {
        await clearLinkedTaskProjection(activeProject, previousLinkedTaskId);
      }
      if (nextProject.linkedTaskId) {
        await syncLinkedTask(nextProject, serializeWorkflow(currentWorkflow()));
      }
    },
    [activeProject, backendMode, clearLinkedTaskProjection, currentWorkflow, syncLinkedTask],
  );

  const handleCreateProject = useCallback(async () => {
    await flushCurrentProjectRef.current?.();
    const title = `工作流 ${projectsRef.current.length + 1}`;
    try {
      const project = backendMode
        ? await createBackendWorkflowProject({ title, state: createDefaultWorkflow(config.activeApiProfileId) })
        : createWorkflowProject(title, config.activeApiProfileId);
	      const nextProjects = [project, ...projectsRef.current];
	      projectsRef.current = nextProjects;
	      setProjects(nextProjects);
	      if (!backendMode) saveWorkflowProjects(nextProjects);
	      onOpenProjectIdsChange((current) => [project.id, ...current.filter((id) => id !== project.id)]);
	      onActiveProjectIdChange(project.id);
	      message.success('已新建工作流画布');
    } catch (err) {
      message.error(formatUnknownErrorMessage(err, '新建工作流失败'));
    }
  }, [backendMode, config.activeApiProfileId, onActiveProjectIdChange, onOpenProjectIdsChange]);

  const handleRenameProject = useCallback(() => {
    if (!activeProject) return;
    let nextTitle = activeProject.title;
    Modal.confirm({
      title: '重命名工作流',
      content: (
        <Input
          defaultValue={activeProject.title}
          autoFocus
          maxLength={40}
          onChange={(event) => {
            nextTitle = event.target.value;
          }}
        />
      ),
      okText: '保存',
      cancelText: '取消',
      onOk: () => patchActiveProject({ title: nextTitle.trim() || activeProject.title }),
    });
  }, [activeProject, patchActiveProject]);

  const handleDeleteProject = useCallback(() => {
    if (!activeProject) return;
    Modal.confirm({
      title: '删除当前工作流？',
      content: '会删除这个独立画布和它引用的工作流图片，不会删除任务卡本身。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const target = activeProject;
        const nextProjects = projectsRef.current.filter((project) => project.id !== target.id);
        try {
          if (backendMode) {
            await deleteBackendWorkflowProject(target.id);
          } else {
            await cleanupWorkflowProjectCache(target, {
              preserveImageKeys: collectTaskImageKeys(tasks.map((task) => task.id)),
            });
            saveWorkflowProjects(nextProjects);
          }
          const fallbackProjects = nextProjects.length > 0
            ? nextProjects
            : [
                backendMode
                  ? await createBackendWorkflowProject({
                      title: '工作流 1',
                      state: createDefaultWorkflow(config.activeApiProfileId),
                    })
                  : createWorkflowProject('工作流 1', config.activeApiProfileId),
              ];
		          projectsRef.current = fallbackProjects;
		          setProjects(fallbackProjects);
		          if (!backendMode) saveWorkflowProjects(fallbackProjects);
		          const nextOpen = openProjectIds.filter((id) => id !== target.id && fallbackProjects.some((project) => project.id === id));
		          onOpenProjectIdsChange(nextOpen);
		          onActiveProjectIdChange((currentActive) => {
		            if (currentActive && currentActive !== target.id && nextOpen.includes(currentActive)) return currentActive;
		            return nextOpen[0] || null;
		          });
		          message.success('已删除工作流');
        } catch (err) {
          message.error(formatUnknownErrorMessage(err, '删除工作流失败'));
        }
      },
    });
  }, [activeProject, backendMode, config.activeApiProfileId, onActiveProjectIdChange, onOpenProjectIdsChange, openProjectIds, tasks]);

	  const handleLinkedTaskChange = useCallback(
	    (taskId: string) => {
	      if (taskId) {
	        const conflict = projectsRef.current.find(
	          (project) => project.linkedTaskId === taskId && project.id !== activeProjectIdRef.current,
	        );
	        if (conflict) {
	          message.warning(`任务卡已绑定「${conflict.title}」，请先在该工作流解除绑定`);
	          return;
	        }
	      }
	      void patchActiveProject({ linkedTaskId: taskId || undefined });
	    },
	    [patchActiveProject],
  );

		  return (
	    <div className="workflow-shell">
	      <div className="workflow-topbar" data-workflow-no-pan data-workflow-no-zoom>
	        <WorkflowProjectTabs
	          projects={openProjects}
	          activeProjectId={activeProjectId}
	          onHome={showProjectHome}
	          onSelect={openProject}
	          onClose={closeProjectTab}
	        />
	        <Space wrap size={8} align="center" className="workflow-topbar-actions">
	          <Tooltip title="新建工作流">
	            <Button shape="circle" icon={<PlusOutlined />} onClick={() => void handleCreateProject()} />
	          </Tooltip>
          <Tooltip title="重命名工作流">
            <Button shape="circle" icon={<EditOutlined />} onClick={handleRenameProject} disabled={!activeProject} />
          </Tooltip>
          <Tooltip title="删除工作流">
            <Button shape="circle" danger icon={<DeleteFilled />} onClick={handleDeleteProject} disabled={!activeProject} />
          </Tooltip>
          <span className="workflow-topbar-divider" />
		          <Select
		            value={linkedTaskId}
		            options={taskOptions}
		            onChange={handleLinkedTaskChange}
		            disabled={!activeProject}
		            popupClassName="workflow-floating-popup"
	            popupRender={(menu) => (
	              <div data-workflow-no-pan data-workflow-no-zoom data-workflow-no-keybind onMouseDown={stopWorkflowControlEvent}>
	                {menu}
	              </div>
	            )}
	            style={{ minWidth: 190 }}
	          />
	          <Button icon={<PlusOutlined />} onClick={onCreateTask}>
	            新建任务卡
	          </Button>
	          <Text type="secondary">{activeProject ? (linkedTask ? '已同步到任务卡' : '独立画布') : '打开工作流后可绑定任务卡'}</Text>
	        </Space>
	      </div>

	      {!projectsHydrated ? (
	        <div className="workflow-loading">
	          <Spin />
	          <Text type="secondary">正在加载工作流...</Text>
	        </div>
	      ) : !activeProject ? (
	        <WorkflowProjectHome
	          projects={projects}
	          openProjectIds={openProjectIds}
	          onOpen={openProject}
	          onCreate={() => void handleCreateProject()}
	        />
	      ) : !hydrated ? (
	        <div className="workflow-loading">
	          <Spin />
	          <Text type="secondary">正在加载工作流...</Text>
	        </div>
	      ) : (
        <div
          ref={containerRef}
          className={`workflow-canvas workflow-canvas-${backgroundMode}`}
          onPointerDown={handleCanvasPointerDown}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
        >
	          <CanvasGrid viewport={viewport} mode={backgroundMode} />
          <svg
            className="workflow-connections"
            style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}
          >
            {connections.map((connection) => {
              const from = nodeById.get(connection.fromNodeId);
              const to = nodeById.get(connection.toNodeId);
              if (!from || !to) return null;
              return (
		                <ConnectionPath
		                  key={connection.id}
		                  connection={connection}
		                  from={from}
		                  to={to}
		                  active={selectedConnectionId === connection.id}
		                  adding={pendingNodePicker?.type === 'insert-connection' && pendingNodePicker.connectionId === connection.id}
		                  onSelect={() => {
		                    setSelectedConnectionId(connection.id);
		                    setSelectedNodeIds(new Set());
	                    setContextMenu(null);
	                  }}
		                  onContextMenu={(event) => {
		                    event.preventDefault();
		                    event.stopPropagation();
		                    setSelectedConnectionId(connection.id);
		                    setSelectedNodeIds(new Set());
		                    setContextMenu({ type: 'connection', x: event.clientX, y: event.clientY, connectionId: connection.id });
		                  }}
		                  onInsert={(event, position) => {
		                    event.preventDefault();
		                    event.stopPropagation();
		                    setSelectedConnectionId(connection.id);
		                    setSelectedNodeIds(new Set());
		                    setContextMenu(null);
		                    setPendingNodePicker({
		                      type: 'insert-connection',
		                      x: event.clientX,
		                      y: event.clientY,
		                      position,
		                      connectionId: connection.id,
		                    });
		                  }}
		                />
	              );
	            })}
            {connecting ? <ActiveConnectionPath node={nodeById.get(connecting.nodeId)} handle={connecting} mouseWorld={mouseWorld} /> : null}
          </svg>
          <div
            className="workflow-world"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
            }}
          >
            {visibleNodes.map((node) => (
              <WorkflowNode
                key={node.id}
	                node={node}
	                config={config}
	                selected={selectedNodeIds.has(node.id)}
	                running={runningNodeId === node.id}
	                profileOptions={profileOptions}
		                inputSummary={getNodeInputSummary(node.id, nodes, connections)}
			                saveImages={getSaveNodeImageInputs(node.id, nodes, connections)}
			                showImageInfo={showImageInfo}
			                uploading={node.id in uploadProgressByNodeId}
			                uploadProgress={uploadProgressByNodeId[node.id]}
			                primary={primaryConfigNodeId === node.id}
			                connecting={Boolean(connecting)}
		                onMouseDown={handleNodeMouseDown}
		                onConnectStart={handleConnectStart}
		                onTitleChange={updateNodeTitle}
		                onMetadataChange={updateNodeMetadata}
	                onUpload={handleUploadRequest}
		                onGenerate={handleGenerateNode}
		                onSaveImages={handleSaveNodeImages}
		                onRetry={handleRetryNode}
	                onPreview={(nodeId) => setPreviewNodeId(nodeId)}
		                onSetPrimary={(nodeId) => setPrimaryConfigNodeId(nodeId)}
		                onToggleCollapse={(nodeId) => {
		                  const targetNode = nodesRef.current.find((item) => item.id === nodeId);
		                  updateNodeMetadata(nodeId, { collapsed: !targetNode?.metadata?.collapsed });
		                }}
	                onContextMenu={(event, nodeId) => {
	                  event.preventDefault();
	                  event.stopPropagation();
	                  setSelectedNodeIds(new Set([nodeId]));
	                  setSelectedConnectionId(null);
	                  setContextMenu({ type: 'node', x: event.clientX, y: event.clientY, nodeId });
	                }}
	              />
	            ))}
            {selectionBox ? <SelectionBox selection={selectionBox} /> : null}
          </div>
	          <WorkflowToolbar
	            selectedCount={selectedNodeIds.size + (selectedConnectionId ? 1 : 0)}
	            canUndo={historyState.canUndo}
	            canRedo={historyState.canRedo}
	            backgroundMode={backgroundMode}
            showImageInfo={showImageInfo}
		            onAddText={() => addNode('text')}
		            onAddImage={() => addNode('image')}
		            onAddConfig={() => addNode('config')}
		            onAddSave={() => addNode('save')}
		            onUpload={() => handleUploadRequest()}
            onUndo={undoCanvas}
            onRedo={redoCanvas}
            onDelete={deleteSelected}
            onClear={() => {
	              Modal.confirm({
	                title: '清空当前工作流？',
	                content: '会删除当前画布中的节点和连线。',
                okText: '清空',
                cancelText: '取消',
                onOk: () => {
		                  const next = createDefaultWorkflow(config.activeApiProfileId);
		                  setNodes(next.nodes);
		                  setConnections(next.connections);
		                  setViewportImmediate(next.viewport);
	                  setBackgroundMode(next.backgroundMode);
	                  setShowImageInfo(next.showImageInfo);
	                  setPrimaryConfigNodeId(next.primaryConfigNodeId);
	                  setSelectedNodeIds(new Set());
	                  setSelectedConnectionId(null);
	                },
              });
            }}
	            onBackgroundModeChange={setBackgroundMode}
	            onShowImageInfoChange={setShowImageInfo}
	          />
		          {contextMenu ? (
		            <WorkflowContextMenuView
		              menu={contextMenu}
		              onClose={() => setContextMenu(null)}
	              onDuplicate={() => {
	                if (contextMenu.type === 'node') duplicateNode(contextMenu.nodeId);
	              }}
	              onDelete={() => {
	                if (contextMenu.type === 'node') deleteNode(contextMenu.nodeId);
	                else deleteConnection(contextMenu.connectionId);
		              }}
		            />
		          ) : null}
		          {pendingNodePicker ? (
		            <WorkflowNodePickerMenu
		              picker={pendingNodePicker}
		              onPick={handlePickNodeType}
		              onClose={() => setPendingNodePicker(null)}
		            />
		          ) : null}
		          <WorkflowZoomControl
		            viewport={viewport}
		            onZoomIn={() => setZoomScale(viewportRef.current.k * 1.2)}
		            onZoomOut={() => setZoomScale(viewportRef.current.k / 1.2)}
		            onZoomTo={(scale) => setZoomScale(scale)}
		            onFit={fitViewport}
		            onReset={resetViewport}
		          />
	          <input ref={imageInputRef} type="file" accept="image/*" className="workflow-file-input" onChange={handleImageInputChange} />
	        </div>
	      )}

      <Modal
        title={previewNode?.title || '图片预览'}
        open={Boolean(previewNode?.metadata?.content)}
        onCancel={() => setPreviewNodeId(null)}
        footer={null}
        width="auto"
        centered
        styles={{ body: { padding: 0, display: 'flex', justifyContent: 'center', maxHeight: '80vh' } }}
      >
        {previewNode?.metadata?.content ? (
          <img
            src={previewNode.metadata.content}
            alt={previewNode.title}
            style={{ maxWidth: '86vw', maxHeight: '80vh', objectFit: 'contain' }}
          />
        ) : null}
      </Modal>
    </div>
  );
	}

function WorkflowProjectTabs({
  projects,
  activeProjectId,
  onHome,
  onSelect,
  onClose,
}: {
  projects: WorkflowProject[];
  activeProjectId: string | null;
  onHome: () => void;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
}) {
  return (
    <div className="workflow-tabs">
      <Tooltip title="工作流主页">
        <Button
          shape="circle"
          icon={<FolderOpenOutlined />}
          className={!activeProjectId ? 'workflow-tab-home is-active' : 'workflow-tab-home'}
          onClick={onHome}
        />
      </Tooltip>
      <div className="workflow-tab-scroll">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className={`workflow-tab${project.id === activeProjectId ? ' is-active' : ''}`}
            onClick={() => onSelect(project.id)}
          >
            <span className="workflow-tab-title">{project.title}</span>
            <span
              role="button"
              tabIndex={0}
              className="workflow-tab-close"
              aria-label="关闭标签"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClose(project.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                onClose(project.id);
              }}
            >
              <CloseOutlined />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function WorkflowProjectHome({
  projects,
  openProjectIds,
  onOpen,
  onCreate,
}: {
  projects: WorkflowProject[];
  openProjectIds: string[];
  onOpen: (projectId: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="workflow-home" data-workflow-no-pan data-workflow-no-zoom>
      <div className="workflow-home-header">
        <div>
          <Typography.Title level={3}>工作流</Typography.Title>
          <Text type="secondary">最近更新的工作流项目</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
          新建工作流
        </Button>
      </div>
      <div className="workflow-home-grid">
        {projects.map((project) => {
          const nodeCount = project.state?.nodes?.length || 0;
          const connectionCount = project.state?.connections?.length || 0;
          const isOpen = openProjectIds.includes(project.id);
          return (
            <button
              key={project.id}
              type="button"
              className="workflow-home-card"
              onClick={() => onOpen(project.id)}
            >
              <span className="workflow-home-card-main">
                <span className="workflow-home-card-icon"><FolderOpenOutlined /></span>
                <span>
                  <span className="workflow-home-card-title">{project.title}</span>
                  <span className="workflow-home-card-meta">
                    {nodeCount} 个节点 · {connectionCount} 条连线
                  </span>
                </span>
              </span>
              <span className={isOpen ? 'workflow-home-card-badge is-open' : 'workflow-home-card-badge'}>
                {isOpen ? '已打开' : '打开'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowNodePickerMenu({
  picker,
  onPick,
  onClose,
}: {
  picker: PendingNodePicker;
  onPick: (type: WorkflowNodeType) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);

  return (
    <div
      className="workflow-node-picker"
      style={{ left: picker.x, top: picker.y }}
      onPointerDown={(event) => event.stopPropagation()}
      data-workflow-no-pan
      data-workflow-no-zoom
      data-workflow-no-keybind
    >
      <button type="button" onClick={() => onPick('text')}>
        <FileTextFilled />
        <span>文本</span>
      </button>
      <button type="button" onClick={() => onPick('image')}>
        <PictureFilled />
        <span>图片</span>
      </button>
	      <button type="button" onClick={() => onPick('config')}>
	        <SettingFilled />
	        <span>生成配置</span>
	      </button>
	      <button type="button" onClick={() => onPick('save')}>
	        <DownloadOutlined />
	        <span>保存图像</span>
	      </button>
	    </div>
	  );
	}

function WorkflowZoomControl({
  viewport,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onFit,
  onReset,
}: {
  viewport: WorkflowViewport;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomTo: (scale: number) => void;
  onFit: () => void;
  onReset: () => void;
}) {
  const percent = Math.round(viewport.k * 100);
  const [open, setOpen] = useState(false);
  const [draftPercent, setDraftPercent] = useState(percent);

  useEffect(() => {
    if (open) setDraftPercent(percent);
  }, [open, percent]);

  const applyDraft = () => {
    const nextPercent = clamp(Number(draftPercent) || 100, WORKFLOW_MIN_ZOOM * 100, WORKFLOW_MAX_ZOOM * 100);
    onZoomTo(nextPercent / 100);
  };

	  return (
	    <div className="workflow-viewport-controls" data-workflow-no-pan data-workflow-no-zoom>
	      <Tooltip title="适应视图">
	        <Button shape="circle" icon={<FullscreenOutlined />} onClick={onFit} />
	      </Tooltip>
	      <Popover
	        open={open}
	        onOpenChange={setOpen}
	        trigger="click"
	        placement="topRight"
	        overlayClassName="workflow-floating-popup"
	        content={
	          <div
	            className="workflow-zoom-panel"
	            data-workflow-no-pan
	            data-workflow-no-zoom
	            data-workflow-no-keybind
	            onMouseDown={stopWorkflowControlEvent}
	          >
	            <div className="workflow-zoom-panel-row">
	              <Tooltip title="缩小">
	                <Button shape="circle" icon={<ZoomOutOutlined />} onClick={onZoomOut} />
	              </Tooltip>
	              <InputNumber
	                min={WORKFLOW_MIN_ZOOM * 100}
	                max={WORKFLOW_MAX_ZOOM * 100}
	                value={draftPercent}
	                addonAfter="%"
	                onChange={(value) => setDraftPercent(Number(value) || 100)}
	                onKeyDown={(event) => {
	                  if (event.key === 'Enter') applyDraft();
	                }}
	              />
	              <Tooltip title="放大">
	                <Button shape="circle" icon={<ZoomInOutlined />} onClick={onZoomIn} />
	              </Tooltip>
	            </div>
	            <Button icon={<ReloadOutlined />} onClick={onReset}>
	              重置视图
	            </Button>
	            <Button type="primary" block onClick={applyDraft}>
	              应用比例
	            </Button>
	          </div>
	        }
	      >
	        <Button className="workflow-zoom-percent">
	          {percent}%
	        </Button>
	      </Popover>
	    </div>
	  );
	}

function WorkflowNode({
  node,
  config,
  selected,
  running,
  profileOptions,
  inputSummary,
  saveImages,
  showImageInfo,
  uploading,
  uploadProgress,
	  primary,
	  connecting,
	  onMouseDown,
	  onConnectStart,
	  onTitleChange,
	  onMetadataChange,
	  onUpload,
  onGenerate,
  onSaveImages,
  onRetry,
	  onPreview,
	  onSetPrimary,
	  onToggleCollapse,
	  onContextMenu,
	}: {
	  node: WorkflowNodeData;
	  config: AppConfig;
	  selected: boolean;
	  running: boolean;
	  profileOptions: Array<{ label: string; value: string; model: string }>;
	  inputSummary: { textCount: number; imageCount: number };
	  saveImages: WorkflowNodeData[];
	  showImageInfo: boolean;
	  uploading: boolean;
	  uploadProgress?: UploadProgressValue;
	  primary: boolean;
	  connecting: boolean;
	  onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
	  onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: 'source' | 'target') => void;
	  onTitleChange: (nodeId: string, title: string) => void;
	  onMetadataChange: (nodeId: string, patch: Partial<WorkflowNodeMetadata>) => void;
	  onUpload: (nodeId?: string) => void;
	  onGenerate: (nodeId: string) => void;
	  onSaveImages: (nodeId: string) => void;
	  onRetry: (node: WorkflowNodeData) => void;
	  onPreview: (nodeId: string) => void;
	  onSetPrimary: (nodeId: string) => void;
	  onToggleCollapse: (nodeId: string) => void;
	  onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
	}) {
		  const status = node.metadata?.status || 'idle';
		  const hasImage = node.type === 'image' && Boolean(node.metadata?.content);
		  const collapsed = Boolean(node.metadata?.collapsed);
		  const [editingTitle, setEditingTitle] = useState(false);
		  const [draftTitle, setDraftTitle] = useState(node.title);
		  useEffect(() => {
		    if (!editingTitle) setDraftTitle(node.title);
		  }, [editingTitle, node.title]);
		  const saveTitle = () => {
		    onTitleChange(node.id, draftTitle);
		    setEditingTitle(false);
		  };
		  return (
	    <div
	      data-node-id={node.id}
	      className={`workflow-node workflow-node-${node.type}${selected ? ' is-selected' : ''}${hasImage ? ' has-image' : ''}${collapsed ? ' is-collapsed' : ''}${connecting ? ' is-connecting' : ''}`}
	      style={{
	        transform: `translate(${node.position.x}px, ${node.position.y}px)`,
	        width: node.width,
	        height: collapsed ? WORKFLOW_COLLAPSED_NODE_HEIGHT : node.height,
	      }}
      onMouseDown={(event) => onMouseDown(event, node.id)}
      onContextMenu={(event) => onContextMenu(event, node.id)}
    >
			      <div className="workflow-node-inner">
		          <div className="workflow-node-header">
		            <Space size={6} className="workflow-node-title-wrap">
		              <span className="workflow-node-icon">{nodeIcon(node.type)}</span>
		              {editingTitle ? (
		                <Input
		                  className="workflow-node-title-input"
		                  value={draftTitle}
		                  autoFocus
		                  maxLength={40}
		                  onMouseDown={stopWorkflowControlEvent}
		                  onClick={stopWorkflowControlEvent}
		                  onChange={(event) => setDraftTitle(event.target.value)}
		                  onBlur={saveTitle}
		                  onPressEnter={saveTitle}
		                  onKeyDown={(event) => {
		                    if (event.key === 'Escape') {
		                      event.stopPropagation();
		                      setDraftTitle(node.title);
		                      setEditingTitle(false);
		                    }
		                  }}
		                />
		              ) : (
		                <Text
		                  strong
		                  className="workflow-node-title"
		                  title={node.title}
		                  onDoubleClick={(event) => {
		                    event.stopPropagation();
		                    setEditingTitle(true);
		                  }}
		                >
		                  {node.title}
		                </Text>
		              )}
		            </Space>
		            <Space size={4} className="workflow-node-header-actions" onMouseDown={stopWorkflowControlEvent}>
		              <Tooltip title="重命名节点">
		                <Button
		                  type="text"
		                  size="small"
		                  shape="circle"
		                  icon={<EditOutlined />}
		                  onClick={(event) => {
		                    event.stopPropagation();
		                    setEditingTitle(true);
		                  }}
		                />
		              </Tooltip>
		              <Tooltip title={collapsed ? '展开节点' : '折叠节点'}>
		                <Button
		                  type="text"
		                  size="small"
		                  shape="circle"
		                  icon={<MinusOutlined />}
		                  onClick={(event) => {
		                    event.stopPropagation();
		                    onToggleCollapse(node.id);
		                  }}
		                />
		              </Tooltip>
		              <span className={`workflow-status-dot status-${status}`} />
		            </Space>
		          </div>
			        {!collapsed ? (
			        <div className={`workflow-node-content${node.type === 'config' ? ' workflow-config-content' : ''}`} data-workflow-no-zoom>
          {node.type === 'text' ? (
            <Input.TextArea
              value={node.metadata?.content || ''}
              placeholder="写提示词、备注或局部描述..."
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => onMetadataChange(node.id, { content: event.target.value, status: 'success' })}
              autoSize={false}
            />
          ) : null}

	          {node.type === 'config' ? (
			            <WorkflowConfigNodePanel
			              node={node}
			              config={config}
			              running={running}
	              profileOptions={profileOptions}
	              inputSummary={inputSummary}
	              primary={primary}
	              onMetadataChange={onMetadataChange}
	              onGenerate={onGenerate}
	              onSetPrimary={onSetPrimary}
	            />
		          ) : null}

		          {node.type === 'image' ? (
			            <ImageContent
			              node={node}
			              status={status}
			              showImageInfo={showImageInfo}
			              uploading={uploading}
			              uploadProgress={uploadProgress}
			              onUpload={onUpload}
			              onRetry={onRetry}
			              onPreview={onPreview}
			            />
		          ) : null}

	          {node.type === 'save' ? (
	            <SaveImageNodePanel node={node} images={saveImages} onSave={onSaveImages} />
	          ) : null}
	        </div>
	        ) : null}
	      </div>
      <button
        type="button"
        className="workflow-handle workflow-handle-left"
        aria-label="连接输入"
        onMouseDown={(event) => onConnectStart(event, node.id, 'target')}
      />
      <button
        type="button"
        className="workflow-handle workflow-handle-right"
        aria-label="连接输出"
        onMouseDown={(event) => onConnectStart(event, node.id, 'source')}
      />
    </div>
	  );
	}
	
const QUALITY_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
];

const ASPECT_OPTIONS = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16'];
const SIZE_OPTIONS = ['auto', '1K', '2K', '4K'];
const COUNT_OPTIONS = [1, 2, 3, 4, 6, 8];

const stopWorkflowControlEvent = (event: React.SyntheticEvent) => {
  event.stopPropagation();
};

const qualityLabel = (value?: string) =>
  QUALITY_OPTIONS.find((option) => option.value === (value || 'auto'))?.label || value || '自动';

const aspectLabel = (value?: string) => (value && value !== 'auto' ? value : '自动');

const settingSummary = (metadata: WorkflowNodeMetadata = {}) => {
  const count = clamp(Math.floor(Number(metadata.count) || 1), 1, 16);
  const middle = metadata.aspectRatio && metadata.aspectRatio !== 'auto'
    ? metadata.aspectRatio
    : aspectLabel(metadata.size);
  return `${qualityLabel(metadata.quality)} · ${middle} · ${count} 张`;
};

function WorkflowConfigNodePanel({
  node,
  config,
  running,
  profileOptions,
  inputSummary,
  primary,
  onMetadataChange,
  onGenerate,
  onSetPrimary,
}: {
  node: WorkflowNodeData;
  config: AppConfig;
  running: boolean;
  profileOptions: Array<{ label: string; value: string; model: string }>;
  inputSummary: { textCount: number; imageCount: number };
  primary: boolean;
  onMetadataChange: (nodeId: string, patch: Partial<WorkflowNodeMetadata>) => void;
  onGenerate: (nodeId: string) => void;
  onSetPrimary: (nodeId: string) => void;
}) {
	  const metadata = normalizeConfigMetadata(node.metadata);
	  const selectedProfileId = metadata.apiProfileId || 'default';
		  const selectedProfile =
		    config.apiProfiles?.find((profile) => profile.id === selectedProfileId) || config;
		  const selectedIsNovelAi = isNovelAiProfile(selectedProfile);
		  const [novelAiModalOpen, setNovelAiModalOpen] = useState(false);
		  const composerValue = metadata.composerContent ?? metadata.prompt ?? '';
		  const count = clamp(Math.floor(Number(metadata.count) || 1), 1, 16);
		  const hasNodeNovelAiOverrides = hasNovelAiOverrides(metadata.novelAiOverrides);

		  useEffect(() => {
		    if (!selectedIsNovelAi && novelAiModalOpen) {
		      setNovelAiModalOpen(false);
		    }
		  }, [selectedIsNovelAi, novelAiModalOpen]);

	  const updateSettings = (patch: Partial<WorkflowNodeMetadata>) => {
	    onMetadataChange(node.id, {
	      ...patch,
	      settingsVersion: WORKFLOW_SETTINGS_VERSION,
	      settingsTouched: true,
	    });
	  };

	  const settingsContent = (
	    <div
	      className="workflow-settings-popover"
	      data-workflow-no-pan
	      data-workflow-no-zoom
	      data-workflow-no-keybind
	      onMouseDown={stopWorkflowControlEvent}
	      onPointerDown={stopWorkflowControlEvent}
	      onWheel={stopWorkflowControlEvent}
	    >
		      {selectedIsNovelAi ? (
		        <div className="workflow-setting-section">
		          <Text type="secondary">NovelAI 参数</Text>
		          <div className="workflow-novelai-settings-entry">
		            <Text strong>{hasNodeNovelAiOverrides ? '已自定义' : '使用默认值'}</Text>
		            <Button
		              size="small"
		              icon={<SlidersOutlined />}
		              onMouseDown={stopWorkflowControlEvent}
		              onClick={() => setNovelAiModalOpen(true)}
		            >
		              参数
		            </Button>
		          </div>
		        </div>
		      ) : (
		        <>
		          <WorkflowSettingGroup
		            title="质量"
		            options={QUALITY_OPTIONS}
		            value={metadata.quality || 'auto'}
		            onChange={(value) => updateSettings({ quality: value })}
		          />
		          <WorkflowSettingGroup
		            title="比例"
		            options={ASPECT_OPTIONS.map((value) => ({ value, label: aspectLabel(value) }))}
		            value={metadata.aspectRatio || 'auto'}
		            onChange={(value) => updateSettings({ aspectRatio: value })}
		          />
		          <WorkflowSettingGroup
		            title="尺寸"
		            options={SIZE_OPTIONS.map((value) => ({ value, label: value === 'auto' ? '自动' : value }))}
		            value={metadata.size || 'auto'}
		            onChange={(value) => updateSettings({ size: value })}
		          />
		        </>
		      )}
	      <div className="workflow-setting-section">
	        <Text type="secondary">张数</Text>
	        <div className="workflow-setting-grid workflow-setting-count-grid">
	          {COUNT_OPTIONS.map((value) => (
	            <button
	              key={value}
	              type="button"
	              className={`workflow-setting-pill${count === value ? ' is-active' : ''}`}
	              onMouseDown={stopWorkflowControlEvent}
	              onClick={() => updateSettings({ count: value })}
	            >
	              {value} 张
	            </button>
	          ))}
	          <InputNumber
	            min={1}
	            max={16}
	            value={count}
	            onMouseDown={stopWorkflowControlEvent}
	            onChange={(value) => updateSettings({ count: Number(value) || 1 })}
	          />
	        </div>
	      </div>
	    </div>
	  );

		  return (
		    <>
		    <div className="workflow-config-panel" onWheel={stopWorkflowControlEvent}>
	      <div className="workflow-config-meta">
	        <div className="workflow-input-summary workflow-config-summary">
	          <span>提示词 {inputSummary.textCount} 个</span>
	          <span>参考图 {inputSummary.imageCount} 张</span>
	          {primary ? <span>主配置</span> : null}
	        </div>
	        <div className="workflow-config-controls">
	          <Select
	            value={selectedProfileId}
	            className="workflow-pill-select workflow-profile-select"
	            popupClassName="workflow-floating-popup"
	            getPopupContainer={() => document.body}
	            popupMatchSelectWidth={false}
	            popupRender={(menu) => (
	              <div
	                data-workflow-no-pan
	                data-workflow-no-zoom
	                data-workflow-no-keybind
	                onMouseDown={stopWorkflowControlEvent}
	                onPointerDown={stopWorkflowControlEvent}
	              >
	                {menu}
	              </div>
	            )}
	            options={profileOptions.map((option) => ({
	              value: option.value,
	              label: <WorkflowProfileOption option={option} />,
	            }))}
	            onChange={(value) => onMetadataChange(node.id, { apiProfileId: value })}
	            onMouseDown={stopWorkflowControlEvent}
	          />
	          <div className="workflow-config-settings-readout">
	            <Popover
	              trigger="click"
	              content={settingsContent}
	              overlayClassName="workflow-floating-popup"
	              getPopupContainer={() => document.body}
	            >
	              <Button
	                className="workflow-config-settings-button"
	                type="text"
	                shape="circle"
	                icon={<SlidersOutlined />}
	                data-workflow-no-pan
	                data-workflow-no-zoom
	                onMouseDown={stopWorkflowControlEvent}
	                onPointerDown={stopWorkflowControlEvent}
	                aria-label="详细设置"
	              />
	            </Popover>
		            <span className="workflow-config-settings-text">
		              {selectedIsNovelAi
		                ? `NovelAI · ${hasNodeNovelAiOverrides ? '自定义' : '默认'} · ${Math.max(1, metadata.count || 1)} 张`
		                : settingSummary(metadata)}
		            </span>
	          </div>
	        </div>
	      </div>

	      <Input.TextArea
	        className="workflow-config-prompt-input"
	        value={composerValue}
	        placeholder="组装提示词，可直接输入或连接文本节点"
	        rows={4}
	        onMouseDown={stopWorkflowControlEvent}
	        onPointerDown={stopWorkflowControlEvent}
	        onWheel={stopWorkflowControlEvent}
	        onChange={(event) =>
	          onMetadataChange(node.id, {
	            composerContent: event.target.value,
	            prompt: event.target.value,
	            status: NODE_STATUS_SUCCESS,
	          })
	        }
	      />

	      {!primary ? (
	        <Button
	          className="workflow-config-primary-button"
	          icon={<LinkOutlined />}
	          onClick={() => onSetPrimary(node.id)}
	          onMouseDown={stopWorkflowControlEvent}
	        >
	          设为主配置
	        </Button>
	      ) : null}

	      <Button
	        type="primary"
	        className="workflow-config-generate"
	        icon={running ? <ReloadOutlined spin /> : <PlayCircleFilled />}
	        onClick={() => onGenerate(node.id)}
	        onMouseDown={stopWorkflowControlEvent}
	        disabled={running}
	        block
	      >
	        开始生成
	      </Button>
		    </div>
		    <Modal
		      title="NovelAI 参数"
		      open={selectedIsNovelAi && novelAiModalOpen}
		      footer={null}
		      onCancel={() => setNovelAiModalOpen(false)}
		      destroyOnClose={false}
		      width={520}
		    >
		      {selectedIsNovelAi ? (
		        <div
		          data-workflow-no-pan
		          data-workflow-no-zoom
		          data-workflow-no-keybind
		          onMouseDown={stopWorkflowControlEvent}
		          onPointerDown={stopWorkflowControlEvent}
		          onWheel={stopWorkflowControlEvent}
		        >
		          <NovelAiParameterPanel
		            mode="overrides"
		            compact
		            value={metadata.novelAiOverrides}
		            defaultConfig={selectedProfile.novelAiConfig || config.novelAiConfig}
		            onChange={(novelAiOverrides) =>
		              updateSettings({ novelAiOverrides: stripEmptyNovelAiOverrides(novelAiOverrides) })
		            }
		          />
		        </div>
		      ) : null}
		    </Modal>
		    </>
		  );
		}

function WorkflowProfileOption({
  option,
}: {
  option: { label: string; value: string; model: string };
}) {
  const primary = option.model || option.label;
  const secondary = option.model && option.label !== option.model ? option.label : '';
  return (
    <span className="workflow-profile-option">
      <span className="workflow-profile-option-main">{primary}</span>
      {secondary ? <span className="workflow-profile-option-sub">{secondary}</span> : null}
    </span>
  );
}

function WorkflowSettingGroup({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="workflow-setting-section">
      <Text type="secondary">{title}</Text>
      <div className="workflow-setting-grid">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`workflow-setting-pill${value === option.value ? ' is-active' : ''}`}
            onMouseDown={stopWorkflowControlEvent}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ImageContent({
  node,
  status,
  showImageInfo,
  uploading,
  uploadProgress,
  onUpload,
  onRetry,
  onPreview,
}: {
  node: WorkflowNodeData;
  status: WorkflowNodeStatus;
  showImageInfo: boolean;
  uploading: boolean;
  uploadProgress?: UploadProgressValue;
  onUpload: (nodeId?: string) => void;
  onRetry: (node: WorkflowNodeData) => void;
  onPreview: (nodeId: string) => void;
}) {
  const hasContent = Boolean(node.metadata?.content);

  if (status === 'loading' && !hasContent) {
    return (
      <div className="workflow-image-state">
        <Spin />
        <Text type="secondary">生成中</Text>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="workflow-image-state">
        <Text type="danger">{node.metadata?.errorDetails || '生成失败'}</Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => onRetry(node)}>
          重试
        </Button>
      </div>
    );
	  }
	  if (node.metadata?.content) {
	    const infoItems = [
	      node.metadata.naturalWidth && node.metadata.naturalHeight
	        ? `${node.metadata.naturalWidth} x ${node.metadata.naturalHeight}`
	        : '',
	      node.metadata.bytes ? formatBytes(node.metadata.bytes) : '',
	      node.metadata.model || node.metadata.generationType || '',
	    ].filter(Boolean);
	    return (
	      <div className="workflow-image-wrap">
	        <img src={node.metadata.content} alt={node.title} draggable={false} />
	        {uploading ? <UploadProgressOverlay percent={uploadProgress} /> : null}
	        {showImageInfo && infoItems.length > 0 ? (
	          <div className="workflow-image-info">
	            {infoItems.map((item) => (
	              <span key={item}>{item}</span>
	            ))}
	          </div>
	        ) : null}
	        {!uploading ? (
		          <div className="workflow-image-actions" onMouseDown={(event) => event.stopPropagation()}>
		            <Tooltip title="预览">
		              <Button shape="circle" icon={<EyeOutlined />} onClick={() => onPreview(node.id)} />
		            </Tooltip>
		            <Tooltip title="替换图片">
		              <Button shape="circle" icon={<UploadOutlined />} onClick={() => onUpload(node.id)} />
		            </Tooltip>
		          </div>
		        ) : null}
	      </div>
	    );
	  }
	  return (
	    <div className={`workflow-image-state${uploading ? ' is-uploading' : ''}`}>
	      <PictureFilled style={{ fontSize: 30, color: '#FF9EB5' }} />
	      <Text type="secondary">上传图片或连接配置节点生成</Text>
	      {uploading ? <UploadProgressOverlay percent={uploadProgress} /> : null}
	      <Button size="small" icon={<UploadOutlined />} disabled={uploading} onClick={() => onUpload(node.id)}>
	        上传图片
	      </Button>
	    </div>
	  );
	}

function SaveImageNodePanel({
  node,
  images,
  onSave,
}: {
  node: WorkflowNodeData;
  images: WorkflowNodeData[];
  onSave: (nodeId: string) => void;
}) {
  const status = node.metadata?.status || 'idle';
  const saving = status === NODE_STATUS_LOADING;
  const lastSavedAt = node.metadata?.lastSavedAt
    ? new Date(node.metadata.lastSavedAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  return (
    <div className="workflow-save-panel">
      <div className="workflow-save-summary">
        <span>输入图片</span>
        <strong>{images.length} 张</strong>
      </div>
      {lastSavedAt ? (
        <Text type="secondary">
          最近保存 {node.metadata?.savedCount || 0} 张 · {lastSavedAt}
        </Text>
      ) : (
        <Text type="secondary">连接图片节点后可下载</Text>
      )}
      {status === NODE_STATUS_ERROR ? (
        <Text type="danger">{node.metadata?.errorDetails || '保存失败'}</Text>
      ) : null}
      <Button
        type="primary"
        block
        icon={<DownloadOutlined />}
        loading={saving}
        disabled={images.length === 0}
        onMouseDown={stopWorkflowControlEvent}
        onClick={() => onSave(node.id)}
      >
        保存图像
      </Button>
    </div>
  );
}

function ConnectionPath({
  connection,
  from,
  to,
  active,
  adding,
  onSelect,
  onContextMenu,
  onInsert,
}: {
  connection: WorkflowConnection;
  from: WorkflowNodeData;
  to: WorkflowNodeData;
  active: boolean;
  adding: boolean;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent<SVGPathElement>) => void;
  onInsert: (event: React.MouseEvent<SVGGElement>, position: WorkflowPosition) => void;
}) {
  const start = getNodeOutputAnchor(from);
  const end = getNodeInputAnchor(to);
  const startX = start.x;
  const startY = start.y;
  const endX = end.x;
  const endY = end.y;
  const dx = Math.abs(endX - startX);
  const curve = Math.max(dx * 0.5, 64);
  const pathD = `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
  const midpoint = getBezierMidpoint(start, end, curve);
  return (
    <g>
      <path
        data-connection-id={connection.id}
        d={pathD}
        stroke="transparent"
        strokeWidth={18}
        fill="none"
	        onMouseDown={(event) => {
	          event.stopPropagation();
	          onSelect();
	        }}
	        onContextMenu={onContextMenu}
	      />
      <path d={pathD} stroke={active ? '#FF7090' : '#FFC2D1'} strokeWidth={active ? 4 : 2.5} fill="none" />
	      <circle cx={startX} cy={startY} r={active ? 5 : 4} fill={active ? '#FF7090' : '#FFC2D1'} />
	      <circle cx={endX} cy={endY} r={active ? 5 : 4} fill={active ? '#FF7090' : '#FFC2D1'} />
	      <g
	        className={`workflow-connection-midpoint${adding ? ' is-adding' : ''}`}
	        transform={`translate(${midpoint.x} ${midpoint.y})`}
	        onMouseDown={(event) => onInsert(event, midpoint)}
	      >
	        <circle className="workflow-connection-midpoint-hit" r={14} />
	        <circle className="workflow-connection-midpoint-dot" r={adding ? 10 : 4} />
	        {adding ? <path d="M -4 0 H 4 M 0 -4 V 4" /> : null}
	      </g>
    </g>
  );
}

function ActiveConnectionPath({
  node,
  handle,
  mouseWorld,
}: {
  node?: WorkflowNodeData;
  handle: ConnectingState;
  mouseWorld: WorkflowPosition;
}) {
	if (!node) return null;
  const output = getNodeOutputAnchor(node);
  const input = getNodeInputAnchor(node);
  const startX = handle.handleType === 'source' ? output.x : mouseWorld.x;
  const startY = handle.handleType === 'source' ? output.y : mouseWorld.y;
  const endX = handle.handleType === 'source' ? mouseWorld.x : input.x;
  const endY = handle.handleType === 'source' ? mouseWorld.y : input.y;
  const dx = Math.abs(endX - startX);
  const pathD = `M ${startX} ${startY} C ${startX + dx * 0.5} ${startY}, ${endX - dx * 0.5} ${endY}, ${endX} ${endY}`;
  return <path d={pathD} stroke="#FF7090" strokeWidth={2.5} strokeDasharray="6 6" fill="none" />;
}

function SelectionBox({ selection }: { selection: SelectionState }) {
  const left = Math.min(selection.start.x, selection.current.x);
  const top = Math.min(selection.start.y, selection.current.y);
  const width = Math.abs(selection.current.x - selection.start.x);
  const height = Math.abs(selection.current.y - selection.start.y);
  return <div className="workflow-selection" style={{ left, top, width, height }} />;
}

function WorkflowContextMenuView({
  menu,
  onClose,
  onDuplicate,
  onDelete,
}: {
  menu: WorkflowContextMenu;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);

  return (
    <div
      className="workflow-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      data-workflow-no-pan
      data-workflow-no-zoom
    >
      {menu.type === 'node' ? (
        <button type="button" onClick={onDuplicate}>
          <CopyOutlined />
          <span>复制节点</span>
        </button>
      ) : null}
      <button type="button" className="danger" onClick={onDelete}>
        <DeleteFilled />
        <span>{menu.type === 'node' ? '删除节点' : '删除连线'}</span>
      </button>
    </div>
  );
}

function CanvasGrid({ viewport, mode }: { viewport: WorkflowViewport; mode: WorkflowBackgroundMode }) {
  if (mode === 'blank') return null;

  const gridSize = 48 * viewport.k;
  const x = viewport.x % gridSize;
  const y = viewport.y % gridSize;
  const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
  const backgroundImage = mode === 'dots'
    ? `radial-gradient(circle, rgba(255, 112, 144, 0.55) ${dotSize}px, transparent ${dotSize + 0.2}px)`
    : 'linear-gradient(rgba(255, 112, 144, 0.34) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 112, 144, 0.34) 1px, transparent 1px)';

  return (
    <div
      className="workflow-grid"
      style={{
        backgroundImage,
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${x}px ${y}px`,
      }}
    />
  );
}

function WorkflowToolbar({
  selectedCount,
  canUndo,
  canRedo,
  backgroundMode,
  showImageInfo,
  onAddText,
  onAddImage,
  onAddConfig,
  onAddSave,
  onUpload,
  onUndo,
  onRedo,
  onDelete,
  onClear,
  onBackgroundModeChange,
  onShowImageInfoChange,
}: {
  selectedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  backgroundMode: WorkflowBackgroundMode;
  showImageInfo: boolean;
  onAddText: () => void;
  onAddImage: () => void;
  onAddConfig: () => void;
  onAddSave: () => void;
  onUpload: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onClear: () => void;
  onBackgroundModeChange: (mode: WorkflowBackgroundMode) => void;
  onShowImageInfoChange: (show: boolean) => void;
}) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [appearancePanelX, setAppearancePanelX] = useState<number | null>(null);
  const toolbarShellRef = useRef<HTMLDivElement | null>(null);
  const backgroundOptions: Array<{ label: string; value: WorkflowBackgroundMode }> = [
    { label: '点', value: 'dots' },
    { label: '线', value: 'lines' },
    { label: '空白', value: 'blank' },
  ];

  return (
    <div ref={toolbarShellRef} className="workflow-toolbar-shell" data-workflow-no-pan data-workflow-no-zoom>
      <div className="workflow-toolbar" data-workflow-no-pan data-workflow-no-zoom>
        <ToolbarButton title="撤销" icon={<UndoOutlined />} disabled={!canUndo} onClick={onUndo} />
        <ToolbarButton title="重做" icon={<RedoOutlined />} disabled={!canRedo} onClick={onRedo} />
        <span className="workflow-toolbar-divider" />
        <ToolbarButton title="文本" icon={<FileTextFilled />} onClick={onAddText} />
        <ToolbarButton title="图片" icon={<PictureFilled />} onClick={onAddImage} />
        <ToolbarButton title="生成配置" icon={<SettingFilled />} onClick={onAddConfig} />
        <ToolbarButton title="保存图像" icon={<DownloadOutlined />} onClick={onAddSave} />
        <ToolbarButton title="上传图片" icon={<UploadOutlined />} onClick={onUpload} />
        <span className="workflow-toolbar-divider" />
        <Tooltip title="画布外观">
          <Button
            shape="circle"
            icon={<BgColorsOutlined />}
            className={appearanceOpen || backgroundMode !== 'dots' || showImageInfo ? 'workflow-tool-active' : ''}
            onClick={(event) => {
              const shellRect = toolbarShellRef.current?.getBoundingClientRect();
              const buttonRect = event.currentTarget.getBoundingClientRect();
              if (shellRect) setAppearancePanelX(buttonRect.left + buttonRect.width / 2 - shellRect.left);
              setAppearanceOpen((open) => !open);
            }}
          />
        </Tooltip>
        {selectedCount > 0 ? <ToolbarButton title="删除选中" icon={<DeleteFilled />} onClick={onDelete} danger /> : null}
        <ToolbarButton title="清空画布" icon={<DeleteFilled />} onClick={onClear} danger />
      </div>
      {appearanceOpen ? (
        <div
          className="workflow-appearance-panel"
          style={{ left: appearancePanelX ?? '50%' }}
          data-workflow-no-pan
          data-workflow-no-zoom
          data-workflow-no-keybind
        >
          <Text strong>画布外观</Text>
          <div className="workflow-background-options" role="group" aria-label="画布背景">
            {backgroundOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`workflow-background-option${backgroundMode === option.value ? ' is-active' : ''}`}
                onClick={() => onBackgroundModeChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="workflow-appearance-row">
            <Text type="secondary">图片信息</Text>
            <Switch size="small" checked={showImageInfo} onChange={onShowImageInfoChange} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolbarButton({
  title,
  icon,
  disabled,
  danger,
  onClick,
}: {
  title: string;
  icon: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={title}>
      <Button shape="circle" icon={icon} disabled={disabled} danger={danger} onClick={onClick} />
    </Tooltip>
  );
}
