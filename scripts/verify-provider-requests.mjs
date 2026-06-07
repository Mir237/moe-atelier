import assert from 'node:assert/strict';
import {
  buildGeminiPayload,
  buildGoogleGenerateRequest,
  buildNovelAiRequest,
} from '../src/utils/providerRequests.mjs';

const baseConfig = {
  apiKey: 'test-key',
  model: 'gemini-test',
  includeImageConfig: true,
  imageConfig: { imageSize: '2K', aspectRatio: '16:9' },
  includeThoughts: true,
  thinkingBudget: 256,
  includeSafetySettings: true,
  safety: {
    HARM_CATEGORY_HARASSMENT: 'BLOCK_NONE',
    HARM_CATEGORY_HATE_SPEECH: 'OFF',
  },
  useResponseModalities: true,
  customJson: '',
};

const gemini = buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'gemini',
  apiUrl: 'https://generativelanguage.googleapis.com',
  apiVersion: 'v1beta',
});
assert.equal(
  gemini.url,
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=test-key',
);
assert.equal(gemini.headers.Authorization, undefined);

const vertex = buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'vertex',
  apiUrl: 'https://aiplatform.googleapis.com',
  apiVersion: 'v1beta1',
  vertexProjectId: 'project-a',
  vertexLocation: 'us-central1',
  vertexPublisher: 'google',
});
assert.equal(
  vertex.url,
  'https://aiplatform.googleapis.com/v1beta1/projects/project-a/locations/us-central1/publishers/google/models/gemini-test:generateContent',
);
assert.equal(vertex.headers.Authorization, 'Bearer test-key');

const express = buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'vertex-express',
  apiUrl: 'https://aiplatform.googleapis.com',
  apiVersion: 'v1',
  vertexPublisher: 'google',
});
assert.equal(
  express.url,
  'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-test:generateContent?key=test-key',
);
assert.equal(express.headers.Authorization, undefined);

const payload = buildGeminiPayload([{ role: 'user', parts: [{ text: 'draw' }] }], baseConfig);
assert.deepEqual(payload.generationConfig.imageConfig, {
  imageSize: '2K',
  aspectRatio: '16:9',
});
assert.deepEqual(payload.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
assert.deepEqual(payload.generationConfig.thinkingConfig, {
  thinkingBudget: 256,
  includeThoughts: true,
});
assert.deepEqual(payload.safetySettings, [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
]);

const novelai = buildNovelAiRequest(
  {
    apiUrl: 'https://image.novelai.net',
    apiKey: 'nai-key',
    model: 'nai-diffusion-4-full',
    imageConfig: { imageSize: '1K', aspectRatio: '3:4' },
    customJson: '{"parameters":{"steps":12},"action":"generate"}',
  },
  { prompt: 'cat cafe' },
);
assert.equal(novelai.url, 'https://image.novelai.net/ai/generate-image');
assert.equal(novelai.headers.Authorization, 'Bearer nai-key');
assert.equal(novelai.payload.input, 'cat cafe');
assert.equal(novelai.payload.model, 'nai-diffusion-4-full');
assert.equal(novelai.payload.parameters.steps, 12);
assert.equal(novelai.payload.parameters.width, 768);
assert.equal(novelai.payload.parameters.height, 1024);

console.log('provider request checks passed');
