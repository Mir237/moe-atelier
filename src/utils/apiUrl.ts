import {
  API_VERSION_OPTIONS as SHARED_API_VERSION_OPTIONS,
  DEFAULT_API_BASES as SHARED_DEFAULT_API_BASES,
  extractVertexProjectId as sharedExtractVertexProjectId,
  inferApiVersionFromUrl as sharedInferApiVersionFromUrl,
  normalizeApiBase as sharedNormalizeApiBase,
  resolveApiUrl as sharedResolveApiUrl,
  resolveApiVersion as sharedResolveApiVersion,
} from './providerRequests.mjs';

export type ApiFormat = 'openai' | 'gemini' | 'vertex' | 'novelai';

export const API_VERSION_OPTIONS = SHARED_API_VERSION_OPTIONS;

export const DEFAULT_API_BASES = SHARED_DEFAULT_API_BASES as Record<ApiFormat, string>;

export const resolveApiUrl = sharedResolveApiUrl;

export const inferApiVersionFromUrl = sharedInferApiVersionFromUrl;

export const normalizeApiBase = sharedNormalizeApiBase;

export const resolveApiVersion = sharedResolveApiVersion;

export const extractVertexProjectId = sharedExtractVertexProjectId;
