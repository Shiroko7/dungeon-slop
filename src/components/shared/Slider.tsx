interface SliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  className?: string;
}

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled = false,
  className = "",
}: SliderProps) {
  return (
    <div className={`slider-container ${className}`.trim()}>
      <div className="slider-header">
        <label className="slider-label">{label}</label>
        <span className="slider-value">{value}</span>
      </div>
      <input
        type="range"
        className="slider"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
      />
    </div>
  );
}
