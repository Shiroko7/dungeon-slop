//! Checks the port against `conformance/golden.json`, frozen from the
//! TypeScript implementation while it was still authoritative.
//!
//! These are equality assertions on `f64`, deliberately. The values are not
//! "close enough" quantities - they are the exact stream the TypeScript
//! produces, and an epsilon here would hide precisely the bug this file exists
//! to catch. The golden stores 17 significant digits, which round-trips an f64.

use dungeon_core::SeededRandom;
use serde_json::Value;

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/golden.json");
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!("cannot read {path}: {e}\nRegenerate with: bun run conformance/generate-golden.ts")
    });
    serde_json::from_str(&raw).expect("golden.json is not valid JSON")
}

fn f(v: &Value) -> f64 {
    v.as_str()
        .expect("golden stores doubles as strings to preserve precision")
        .parse()
        .expect("unparseable double in golden")
}

#[test]
fn raw_stream_matches_typescript() {
    let g = golden();
    let vectors = g["rng"].as_array().expect("rng vectors");
    assert!(!vectors.is_empty(), "golden has no rng vectors");

    for vec in vectors {
        let seed = vec["seed"].as_i64().unwrap() as i32;
        let mut r = SeededRandom::new(seed);
        for (i, want) in vec["first16"].as_array().unwrap().iter().enumerate() {
            assert_eq!(r.next_f64(), f(want), "seed {seed}, draw {i}");
        }
    }
}

/// Ten thousand draws in. A port that gets the first few right and the integer
/// width wrong stays correct until a carry propagates somewhere it should not.
#[test]
fn stream_still_matches_far_downstream() {
    let g = golden();
    for vec in g["rng"].as_array().unwrap() {
        let seed = vec["seed"].as_i64().unwrap() as i32;
        let mut r = SeededRandom::new(seed);
        for _ in 0..10_000 {
            r.next_f64();
        }
        assert_eq!(
            r.next_f64(),
            f(&vec["at10k"]),
            "seed {seed} diverged by draw 10,000"
        );
    }
}

/// The derived helpers are where an off-by-one hides: the raw stream can be
/// perfect while `next_int` is skewed by one at the top of its range.
#[test]
fn derived_helpers_match_typescript() {
    let g = golden();
    for vec in g["rng"].as_array().unwrap() {
        let seed = vec["seed"].as_i64().unwrap() as i32;

        // One instance, consumed in the same order the generator script used.
        let mut r = SeededRandom::new(seed);

        for (i, want) in vec["nextInt_0_99"].as_array().unwrap().iter().enumerate() {
            let got = r.next_int(0, 99);
            assert_eq!(
                i64::from(got),
                want.as_i64().unwrap(),
                "seed {seed}, next_int(0,99) #{i}"
            );
        }
        for (i, want) in vec["nextInt_neg"].as_array().unwrap().iter().enumerate() {
            let got = r.next_int(-50, 50);
            assert_eq!(
                i64::from(got),
                want.as_i64().unwrap(),
                "seed {seed}, next_int(-50,50) #{i}"
            );
        }
        for (i, want) in vec["nextFloat"].as_array().unwrap().iter().enumerate() {
            assert_eq!(
                r.next_float(-1.5, 2.5),
                f(want),
                "seed {seed}, next_float #{i}"
            );
        }

        let src: Vec<i64> = (0..16).collect();
        let got = r.shuffle(&src);
        let want: Vec<i64> = vec["shuffle16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect();
        assert_eq!(got, want, "seed {seed}, shuffle");

        let pool = ["a", "b", "c", "d", "e"];
        for (i, want) in vec["picks"].as_array().unwrap().iter().enumerate() {
            let got = r.pick(&pool).copied().unwrap();
            assert_eq!(got, want.as_str().unwrap(), "seed {seed}, pick #{i}");
        }
        for (i, want) in vec["chances"].as_array().unwrap().iter().enumerate() {
            assert_eq!(
                r.chance(0.5),
                want.as_bool().unwrap(),
                "seed {seed}, chance #{i}"
            );
        }
    }
}

/// Guards the guard: if the golden ever loses its dungeon vectors, the layout
/// passes would silently have nothing to be ported against.
#[test]
fn golden_still_describes_whole_dungeons() {
    let g = golden();
    let d = g["dungeons"].as_array().expect("dungeon vectors");
    assert!(
        d.len() >= 4,
        "expected at least 4 dungeon vectors, found {}",
        d.len()
    );
    for case in d {
        assert!(case["gridHash"].as_str().is_some_and(|h| h.len() == 32));
        assert!(case["roomCount"].as_u64().is_some_and(|n| n > 0));
    }
}
