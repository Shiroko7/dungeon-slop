/** Cancels upstream work both on request abort and response-reader cancellation.
 * Closing/enqueueing are idempotent so an early parse failure cannot double-close.
 */
export function operationStream(
  request: Request,
  run: (
    controller: Pick<
      ReadableStreamDefaultController<Uint8Array>,
      "enqueue" | "close"
    >,
    signal: AbortSignal,
  ) => Promise<void>,
): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const safe = {
        enqueue(chunk: Uint8Array) {
          if (!closed && !signal.aborted) controller.enqueue(chunk);
        },
        close() {
          if (!closed) {
            closed = true;
            controller.close();
          }
        },
      };
      void (async () => {
        try {
          await run(safe, signal);
        } catch (err) {
          if (!signal.aborted)
            safe.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ error: err instanceof Error ? err.message : "Stream failed" })}\n\n`,
              ),
            );
        } finally {
          safe.close();
        }
      })();
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });
}
