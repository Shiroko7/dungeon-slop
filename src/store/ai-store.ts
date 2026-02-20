import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AIState {
  temperature: number;
  provider: string;
  setTemperature: (temp: number) => void;
  setProvider: (provider: string) => void;
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      temperature: 0.7,
      provider: "ollama",
      setTemperature: (temp) => set({ temperature: temp }),
      setProvider: (provider) => set({ provider }),
    }),
    {
      name: "dungeon-slop-ai",
      partialize: (state) => ({
        temperature: state.temperature,
        provider: state.provider,
      }),
    },
  ),
);
