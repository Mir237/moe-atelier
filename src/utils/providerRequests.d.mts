import type { AppConfig } from '../types/app';

export type ApiFormat = 'openai' | 'gemini' | 'vertex' | 'vertex-express' | 'novelai';

export const API_FORMATS: ApiFormat[];
export const GOOGLE_API_FORMATS: ApiFormat[];
export const API_VERSION_OPTIONS: string[];
export const DEFAULT_API_BASES: Record<ApiFormat, string>;

export function isSupportedApiFormat(value: unknown): value is ApiFormat;
export function coerceApiFormat(value: unknown): ApiFormat;
export function isGoogleApiFormat(value: unknown): value is 'gemini' | 'vertex' | 'vertex-express';
export function isVersionSegment(value?: unknown): boolean;
export function resolveApiUrl(apiUrl: string | undefined, apiFormat: ApiFormat): string;
export function normalizeApiBase(apiUrl?: string): {
  origin: string;
  segments: string[];
  host: string;
};
export function inferApiVersionFromUrl(apiUrl?: string): string | null;
export function resolveApiVersion(
  apiUrl: string,
  apiVersion: string | undefined,
  fallback: string,
): string;
export function extractVertexProjectId(apiUrl?: string): string | null;
export function getApiVersionFallback(apiFormat: ApiFormat): string;

export function buildGoogleGenerateRequest(
  config: Partial<AppConfig>,
  options?: { stream?: boolean },
): { url: string; headers: Record<string, string> };

export function buildGeminiGenerationConfig(config?: Partial<AppConfig>): Record<string, unknown> | null;
export function buildGeminiSafetySettings(config?: Partial<AppConfig>): Array<Record<string, string>> | null;
export function mergeGeminiCustomJson(
  payload: Record<string, unknown>,
  config?: Partial<AppConfig>,
): Record<string, unknown>;
export function buildGeminiPayload(
  contents: Array<Record<string, unknown>>,
  config?: Partial<AppConfig>,
): Record<string, unknown>;

export function buildOpenAiBaseUrl(apiUrl: string, apiVersion?: string): string;
export function buildOpenAiChatUrl(openAiBase: string): string;
export function buildOpenAiImagesUrl(openAiBase: string, hasReferenceImages: boolean): string;

export function getNovelAiDimensions(imageConfig?: Partial<AppConfig['imageConfig']>): {
  width: number;
  height: number;
};
export function buildNovelAiRequest(
  config: Partial<AppConfig>,
  options?: { prompt?: string },
): {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
};
export function extractFirstImageFromNovelAiZip(arrayBuffer: ArrayBuffer): Promise<{
  dataUrl: string;
  filename: string;
  mimeType: string;
} | null>;
