import { describe, test, expect } from "bun:test";
import { roomName } from "./room-name.ts";
import type { Room } from "./types.ts";

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 7,
    x: 0, y: 0, width: 5, height: 5, centerX: 2, centerY: 2,
    shape: "Rectangular",
    connections: [],
    features: [],
    ...overrides,
  };
}

describe("roomName", () => {
  test("written text wins over everything", () => {
    const r = room({ plan: { key: "throne", name: "The Frozen Throne" } });
    expect(roomName(r, { name: "Hall of Ash" })).toBe("Hall of Ash");
  });

  test("the planned name shows before anything is described", () => {
    const r = room({ plan: { key: "throne", name: "The Frozen Throne" } });
    expect(roomName(r)).toBe("The Frozen Throne");
    expect(roomName(r, null)).toBe("The Frozen Throne");
  });

  test("a blank written name falls through to the plan", () => {
    const r = room({ plan: { key: "throne", name: "The Frozen Throne" } });
    expect(roomName(r, { name: "   " })).toBe("The Frozen Throne");
  });

  test("junction chambers say what they are", () => {
    expect(roomName(room({ role: "junction" }))).toBe("Junction 7");
  });

  test("an unplanned room falls back to its number", () => {
    expect(roomName(room())).toBe("Room 7");
  });
});
