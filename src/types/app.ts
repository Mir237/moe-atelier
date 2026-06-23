export type SafetySettings = Record<string, string>;

export interface ImageConfig {
  imageSize: string;
  aspectRatio: string;
}

export interface NovelAiConfig {
  width: number;
  height: number;
  aspectRatio: string;
  lockAspectRatio: boolean;
  steps: number;
  scale: number;
  sampler: string;
  seed?: number;
  ucPreset: number;
  uc: string;
  qualityToggle: boolean;
  dynamicThresholding: boolean;
  sm: boolean;
  smDyn: boolean;
  cfgRescale: number;
  noiseSchedule: string;
}

export type NovelAiOverrides = Partial<NovelAiConfig>;

export type OpenAiEndpointMode = 'chat' | 'images';
export type VertexAuthMode = 'json' | 'apiKey';

export interface VertexModelLocation {
  model: string;
  location: string;
}

export interface ApiProfile {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  apiFormat: 'openai' | 'gemini' | 'vertex' | 'novelai';
  openaiEndpointMode: OpenAiEndpointMode;
  apiVersion: string;
  vertexAuthMode?: VertexAuthMode;
  vertexProjectId?: string;
  vertexLocation?: string;
  vertexDefaultLocation?: string;
  vertexModelLocations?: VertexModelLocation[];
  vertexPublisher?: string;
  thinkingBudget: number;
  includeThoughts: boolean;
  includeImageConfig: boolean;
  includeSafetySettings: boolean;
  safety: SafetySettings;
  imageConfig: ImageConfig;
  novelAiConfig: NovelAiConfig;
  webpQuality: number;
  useResponseModalities: boolean;
  customJson: string;
}

export interface AppConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  apiFormat: 'openai' | 'gemini' | 'vertex' | 'novelai';
  openaiEndpointMode: OpenAiEndpointMode;
  apiVersion: string;
  vertexAuthMode?: VertexAuthMode;
  vertexProjectId?: string;
  vertexLocation?: string;
  vertexDefaultLocation?: string;
  vertexModelLocations?: VertexModelLocation[];
  vertexPublisher?: string;
  stream: boolean;
  enableCollection: boolean;
  thinkingBudget: number;
  includeThoughts: boolean;
  includeImageConfig: boolean;
  includeSafetySettings: boolean;
  safety: SafetySettings;
  imageConfig: ImageConfig;
  novelAiConfig: NovelAiConfig;
  webpQuality: number;
  useResponseModalities: boolean;
  customJson: string;

  apiProfiles?: ApiProfile[];
  activeApiProfileId?: string;
}

export interface TaskConfig {
  id: string;
  prompt: string;
  imageUrl?: string;
}
