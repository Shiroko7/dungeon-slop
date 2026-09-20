/** An owner has one interactive operation, including all chained AI phases.
 * A local edit or navigation invalidates it synchronously; even a transport that
 * ignores AbortSignal cannot commit a late response.
 */
export class OperationScope {
  private current: Operation | null = null;
  constructor(private settled: () => void = () => {}) {}
  begin(): Operation {
    this.cancel();
    const controller = new AbortController();
    const operation: Operation = {
      id: crypto.randomUUID(),
      signal: controller.signal,
      valid: () => this.current === operation && !controller.signal.aborted,
      assert: () => {
        if (!operation.valid())
          throw new DOMException("Operation cancelled", "AbortError");
      },
      cancel: () => controller.abort(),
      finish: () => {
        if (this.current === operation) {
          this.current = null;
          this.settled();
        }
      },
    };
    this.current = operation;
    return operation;
  }
  cancel() {
    this.current?.cancel();
    this.current = null;
    this.settled();
  }
}
export interface Operation {
  id: string;
  signal: AbortSignal;
  valid(): boolean;
  assert(): void;
  cancel(): void;
  finish(): void;
}

/** Strict SSE consumption with cancellation and reader cleanup. */
export async function* events(
  path: string,
  body: unknown,
  operation: Operation,
) {
  operation.assert();
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: operation.signal,
  });
  operation.assert();
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      payload?.error ?? `Server responded with ${response.status}`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      operation.assert();
      buffer += done
        ? decoder.decode() + "\n"
        : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const parsed: unknown = JSON.parse(line.slice(5).trim());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Invalid stream event");
        const event = parsed as Record<string, unknown>;
        if (typeof event.error === "string") throw new Error(event.error);
        yield event;
        operation.assert();
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
