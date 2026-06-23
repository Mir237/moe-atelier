export const IMAGE_SIZE_OPTIONS = ['512', '1K', '2K', '4K'];
export const ASPECT_RATIO_OPTIONS = [
  'auto',
  '1:1',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '2:3',
  '3:2',
  '4:5',
  '5:4',
  '21:9',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
];

export const SAFETY_OPTIONS = [
  { label: 'OFF', value: 'OFF' },
  { label: 'BLOCK_NONE', value: 'BLOCK_NONE' },
  { label: 'BLOCK_ONLY_HIGH', value: 'BLOCK_ONLY_HIGH' },
  { label: 'BLOCK_MEDIUM', value: 'BLOCK_MEDIUM_AND_ABOVE' },
  { label: 'BLOCK_LOW', value: 'BLOCK_LOW_AND_ABOVE' },
];

export const NOVELAI_SAMPLER_OPTIONS = [
  { label: 'Euler a', value: 'k_euler_ancestral' },
  { label: 'Euler', value: 'k_euler' },
  { label: 'DPM++ 2M', value: 'k_dpmpp_2m' },
  { label: 'DPM++ 2S Ancestral', value: 'k_dpmpp_2s_ancestral' },
  { label: 'DPM++ SDE', value: 'k_dpmpp_sde' },
  { label: 'DPM2', value: 'k_dpm_2' },
  { label: 'DPM Fast', value: 'k_dpm_fast' },
  { label: 'DDIM', value: 'ddim' },
];

export const NOVELAI_NOISE_SCHEDULE_OPTIONS = [
  { label: '原生', value: 'native' },
  { label: 'Karras', value: 'karras' },
  { label: '指数', value: 'exponential' },
  { label: '多项指数', value: 'polyexponential' },
];

export const NOVELAI_UC_PRESET_OPTIONS = [
  { label: '无', value: 0 },
  { label: '低质量 + 错误人体', value: 1 },
  { label: '低质量 + 错误人体 + 错误手部', value: 2 },
  { label: '重度', value: 3 },
];
