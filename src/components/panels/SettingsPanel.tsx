import { TemperatureSlider } from "../input/TemperatureSlider.tsx";
import { Select } from "../shared/Select.tsx";
import { useAIStore } from "../../store/ai-store.ts";

const providerOptions = [
  { value: "gemini", label: "Gemini Flash" },
  { value: "claude", label: "Claude Haiku" },
  { value: "ollama", label: "Ollama (Local)" },
];

export function SettingsPanel() {
  const provider = useAIStore((s) => s.provider);
  const setProvider = useAIStore((s) => s.setProvider);

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
        <TemperatureSlider />
      </section>
    </div>
  );
}
