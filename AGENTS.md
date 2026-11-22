# Dungeon Slop workflow

## Revising an existing scene

1. Open the exact saved scene in Puzzle Slop. Identify its 2D layers and its 3D representation before editing. For scenes with custom 3D, find the ground-only textures, models, material textures, layout data and the renderer rule that selects them. Keep a copy of the current scene and its art for comparison.
2. Apply each layout change at the same map coordinates in both views. Moving or resizing a prop also moves or resizes its 3D model, floor markings, shadows and any associated collision or sight blockers. Reuse a shared layout when available. Carry over the scene and layer IDs, placement bounds, tokens, drawings, doors, fog and terrain for art-only revisions.
3. Package the UVTT and stage the changes in a copy of the actual scene. Update the 3D renderer's art selection if it uses a map image URL, content hash or asset ID that the revision changes. A fresh UVTT import can fall back to the painted map on the floor and miss the original scene's custom 3D entirely.
4. Before review, open the staged scene in the VTT in both 2D and 3D. Inspect each changed feature at token scale from above and at eye level. Confirm the 3D view loads the intended geometry and textures, including any props that disappeared from the ground-only art. Confirm that the edit preserves the scene state outside its scope. Include the 2D and 3D checks in the handoff. If a check is blocked, report it as pending before calling the revision ready.
