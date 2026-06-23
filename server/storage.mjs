import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  backendCollectionPath,
  backendStatePath,
  backendTasksDir,
  backendWorkflowsDir,
  coerceApiFormat,
  DEFAULT_BACKEND_CONFIG,
  DEFAULT_CONCURRENCY,
  DEFAULT_GLOBAL_STATS,
  DEFAULT_TASK_STATS,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  pickFormatConfig,
} from './config.mjs'
import { broadcastSseEvent } from './sse.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readJsonFile = async (filePath, fallback) => {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    if (err && err.name === 'SyntaxError') {
      console.warn(`Invalid JSON file, fallback to defaults: ${filePath}`, err)
      return fallback
    }
    throw err
  }
}

const writeJsonFileAtomic = async (filePath, data) => {
  const dir = path.dirname(filePath)
  const baseName = path.basename(filePath)
  const payload = JSON.stringify(data, null, 2)
  await fs.promises.mkdir(dir, { recursive: true })

  let tempPath = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = crypto.randomUUID()
    tempPath = path.join(
      dir,
      `.${baseName}.${process.pid}.${Date.now()}.${nonce}.tmp`,
    )
    try {
      await fs.promises.writeFile(tempPath, payload, { encoding: 'utf-8', flag: 'wx' })
      break
    } catch (err) {
      if (err && err.code === 'EEXIST' && attempt < 2) continue
      throw err
    }
  }

  try {
    await fs.promises.rename(tempPath, filePath)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await fs.promises.mkdir(dir, { recursive: true })
      try {
        await fs.promises.rename(tempPath, filePath)
        return
      } catch (retryErr) {
        if (!retryErr || retryErr.code !== 'ENOENT') {
          throw retryErr
        }
      }
      await fs.promises.writeFile(filePath, payload, { encoding: 'utf-8' })
      return
    }
    if (err && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(30 * (attempt + 1))
        try {
          await fs.promises.rename(tempPath, filePath)
          return
        } catch (retryErr) {
          if (!retryErr || !['EPERM', 'EACCES', 'EBUSY'].includes(retryErr.code)) {
            throw retryErr
          }
        }
      }
      await fs.promises.writeFile(filePath, payload, { encoding: 'utf-8' })
      return
    }
    throw err
  } finally {
    if (tempPath) {
      await fs.promises.unlink(tempPath).catch(() => undefined)
    }
  }
}

const coerceString = (value) => (typeof value === 'string' ? value : '')
const coerceFiniteNumber = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const MAX_TASK_NAME_LENGTH = 40
export const normalizeTaskName = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed.slice(0, MAX_TASK_NAME_LENGTH) : undefined
}

const WORKFLOW_NODE_TYPES = new Set(['text', 'image', 'config'])
const WORKFLOW_STATUSES = new Set(['idle', 'loading', 'success', 'error'])
const WORKFLOW_BACKGROUNDS = new Set(['dots', 'lines', 'blank'])

const normalizeNovelAiOverrides = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const next = {}
  Object.entries(value).forEach(([key, rawValue]) => {
    if (rawValue === undefined || rawValue === null) return
    if (typeof rawValue === 'string' && rawValue.trim() === '') return
    if (key === 'seed' && !Number.isFinite(Number(rawValue))) return
    if (typeof rawValue === 'number' && !Number.isFinite(rawValue)) return
    next[key] = rawValue
  })
  return Object.keys(next).length > 0 ? next : undefined
}

const normalizeWorkflowMetadata = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value
  const metadata = {}
  ;[
    'content',
    'composerContent',
    'prompt',
    'errorDetails',
    'apiProfileId',
    'model',
    'size',
    'aspectRatio',
    'quality',
    'generationType',
    'localKey',
    'sourceUrl',
    'mimeType',
    'uploadName',
  ].forEach((key) => {
    if (typeof raw[key] === 'string') metadata[key] = raw[key]
  })
  if (WORKFLOW_STATUSES.has(raw.status)) metadata.status = raw.status
	if (typeof raw.count === 'number' && Number.isFinite(raw.count)) {
	  metadata.count = Math.max(1, Math.min(16, Math.floor(raw.count)))
	}
	if (typeof raw.settingsVersion === 'number' && Number.isFinite(raw.settingsVersion)) {
	  metadata.settingsVersion = Math.max(1, Math.floor(raw.settingsVersion))
	}
	if (typeof raw.settingsTouched === 'boolean') {
	  metadata.settingsTouched = raw.settingsTouched
	}
	;['naturalWidth', 'naturalHeight', 'bytes'].forEach((key) => {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) metadata[key] = raw[key]
  })
	  if (Array.isArray(raw.references)) {
	    metadata.references = raw.references.filter((item) => typeof item === 'string')
	  }
  const novelAiOverrides = normalizeNovelAiOverrides(raw.novelAiOverrides)
  if (novelAiOverrides) metadata.novelAiOverrides = novelAiOverrides
	  return metadata
	}

