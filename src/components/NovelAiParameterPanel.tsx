import React from 'react';
import { Button, Col, Input, InputNumber, Row, Select, Space, Switch, Tooltip, Typography } from 'antd';
import { LockFilled, ReloadOutlined, UnlockOutlined } from '@ant-design/icons';
import type { NovelAiConfig, NovelAiOverrides } from '../types/app';
import {
  NOVELAI_NOISE_SCHEDULE_OPTIONS,
  NOVELAI_SAMPLER_OPTIONS,
  NOVELAI_UC_PRESET_OPTIONS,
} from '../app/constants';
import LazySliderInput from '../shared/ui/LazySliderInput';
import {
  hasNovelAiOverrides,
  mergeNovelAiConfig,
  stripEmptyNovelAiOverrides,
} from '../utils/novelAiConfig';

const { Text } = Typography;

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;

type NovelAiResolutionPreset = {
  key: string;
  group: string;
  name: string;
  width: number;
  height: number;
};

const PRESET_GROUPS: Array<{ label: string; options: NovelAiResolutionPreset[] }> = [
  {
    label: 'Normal',
    options: [
      { key: 'normal-portrait', group: 'Normal', name: 'Portrait', width: 832, height: 1216 },
      { key: 'normal-landscape', group: 'Normal', name: 'Landscape', width: 1216, height: 832 },
      { key: 'normal-square', group: 'Normal', name: 'Square', width: 1024, height: 1024 },
    ],
  },
  {
    label: 'Large',
    options: [
      { key: 'large-portrait', group: 'Large', name: 'Portrait', width: 1024, height: 1536 },
      { key: 'large-landscape', group: 'Large', name: 'Landscape', width: 1536, height: 1024 },
      { key: 'large-square', group: 'Large', name: 'Square', width: 1472, height: 1472 },
    ],
  },
  {
    label: 'Wallpaper',
    options: [
      { key: 'wallpaper-landscape', group: 'Wallpaper', name: 'Landscape', width: 1920, height: 1088 },
      { key: 'wallpaper-portrait', group: 'Wallpaper', name: 'Portrait', width: 1088, height: 1920 },
    ],
  },
];

const PRESETS = PRESET_GROUPS.flatMap((group) => group.options);

const PRESET_OPTIONS = [
  {
    label: 'Custom',
    options: [{ label: '自定义尺寸', selectedLabel: '自定义尺寸', value: 'custom', disabled: true }],
  },
  ...PRESET_GROUPS.map((group) => ({
    label: group.label,
    options: group.options.map((preset) => ({
      label: `${preset.group} ${preset.name} (${preset.width}x${preset.height})`,
      selectedLabel: `${preset.group} ${preset.name}`,
      value: preset.key,
    })),
  })),
];

const gcd = (a: number, b: number): number => {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
};

const formatRatio = (width?: number, height?: number) => {
  if (!width || !height) return '1:1';
  const divisor = gcd(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
};

const parseRatio = (value?: string) => {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
};

const formatRatioPart = (value: number) => {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/\.?0+$/, '');
};

const formatRatioValue = (width: number, height: number) =>
  `${formatRatioPart(width)}:${formatRatioPart(height)}`;

const formatRatioInput = (
  value: string | number | undefined,
  info?: { userTyping: boolean; input: string },
) => {
  if (info?.userTyping) return info.input;
  if (value === undefined || value === null || value === '') return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? formatRatioPart(numeric) : String(value);
};

const coercePositiveInt = (value: unknown, fallback: number) => {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.round(numeric)) : fallback;
};

const getPresetKey = (width: number, height: number) =>
  PRESETS.find((preset) => preset.width === width && preset.height === height)?.key;

type DefaultProps = {
  mode?: 'default';
  value: NovelAiConfig;
  onChange: (value: NovelAiConfig) => void;
  defaultConfig?: never;
};

type OverrideProps = {
  mode: 'overrides';
  value?: NovelAiOverrides;
  defaultConfig: NovelAiConfig;
  onChange: (value: NovelAiOverrides) => void;
};

