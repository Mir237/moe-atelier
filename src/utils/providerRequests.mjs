import JSZip from 'jszip';

export const API_FORMATS = [
  'openai',
  'gemini',
  'vertex',
  'vertex-express',
  'novelai',
];

export const GOOGLE_API_FORMATS = ['gemini', 'vertex', 'vertex-express'];

export const API_VERSION_OPTIONS = ['v1', 'v1beta', 'v1beta1'];

export const DEFAULT_API_BASES = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  vertex: 'https://aiplatform.googleapis.com',
  'vertex-express': 'https://aiplatform.googleapis.com',
  novelai: 'https://image.novelai.net',
};

const VERSION_REGEX = /^v1(?:beta1|beta)?$/i;
const API_MARKER_SEGMENTS = new Set(['projects', 'locations', 'publishers', 'models']);
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

export const isSupportedApiFormat = (value) => API_FORMATS.includes(value);

export const coerceApiFormat = (value) =>
  isSupportedApiFormat(value) ? value : 'openai';

export const isGoogleApiFormat = (value) => GOOGLE_API_FORMATS.includes(value);

export const isVersionSegment = (value) => VERSION_REGEX.test(String(value || ''));

const ensureProtocol = (value) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

const trimUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const withoutActionSuffix = (value) =>
  String(value || '').replace(/:(?:streamGenerateContent|generateContent)$/i, '');

export const resolveApiUrl = (apiUrl, apiFormat) => {
  const trimmed = trimUrl(apiUrl);
  return trimmed || DEFAULT_API_BASES[coerceApiFormat(apiFormat)];
};

export const normalizeApiBase = (apiUrl = '') => {
  const cleaned = withoutActionSuffix(trimUrl(apiUrl));
  if (!cleaned) return { origin: '', segments: [], host: '' };
  try {
    const url = new URL(ensureProtocol(cleaned));
    return {
      origin: `${url.protocol}//${url.host}`,
      segments: url.pathname.split('/').filter(Boolean),
      host: url.host.toLowerCase(),
    };
  } catch {
    return { origin: cleaned, segments: [], host: '' };
  }
};

export const inferApiVersionFromUrl = (apiUrl = '') => {
  const cleaned = trimUrl(apiUrl);
  if (!cleaned) return null;
  try {
    const url = new URL(ensureProtocol(cleaned));
    const segments = url.pathname.split('/').filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (isVersionSegment(segments[index])) return segments[index];
    }
    return null;
  } catch {
    const segments = cleaned.split('/').filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (isVersionSegment(segments[index])) return segments[index];
    }
    return null;
  }
};

export const resolveApiVersion = (apiUrl, apiVersion, fallback) => {
  const inferred = inferApiVersionFromUrl(apiUrl);
  if (inferred) return inferred;
  const trimmed = String(apiVersion || '').trim();
  return trimmed || fallback;
};

export const extractVertexProjectId = (apiUrl = '') => {
  const { segments } = normalizeApiBase(apiUrl);
  const index = segments.indexOf('projects');
  if (index < 0) return null;
  const candidate = segments[index + 1];
  if (!candidate) return null;
  if (API_MARKER_SEGMENTS.has(candidate)) return null;
  if (isVersionSegment(candidate)) return null;
  return candidate;
};

export const getApiVersionFallback = (apiFormat) => {
  switch (apiFormat) {
    case 'gemini':
      return 'v1beta';
    case 'vertex':
      return 'v1beta1';
    case 'vertex-express':
      return 'v1';
    case 'openai':
      return 'v1';
    default:
      return '';
  }
};

const addBearerPrefix = (apiKey = '') => {
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) return '';
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
};

const insertVersionIfMissing = (segments, version) => {
  if (!version || segments.some(isVersionSegment)) return;
  const markerIndex = segments.findIndex((segment) => API_MARKER_SEGMENTS.has(segment));
  if (markerIndex >= 0) {
    segments.splice(markerIndex, 0, version);
  } else {
    segments.push(version);
  }
};

const ensureMarkerValue = (segments, marker, value) => {
  const index = segments.indexOf(marker);
  if (index === -1) {
    if (!value) return false;
    segments.push(marker, value);
    return true;
  }
  const next = segments[index + 1];
  if (!next || API_MARKER_SEGMENTS.has(next) || isVersionSegment(next)) {
    if (!value) return false;
    segments.splice(index + 1, 0, value);
    return true;
  }
  return true;
};

const applyModelPath = (segments, modelValue) => {
  const modelSegments = modelValue.split('/').filter(Boolean);
  const geminiModelIsPath = modelSegments[0] === 'models';
  const modelIndex = segments.indexOf('models');
  if (geminiModelIsPath) {
    if (modelIndex >= 0) {
      segments.splice(modelIndex + 1);
      segments.push(...modelSegments.slice(1));
    } else {
      segments.push(...modelSegments);
    }
    return;
  }
  if (modelIndex >= 0) {
    segments.splice(modelIndex + 1);
    segments.push(modelValue);
  } else {
    segments.push('models', modelValue);
  }
};

