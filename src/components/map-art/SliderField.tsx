import { useEffect, useState, type ReactNode } from "react";

interface SliderFieldProps {
  label: string;
  icon?: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Shown after the number, e.g. "%", "°", "cells". */
  unit?: string;
  /** Display transform (e.g. 0.25 → 25 for a percentage); the inverse is applied on input. */
  scale?: number;
  onChange: (value: number) => void;
}

/** A labelled range slider with an editable number beside its label. */
export function SliderField({ label, icon, value, min, max, step = 1, unit, scale = 1, onChange }: SliderFieldProps) {
  const shown = Math.round(value * scale * 100) / 100;
  const [draft, setDraft] = useState(String(shown));
  useEffect(() => setDraft(String(shown)), [shown]);

  const commit = (text: string) => {
    const n = Number(text);
    if (!Number.isFinite(n)) return setDraft(String(shown));
    onChange(Math.min(max, Math.max(min, n / scale)));
  };
  const pct = ((value - min) / (max - min || 1)) * 100;

  return (
    <div className="art-slider">
      <div className="art-slider-head">
        <span className="art-slider-label">
          {icon && <span className="art-slider-icon" aria-hidden="true">{icon}</span>}
          {label}
        </span>
        <span className="art-slider-value">
          <input
            className="art-slider-number"
            inputMode="decimal"
            aria-label={`${label} value`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                const delta = (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1);
                onChange(Math.min(max, Math.max(min, value + delta)));
              }
            }}
          />
          {unit && <span className="art-slider-unit">{unit}</span>}
        </span>
      </div>
      <input
        type="range"
        className="art-range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