type NovelAiParameterPanelProps = (DefaultProps | OverrideProps) & {
  compact?: boolean;
  disabled?: boolean;
};

const isOverrideMode = (
  props: NovelAiParameterPanelProps,
): props is OverrideProps & { compact?: boolean; disabled?: boolean } => props.mode === 'overrides';

const fieldLabelStyle = { fontWeight: 600, color: '#665555' };

const resolveEffectiveConfig = (props: NovelAiParameterPanelProps): NovelAiConfig =>
  isOverrideMode(props) ? mergeNovelAiConfig(props.defaultConfig, props.value) : props.value;

const resolveOverrides = (props: NovelAiParameterPanelProps): NovelAiOverrides =>
  isOverrideMode(props) ? props.value || {} : {};

const isSameValue = (left: unknown, right: unknown) => {
  if (typeof left === 'number' || typeof right === 'number') {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
  }
  return left === right;
};

const emitChange = (
  props: NovelAiParameterPanelProps,
  patch: NovelAiOverrides,
) => {
  if (isOverrideMode(props)) {
    const next: NovelAiOverrides = { ...(props.value || {}), ...patch };
    (Object.keys(patch) as Array<keyof NovelAiConfig>).forEach((key) => {
      if (isSameValue(next[key], props.defaultConfig[key])) {
        delete next[key];
      }
    });
    props.onChange(stripEmptyNovelAiOverrides(next));
    return;
  }
  props.onChange({ ...props.value, ...patch });
};

const resetOverrides = (props: OverrideProps) => props.onChange({});