export const normalizeWorkflowState = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes
        .map((node) => {
          if (!node || typeof node !== 'object') return null
          const id = coerceString(node.id)
          const type = coerceString(node.type)
          if (!id || !WORKFLOW_NODE_TYPES.has(type)) return null
          const position = node.position && typeof node.position === 'object' ? node.position : {}
          return {
            id,
            type,
            title: coerceString(node.title) || (type === 'config' ? '生成配置' : type === 'text' ? '提示词' : '图片'),
            position: {
              x: coerceFiniteNumber(position.x, 0),
              y: coerceFiniteNumber(position.y, 0),
            },
            width: Math.max(160, coerceFiniteNumber(node.width, type === 'config' ? 340 : 320)),
            height: Math.max(120, coerceFiniteNumber(node.height, type === 'text' ? 220 : 240)),
            metadata: normalizeWorkflowMetadata(node.metadata),
          }
        })
        .filter(Boolean)
    : []
  const nodeIds = new Set(nodes.map((node) => node.id))
  const connections = Array.isArray(raw.connections)
    ? raw.connections
        .map((connection) => {
          if (!connection || typeof connection !== 'object') return null
          const id = coerceString(connection.id)
          const fromNodeId = coerceString(connection.fromNodeId)
          const toNodeId = coerceString(connection.toNodeId)
          if (!id || !nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) return null
          return { id, fromNodeId, toNodeId }
        })
        .filter(Boolean)
    : []
  const viewport = raw.viewport && typeof raw.viewport === 'object' ? raw.viewport : {}
  return {
    nodes,
    connections,
    viewport: {
      x: coerceFiniteNumber(viewport.x, 0),
      y: coerceFiniteNumber(viewport.y, 0),
      k: Math.min(5, Math.max(0.05, coerceFiniteNumber(viewport.k, 1))),
    },
    backgroundMode: WORKFLOW_BACKGROUNDS.has(raw.backgroundMode) ? raw.backgroundMode : 'dots',
    showImageInfo: typeof raw.showImageInfo === 'boolean' ? raw.showImageInfo : false,
    primaryConfigNodeId: typeof raw.primaryConfigNodeId === 'string' ? raw.primaryConfigNodeId : undefined,
  }
}

const workflowProjectPath = (id) => path.join(backendWorkflowsDir, `${id}.json`)

const sanitizeWorkflowProject = (value, fallback = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const now = new Date().toISOString()
  const id = coerceString(value.id) || fallback.id || crypto.randomUUID()
  const title = coerceString(value.title) || fallback.title || '未命名画布'
  const createdAt = coerceString(value.createdAt) || fallback.createdAt || now
  const updatedAt = coerceString(value.updatedAt) || fallback.updatedAt || now
  const state = normalizeWorkflowState(value.state) || normalizeWorkflowState(fallback.state) || {
    nodes: [],
    connections: [],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: 'dots',
    showImageInfo: false,
  }
  const linkedTaskId = coerceString(value.linkedTaskId)
  return {
    id,
    title,
    ...(linkedTaskId ? { linkedTaskId } : {}),
    createdAt,
    updatedAt,
    state,
  }
}

const stripBackendTokenFromUrl = (value = '') => {
  if (!value.includes('/api/backend/image/')) return value
  return value.replace(/[?&]token=[^&]+/g, '').replace(/[?&]$/, '')
}

const sanitizeCollectionItem = (value) => {
  if (!value || typeof value !== 'object') return null
  const raw = value
  const id = coerceString(raw.id)
  if (!id) return null
  const prompt = coerceString(raw.prompt)
  const taskId = coerceString(raw.taskId)
  const timestamp =
    typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
      ? raw.timestamp
      : Date.now()
  const image =
    typeof raw.image === 'string' ? stripBackendTokenFromUrl(raw.image) : undefined
  const localKey = typeof raw.localKey === 'string' ? raw.localKey : undefined
  const sourceSignature =
    typeof raw.sourceSignature === 'string' ? raw.sourceSignature : undefined
  const item = { id, prompt, taskId, timestamp }
  if (image) item.image = image
  if (localKey) item.localKey = localKey
  if (sourceSignature) item.sourceSignature = sourceSignature
  return item
}

const normalizeCollectionPayload = (payload) => {
  if (!Array.isArray(payload)) return []
  const items = []
  const seen = new Set()
  payload.forEach((entry) => {
    const item = sanitizeCollectionItem(entry)
    if (!item) return
    if (seen.has(item.id)) return
    seen.add(item.id)
    items.push(item)
  })
  return items
}

export const clampNumber = (value, min, max, fallback) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export const normalizeConcurrency = (value, fallback = DEFAULT_CONCURRENCY) =>
  clampNumber(value, MIN_CONCURRENCY, MAX_CONCURRENCY, fallback)

export const DEFAULT_TASK_RETRY_INTERVAL = 1000
export const DEFAULT_TASK_RETRY_LIMIT = -1

export const normalizeRetryInterval = (
  value,
  fallback = DEFAULT_TASK_RETRY_INTERVAL,
) => {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(0, value)
}

export const normalizeRetryLimit = (
  value,
  fallback = DEFAULT_TASK_RETRY_LIMIT,
) => {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback
  }
  return Math.floor(Math.max(DEFAULT_TASK_RETRY_LIMIT, value))
}

