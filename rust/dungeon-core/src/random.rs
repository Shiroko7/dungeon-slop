//! Mulberry32, ported from `src/lib/random.ts`.
//!
//! This is the load-bearing piece of the whole port. The generator is seeded,
//! so every downstream algorithm is only correct if this produces the identical
//! stream of doubles. `tests/conformance.rs` checks it against vectors frozen
//! from the TypeScript implementation.
//!
//! ## Why `wrapping_add` on a `u32` when the TypeScript does not wrap
//!
//! The original reads:
//!
//! ```js
//! let t = (this.state += 0x6d2b79f5);
//! ```
//!
//! `this.state` is a JavaScript number. It never wraps to 32 bits - it grows
//! without bound, and truncation happens later, at each use (`t >>> 15`,
//! `t | 1`, `Math.imul`). That is indistinguishable from `u32` wrapping while
//! the accumulator remains an exactly representable integer, and diverges once
//! it passes `2**53`, where f64 can no longer represent consecutive integers.
//!
//! Verified: the two first differ at draw **4,917,760**.
//!
//! This port wraps, and so is intentionally not bit-identical beyond that
//! point. Generating the largest dungeon the schema permits (1000x1000) draws
//! 3,806 numbers - a 1,292x margin - and past `2**53` the JavaScript behaviour
//! is degenerate rather than merely different. See `conformance/README.md`.

/// Seeded PRNG producing the same sequence as the TypeScript `SeededRandom`.
#[derive(Debug, Clone)]
pub struct SeededRandom {
    state: u32,
}

impl SeededRandom {
    /// `seed` is an `i32` because the TypeScript coerces with `seed | 0`.
    pub fn new(seed: i32) -> Self {
        Self { state: seed as u32 }
    }

    /// Next double in `[0, 1)`.
    ///
    /// Named `next_f64` rather than `next` so it cannot be mistaken for
    /// `Iterator::next`, and to match the `next_u32` / `next_u64` convention.
    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        let v = f64::from(t ^ (t >> 14)) / 4_294_967_296.0;
        // The original clamps rather than rejecting, so the port must too.
        if v >= 1.0 {
            0.999_999_999_9
        } else {
            v
        }
    }

    /// Integer in `[min, max]`, inclusive at both ends.
    pub fn next_int(&mut self, min: i32, max: i32) -> i32 {
        let span = f64::from(max - min + 1);
        (self.next_f64() * span).floor() as i32 + min
    }

    /// Float in `[min, max)`.
    pub fn next_float(&mut self, min: f64, max: f64) -> f64 {
        self.next_f64() * (max - min) + min
    }

    /// Fisher-Yates, descending, matching the original's draw order exactly.
    ///
    /// The index order matters as much as the result: shuffling differently
    /// would still be a shuffle, but it would consume the stream differently
    /// and every later draw would diverge.
    pub fn shuffle<T: Clone>(&mut self, items: &[T]) -> Vec<T> {
        let mut out = items.to_vec();
        if out.len() < 2 {
            return out;
        }
        for i in (1..out.len()).rev() {
            let j = (self.next_f64() * ((i + 1) as f64)).floor() as usize;
            out.swap(i, j);
        }
        out
    }

    /// One element at random.
    ///
    /// Diverges from the TypeScript deliberately: the original throws on an
    /// empty slice, which is a panic in Rust for a case the caller can see
    /// coming. Returns `None` instead. No draw is consumed when empty, which
    /// matches the original - it throws before calling `next`.
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() {
            return None;
        }
        let idx = (self.next_f64() * (items.len() as f64)).floor() as usize;
        items.get(idx)
    }

    /// True with the given probability.
    pub fn chance(&mut self, probability: f64) -> bool {
        self.next_f64() < probability
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_reproducible_from_the_same_seed() {
        let a: Vec<f64> = (0..64).map(|_| SeededRandom::new(7).next_f64()).collect();
        assert!(
            a.windows(2).all(|w| w[0] == w[1]),
            "a fresh seed must restart the stream"
        );

        let mut x = SeededRandom::new(7);
        let mut y = SeededRandom::new(7);
        for i in 0..1000 {
            assert_eq!(x.next_f64(), y.next_f64(), "diverged at draw {i}");
        }
    }

    #[test]
    fn output_stays_in_unit_interval() {
        let mut r = SeededRandom::new(-1);
        for _ in 0..100_000 {
            let v = r.next_f64();
            assert!((0.0..1.0).contains(&v), "{v} outside [0,1)");
        }
    }

    #[test]
    fn next_int_is_inclusive_at_both_ends() {
        let mut r = SeededRandom::new(3);
        let mut lo = false;
        let mut hi = false;
        for _ in 0..10_000 {
            let v = r.next_int(0, 3);
            assert!((0..=3).contains(&v));
            lo |= v == 0;
            hi |= v == 3;
        }
        assert!(lo && hi, "both endpoints must be reachable");
    }

    #[test]
    fn next_int_handles_a_single_value_range() {
        let mut r = SeededRandom::new(11);
        for _ in 0..100 {
            assert_eq!(r.next_int(5, 5), 5);
        }
    }

    #[test]
    fn shuffle_is_a_permutation() {
        let mut r = SeededRandom::new(99);
        let src: Vec<i32> = (0..64).collect();
        let out = r.shuffle(&src);
        let mut sorted = out.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, src, "shuffle must not add, drop or duplicate");
    }

    #[test]
    fn pick_on_empty_returns_none_without_consuming_a_draw() {
        let mut r = SeededRandom::new(1);
        let empty: [u8; 0] = [];
        let before = r.clone().next_f64();
        assert!(r.pick(&empty).is_none());
        assert_eq!(
            r.next_f64(),
            before,
            "an empty pick must not advance the stream"
        );
    }
}
