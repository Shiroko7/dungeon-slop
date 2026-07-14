# Verify dungeon-slop changes in the running app

## Launch

- `bun` lives at `%USERPROFILE%\.bun\bin\bun.exe` (NOT on PATH in non-interactive shells — prepend it).
- `bun run dev` starts both servers via concurrently: API (Bun.serve) on :3000, vite on :5173 with `/api` proxied to :3000. Ready in ~1s; check `curl http://localhost:5173` → 200.

## Get a dungeon on screen without the AI step

The AI is only needed to produce a `DungeonConfig` from natural language. The engine endpoint is pure and deterministic:

1. `POST http://localhost:3000/api/generate-dungeon` with a full `DungeonConfig` JSON (copy `DEFAULT_CONFIG` from `src/ai/schema.ts`, add a fixed `seed`) → `{ dungeon }`.
2. Pre-seed localStorage before app scripts run (zustand persist, key `dungeon-slop-dungeon`):
   ```js
   localStorage.setItem("dungeon-slop-dungeon", JSON.stringify({
     state: { config, dungeon, roomDescriptions: [], dungeonDescription: null, conversationHistory: [] },
     version: 0,
   }));
   ```
3. Load `http://localhost:5173` → the map renders immediately from the restored session.

## Drive the GUI

No playwright browsers are installed under ms-playwright, but **Edge is available**: use `playwright-core` (npm-install it in a scratch dir, not the repo) with `chromium.launch({ channel: "msedge", headless: true })`. Working harness pattern: `verify-phase1.js` in the session scratchpad (contexts at `deviceScaleFactor` 1 and 2, screenshot clips around a mouse anchor to verify zoom anchoring, `.toolbar-zoom-label` innerText as the zoom observable, `[aria-label="Zoom in"/"Zoom out"/"Reset view"]` for toolbar buttons).

## Gotchas

- PowerShell 5.1: don't pipe bun stderr (`2>&1` wraps lines in NativeCommandError); plain `bun test | Select-Object -Last 4` works.
- `bun x tsc --noEmit` has one pre-existing error in `generate.test.ts:852` (iterating possibly-undefined tuple) — not a regression signal.
- Kill the dev server by killing the background shell or by port; `concurrently` spawns two bun processes.
