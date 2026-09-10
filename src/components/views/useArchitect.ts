import { useCallback } from "react";
import { useDungeonStore } from "../../store/dungeon-store.ts";
import { useChatStore } from "../../store/chat-store.ts";
import { useAIStore } from "../../store/ai-store.ts";
import { DungeonConfigSchema } from "../../ai/schema.ts";

/**
 * The Architect turn: describe a map, get a config back.
 *
 * The conversation is the dungeon's build log, so it is read from and written
 * to the dungeon's own chat thread rather than held in component state. The
 * config it produces goes to the dungeon store, which autosaves it.
 */
export function useArchitect(): (text: string) => Promise<void> {
  const temperature = useAIStore((s) => s.temperature);
  const provider = useAIStore((s) => s.provider);
  const model = useAIStore((s) => s.model);
  const thinkingLevel = useAIStore((s) => s.thinkingLevel);
  const captureReasoning = useAIStore((s) => s.captureReasoning);
  const useBlueprint = useAIStore((s) => s.useBlueprint);

  return useCallback(
    async (text: string) => {
      const chatState = useChatStore.getState();
      const dungeonState = useDungeonStore.getState();
      if (chatState.chat === null || dungeonState.isGeneratingConfig) return;

      dungeonState.setIsGeneratingConfig(true);
      dungeonState.setConfigRawText("");
      dungeonState.setClarificationQuestion(null);

      await chatState.send(text);

      // Read back after the send so the turn just added is included.
      const history = (useChatStore.getState().chat?.messages ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      let accumulated = "";
      let gotConfig = false;

      try {
        const response = await fetch("/api/generate-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: text,
            temperature,
            provider,
            model,
            thinkingLevel,
            includeThoughts: captureReasoning,
            campaignId: dungeonState.campaignId,
            dungeonId: dungeonState.dungeonId,
            chatId: chatState.chat?.id ?? null,
            conversationHistory: history,
          }),
        });
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

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

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (parsed.text) {
              accumulated += parsed.text as string;
              useDungeonStore.getState().setConfigRawText(accumulated);
            } else if (parsed.type === "config") {
              const result = DungeonConfigSchema.safeParse(parsed.config);
              if (result.success) {
                const c = result.data;
                gotConfig = true;
                useDungeonStore.getState().setConfig(c);
                await useChatStore
                  .getState()
                  .recordAssistant(
                    `Config ready — ${c.room_count} rooms, ${c.corridors.toLowerCase()} corridors, ` +
                      `${c.motif.toLowerCase()} motif, ${c.grid_width}×${c.grid_height} grid.`,
                  );
              } else {
                await useChatStore.getState().recordAssistant(accumulated);
              }
            } else if (parsed.type === "clarification") {
              const question = parsed.clarification as string;
              await useChatStore.getState().recordAssistant(question);
              useDungeonStore.getState().setClarificationQuestion(question);
            } else if (parsed.error) {
              useDungeonStore.getState().setError(String(parsed.error));
            }
          }
        }
      } catch (err) {
        useDungeonStore
          .getState()
          .setError(err instanceof Error ? err.message : "Config generation failed");
      } finally {
        useDungeonStore.getState().setIsGeneratingConfig(false);
      }

      // The floor plan is a second call, made only once a config actually
      // landed - a clarification question means the model does not yet know
      // what it is designing, and planning rooms for it would be guesswork
      // billed as insight.
      if (gotConfig && useBlueprint) {
        const plan = await useDungeonStore.getState().generateBlueprint(text);
        if (plan !== null) {
          const wings = new Set(
            plan.nodes.map((n) => n.wing).filter((w): w is string => w != null),
          );
          await useChatStore
            .getState()
            .recordAssistant(
              `Floor plan ready - ${plan.nodes.length} rooms across ` +
                `${Math.max(...plan.nodes.map((n) => n.tier)) + 1} tiers` +
                (wings.size > 0 ? `, ${wings.size} wings` : "") +
                `. Hit Generate to lay it out.`,
            );
        }
      }
    },
    [temperature, provider, model, thinkingLevel, captureReasoning, useBlueprint],
  );
}
