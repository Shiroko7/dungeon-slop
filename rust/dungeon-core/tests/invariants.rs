//! Property-based tests.
//!
//! The TypeScript suite already tests by invariant rather than by snapshot -
//! "a corridor never occupies a room cell", "every room outline is a closed
//! ring" - which is why it survives tuning the generator. Those are written
//! against a fixed set of generated dungeons, though.
//!
//! `proptest` takes the same idea further: it searches the input space for a
//! counterexample and, on finding one, shrinks it to the smallest case that
//! still fails. That turns "this held for the dungeons we happened to try" into
//! "this held across thousands of generated inputs, and here is the minimal one
//! that breaks it."

use dungeon_core::{CellType, Grid, SeededRandom};
use proptest::prelude::*;

proptest! {
    /// The clamp in `next` exists because the original has one. If it is ever
    /// removed, this catches the day a draw lands on exactly 1.0.
    #[test]
    fn draws_stay_in_the_unit_interval(seed: i32, draws in 0usize..2_000) {
        let mut r = SeededRandom::new(seed);
        for i in 0..draws {
            let v = r.next_f64();
            prop_assert!((0.0..1.0).contains(&v), "draw {} was {}", i, v);
        }
    }

    #[test]
    fn next_int_respects_its_bounds(seed: i32, a in -10_000i32..10_000, b in -10_000i32..10_000) {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let mut r = SeededRandom::new(seed);
        for _ in 0..64 {
            let v = r.next_int(lo, hi);
            prop_assert!(v >= lo && v <= hi, "{} outside [{}, {}]", v, lo, hi);
        }
    }

    #[test]
    fn next_float_respects_its_bounds(seed: i32, lo in -1_000.0f64..1_000.0, span in 0.0f64..1_000.0) {
        let hi = lo + span;
        let mut r = SeededRandom::new(seed);
        for _ in 0..64 {
            let v = r.next_float(lo, hi);
            prop_assert!(v >= lo && v <= hi, "{} outside [{}, {}]", v, lo, hi);
        }
    }

    /// A shuffle may reorder, and may do nothing, but may never change the
    /// multiset. This is the property that catches a bad swap index.
    #[test]
    fn shuffle_preserves_the_multiset(seed: i32, items in prop::collection::vec(any::<i32>(), 0..128)) {
        let mut r = SeededRandom::new(seed);
        let out = r.shuffle(&items);
        prop_assert_eq!(out.len(), items.len());

        let mut a = items.clone();
        let mut b = out;
        a.sort_unstable();
        b.sort_unstable();
        prop_assert_eq!(a, b);
    }

    /// The same seed must always yield the same stream. Determinism is the
    /// entire premise - if this fails, sharing a seed means nothing.
    #[test]
    fn the_same_seed_always_replays(seed: i32, draws in 1usize..500) {
        let mut a = SeededRandom::new(seed);
        let mut b = SeededRandom::new(seed);
        for i in 0..draws {
            prop_assert_eq!(a.next_f64(), b.next_f64(), "diverged at draw {}", i);
        }
    }

    /// Any coordinate at all, in-bounds or wildly outside. The original returns
    /// `undefined` and ignores stray writes; this must not panic either.
    #[test]
    fn out_of_bounds_access_never_panics(
        w in 1usize..40, h in 1usize..40,
        x in -200i32..200, y in -200i32..200,
    ) {
        let mut g = Grid::new(w, h);
        let inside = g.get(x, y).is_some();
        prop_assert_eq!(inside, g.in_bounds(x, y));
        g.set_type(x, y, CellType::Floor);
        prop_assert_eq!(g.get(x, y).is_some(), inside);
    }

    /// Writes land where they were addressed and nowhere else - the property a
    /// flat buffer with a hand-written index can plausibly get wrong.
    #[test]
    fn a_write_lands_on_exactly_one_cell(
        w in 1usize..30, h in 1usize..30,
        x in 0usize..30, y in 0usize..30,
    ) {
        prop_assume!(x < w && y < h);
        let mut g = Grid::new(w, h);
        g.set_type(x as i32, y as i32, CellType::Floor);

        let mut floors = 0;
        let mut at = None;
        g.for_each(|cx, cy, c| {
            if c.kind == CellType::Floor {
                floors += 1;
                at = Some((cx, cy));
            }
        });
        prop_assert_eq!(floors, 1);
        prop_assert_eq!(at, Some((x as i32, y as i32)));
    }

    #[test]
    fn interior_is_strictly_inside_bounds(w in 1usize..40, h in 1usize..40, x in -5i32..45, y in -5i32..45) {
        let g = Grid::new(w, h);
        if g.is_interior(x, y) {
            prop_assert!(g.in_bounds(x, y), "interior cell ({}, {}) was out of bounds", x, y);
            // and never on the border ring
            prop_assert!(x > 0 && y > 0);
            prop_assert!((x as usize) < w - 1 && (y as usize) < h - 1);
        }
    }

    #[test]
    fn neighbour_counts_never_exceed_the_moore_neighbourhood(
        w in 1usize..25, h in 1usize..25, x in -3i32..28, y in -3i32..28,
    ) {
        let g = Grid::new(w, h);
        prop_assert!(g.count_neighbors(x, y, CellType::Empty, true) <= 8);
        prop_assert!(g.count_neighbors(x, y, CellType::Empty, false) <= 8);
        prop_assert!(g.cardinal_neighbors(x, y).len() <= 4);
    }
}
