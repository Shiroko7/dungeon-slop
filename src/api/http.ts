/** Small shared helpers so every handler answers in the same shape. */

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function badRequest(message: string): Response {
  return json({ error: message, code: "invalid_request" }, 400);
}

export function notFound(message = "Not found"): Response {
  return json({ error: message, code: "owner_missing" }, 404);
}

export function serverError(err: unknown): Response {
  return json(
    { error: err instanceof Error ? err.message : "Request failed" },
    500,
  );
}

/** Route ids are always positive integers; anything else is a bad request, not a 404. */
export function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as T)
      : null;
  } catch {
    return null;
  }
}
