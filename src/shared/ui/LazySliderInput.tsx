import React, { useState } from 'react';
import { Row, Col, Slider } from 'antd';

interface LazySliderProps {
  value?: number;
  onChange?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}

const LazySliderInput: React.FC<LazySliderProps> = ({
  value = 0,
  onChange,
  min,
  max,
  step = 1,
  disabled,
}) => {
  const [localValue, setLocalValue] = useState<number>(value);

  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleSliderChange = (val: number) => {
    if (disabled) return;
    setLocalValue(val);
  };

  const handleSliderAfterChange = (val: number) => {
    if (disabled) return;
    onChange?.(val);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    const val = e.target.value;
    if (val === '') return;
    if (!/^\d+(?:\.\d*)?$/.test(val)) return;
    const next = Number(val);
    if (Number.isFinite(next)) setLocalValue(next);
  };

  const handleInputBlur = () => {
    if (disabled) return;
    let constrained = Math.max(min, Math.min(max, localValue));
    if (step) {
      constrained = Number((Math.round(constrained / step) * step).toFixed(6));
    }
    setLocalValue(constrained);
    onChange?.(constrained);
  };

  return (
    <Row gutter={12} align="middle">
      <Col span={16}>
        <Slider
          min={min}
          max={max}
	          step={step}
	          value={localValue}
	          onChange={handleSliderChange}
	          onAfterChange={handleSliderAfterChange}
	          disabled={disabled}
	        />
      </Col>
      <Col span={8}>
        <div
          style={{
            background: '#fff',
            padding: '2px 8px',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            height: 28,
            justifyContent: 'center',
          }}
        >
          <input
	            type="number"
	            value={localValue}
	            onChange={handleInputChange}
	            onBlur={handleInputBlur}
	            disabled={disabled}
	            style={{
              width: '100%',
              border: 'none',
              textAlign: 'center',
	              color: disabled ? '#B8A7A7' : '#665555',
              fontWeight: 700,
	              background: 'transparent',
	              cursor: disabled ? 'not-allowed' : 'text',
              outline: 'none',
              fontSize: 12,
              padding: 0,
            }}
          />
        </div>
      </Col>
    </Row>
  );
};

export default LazySliderInput;
