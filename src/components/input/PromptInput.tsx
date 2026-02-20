import { useCallback } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useAIStore } from "../../store/ai-store.ts";
import { useUIStore } from "../../store/ui-store.ts";
import { DungeonConfigSchema } from "../../ai/schema.ts";
import { LoadingSpinner } from "../shared/LoadingSpinner.tsx";

export function PromptInput() {
  const prompt = useUIStore((s) => s.promptText);
  const setPrompt = useUIStore((s) => s.setPromptText);

  const isGeneratingConfig = useDungeonStore((s) => s.isGeneratingConfig);
  const setIsGeneratingConfig = useDungeonStore((s) => s.setIsGeneratingConfig);
  const setConfigRawText = useDungeonStore((s) => s.setConfigRawText);
  const setConfig = useDungeonStore((s) => s.setConfig);
  const setClarificationQuestion = useDungeonStore((s) => s.setClarificationQuestion);
  const addConversationMessage = useDungeonStore((s) => s.addConversationMessage);
  const clarificationQuestion = useDungeonStore((s) => s.clarificationQuestion);

  const temperature = useAIStore((s) => s.temperature);
  const provider = useAIStore((s) => s.provider);

  const handleGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isGeneratingConfig) return;

    setIsGeneratingConfig(true);
    setConfigRawText("");
    setClarificationQuestion(null);
    addConversationMessage("user", trimmed);
    setPrompt("");

    const history = useDungeonStore.getState().conversationHistory;
    let accumulated = "";

    try {
      const response = await fetch("/api/generate-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          temperature,
          provider,
          conversationHistory: history,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (parsed.text) {
            accumulated += parsed.text as string;
            setConfigRawText(accumulated);
          } else if (parsed.type === "config") {
            const configResult = DungeonConfigSchema.safeParse(parsed.config);
            if (configResult.success) {
              const c = configResult.data;
              const summary = `Config ready — ${c.room_count} rooms, ${c.corridors.toLowerCase()} corridors, ${c.motif.toLowerCase()} motif, ${c.grid_width}×${c.grid_height} grid.`;
              addConversationMessage("assistant", summary);
              setConfig(c);
            } else {
              addConversationMessage("assistant", accumulated);
            }
          } else if (parsed.type === "clarification") {
            addConversationMessage("assistant", parsed.clarification as string);
            setClarificationQuestion(parsed.clarification as string);
          } else if (parsed.error) {
            console.error("SSE error:", parsed.error);
          }
        }
      }
    } catch (err) {
      console.error("Config generation failed:", err);
    } finally {
      setIsGeneratingConfig(false);
    }
  }, [
    prompt,
    isGeneratingConfig,
    temperature,
    provider,
    setIsGeneratingConfig,
    setConfigRawText,
    setConfig,
    setClarificationQuestion,
    addConversationMessage,
    setPrompt,
  ]);

  return (
    <div className="chat-compose-inner">
      <textarea
        className="chat-textarea"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleGenerate();
        }}
        placeholder={
          clarificationQuestion
            ? "Type your reply…"
            : "Describe your dungeon… (Ctrl+Enter to send)"
        }
        rows={3}
        disabled={isGeneratingConfig}
      />
      <button
        className="chat-send-btn"
        onClick={handleGenerate}
        disabled={!prompt.trim() || isGeneratingConfig}
        title="Generate config (Ctrl+Enter)"
      >
        {isGeneratingConfig ? <LoadingSpinner size={14} /> : "↑"}
      </button>
    </div>
  );
}
