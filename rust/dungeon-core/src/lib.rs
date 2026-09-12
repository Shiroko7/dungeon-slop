//! Deterministic dungeon generation.
//!
//! A port of the TypeScript engine in `src/engine/`, moving the CPU-bound half
//! of the generator - seeded PRNG, grid, partitioning, corridor carving - into
//! Rust, compiled to WASM and called from the existing app.
//!
//! The port is only correct if it reproduces the original **exactly**. The
//! generator is seeded, so a dungeon that is merely plausible is a different
//! dungeon, and every map anyone has shared as a seed would break. The contract
//! is frozen in `conformance/golden.json` at the repository root and checked by
//! `tests/conformance.rs`.
//!
//! Status: `random` and `grid` are ported and passing conformance. The layout
//! passes (`bsp`, `cellular`, `corridors`) are still TypeScript-only.

pub mod grid;
pub mod random;
pub mod types;

pub use grid::Grid;
pub use random::SeededRandom;
pub use types::{Cell, CellType, Point, Room, RoomRole};
