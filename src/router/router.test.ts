import { describe, test, expect } from "bun:test";
import { campaignOf, parseRoute, paths } from "./router.ts";

describe("parseRoute", () => {
  test("the root is the campaign picker", () => {
    expect(parseRoute("/")).toEqual({ view: "picker" });
    expect(parseRoute("")).toEqual({ view: "picker" });
  });

  test("each level of the tree has its own route", () => {
    expect(parseRoute("/c/3")).toEqual({ view: "campaign", campaignId: 3 });
    expect(parseRoute("/c/3/notes")).toEqual({ view: "notes", campaignId: 3 });
    expect(parseRoute("/c/3/chat/8")).toEqual({ view: "chat", campaignId: 3, chatId: 8 });
    expect(parseRoute("/c/3/d/5")).toEqual({
      view: "dungeon",
      campaignId: 3,
      dungeonId: 5,
      roomId: null,
    });
    expect(parseRoute("/c/3/d/5/r/4")).toEqual({
      view: "dungeon",
      campaignId: 3,
      dungeonId: 5,
      roomId: 4,
    });
  });

  test("a trailing slash is not a different route", () => {
    expect(parseRoute("/c/3/")).toEqual(parseRoute("/c/3"));
    expect(parseRoute("/c/3/d/5/r/4/")).toEqual(parseRoute("/c/3/d/5/r/4"));
  });

  test("anything unrecognised is reported rather than guessed at", () => {
    expect(parseRoute("/c/abc")).toEqual({ view: "unknown", path: "/c/abc" });
    expect(parseRoute("/c/3/dungeons")).toEqual({ view: "unknown", path: "/c/3/dungeons" });
    expect(parseRoute("/nope")).toEqual({ view: "unknown", path: "/nope" });
  });

  test("a room route is not confused with a dungeon route", () => {
    const room = parseRoute("/c/1/d/2/r/3");
    expect(room.view).toBe("dungeon");
    expect(room.view === "dungeon" && room.roomId).toBe(3);
  });
});

describe("path builders round-trip", () => {
  test("document and passage addresses retain campaign, document and revision identity", () => {
    expect(parseRoute(paths.note(3, 8, 2))).toEqual({ view: "note", campaignId: 3, documentId: 8, revision: 2, chunkId: null });
    expect(parseRoute(paths.note(3, 8, 2, 45))).toEqual({ view: "note", campaignId: 3, documentId: 8, revision: 2, chunkId: 45 });
    expect(campaignOf(parseRoute(paths.note(3, 8, 2, 45)))).toBe(3);
  });
  test("every builder produces a path that parses back to itself", () => {
    expect(parseRoute(paths.picker())).toEqual({ view: "picker" });
    expect(parseRoute(paths.campaign(3))).toEqual({ view: "campaign", campaignId: 3 });
    expect(parseRoute(paths.notes(3))).toEqual({ view: "notes", campaignId: 3 });
    expect(parseRoute(paths.chat(3, 8))).toEqual({ view: "chat", campaignId: 3, chatId: 8 });
    expect(parseRoute(paths.dungeon(3, 5))).toEqual({
      view: "dungeon",
      campaignId: 3,
      dungeonId: 5,
      roomId: null,
    });
    expect(parseRoute(paths.room(3, 5, 4))).toEqual({
      view: "dungeon",
      campaignId: 3,
      dungeonId: 5,
      roomId: 4,
    });
  });
});

describe("campaignOf", () => {
  test("every in-campaign route reports its campaign", () => {
    expect(campaignOf(parseRoute("/c/7"))).toBe(7);
    expect(campaignOf(parseRoute("/c/7/notes"))).toBe(7);
    expect(campaignOf(parseRoute("/c/7/chat/1"))).toBe(7);
    expect(campaignOf(parseRoute("/c/7/d/2/r/3"))).toBe(7);
  });

  test("the picker and unknown paths belong to no campaign", () => {
    expect(campaignOf(parseRoute("/"))).toBeNull();
    expect(campaignOf(parseRoute("/nonsense"))).toBeNull();
  });
});