const NovelAiParameterPanel: React.FC<NovelAiParameterPanelProps> = (props) => {
  const overrideMode = isOverrideMode(props);
  const effective = resolveEffectiveConfig(props);
  const overrides = resolveOverrides(props);
  const width = coercePositiveInt(effective.width, DEFAULT_WIDTH);
  const height = coercePositiveInt(effective.height, DEFAULT_HEIGHT);
  const currentRatio = formatRatio(width, height);
  const ratio = parseRatio(effective.aspectRatio) || parseRatio(currentRatio) || { width: 1, height: 1 };
  const selectedPresetKey = getPresetKey(width, height) || 'custom';
  const locked = Boolean(effective.lockAspectRatio);
  const customized = hasNovelAiOverrides(overrides);
  const ucValue = overrideMode ? overrides.uc || '' : effective.uc;
  const ucPlaceholder =
    overrideMode && props.defaultConfig.uc
      ? `默认负面提示词后追加：${props.defaultConfig.uc}`
      : 'lowres, bad anatomy, bad hands';

  const updatePreset = (value: string) => {
    const preset = PRESETS.find((item) => item.key === value);
    if (!preset) return;
    emitChange(props, {
      width: preset.width,
      height: preset.height,
      aspectRatio: formatRatio(preset.width, preset.height),
    });
  };

  const updateDimension = (field: 'width' | 'height', value: number | string | null) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 1) return;
    const nextValue = Math.max(1, Math.round(numeric));
    let nextWidth = field === 'width' ? nextValue : width;
    let nextHeight = field === 'height' ? nextValue : height;
    if (locked) {
      if (field === 'width') {
        nextHeight = Math.max(1, Math.round(nextWidth * ratio.height / ratio.width));
      } else {
        nextWidth = Math.max(1, Math.round(nextHeight * ratio.width / ratio.height));
      }
    }
    emitChange(props, {
      width: nextWidth,
      height: nextHeight,
      aspectRatio: formatRatio(nextWidth, nextHeight),
    });
  };

  const updateRatio = (field: 'width' | 'height', value: number | string | null) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    const nextRatioWidth = field === 'width' ? numeric : ratio.width;
    const nextRatioHeight = field === 'height' ? numeric : ratio.height;
    const nextHeight = Math.max(1, Math.round(width * nextRatioHeight / nextRatioWidth));
    emitChange(props, {
      width,
      height: nextHeight,
      aspectRatio: formatRatioValue(nextRatioWidth, nextRatioHeight),
    });
  };

  const swapDimensions = () => {
    emitChange(props, {
      width: height,
      height: width,
      aspectRatio: formatRatio(height, width),
    });
  };

  const swapRatio = () => {
    const nextHeight = Math.max(1, Math.round(width * ratio.width / ratio.height));
    emitChange(props, {
      width,
      height: nextHeight,
      aspectRatio: formatRatioValue(ratio.height, ratio.width),
    });
  };

  const toggleAspectLock = () => {
    emitChange(props, {
      lockAspectRatio: !locked,
      aspectRatio: formatRatio(width, height),
    });
  };

  return (
    <Space direction="vertical" size={props.compact ? 8 : 12} style={{ width: '100%' }}>
	      {overrideMode ? (
	        <div className="novelai-override-header">
          <Text type={customized ? undefined : 'secondary'}>
            {customized ? '已自定义当前任务参数' : '使用配置档默认参数'}
          </Text>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            disabled={!customized || props.disabled}
            onClick={() => resetOverrides(props)}
          >
            重置为默认
          </Button>
        </div>
      ) : null}

      <div>
        <Text type="secondary" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
          像素
        </Text>
        <div className="novelai-size-row">
          <Select
            size="large"
            value={selectedPresetKey}
            options={PRESET_OPTIONS}
            optionLabelProp="selectedLabel"
            onChange={updatePreset}
            className="novelai-preset-select"
            popupClassName="novelai-preset-select-popup"
            popupMatchSelectWidth={false}
            dropdownStyle={{ minWidth: 280 }}
            disabled={props.disabled}
          />
          <div className="novelai-linked-input novelai-pixel-input">
            <InputNumber
              aria-label="NovelAI 图像宽度"
              min={1}
              step={1}
              precision={0}
              controls={false}
              value={width}
              onChange={(value) => updateDimension('width', value)}
              className="novelai-linked-number"
              disabled={props.disabled}
            />
            <Tooltip title="交换宽高">
              <button
                type="button"
                className="novelai-linked-separator novelai-inline-action"
                onClick={swapDimensions}
                aria-label="交换 NovelAI 宽高"
                disabled={props.disabled}
              >
                ×
              </button>
            </Tooltip>
            <InputNumber
              aria-label="NovelAI 图像高度"
              min={1}
              step={1}
              precision={0}
              controls={false}
              value={height}
              onChange={(value) => updateDimension('height', value)}
              className="novelai-linked-number"
              disabled={props.disabled}
            />
          </div>
        </div>
      </div>

      <div>
        <Text type="secondary" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
          比例
        </Text>
        <div className="novelai-ratio-row">
          <div className="novelai-linked-input novelai-ratio-input">
            <InputNumber
              aria-label="NovelAI 比例宽度"
              min={0.001}
              step={1}
              precision={3}
              formatter={formatRatioInput}
              controls={false}
              value={ratio.width}
              onChange={(value) => updateRatio('width', value)}
              className="novelai-linked-number"
              disabled={props.disabled}
            />
            <Tooltip title="交换比例">
              <button
                type="button"
                className="novelai-linked-separator novelai-inline-action"
                onClick={swapRatio}
                aria-label="交换 NovelAI 比例"
                disabled={props.disabled}
              >
                :
              </button>
            </Tooltip>
            <InputNumber
              aria-label="NovelAI 比例高度"
              min={0.001}
              step={1}
              precision={3}
              formatter={formatRatioInput}
              controls={false}
              value={ratio.height}
              onChange={(value) => updateRatio('height', value)}
              className="novelai-linked-number"
              disabled={props.disabled}
            />
          </div>
          <Tooltip title={locked ? '已锁定比例' : '锁定比例'}>
            <Button
              size="small"
              type="default"
              shape="circle"
              icon={locked ? <LockFilled /> : <UnlockOutlined />}
              onClick={toggleAspectLock}
              aria-label={locked ? '解除锁定比例' : '锁定比例'}
              className={`novelai-aspect-lock-button${locked ? ' is-active' : ''}`}
              disabled={props.disabled}
            />
          </Tooltip>
        </div>
      </div>

      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block' }}>采样参数</Text>
      <Select
        value={effective.sampler}
        options={NOVELAI_SAMPLER_OPTIONS}
        onChange={(sampler) => emitChange(props, { sampler })}
        disabled={props.disabled}
      />
	      <FieldLabel>采样步数</FieldLabel>
	      <LazySliderInput
	        min={1}
	        max={50}
	        step={1}
	        value={effective.steps}
	        onChange={(steps) => emitChange(props, { steps })}
	        disabled={props.disabled}
	      />
      <FieldLabel>提示词引导 / CFG</FieldLabel>
      <LazySliderInput
        min={0}
        max={20}
	        step={0.1}
	        value={effective.scale}
	        onChange={(scale) => emitChange(props, { scale })}
	        disabled={props.disabled}
	      />
      <FieldLabel>CFG 重缩放</FieldLabel>
      <LazySliderInput
        min={0}
        max={1}
	        step={0.01}
	        value={effective.cfgRescale}
	        onChange={(cfgRescale) => emitChange(props, { cfgRescale })}
	        disabled={props.disabled}
	      />
      <FieldLabel>噪声调度</FieldLabel>
      <Select
        value={effective.noiseSchedule}
        options={NOVELAI_NOISE_SCHEDULE_OPTIONS}
        onChange={(noiseSchedule) => emitChange(props, { noiseSchedule })}
        disabled={props.disabled}
      />
      <FieldLabel>种子</FieldLabel>
      <InputNumber
        min={0}
        precision={0}
        placeholder="随机"
        controls={false}
        value={effective.seed}
        onChange={(seed) => emitChange(props, { seed: seed ?? undefined })}
        className="novelai-pill-number"
        disabled={props.disabled}
      />

      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block' }}>生成选项</Text>
      <FieldLabel>UC 预设</FieldLabel>
      <Select
        value={effective.ucPreset}
        options={NOVELAI_UC_PRESET_OPTIONS}
        onChange={(ucPreset) => emitChange(props, { ucPreset })}
        disabled={props.disabled}
      />
      <FieldLabel>负面提示词</FieldLabel>
      <Input.TextArea
	        rows={props.compact ? 2 : 3}
	        value={ucValue}
	        placeholder={ucPlaceholder}
	        onChange={(event) => emitChange(props, { uc: event.target.value })}
	        disabled={props.disabled}
	      />
      <Row gutter={12}>
        <Col span={12}>
          <ToggleField
            label="自动质量词"
            checked={effective.qualityToggle}
            disabled={props.disabled}
            onChange={(qualityToggle) => emitChange(props, { qualityToggle })}
          />
        </Col>
        <Col span={12}>
          <ToggleField
            label="动态阈值"
            checked={effective.dynamicThresholding}
            disabled={props.disabled}
            onChange={(dynamicThresholding) => emitChange(props, { dynamicThresholding })}
          />
        </Col>
        <Col span={12}>
          <ToggleField
            label="SMEA"
            checked={effective.sm}
            disabled={props.disabled}
            onChange={(sm) => emitChange(props, { sm })}
          />
        </Col>
        <Col span={12}>
          <ToggleField
            label="SMEA DYN"
            checked={effective.smDyn}
            disabled={props.disabled}
            onChange={(smDyn) => emitChange(props, { smDyn })}
          />
        </Col>
      </Row>
    </Space>
  );
};

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text style={fieldLabelStyle}>{children}</Text>
);

const ToggleField: React.FC<{
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}> = ({ checked, disabled, label, onChange }) => (
  <div className="novelai-toggle-row">
    <Text style={fieldLabelStyle}>{label}</Text>
    <Switch checked={checked} disabled={disabled} onChange={onChange} />
  </div>
);

export default NovelAiParameterPanel;
