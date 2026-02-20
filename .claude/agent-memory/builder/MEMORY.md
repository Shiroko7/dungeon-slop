# Builder Agent Memory

## Project: dungeon-slop

### Tech Stack
- Bun runtime, TypeScript 5, React 19, Zustand 5, Zod 3, jsPDF 2
- tsconfig: strict mode, `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`
- All imports use `.ts` extension; type-only imports must use `import type`
- Module: ESNext with bundler resolution, `"type": "module"` in package.json

### File Structure
- `src/ai/schema.ts` - DungeonConfig Zod schema + type + DEFAULT_CONFIG
- `src/ai/types.ts` - AIMessage, AICompletionOptions, AICompletionResult, AIProvider interfaces
- `src/engine/types.ts` - Dungeon, Room, Corridor, Feature, RoomDescription, Cell, CellType, FeatureType
- `src/engine/grid.ts` - Grid logic
- `src/lib/math.ts`, `random.ts`, `validation.ts` - Utility modules
- `src/store/` - Zustand stores (dungeon-store, ai-store, ui-store, history-store)

### Code Style
- Double quotes for strings
- 2-space indentation
- Non-null assertions with `!` used for array access (see random.ts pattern)
- Interfaces preferred over type aliases for object shapes
- `const` for initial state objects extracted outside `create()` calls
- Zustand stores use `create<T>()((set, get) => ({...}))` pattern (curried for TS)

### Zustand Patterns (v5)
- `persist` middleware from `zustand/middleware` for localStorage
- `partialize` used in persist to exclude functions and transient state
- Map state updated immutably: `new Map(state.map)` then `.set()`
- `undo/redo` uses `get()` to read before `set()` for return values
- `reset` creates fresh instances of mutable objects (Map, Array)

### API Layer (src/api/)
- `routes.ts` - Central router: `handleApiRoute(req, pathname) -> Response | null`
- `validate-key.ts` - POST /api/validate-key - validates AI provider API keys
- `generate-config.ts` - POST /api/generate-config - SSE stream for AI config generation
- `generate-dungeon.ts` - POST /api/generate-dungeon - sync dungeon grid generation
- `describe-rooms.ts` - POST /api/describe-rooms + /api/describe-room/:id - SSE room descriptions
- SSE format: `event: token|complete|error\ndata: JSON\n\n`
- Error pattern: try/catch with `err instanceof Error ? err.message : "fallback"`
- JSON responses always set `Content-Type: application/json` header

### Server (src/index.ts)
- Bun.build bundles frontend.tsx -> dist/
- HTML template injection: CSS inlined, JS as script tag
- Serves: API routes -> dist JS -> public/ static -> SPA catch-all

### AI Provider Layer (src/ai/)
- `types.ts` - AIMessage, AICompletionOptions, AICompletionResult, AIProvider interfaces
- `schema.ts` - DungeonConfigSchema (zod), DungeonConfig type, DEFAULT_CONFIG
- `provider-registry.ts` - getProvider(name), getProviderNames(), getAllProviders()
- `providers/claude.ts` - claudeProvider singleton (raw fetch to Anthropic API)
- `providers/openai.ts` - openaiProvider singleton (raw fetch to OpenAI API)
- `providers/gemini.ts` - geminiProvider singleton (raw fetch to Google Gemini API)
- `prompts/architect.ts` - ARCHITECT_SYSTEM_PROMPT + buildArchitectMessages(prompt, history?)
- `prompts/narrator.ts` - NARRATOR_SYSTEM_PROMPT + buildNarratorMessages(rooms, config)
- All providers: complete(), streamComplete() (SSE parsing), validateApiKey()
- Stream parsing uses ReadableStream reader + TextDecoder + line-based SSE buffering

### Renderer Layer (src/renderer/)
- `themes/theme-engine.ts` - ThemePalette interface, getTheme(motif) -> palette
- `themes/default.ts`, `infernal.ts`, `aquatic.ts` - Theme palettes
- `canvas-renderer.ts` - renderDungeon(), getCellAtPixel(), getRoomAtCell()
- `svg-overlay.ts` - FEATURE_ICONS record with SVG path data for map icons

### Export Layer (src/export/)
- `png-export.ts` - exportPNG(dungeon, cellSize?) - offscreen canvas -> blob download
- `pdf-export.ts` - exportPDF(dungeon) - jsPDF with map page + room key pages
- `vtt-export.ts` - exportVTT(dungeon) - DD2VTT format with wall segments + portals

### Components (src/components/)
- `shared/` - Button (primary/secondary/icon, sm/md), LoadingSpinner, Select, Slider
- `layout/` - AppShell (flex shell), Sidebar (tabs + panels), Toolbar (actions + zoom)
- `input/` - PromptInput (SSE streaming), ConfigReadout (field display), TemperatureSlider
- `panels/` - ConfigPanel, SettingsPanel, RoomPanel, ExportPanel
- `canvas/` - DungeonCanvas (2D canvas + mouse events), SvgOverlay (feature icons), RoomTooltip
- CELL_SIZE = 16 used in DungeonCanvas and SvgOverlay
- CSS classes reference: .app-shell, .sidebar, .toolbar, .spinner, .slider-container, etc.

### Engine Modules (src/engine/)
- `types.ts` - CellType/FeatureType enums, Cell/Room/Corridor/Feature/Dungeon interfaces
- `grid.ts` - 2D grid utilities: createGrid, getCell, setCell, setCellType, forEachCell, getNeighbors, countNeighborsByType, cloneGrid, isInBounds
- `bsp.ts` - BSP room generation (BSPNode, generateBSP). Size ranges: Tiny=3-5, Small=4-7, Medium=5-10, Large=8-15, Huge=12-20
- `cellular.ts` - Cellular automata caves (generateCellular). B678/S345678 rule, flood-fill regions, extractChambers
- `graph.ts` - Delaunay triangulation (Bowyer-Watson), MST (Kruskal's w/ Union-Find), selectCorridorEdges
- `corridors.ts` - carveCorridors: Straight (L-shaped), Winding (waypoints), Labyrinth (A* with noise)
- `features.ts` - placeFeatures: doors, secret doors, traps, treasure, stairs
- `generate.ts` - generateDungeon orchestrator: seed -> grid -> rooms -> walls -> triangulation -> corridors -> features -> walls

### DungeonConfig Field Names (IMPORTANT - schema uses capitalized values)
- `corridors` NOT `corridor_style` - values: "Straight"/"Winding"/"Labyrinth"
- `door_type` NOT `door_style` - values: "Open"/"Standard"/"Locked"/"Secure"/"Secret"
- `room_count` is number (3-50), NOT string enum
- `corridor_complexity` is number (0-1), NOT string enum
- `grid_width`/`grid_height` are numbers (20-100), NOT `grid_size` enum
- Density values: "None"/"Low"/"Medium"/"High" (trap_density, treasure_density)
- Stairs values: "None"/"Few"/"Many"
