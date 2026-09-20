import { API_HOST } from "./api/origin.ts";
import { join } from "node:path";
import { handleApiRoute } from "./api/routes.ts";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DIST = join(import.meta.dir, "..", "dist");

/**
 * The app has real URLs now (`/c/3/d/5/r/4`), and every one of them has to
 * return the same HTML — the router runs in the browser. Without this fallback
 * a reload or a pasted link would 404, which is the classic way a client-side
 * router looks broken in production. In development Vite does the same thing.
 */
async function serveStatic(pathname: string): Promise<Response | null> {
  // Reject traversal before touching the filesystem.
  if (pathname.includes("..")) return null;

  if (pathname !== "/") {
    const file = Bun.file(join(DIST, pathname));
    if (await file.exists()) return new Response(file);
  }

  const index = Bun.file(join(DIST, "index.html"));
  if (await index.exists()) {
    return new Response(index, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return null;
}

Bun.serve({
  port: PORT,
  hostname: API_HOST,
  // Bun defaults to 10s, which is shorter than a single describe call: with
  // thinking on, time-to-first-token alone can pass that, and the connection is
  // genuinely idle until the first SSE frame. 255 is Bun's ceiling and sits just
  // under the provider's own 300s abort.
  idleTimeout: 255,
  async fetch(req) {
    const pathname = new URL(req.url).pathname;

    const apiResponse = await handleApiRoute(req, pathname);
    if (apiResponse) return apiResponse;

    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "No such endpoint" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const staticResponse = await serveStatic(pathname);
    if (staticResponse) return staticResponse;

    return new Response("No build found — run `bun run build` first.", {
      status: 404,
    });
  },
});

console.log(`Server running at http://${API_HOST}:${PORT}`);
