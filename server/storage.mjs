import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  backendCollectionPath,
  backendStatePath,
  backendTasksDir,
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

export const createDefaultTaskState = () => ({
  version: 1,
  prompt: '',
  concurrency: DEFAULT_CONCURRENCY,
  enableSound: true,
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
  const apiFormat =
    config.apiFormat === 'gemini' || config.apiFormat === 'vertex'
      ? config.apiFormat
      : 'openai'
  config.apiFormat = apiFormat
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
}

const getTaskFilePath = (taskId) => path.join(backendTasksDir, `${taskId}.json`)

export const loadTaskState = async (taskId) => {
  const data = await readJsonFile(getTaskFilePath(taskId), null)
  if (!data) return null
  return {
    ...createDefaultTaskState(),
    ...data,
    concurrency: normalizeConcurrency(data?.concurrency),
    stats: { ...DEFAULT_TASK_STATS, ...(data?.stats || {}) },
    results: Array.isArray(data?.results) ? data.results : [],
    uploads: Array.isArray(data?.uploads) ? data.uploads : [],
  }
}

export const saveTaskState = async (taskId, state) => {
  await writeJsonFileAtomic(getTaskFilePath(taskId), state)
  broadcastSseEvent('task', { taskId, state })
}

export const normalizeCollectionPayloadForSave = normalizeCollectionPayload
