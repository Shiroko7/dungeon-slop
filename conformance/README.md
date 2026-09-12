# Conformance

The generator is being ported to Rust (compiled to WASM, called from the
existing TypeScript app). A port of a *seeded* generator is only correct if it
reproduces the original exactly: a dungeon that is merely plausible is a
different dungeon, and every map anyone ever shared as a seed would break.

`golden.json` freezes the behaviour of the TypeScript implementation while it is
still authoritative. Regenerate with:

```bash
bun run conformance/generate-golden.ts
```

It pins three things:

1. **Raw `SeededRandom` output** for seven seeds, including `0`, `-1` and
   `2^31 - 1`. Everything downstream rests on this.
2. **The derived helpers** — `nextInt`, `nextFloat`, `shuffle`, `pick`,
   `chance` — which is where an off-by-one in a port hides.
3. **Whole dungeons** for four configurations, reduced to a grid hash plus
   enough summary (dimensions, room count, cell-type histogram, first rooms)
   to say *how* a mismatch differs rather than only that it does.

The generator script also asserts that generating the same config twice in one
process yields the same hash. If that ever fails, the engine is not
deterministic and there is nothing to port *to*.

## One real subtlety: the PRNG accumulator

`SeededRandom` is mulberry32, and the obvious Rust translation is
`state = state.wrapping_add(0x6d2b79f5)` on a `u32`. That is **not** literally
what the TypeScript does:

```ts
let t = (this.state += 0x6d2b79f5);
```

`this.state` is a JavaScript number. It never wraps to 32 bits — it grows
without bound, and truncation to 32 bits happens later, at each use
(`t >>> 15`, `t | 1`, `Math.imul`). While the accumulator is still an exactly
representable integer, that is indistinguishable from `u32` wrapping. Past
`2^53`, f64 can no longer represent consecutive integers and the two diverge.

Both models were checked against `golden.json` and both reproduce it. They
first differ at:

```
draw 4,917,760   (accumulator 9.007e15 == 2^53)
```

**Decision: the Rust port uses `u32` wrapping arithmetic**, and is therefore
*intentionally* not bit-identical to JavaScript beyond ~4.9M draws from a single
`SeededRandom` instance. Two reasons:

- It is unreachable. The largest dungeon the schema permits is 1000x1000
  (`grid_width`/`grid_height` max out there), and generating one consumes
  **3,806 draws** — a 1,292x margin. A 100x100 default map uses 518.
- Past `2^53` the JavaScript behaviour is degenerate, not merely different: the
  accumulator stops advancing by a consistent amount. Reproducing that bug-for-bug
  would be preserving a defect, not compatibility.

Measured draw counts, for the record:

| config              | draws | margin to divergence |
|---------------------|-------|----------------------|
| 100x100 default     |   518 | 9,494x               |
| 100x100 labyrinth   |   599 | 8,210x               |
| 300x300 dense       | 1,664 | 2,955x               |
| 1000x1000 dense     | 3,806 | 1,292x               |

If the engine ever grows a use case that draws millions of numbers from one
instance — very large batch generation on a single RNG, say — revisit this, and
either re-seed per dungeon or model the f64 accumulator explicitly.
