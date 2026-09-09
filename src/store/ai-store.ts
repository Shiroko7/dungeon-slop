import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ThinkingLevel } from "../ai/types.ts";

interface AIState {
  temperature: number;
  provider: string;
  /** null means "whatever the provider's defaultModel is". */
  model: string | null;
  /** null means "let the API pick" - no thinkingConfig is sent. */
  thinkingLevel: ThinkingLevel | null;
  /** Chain room + overview descriptions onto Generate. */
  autoDescribe: boolean;
  /**
   * Have the Architect design a floor plan (rooms, roles, connections) and lay
   * the map out from it, instead of scattering rooms by density alone.
   */
  useBlueprint: boolean;
  /**
   * Ask for the model's reasoning summary. Free: thinking tokens are billed
   * whether or not the summary is returned, so this only decides whether the
   * text is kept for you to read.
   */
  captureReasoning: boolean;
  setTemperature: (temp: number) => void;
  setProvider: (provider: string) => void;
  setModel: (model: string | null) => void;
  setThinkingLevel: (level: ThinkingLevel | null) => void;
  setAutoDescribe: (on: boolean) => void;
  setUseBlueprint: (on: boolean) => void;
  setCaptureReasoning: (on: boolean) => void;
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      temperature: 0.7,
      provider: "gemini",
      model: null,
      thinkingLevel: null,
      autoDescribe: true,
      useBlueprint: true,
      captureReasoning: true,
      setTemperature: (temp) => set({ temperature: temp }),
      // Model ids are provider-specific, so a provider switch drops back to
      // that provider's default rather than carrying a foreign id across.
      setProvider: (provider) => set({ provider, model: null, thinkingLevel: null }),
      setModel: (model) => set({ model }),
      setThinkingLevel: (thinkingLevel) => set({ thinkingLevel }),
      setAutoDescribe: (autoDescribe) => set({ autoDescribe }),
      setUseBlueprint: (useBlueprint) => set({ useBlueprint }),
      setCaptureReasoning: (captureReasoning) => set({ captureReasoning }),
    }),
    {
      name: "dungeon-slop-ai",
      version: 1,
      // v0 shipped with ollama as the default and no model field. Existing
      // installs have "ollama" persisted, so bumping the initial state alone
      // would not move anyone off it.
      migrate: (persisted, fromVersion) => {
        const state = (persisted ?? {}) as Partial<AIState>;
        const provider = state.provider ?? "gemini";
        return {
          temperature: state.temperature ?? 0.7,
          // v0 pinned ollama, so only that generation gets rewritten.
          provider: fromVersion < 1 && provider === "ollama" ? "gemini" : provider,
          model: fromVersion < 1 ? null : state.model ?? null,
          thinkingLevel: fromVersion < 1 ? null : state.thinkingLevel ?? null,
          autoDescribe: state.autoDescribe ?? true,
          useBlueprint: state.useBlueprint ?? true,
          captureReasoning: state.captureReasoning ?? true,
        };
      },
      partialize: (state) => ({
        temperature: state.temperature,
        provider: state.provider,
        model: state.model,
        thinkingLevel: state.thinkingLevel,
        autoDescribe: state.autoDescribe,
        useBlueprint: state.useBlueprint,
        captureReasoning: state.captureReasoning,
      }),
    },
  ),
);
