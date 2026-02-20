/** Generic min-heap keyed by numeric priority. */
export class MinHeap<T> {
  private data: Array<{ item: T; priority: number }> = [];

  get size(): number {
    return this.data.length;
  }

  push(item: T, priority: number): void {
    this.data.push({ item, priority });
    this.bubbleUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top.item;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i]!.priority >= this.data[parent]!.priority) break;
      [this.data[i], this.data[parent]] = [this.data[parent]!, this.data[i]!];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left]!.priority < this.data[smallest]!.priority) {
        smallest = left;
      }
      if (right < n && this.data[right]!.priority < this.data[smallest]!.priority) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest]!, this.data[i]!];
      i = smallest;
    }
  }
}
