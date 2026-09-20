import { json } from "./http.ts";
export const API_HOST = process.env.API_HOST || "127.0.0.1";
export function checkOrigin(req: Request): Response | null {
  const port = process.env.PORT || "3000";
  const allowed = new Set([
    ...["localhost", "127.0.0.1", "[::1]"].flatMap((host) => [
      `http://${host}:${port}`,
      `http://${host}:5173`,
    ]),
    ...(process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]);
  const host = new URL(req.url).hostname;
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...[...allowed].map((origin) => new URL(origin).hostname),
  ]);
  if (!allowedHosts.has(host))
    return json({ error: "Untrusted API host", code: "forbidden_host" }, 403);
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
  const origin = req.headers.get("Origin");
  if (
    (origin !== null && !allowed.has(origin)) ||
    req.headers.get("Sec-Fetch-Site") === "cross-site"
  ) {
    return json(
      {
        error: "This browser origin is not allowed to change local data",
        code: "forbidden_origin",
      },
      403,
    );
  }
  return null; // CLI clients need no Origin; this is not hosted authentication
}