const replaceWithFullModelPath = (segments, version, modelSegments) => {
  segments.splice(0);
  if (version) segments.push(version);
  segments.push(...modelSegments);
};

export const buildGoogleGenerateRequest = (config = {}, options = {}) => {
  const apiFormat = coerceApiFormat(config.apiFormat);
  if (!isGoogleApiFormat(apiFormat)) {
    throw new Error(`Unsupported Google API format: ${apiFormat}`);
  }

  const apiUrl = resolveApiUrl(config.apiUrl, apiFormat);
  const baseInfo = normalizeApiBase(apiUrl);
  const baseOrigin = baseInfo.origin || trimUrl(apiUrl);
  const version = resolveApiVersion(
    apiUrl,
    config.apiVersion,
    getApiVersionFallback(apiFormat),
  );
  const segments = [...baseInfo.segments];
  insertVersionIfMissing(segments, version);

  const modelValue = String(config.model || '').trim();
  if (!modelValue) throw new Error('Model is required');

  const modelSegments = modelValue.split('/').filter(Boolean);
  const modelHasProjectPath = modelSegments.includes('projects');
  const publisher = String(config.vertexPublisher || '').trim() || 'google';

  if (apiFormat === 'gemini') {
    applyModelPath(segments, modelValue);
  } else if (apiFormat === 'vertex-express') {
    ensureMarkerValue(segments, 'publishers', publisher);
    applyModelPath(segments, modelValue.replace(/^models\//, ''));
  } else {
    const projectId =
      String(config.vertexProjectId || '').trim() ||
      extractVertexProjectId(apiUrl) ||
      '';
    const location = String(config.vertexLocation || '').trim() || 'us-central1';
    if (modelHasProjectPath) {
      replaceWithFullModelPath(segments, version, modelSegments);
    } else {
      if (!projectId && !segments.includes('projects')) {
        throw new Error('Vertex project ID is required');
      }
      ensureMarkerValue(segments, 'projects', projectId);
      ensureMarkerValue(segments, 'locations', location);
      ensureMarkerValue(segments, 'publishers', publisher);
      applyModelPath(segments, modelValue.replace(/^models\//, ''));
    }
  }

  const suffix = options.stream ? ':streamGenerateContent' : ':generateContent';
  let url = `${baseOrigin}${segments.length ? `/${segments.join('/')}` : ''}${suffix}`;
  const headers = { 'Content-Type': 'application/json' };
  const isOfficialGemini =
    apiFormat === 'gemini' && baseInfo.host === 'generativelanguage.googleapis.com';
  const isOfficialVertexExpress =
    apiFormat === 'vertex-express' && baseInfo.host === 'aiplatform.googleapis.com';

  if (isOfficialGemini || isOfficialVertexExpress) {
    url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(config.apiKey || '')}`;
  } else {
    headers.Authorization = addBearerPrefix(config.apiKey);
  }

  return { url, headers };
};

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

export const buildGeminiGenerationConfig = (config = {}) => {
  const generationConfig = {};
  if (config.includeImageConfig) {
    const imageSize = config.imageConfig?.imageSize || '2K';
    const aspectRatio = config.imageConfig?.aspectRatio || 'auto';
    const imageConfig = { imageSize };
    if (aspectRatio && aspectRatio !== 'auto') {
      imageConfig.aspectRatio = aspectRatio;
    }
    generationConfig.imageConfig = imageConfig;
    if (config.useResponseModalities) {
      generationConfig.responseModalities = ['TEXT', 'IMAGE'];
    }
  }
  if (config.includeThoughts) {
    const budget = clampNumber(
      Math.round(typeof config.thinkingBudget === 'number' ? config.thinkingBudget : 128),
      0,
      8192,
    );
    generationConfig.thinkingConfig = {
      thinkingBudget: budget,
      includeThoughts: true,
    };
  }
  return Object.keys(generationConfig).length > 0 ? generationConfig : null;
};

export const buildGeminiSafetySettings = (config = {}) => {
  if (!config.includeSafetySettings || !config.safety) return null;
  const entries = Object.entries(config.safety).filter(
    ([, threshold]) => threshold && threshold !== 'OFF',
  );
  if (entries.length === 0) return null;
  return entries.map(([category, threshold]) => ({ category, threshold }));
};

const parseCustomJson = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const mergeGeminiCustomJson = (payload, config = {}) => {
  const custom = parseCustomJson(config.customJson);
  if (!custom) return payload;
  const mergedGenerationConfig = {
    ...(payload.generationConfig || {}),
    ...(custom.generationConfig || {}),
  };
  return {
    ...payload,
    ...custom,
    generationConfig:
      Object.keys(mergedGenerationConfig).length > 0 ? mergedGenerationConfig : undefined,
    safetySettings: custom.safetySettings ?? payload.safetySettings,
  };
};

export const buildGeminiPayload = (contents, config = {}) => {
  const payload = { contents };
  const generationConfig = buildGeminiGenerationConfig(config);
  if (generationConfig) payload.generationConfig = generationConfig;
  const safetySettings = buildGeminiSafetySettings(config);
  if (safetySettings) payload.safetySettings = safetySettings;
  return mergeGeminiCustomJson(payload, config);
};

export const buildOpenAiBaseUrl = (apiUrl, apiVersion) => {
  const baseInfo = normalizeApiBase(apiUrl);
  const basePath = baseInfo.origin
    ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
    : trimUrl(apiUrl);
  const version = resolveApiVersion(apiUrl, apiVersion, 'v1');
  return inferApiVersionFromUrl(apiUrl) ? basePath : `${basePath}/${version}`;
};

export const buildOpenAiChatUrl = (openAiBase) =>
  String(openAiBase || '').endsWith('/chat/completions')
    ? openAiBase
    : `${String(openAiBase || '').replace(/\/+$/, '')}/chat/completions`;

export const buildOpenAiImagesUrl = (openAiBase, hasReferenceImages) => {
  const normalized = String(openAiBase || '').replace(/\/+$/, '');
  if (/\/images(?:\/(?:generations|edits))?$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/images/${hasReferenceImages ? 'edits' : 'generations'}`;
};

const sizeLongEdge = (imageSize = '1K') => {
  switch (String(imageSize).toUpperCase()) {
    case '512':
      return 512;
    case '2K':
      return 1216;
    case '4K':
      return 1536;
    case '1K':
    default:
      return 1024;
  }
};

const parseAspectRatio = (value = '1:1') => {
  if (!value || value === 'auto') return [1, 1];
  const match = String(value).match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return [1, 1];
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return [1, 1];
  }
  return [width, height];
};

const roundToMultiple = (value, step) => Math.max(step, Math.round(value / step) * step);

export const getNovelAiDimensions = (imageConfig = {}) => {
  const longEdge = sizeLongEdge(imageConfig.imageSize);
  const [ratioWidth, ratioHeight] = parseAspectRatio(imageConfig.aspectRatio);
  const landscape = ratioWidth >= ratioHeight;
  const width = landscape ? longEdge : longEdge * (ratioWidth / ratioHeight);
  const height = landscape ? longEdge * (ratioHeight / ratioWidth) : longEdge;
  return {
    width: clampNumber(roundToMultiple(width, 64), 512, 1536),
    height: clampNumber(roundToMultiple(height, 64), 512, 1536),
  };
};

export const buildNovelAiRequest = (config = {}, options = {}) => {
  const apiUrl = resolveApiUrl(config.apiUrl, 'novelai');
  const base = trimUrl(apiUrl);
  const url = /\/ai\/generate-image$/i.test(base) ? base : `${base}/ai/generate-image`;
  const dimensions = getNovelAiDimensions(config.imageConfig);
  const custom = parseCustomJson(config.customJson) || {};
  const customParameters =
    custom.parameters && typeof custom.parameters === 'object' && !Array.isArray(custom.parameters)
      ? custom.parameters
      : {};
  const parameters = {
    params_version: 3,
    width: dimensions.width,
    height: dimensions.height,
    scale: 5,
    sampler: 'k_euler_ancestral',
    steps: 28,
    n_samples: 1,
    ucPreset: 0,
    qualityToggle: true,
    dynamic_thresholding: false,
    legacy: false,
    add_original_image: false,
    cfg_rescale: 0,
    noise_schedule: 'native',
    ...customParameters,
  };
  const basePayload = {
    input: String(options.prompt || '').trim(),
    model: String(config.model || '').trim(),
    action: 'generate',
    parameters,
  };
  const { parameters: _parameters, ...topLevelCustom } = custom;
  const payload = {
    ...basePayload,
    ...topLevelCustom,
    parameters: {
      ...parameters,
      ...(topLevelCustom.parameters || {}),
    },
  };
  return {
    url,
    headers: {
      Authorization: addBearerPrefix(config.apiKey),
      'Content-Type': 'application/json',
    },
    payload,
  };
};

const mimeFromFilename = (filename = '') => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
};

const isImageZipEntry = (entry) => {
  if (!entry || entry.dir) return false;
  const lower = entry.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

export const extractFirstImageFromNovelAiZip = async (arrayBuffer) => {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entry = Object.values(zip.files).find(isImageZipEntry);
  if (!entry) return null;
  const base64 = await entry.async('base64');
  return {
    dataUrl: `data:${mimeFromFilename(entry.name)};base64,${base64}`,
    filename: entry.name,
    mimeType: mimeFromFilename(entry.name),
  };
};
