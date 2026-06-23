import type { AppConfig, ApiProfile } from '../types/app';
import type { WorkflowGenerationOptions, WorkflowReferenceImage } from '../types/workflow';
import {
  buildGeminiPayload,
  buildGoogleGenerateRequest,
  buildNovelAiRequest,
  buildOpenAiBaseUrl,
  buildOpenAiChatUrl,
  buildOpenAiImagesUrl,
  coerceApiFormat,
  extractFirstImageFromNovelAiZip,
  isGoogleApiFormat,
  resolveApiUrl,
} from './providerRequests.mjs';
import { parseMarkdownImage, resolveImageFromResponse } from './imageResponse';
import { formatResponseErrorMessage } from './httpError';

type WorkflowProfile = AppConfig | ApiProfile;

const normalizeBase64Payload = (value: string) => value.replace(/\s+/g, '');

const normalizeGenerationOptions = (options?: WorkflowGenerationOptions) => {
  const normalized: WorkflowGenerationOptions = {};
  const size = typeof options?.size === 'string' ? options.size.trim() : '';
  const aspectRatio = typeof options?.aspectRatio === 'string' ? options.aspectRatio.trim() : '';
  const quality = typeof options?.quality === 'string' ? options.quality.trim() : '';
  if (size && size !== 'auto') normalized.size = size;
  if (aspectRatio && aspectRatio !== 'auto') normalized.aspectRatio = aspectRatio;
  if (quality && quality !== 'auto') normalized.quality = quality;
  return normalized;
};

const withGenerationOptions = (profile: WorkflowProfile, options?: WorkflowGenerationOptions) => {
  if (typeof options === 'undefined') return profile;
  const normalized = normalizeGenerationOptions(options);
  if (Object.keys(normalized).length === 0) {
    return {
      ...profile,
      includeImageConfig: false,
      imageConfig: {
        ...(profile.imageConfig || {}),
        imageSize: 'auto',
        aspectRatio: 'auto',
      },
    };
  }
  return {
    ...profile,
    ...(normalized.quality ? { quality: normalized.quality } : {}),
    includeImageConfig: Boolean(normalized.size || normalized.aspectRatio),
    imageConfig: {
      ...(profile.imageConfig || {}),
      imageSize: normalized.size || 'auto',
      aspectRatio: normalized.aspectRatio || 'auto',
    },
  };
};

const applyOpenAiImageOptions = (
  target: FormData | Record<string, unknown>,
  options?: WorkflowGenerationOptions,
) => {
  const normalized = normalizeGenerationOptions(options);
  const append = (key: string, value?: string) => {
    if (!value) return;
    if (target instanceof FormData) target.append(key, value);
    else target[key] = value;
  };
  append('size', normalized.size);
  append('quality', normalized.quality);
};

const splitDataUrl = (value: string) => {
  const match = value.match(/^data:(.+?);base64,(.*)$/i);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: normalizeBase64Payload(match[2]),
  };
};

const dataUrlToBlob = async (value: string, fallbackType = 'image/png') => {
  const response = await fetch(value);
  const blob = await response.blob();
  if (blob.type) return blob;
  return blob.slice(0, blob.size, fallbackType);
};

const readStreamedText = async (response: Response) => {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let generatedText = '';
  let pending = '';
  const consumeLine = (line: string) => {
    const cleaned = line.replace(/\r$/, '');
    if (!cleaned.startsWith('data:')) return;
    const payload = cleaned.slice(5).trimStart();
    if (!payload || payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) generatedText += delta.content;
      if (delta?.reasoning_content) generatedText += delta.reasoning_content;
    } catch {
      // Ignore malformed stream fragments.
    }
  };

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        consumeLine(line);
        newlineIndex = pending.indexOf('\n');
      }
    }
    const tail = decoder.decode();
    if (tail) pending += tail;
  }
  if (pending) consumeLine(pending);
  return generatedText;
};

const readGeminiStream = async (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastJson: unknown = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (!line) continue;
      const cleaned = line.replace(/^data:\s*/i, '').trim();
      if (!cleaned || cleaned === '[DONE]') continue;
      try {
        lastJson = JSON.parse(cleaned);
      } catch {
        // Ignore partial stream fragments.
      }
    }
  }

  const tail = decoder.decode();
  if (tail) buffer += tail;
  const remainder = buffer.trim();
  if (remainder) {
    const cleaned = remainder.replace(/^data:\s*/i, '').trim();
    if (cleaned && cleaned !== '[DONE]') {
      try {
        lastJson = JSON.parse(cleaned);
      } catch {
        // Ignore malformed tail.
      }
    }
  }
  return lastJson;
};

const buildOpenAiMessages = (prompt: string, references: WorkflowReferenceImage[]) => {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [];
  if (prompt) content.push({ type: 'text', text: prompt });
  references.forEach((reference) => {
    const url = reference.dataUrl || reference.sourceUrl;
    if (url) content.push({ type: 'image_url', image_url: { url } });
  });
  return [{ role: 'user', content }];
};

