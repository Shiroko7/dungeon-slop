import { useState } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import type { DungeonConfig } from "../../ai/schema.ts";

const CONFIG_LABELS: Record<keyof DungeonConfig, string> = {
  layout_style: "Layout Style",
  motif: "Motif",
  room_density: "Room Count",
  room_size: "Room Size",
  room_count: "Room Count (Exact)",
  room_eccentricity: "Room Eccentricity",
  symmetry: "Symmetry",
  entry_points: "Entry Points",
  entry_point_count: "Entry Count",
  corridors: "Corridors",
  corridor_complexity: "Corridor Complexity",
  dead_ends: "Dead Ends",
  door_types: "Door Types",
  trap_density: "Trap Density",
  treasure_density: "Treasure Density",
  stairs: "Stairs",
  grid_type: "Grid Type",
  grid_width: "Grid Width",
  grid_height: "Grid Height",
  room_shapes: "Room Shapes",
  theme_description: "Theme",
  seed: "Seed",
};

type FieldMeta =
  | { kind: "enum"; options: readonly string[] }
  | { kind: "number"; min: number; max: number; step: number }
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "text" }
  | { kind: "multi"; options: readonly string[] };

const FIELD_META: Record<keyof DungeonConfig, FieldMeta> = {
  layout_style: { kind: "enum", options: ["constructed", "organic"] },
  motif: { kind: "enum", options: ["Default", "Infernal", "Aquatic", "Natural", "Arcane", "Undead", "Mechanical", "Frozen"] },
  room_density: { kind: "enum", options: ["Sparse", "Moderate", "Dense", "Exact"] },
  room_size: { kind: "enum", options: ["Tiny", "Small", "Medium", "Large", "Huge"] },
  room_count: { kind: "number", min: 1, max: 100, step: 1 },
  room_eccentricity: { kind: "slider", min: 0, max: 1, step: 0.05 },
  symmetry: { kind: "enum", options: ["None", "Horizontal", "Vertical", "Radial", "Four-Way"] },
  entry_points: { kind: "enum", options: ["None", "Few", "Many", "Exact"] },
  entry_point_count: { kind: "number", min: 1, max: 8, step: 1 },
  corridors: { kind: "enum", options: ["Straight", "Winding", "Labyrinth"] },
  corridor_complexity: { kind: "slider", min: 0, max: 1, step: 0.05 },
  dead_ends: { kind: "enum", options: ["None", "Few", "Many"] },
  door_types: { kind: "multi", options: ["Open", "Archway", "Portcullis", "Standard", "Locked", "Secure", "Trapped", "Secret"] },
  trap_density: { kind: "enum", options: ["None", "Low", "Medium", "High"] },
  treasure_density: { kind: "enum", options: ["None", "Low", "Medium", "High"] },
  stairs: { kind: "enum", options: ["None", "Few", "Many"] },
  grid_type: { kind: "enum", options: ["Square"] },
  grid_width: { kind: "number", min: 20, max: 100, step: 1 },
  grid_height: { kind: "number", min: 20, max: 100, step: 1 },
  room_shapes: { kind: "multi", options: ["Rectangular", "Square", "Circular", "Hexagonal", "Pentagonal", "Cave", "Cross", "Diamond"] },
  theme_description: { kind: "text" },
  seed: { kind: "number", min: 0, max: 2147483647, step: 1 },
};

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}

function SliderField({ label, value, min, max, step, onChange }: SliderFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft ?? String(Math.round(value * 1000) / 1000);

  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
    setDraft(null);
  };

  return (
    <div className="config-field">
      <span className="config-field-key">{label}</span>
      <div className="config-field-slider-group">
        <input
          type="range"
          className="config-field-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => { setDraft(null); onChange(parseFloat(e.target.value)); }}
        />
        <input
          type="text"
          className="config-field-number config-field-slider-number"
          value={displayValue}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
      </div>
    </div>
  );
}

