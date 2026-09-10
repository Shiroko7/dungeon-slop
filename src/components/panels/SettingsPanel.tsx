import { TemperatureSlider } from "../input/TemperatureSlider.tsx";
import { Select } from "../shared/Select.tsx";
import { useAIStore } from "../../store/ai-store.ts";
import { getProvider, listModels } from "../../ai/provider-registry.ts";
import type { ThinkingLevel } from "../../ai/types.ts";

const providerOptions = [
  { value: "gemini", label: "Gemini" },
  { value: "claude", label: "Claude Haiku" },
  { value: "ollama", label: "Ollama (Local)" },
];

const DEFAULT_MODEL_VALUE = "__default__";
const DEFAULT_THINKING_VALUE = "__auto__";

const thinkingLabels: Record<ThinkingLevel, string> = {
  minimal: "Minimal (fastest)",
  low: "Low",
  medium: "Medium",
  high: "High (best quality)",
};

export function SettingsPanel() {
  const provider = useAIStore((s) => s.provider);
  const setProvider = useAIStore((s) => s.setProvider);
  const model = useAIStore((s) => s.model);
  const setModel = useAIStore((s) => s.setModel);
  const thinkingLevel = useAIStore((s) => s.thinkingLevel);
  const setThinkingLevel = useAIStore((s) => s.setThinkingLevel);
  const autoDescribe = useAIStore((s) => s.autoDescribe);
  const setAutoDescribe = useAIStore((s) => s.setAutoDescribe);
  const useBlueprint = useAIStore((s) => s.useBlueprint);
  const setUseBlueprint = useAIStore((s) => s.setUseBlueprint);
  const captureReasoning = useAIStore((s) => s.captureReasoning);
  const setCaptureReasoning = useAIStore((s) => s.setCaptureReasoning);

  const models = listModels(provider);
  const activeModelId = model ?? getProvider(provider).defaultModel;
  const activeModel = models.find((m) => m.id === activeModelId);
  const availableLevels = activeModel?.thinkingLevels ?? [];

  const modelOptions = [
    { value: DEFAULT_MODEL_VALUE, label: "Provider default" },
    ...models.map((m) => ({ value: m.id, label: m.label })),
  ];

  const thinkingOptions = [
    { value: DEFAULT_THINKING_VALUE, label: "Auto (API default)" },
    ...availableLevels.map((l) => ({ value: l, label: thinkingLabels[l] })),
  ];

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <h3 className="settings-heading">AI Provider</h3>
        <Select
          label="Provider"
          value={provider}
          onChange={setProvider}
          options={providerOptions}
        />
        <Select
          label="Model"
          value={model ?? DEFAULT_MODEL_VALUE}
          onChange={(v) => setModel(v === DEFAULT_MODEL_VALUE ? null : v)}
          options={modelOptions}
          disabled={models.length <= 1}
        />
        <Select
          label="Thinking"
          value={
            thinkingLevel !== null && availableLevels.includes(thinkingLevel)
              ? thinkingLevel
              : DEFAULT_THINKING_VALUE
          }
          onChange={(v) =>
            setThinkingLevel(v === DEFAULT_THINKING_VALUE ? null : (v as ThinkingLevel))
          }
          options={thinkingOptions}
          disabled={availableLevels.length === 0}
        />
        <TemperatureSlider />
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">Generation</h3>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={useBlueprint}
            onChange={(e) => setUseBlueprint(e.target.checked)}
          />
          <span>
            Design a floor plan first
            <small className="settings-toggle-hint">
              The Architect plans rooms, roles and connections, and the map is laid out
              from that. Off, rooms are scattered by density alone.
            </small>
          </span>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={autoDescribe}
            onChange={(e) => setAutoDescribe(e.target.checked)}
          />
          <span>
            Describe rooms after generating
            <small className="settings-toggle-hint">
              Generating geometry is free; describing it calls the model once per room.
            </small>
          </span>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={captureReasoning}
            onChange={(e) => setCaptureReasoning(e.target.checked)}
          />
          <span>
            Keep the model's reasoning
            <small className="settings-toggle-hint">
              Records why it chose the values it did. Costs nothing extra - thinking
              tokens are billed either way.
            </small>
          </span>
        </label>
      </section>
    </div>
  );
}
