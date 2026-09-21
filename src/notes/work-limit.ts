/** Bounds simultaneous provider work and releases waiting requests on cancellation. */
export class WorkLimit {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly maximum: number) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener("abort", cancel); resolve(); };
        const cancel = () => {
          this.waiting = this.waiting.filter((entry) => entry !== ready);
          reject(signal.reason);
        };
        this.waiting.push(ready);
        signal.addEventListener("abort", cancel, { once: true });
      });
    } else {
      this.active++;
    }
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export const noteWork = new WorkLimit(2);
