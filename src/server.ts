import { handleApiRoute } from "./api/routes.ts";

const PORT = parseInt(process.env.PORT || "3000", 10);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    const apiResponse = await handleApiRoute(req, pathname);
    if (apiResponse) return apiResponse;

    return new Response("Not found", { status: 404 });
  },
});

console.log(`API server running at http://localhost:${PORT}`);
