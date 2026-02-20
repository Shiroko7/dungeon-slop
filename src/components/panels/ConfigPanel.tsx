import { PromptInput } from "../input/PromptInput.tsx";
import { ConfigReadout } from "../input/ConfigReadout.tsx";

export function ConfigPanel() {
  return (
    <div className="config-panel">
      <PromptInput />
      <ConfigReadout />
    </div>
  );
}
