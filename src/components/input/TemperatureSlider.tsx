import { useAIStore } from "../../store/ai-store.ts";
import { Slider } from "../shared/Slider.tsx";

export function TemperatureSlider() {
  const temperature = useAIStore((s) => s.temperature);
  const setTemperature = useAIStore((s) => s.setTemperature);

  return (
    <Slider
      label="Temperature"
      value={temperature}
      onChange={setTemperature}
      min={0}
      max={1}
      step={0.1}
    />
  );
}
