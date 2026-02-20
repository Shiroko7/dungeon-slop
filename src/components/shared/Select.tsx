interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
}

export function Select({
  label,
  value,
  onChange,
  options,
  disabled = false,
  className = "",
}: SelectProps) {
  return (
    <div className={`select-wrapper ${className}`.trim()}>
      <label className="select-label">{label}</label>
      <select
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