interface ConfigFieldProps {
  fieldKey: keyof DungeonConfig;
  label: string;
  config: DungeonConfig;
  onChange: (key: keyof DungeonConfig, value: DungeonConfig[keyof DungeonConfig]) => void;
}

function ConfigField({ fieldKey, label, config, onChange }: ConfigFieldProps) {
  const meta = FIELD_META[fieldKey];
  const value = config[fieldKey];

  if (meta.kind === "enum") {
    return (
      <div className="config-field">
        <span className="config-field-key">{label}</span>
        <select
          className="config-field-select"
          value={value as string}
          onChange={(e) => onChange(fieldKey, e.target.value as DungeonConfig[keyof DungeonConfig])}
        >
          {meta.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  if (meta.kind === "slider") {
    return (
      <SliderField
        label={label}
        value={(value as number) ?? 0}
        min={meta.min}
        max={meta.max}
        step={meta.step}
        onChange={(n) => onChange(fieldKey, n as DungeonConfig[keyof DungeonConfig])}
      />
    );
  }

  if (meta.kind === "number") {
    const numVal = value as number | undefined;
    return (
      <div className="config-field">
        <span className="config-field-key">{label}</span>
        <input
          type="number"
          className="config-field-number"
          value={numVal ?? ""}
          min={meta.min}
          max={meta.max}
          step={meta.step}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!isNaN(n)) onChange(fieldKey, n as DungeonConfig[keyof DungeonConfig]);
          }}
        />
      </div>
    );
  }

  if (meta.kind === "text") {
    return (
      <div className="config-field config-field--block">
        <span className="config-field-key">{label}</span>
        <textarea
          className="config-field-textarea"
          value={value as string}
          rows={3}
          onChange={(e) => onChange(fieldKey, e.target.value as DungeonConfig[keyof DungeonConfig])}
        />
      </div>
    );
  }

  if (meta.kind === "multi") {
    const current = (value as string[]) ?? [];
    return (
      <div className="config-field config-field--block">
        <span className="config-field-key">{label}</span>
        <div className="config-field-checkboxes">
          {meta.options.map((opt) => (
            <label key={opt} className="config-field-chip">
              <input
                type="checkbox"
                checked={current.includes(opt)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...current, opt]
                    : current.filter((s) => s !== opt);
                  if (next.length > 0) onChange(fieldKey, next as DungeonConfig[keyof DungeonConfig]);
                }}
              />
              {opt}
            </label>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

export function ConfigReadout() {
  const appliedConfig = useDungeonStore((s) => s.config);
  const proposedConfig = useDungeonStore((s) => s.proposedConfig);
  const setProposedConfig = useDungeonStore((s) => s.setProposedConfig);
  const configRawText = useDungeonStore((s) => s.configRawText);
  const isGeneratingConfig = useDungeonStore((s) => s.isGeneratingConfig);

  if (isGeneratingConfig && configRawText) {
    return (
      <div className="config-readout config-readout--streaming">
        <pre className="config-raw-text pulse">{configRawText}</pre>
      </div>
    );
  }

  const config = proposedConfig ?? appliedConfig;
  if (!config) {
    return (
      <div className="config-readout config-readout--empty">
        <p className="config-readout-placeholder">
          No configuration yet. Use the prompt above to generate one.
        </p>
      </div>
    );
  }

  const handleChange = (key: keyof DungeonConfig, value: DungeonConfig[keyof DungeonConfig]) => {
    setProposedConfig({ ...config, [key]: value });
  };

  return (
    <div className="config-readout">
      {proposedConfig && <p className="config-readout-notice">Proposed changes — Generate to apply as a new version.</p>}
      {(Object.keys(CONFIG_LABELS) as Array<keyof DungeonConfig>)
        .filter((key) => {
          if (key === "room_count" && config.room_density !== "Exact") return false;
          if (key === "entry_point_count" && config.entry_points !== "Exact") return false;
          return true;
        })
        .map((key) => (
          <ConfigField
            key={key}
            fieldKey={key}
            label={CONFIG_LABELS[key] ?? key}
            config={config}
            onChange={handleChange}
          />
        ))}
    </div>
  );
}
