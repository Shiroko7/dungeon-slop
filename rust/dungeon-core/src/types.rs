//! Core types, ported from `src/engine/types.ts`.

/// Discriminants match the TypeScript enum exactly. The golden vectors record
/// a cell-type histogram by number, so these values are part of the contract
/// rather than an implementation detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum CellType {
    Empty = 0,
    Floor = 1,
    Wall = 2,
    Corridor = 3,
    Door = 4,
    SecretDoor = 5,
    StairsUp = 6,
    StairsDown = 7,
}

impl CellType {
    /// Can something stand here?
    ///
    /// The TypeScript spells this set out at each call site, which is how
    /// `buildWalls` and the corridor carver ended up with slightly different
    /// ideas of what counts. One definition, used everywhere.
    pub fn is_walkable(self) -> bool {
        matches!(
            self,
            CellType::Floor
                | CellType::Corridor
                | CellType::Door
                | CellType::SecretDoor
                | CellType::StairsUp
                | CellType::StairsDown
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cell {
    pub kind: CellType,
    pub room_id: Option<u32>,
    pub corridor_id: Option<u32>,
    pub feature_id: Option<u32>,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            kind: CellType::Empty,
            room_id: None,
            corridor_id: None,
            feature_id: None,
        }
    }
}

/// What a room is for. Geometry alone cannot say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoomRole {
    Entrance,
    Hub,
    Gauntlet,
    Chokepoint,
    Boss,
    Vault,
    Junction,
    Chamber,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Room {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub center_x: i32,
    pub center_y: i32,
    pub shape: String,
    pub connections: Vec<u32>,
    pub role: Option<RoomRole>,
    /// Depth in rooms from the entrance; `None` if unreachable.
    pub tier: Option<u32>,
    pub on_critical_path: bool,
}

/// A pointy-top regular pentagon of circumradius r spans `2·sin(72°)·r` across
/// and `(1 + cos(36°))·r` down. Kept as computed constants for the same reason
/// the original does: rounding them to 1.902/1.809 made the width ~0.0003 cells
/// too large, which pushed a vertex outside the room's own rectangle.
pub const PENTAGON_W: f64 = 1.902_113_032_590_307;
pub const PENTAGON_H: f64 = 1.809_016_994_374_947_5;

/// Is this room an organic blob rather than a shape with a formula?
///
/// Case-insensitive, and that is not incidental: the cellular generator writes
/// `"cave"` while readers compared against `"Cave"`, which silently drew every
/// organic room as a filled rectangle over its bounding box.
pub fn is_cave_shape(shape: &str) -> bool {
    shape.eq_ignore_ascii_case("cave")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pentagon_constants_match_their_formulas() {
        let w = 2.0 * (2.0 * std::f64::consts::PI / 5.0).sin();
        let h = 1.0 + (std::f64::consts::PI / 5.0).cos();
        assert_eq!(PENTAGON_W, w);
        assert_eq!(PENTAGON_H, h);
    }

    #[test]
    fn cave_shape_is_case_insensitive() {
        for s in ["cave", "Cave", "CAVE", "CaVe"] {
            assert!(is_cave_shape(s), "{s} should be a cave");
        }
        assert!(!is_cave_shape("rectangle"));
        assert!(!is_cave_shape("caves"));
    }

    #[test]
    fn empty_is_not_walkable_but_floor_is() {
        assert!(!CellType::Empty.is_walkable());
        assert!(!CellType::Wall.is_walkable());
        assert!(CellType::Floor.is_walkable());
        assert!(CellType::Door.is_walkable());
    }
}
