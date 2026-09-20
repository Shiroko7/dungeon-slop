import { test, expect } from "bun:test";
import { operationStream } from "./stream.ts";
import { deferred } from "../test-fixtures.ts";
import { OperationScope, events } from "../store/operation.ts";

test("cancelling the response reader aborts the provider signal immediately", async () => {
  const stopped = deferred<void>();
  const response = operationStream(
    new Request("http://localhost"),
    async (controller, signal) => {
      controller.enqueue(new TextEncoder().encode("first"));
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped.resolve();
            resolve();
          },
          { once: true },
        ),
      );
    },
  );
  const reader = response.getReader();
  await reader.read();
  await reader.cancel();
  await stopped.promise;
});
test("request cancellation propagates through the stream", async () => {
  const abort = new AbortController();
  const stopped = deferred<void>();
  const stream = operationStream(
    new Request("http://localhost", { signal: abort.signal }),
    async (_, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped.resolve();
            resolve();
          },
          { once: true },
        ),
      );
    },
  );
  abort.abort();
  await stopped.promise;
  expect((await stream.getReader().read()).done).toBe(true);
});
test("early completion and parse failure never double-close", async () => {
  const stream = operationStream(
    new Request("http://localhost"),
    async (controller) => {
      controller.close();
      controller.close();
      controller.enqueue(new Uint8Array());
    },
  );
  expect((await stream.getReader().read()).done).toBe(true);
});
test("an old operation cannot settle or commit over its replacement", () => {
  let settled = 0;
  const scope = new OperationScope(() => settled++);
  const old = scope.begin();
  const current = scope.begin();
  const before = settled;
  old.finish();
  expect(settled).toBe(before);
  expect(old.signal.aborted).toBe(true);
  expect(() => old.assert()).toThrow("cancelled");
  expect(current.valid()).toBe(true);
  scope.cancel();
  expect(current.valid()).toBe(false);
});
