# dungeon-core

The CPU-bound half of the generator, in Rust, compiled to WASM and called from
the TypeScript app.

## Why

The engine is ~6,800 lines of pure computation — seeded PRNG, grid sweeps, BSP
partitioning, cellular automata, corridor carving, polygon work — with exactly
one runtime dependency (`zod`, for validation, which the type system replaces
here). That is the shape of thing Rust is actually better at, rather than a
language chosen for its own sake.

It also gets stronger tests. The TypeScript suite is already written as
invariants rather than snapshots, which is why it survives tuning the generator.
`proptest` takes the same invariants and *searches* for counterexamples,
shrinking any failure to the smallest input that still breaks. "This held for
the dungeons we tried" becomes "this held across thousands of generated inputs."

## The hard constraint

The generator is **seeded**, so the port is only correct if it reproduces the
original exactly. A dungeon that is merely plausible is a different dungeon, and
every map anyone shared as a seed would break.

`../conformance/golden.json` freezes the TypeScript behaviour. `tests/conformance.rs`
checks the port against it — the raw PRNG stream across seven seeds, the same
stream 10,000 draws deep, and every derived helper (`next_int`, `next_float`,
`shuffle`, `pick`, `chance`), where an off-by-one would otherwise hide behind a
perfect-looking raw stream.

Those assertions compare `f64` with `==` on purpose. These are not
"close enough" quantities; an epsilon would hide exactly the bug the file exists
to catch.

See `../conformance/README.md` for the one real subtlety — the PRNG accumulator
does not wrap in JavaScript, and where that stops mattering.

## Status

| module      | state                                  |
|-------------|----------------------------------------|
| `random`    | ported, conformance-verified           |
| `types`     | ported                                 |
| `grid`      | ported                                 |
| `bsp`       | TypeScript only                        |
| `cellular`  | TypeScript only                        |
| `corridors` | TypeScript only                        |
| `shapes`    | TypeScript only                        |

The app still runs entirely on the TypeScript engine. Nothing is wired to WASM
yet — the Rust is verified against the golden, not yet in the hot path.

## Working on it

```bash
cd rust
cargo test                                      # unit + conformance + proptest
cargo clippy --all-targets -- -D warnings
cargo fmt
cargo build --release --target wasm32-unknown-unknown
```

Regenerate the golden only when the TypeScript engine's behaviour is
*intentionally* changed — it is the reference the port is checked against, so
refreshing it to make a failing test pass defeats the point:

```bash
bun run conformance/generate-golden.ts
```

### Toolchain note (Windows)

Built against `stable-x86_64-pc-windows-gnu`. The GNU toolchain needs
mingw-w64 **binutils** on `PATH` — `rustup` bundles a linker but not `dlltool`,
and without it any dependency that links a Windows DLL (`windows-sys`, reached
via `proptest` → `getrandom`) fails with `error calling dlltool 'dlltool.exe': program not found`.

`winget install BrechtSanders.WinLibs.POSIX.MSVCRT` supplies it. MSVCRT rather
than UCRT, to match what `x86_64-pc-windows-gnu` targets.