export const createDefaultTaskState = () => ({
  version: 1,
  prompt: '',
  concurrency: DEFAULT_CONCURRENCY,
  enableSound: true,
  retryInterval: DEFAULT_TASK_RETRY_INTERVAL,
	  retryLimit: DEFAULT_TASK_RETRY_LIMIT,
	  novelAiOverrides: {},
	  results: [],
  uploads: [],
  stats: { ...DEFAULT_TASK_STATS },
})

const normalizeBackendState = (data) => {
  const config = { ...DEFAULT_BACKEND_CONFIG, ...(data?.config || {}) }
  const rawFormatMap = data?.configByFormat
  const configByFormat =
    rawFormatMap && typeof rawFormatMap === 'object' && !Array.isArray(rawFormatMap)
      ? { ...rawFormatMap }
      : {}
  const rawApiFormat = config.apiFormat
  const apiFormat = coerceApiFormat(rawApiFormat)
  config.apiFormat = apiFormat
  if (rawApiFormat === 'vertex-express') config.vertexAuthMode = 'apiKey'
  if (!configByFormat[apiFormat] && rawApiFormat === 'vertex-express' && configByFormat['vertex-express']) {
    configByFormat[apiFormat] = { ...configByFormat['vertex-express'], vertexAuthMode: 'apiKey' }
  }
  if (!configByFormat[apiFormat]) {
    configByFormat[apiFormat] = pickFormatConfig(config)
  }
  return {
    config,
    configByFormat,
    tasksOrder: Array.isArray(data?.tasksOrder) ? data.tasksOrder : [],
    globalStats: { ...DEFAULT_GLOBAL_STATS, ...(data?.globalStats || {}) },
  }
}

export const buildBackendStateSnapshot = (state, hasSavedState = true) => ({
  ...state,
  meta: { hasSavedState },
})

export const loadBackendState = async () => {
  const data = await readJsonFile(backendStatePath, null)
  return normalizeBackendState(data)
}

export const loadBackendStateSnapshot = async () => {
  const hasSavedState = fs.existsSync(backendStatePath)
  const data = await readJsonFile(backendStatePath, null)
  return buildBackendStateSnapshot(normalizeBackendState(data), hasSavedState)
}

export const saveBackendState = async (state) => {
  await writeJsonFileAtomic(backendStatePath, state)
  broadcastSseEvent('state', buildBackendStateSnapshot(state))
}

export const loadBackendCollection = async () => {
  const data = await readJsonFile(backendCollectionPath, [])
  return normalizeCollectionPayload(data)
}

export const saveBackendCollection = async (items) => {
  await writeJsonFileAtomic(backendCollectionPath, items)
  broadcastSseEvent('collection', items)
}

const getTaskFilePath = (taskId) => path.join(backendTasksDir, `${taskId}.json`)

export const loadTaskState = async (taskId) => {
  const data = await readJsonFile(getTaskFilePath(taskId), null)
  if (!data) return null
  return {
    ...createDefaultTaskState(),
    ...data,
    name: normalizeTaskName(data?.name),
    concurrency: normalizeConcurrency(data?.concurrency),
    retryInterval: normalizeRetryInterval(data?.retryInterval),
    retryLimit: normalizeRetryLimit(data?.retryLimit),
    stats: { ...DEFAULT_TASK_STATS, ...(data?.stats || {}) },
    results: Array.isArray(data?.results) ? data.results : [],
    uploads: Array.isArray(data?.uploads) ? data.uploads : [],
    workflow: normalizeWorkflowState(data?.workflow),
  }
}

export const saveTaskState = async (taskId, state) => {
  await writeJsonFileAtomic(getTaskFilePath(taskId), state)
  broadcastSseEvent('task', { taskId, state })
}

export const listWorkflowProjects = async () => {
  await fs.promises.mkdir(backendWorkflowsDir, { recursive: true })
  const entries = await fs.promises.readdir(backendWorkflowsDir, { withFileTypes: true })
  const projects = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const data = await readJsonFile(path.join(backendWorkflowsDir, entry.name), null)
    const project = sanitizeWorkflowProject(data, { id: entry.name.replace(/\.json$/i, '') })
    if (project) projects.push(project)
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export const loadWorkflowProject = async (id) => {
  const data = await readJsonFile(workflowProjectPath(id), null)
  return sanitizeWorkflowProject(data, { id })
}

export const saveWorkflowProject = async (id, project) => {
  const current = await loadWorkflowProject(id)
  const next = sanitizeWorkflowProject(
    {
      ...(current || {}),
      ...project,
      id,
      updatedAt: new Date().toISOString(),
    },
    { id },
  )
  await writeJsonFileAtomic(workflowProjectPath(id), next)
  broadcastSseEvent('workflow', { projectId: id, project: next })
  return next
}

export const deleteWorkflowProject = async (id) => {
  await fs.promises.unlink(workflowProjectPath(id)).catch((err) => {
    if (!err || err.code === 'ENOENT') return
    throw err
  })
  broadcastSseEvent('workflow', { projectId: id, deleted: true })
}

export const normalizeCollectionPayloadForSave = normalizeCollectionPayload
