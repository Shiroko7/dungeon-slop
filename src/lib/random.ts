export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const v = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return v >= 1 ? 0.9999999999 : v;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  shuffle<T>(array: readonly T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const temp = result[i]!;
      result[i] = result[j]!;
      result[j] = temp;
    }
    return result;
  }

  pick<T>(array: readonly T[]): T {
    if (array.length === 0) {
      throw new Error("Cannot pick from an empty array");
    }
    return array[Math.floor(this.next() * array.length)]!;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
