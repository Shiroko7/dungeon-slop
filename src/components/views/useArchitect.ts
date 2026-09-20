import { useCallback } from "react";
import {
  useDungeonStore,
  beginDungeonOperation,
  prepareAI,
} from "../../store/dungeon-store.ts";
import { events } from "../../store/operation.ts";
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
  return useCallback(runArchitect, []);
}

/** Exported separately so the complete config → blueprint lifecycle is testable
 * without a mounted React tree or live model credentials.
 */
export async function runArchitect(text: string): Promise<void> {
  const {
    temperature,
    provider,
    model,
    thinkingLevel,
    captureReasoning,
    useBlueprint,
  } = useAIStore.getState();
  const chatState = useChatStore.getState();
  const dungeonState = useDungeonStore.getState();
  if (
    !chatState.chat ||
    chatState.chat.dungeonId !== dungeonState.dungeonId ||
    dungeonState.isGeneratingConfig ||
    dungeonState.isGeneratingBlueprint
  )
    return;
  const operation = beginDungeonOperation();
  dungeonState.setIsGeneratingConfig(true);
  dungeonState.setConfigRawText("");
  dungeonState.setClarificationQuestion(null);
  try {
    if (!(await chatState.send(text)))
      throw new Error("Save the message before generating a reply.");
    operation.assert();
    const ctx = await prepareAI(operation);
    let accumulated = "";
    let gotConfig = false;
    for await (const parsed of events(
      "/api/generate-config",
      {
        prompt: text,
        ...ctx,
        temperature,
        provider,
        model,
        thinkingLevel,
        includeThoughts: captureReasoning,
      },
      operation,
    )) {
      if (typeof parsed.text === "string") {
        accumulated += parsed.text;
        useDungeonStore.getState().setConfigRawText(accumulated);
      } else if (parsed.type === "config") {
        const result = DungeonConfigSchema.safeParse(parsed.config);
        if (!result.success)
          throw new Error("The Architect returned an invalid config.");
        gotConfig = true;
        operation.commit(() =>
          useDungeonStore.getState().setProposedConfig(result.data),
        );
        await useChatStore
          .getState()
          .recordAssistant(
            `Config ready — ${result.data.room_count} rooms. ${useBlueprint ? "Designing the floor plan…" : "Ready to generate."}`,
          );
      } else if (
        parsed.type === "clarification" &&
        typeof parsed.clarification === "string"
      ) {
        useDungeonStore
          .getState()
          .setClarificationQuestion(parsed.clarification);
        await useChatStore.getState().recordAssistant(parsed.clarification);
      }
    }
    operation.assert();
    if (gotConfig && useBlueprint) {
      const plan = await useDungeonStore
        .getState()
        .generateBlueprint(text, operation);
      operation.assert();
      if (plan)
        await useChatStore
          .getState()
          .recordAssistant(
            `Floor plan ready — ${plan.nodes.length} rooms. Hit Generate to lay it out.`,
          );
    }
  } catch (err) {
    if (operation.valid())
      useDungeonStore
        .getState()
        .setError(
          err instanceof Error ? err.message : "Config generation failed",
        );
  } finally {
    operation.finish();
  }
}