const buildGeminiContents = (prompt: string, references: WorkflowReferenceImage[]) => {
  const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
  if (prompt) parts.push({ text: prompt });
  references.forEach((reference) => {
    const parsed = reference.dataUrl ? splitDataUrl(reference.dataUrl) : null;
    if (!parsed) return;
    parts.push({
      inline_data: {
        mime_type: parsed.mimeType || reference.type || 'image/png',
        data: parsed.data,
      },
    });
  });
  return [{ role: 'user', parts }];
};

const requestOpenAiImagesEndpoint = async (
  profile: WorkflowProfile,
  prompt: string,
  references: WorkflowReferenceImage[],
  signal?: AbortSignal,
  generationOptions?: WorkflowGenerationOptions,
) => {
  const apiUrl = resolveApiUrl(profile.apiUrl, 'openai');
  const openAiBase = buildOpenAiBaseUrl(apiUrl, profile.apiVersion);
  const imageUrl = buildOpenAiImagesUrl(openAiBase, references.length > 0);
  const headers = {
    Authorization: `Bearer ${profile.apiKey}`,
    'x-api-key': profile.apiKey,
  };

  let response: Response;
  if (references.length > 0) {
    const formData = new FormData();
    formData.append('model', profile.model);
    formData.append('prompt', prompt);
    for (const reference of references) {
      const dataUrl = reference.dataUrl || reference.sourceUrl;
      if (!dataUrl) continue;
      const blob = await dataUrlToBlob(dataUrl, reference.type || 'image/png');
      formData.append('image', blob, reference.name || `${reference.id}.png`);
    }
    applyOpenAiImageOptions(formData, generationOptions);
    response = await fetch(imageUrl, {
      method: 'POST',
      headers,
      body: formData,
      signal,
    });
  } else {
    response = await fetch(imageUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        (() => {
          const payload: Record<string, unknown> = { model: profile.model, prompt };
          applyOpenAiImageOptions(payload, generationOptions);
          return payload;
        })(),
      ),
      signal,
    });
  }

  if (!response.ok) {
    throw new Error(await formatResponseErrorMessage(response, response.statusText || '请求失败'));
  }
  return resolveImageFromResponse(await response.json());
};

export const requestWorkflowImage = async (
  profile: WorkflowProfile,
  prompt: string,
  references: WorkflowReferenceImage[],
  options: { stream?: boolean; signal?: AbortSignal; generationOptions?: WorkflowGenerationOptions } = {},
) => {
  const apiFormat = coerceApiFormat(profile.apiFormat || 'openai');
  const promptText = prompt.trim();
  const requestProfile = withGenerationOptions(profile, options.generationOptions);

  if (apiFormat === 'openai') {
    const endpointMode = requestProfile.openaiEndpointMode === 'images' ? 'images' : 'chat';
    if (endpointMode === 'images') {
      return requestOpenAiImagesEndpoint(
        requestProfile,
        promptText,
        references,
        options.signal,
        options.generationOptions,
      );
    }
    const apiUrl = resolveApiUrl(requestProfile.apiUrl, 'openai');
    const openAiBase = buildOpenAiBaseUrl(apiUrl, requestProfile.apiVersion);
    const chatUrl = buildOpenAiChatUrl(openAiBase);
    const headers = {
      Authorization: `Bearer ${requestProfile.apiKey}`,
      'x-api-key': requestProfile.apiKey,
      'Content-Type': 'application/json',
    };
    const messages = buildOpenAiMessages(promptText, references);
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: requestProfile.model, messages, stream: Boolean(options.stream) }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(await formatResponseErrorMessage(response, response.statusText || '请求失败'));
    }
    if (options.stream) {
      return parseMarkdownImage(await readStreamedText(response));
    }
    return resolveImageFromResponse(await response.json());
  }

  if (isGoogleApiFormat(apiFormat)) {
    const { url, headers } = await buildGoogleGenerateRequest(
      { ...requestProfile, apiFormat },
      { stream: Boolean(options.stream) },
    );
    const payload = buildGeminiPayload(buildGeminiContents(promptText, references), requestProfile);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(await formatResponseErrorMessage(response, response.statusText || '请求失败'));
    }
    const data = options.stream ? await readGeminiStream(response) : await response.json();
    return resolveImageFromResponse(data);
  }

  if (apiFormat === 'novelai') {
    if (references.length > 0) {
      throw new Error('NovelAI v1 暂不支持工作流参考图，请移除参考图或切换 API 配置。');
    }
    const built = buildNovelAiRequest(requestProfile, { prompt: promptText });
    const response = await fetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: JSON.stringify(built.payload),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(await formatResponseErrorMessage(response, response.statusText || '请求失败'));
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return resolveImageFromResponse(await response.json());
    }
    const image = await extractFirstImageFromNovelAiZip(await response.arrayBuffer());
    return image?.dataUrl || null;
  }

  throw new Error('当前 API 格式暂不支持工作流生图');
};
