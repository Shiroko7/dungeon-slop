import { expect, test } from "bun:test";
import { deferred } from "../test-fixtures.ts";
import { WorkLimit } from "./work-limit.ts";

test("provider concurrency stays bounded and queued cancellation frees its position", async () => {
  const limit = new WorkLimit(2);
  const gate = deferred<void>();
  const signal = new AbortController().signal;
  let active = 0;
  let maximum = 0;
  const work = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active--;
  };
  const first = limit.run(signal, work);
  const second = limit.run(signal, work);
  const abort = new AbortController();
  let cancelledWorkRan = false;
  const cancelled = limit.run(abort.signal, async () => { cancelledWorkRan = true; }).catch((error: unknown) => error);
  const fourth = limit.run(signal, work);
  abort.abort();
  expect(active).toBe(2);
  expect(await cancelled).toBeInstanceOf(Error);
  gate.resolve();
  await Promise.all([first, second, fourth]);
  expect(maximum).toBe(2);
  expect(active).toBe(0);
  expect(cancelledWorkRan).toBe(false);
  expect(await limit.run(signal, async () => "released")).toBe("released");
});

test("a failed provider releases its slot for the next request", async () => {
  const limit = new WorkLimit(1);
  const signal = new AbortController().signal;
  const gate = deferred<void>();
  const failure = limit.run(signal, async () => { await gate.promise; throw new Error("offline"); }).catch((error: unknown) => error);
  const next = limit.run(signal, async () => "next");
  gate.resolve();
  expect(await failure).toBeInstanceOf(Error);
  expect(await next).toBe("next");
});
