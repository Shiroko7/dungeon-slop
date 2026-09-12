//! The cell grid, ported from `src/engine/grid.ts`.
//!
//! The TypeScript stores `Cell[][]` - a Vec of row Vecs. This uses one flat
//! buffer with an index calculation. Same semantics, one allocation instead of
//! `height + 1`, and contiguous memory for the passes that sweep the whole grid
//! (wall building, cellular automata smoothing).
//!
//! That is safe to change because iteration order is preserved: `for_each_cell`
//! walks row-major, `y` outer and `x` inner, exactly as the original does. Order
//! matters here - several passes consume random draws per cell, so visiting
//! cells in a different order would desynchronise the PRNG stream.

use crate::types::{Cell, CellType};

#[derive(Debug, Clone, PartialEq)]
pub struct Grid {
    width: usize,
    height: usize,
    cells: Vec<Cell>,
}

impl Grid {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            cells: vec![Cell::default(); width * height],
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    #[inline]
    fn index(&self, x: i32, y: i32) -> Option<usize> {
        if !self.in_bounds(x, y) {
            return None;
        }
        Some(y as usize * self.width + x as usize)
    }

    #[inline]
    pub fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as usize) < self.width && (y as usize) < self.height
    }

    /// At least one cell inside all four edges.
    ///
    /// Use this rather than `in_bounds` whenever carving walkable cells, so no
    /// room, corridor or dead end can touch the grid border.
    #[inline]
    pub fn is_interior(&self, x: i32, y: i32) -> bool {
        x >= 1
            && y >= 1
            && (x as usize) < self.width.saturating_sub(1)
            && (y as usize) < self.height.saturating_sub(1)
    }

    pub fn get(&self, x: i32, y: i32) -> Option<&Cell> {
        self.index(x, y).map(|i| &self.cells[i])
    }

    pub fn get_mut(&mut self, x: i32, y: i32) -> Option<&mut Cell> {
        self.index(x, y).map(move |i| &mut self.cells[i])
    }

    /// Out-of-bounds writes are ignored, matching the original's early return.
    pub fn set(&mut self, x: i32, y: i32, cell: Cell) {
        if let Some(i) = self.index(x, y) {
            self.cells[i] = cell;
        }
    }

    /// Out-of-bounds writes are ignored, matching the original's early return.
    pub fn set_type(&mut self, x: i32, y: i32, kind: CellType) {
        if let Some(i) = self.index(x, y) {
            self.cells[i].kind = kind;
        }
    }

    /// Row-major: `y` outer, `x` inner. Do not change - see the module note.
    pub fn for_each<F: FnMut(i32, i32, &Cell)>(&self, mut f: F) {
        for y in 0..self.height {
            for x in 0..self.width {
                f(x as i32, y as i32, &self.cells[y * self.width + x]);
            }
        }
    }

    /// The four cardinal neighbours that exist, in N, E, S, W order.
    ///
    /// The order is part of the contract: callers that break ties by first
    /// match would pick differently under a different order.
    pub fn cardinal_neighbors(&self, x: i32, y: i32) -> Vec<(i32, i32, &Cell)> {
        const OFFSETS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];
        OFFSETS
            .iter()
            .filter_map(|(dx, dy)| {
                let (nx, ny) = (x + dx, y + dy);
                self.get(nx, ny).map(|c| (nx, ny, c))
            })
            .collect()
    }

    /// Count of the eight surrounding cells matching `kind`.
    ///
    /// `oob_counts` decides whether off-grid neighbours count as a match. The
    /// cellular automata pass needs `true` so caves close against the border
    /// instead of bleeding off the edge.
    pub fn count_neighbors(&self, x: i32, y: i32, kind: CellType, oob_counts: bool) -> usize {
        const OFFSETS: [(i32, i32); 8] = [
            (-1, -1),
            (0, -1),
            (1, -1),
            (-1, 0),
            (1, 0),
            (-1, 1),
            (0, 1),
            (1, 1),
        ];
        OFFSETS
            .iter()
            .filter(|(dx, dy)| match self.get(x + dx, y + dy) {
                Some(c) => c.kind == kind,
                None => oob_counts,
            })
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_empty_at_the_requested_size() {
        let g = Grid::new(7, 5);
        assert_eq!((g.width(), g.height()), (7, 5));
        let mut seen = 0;
        g.for_each(|_, _, c| {
            assert_eq!(c.kind, CellType::Empty);
            seen += 1;
        });
        assert_eq!(seen, 35);
    }

    #[test]
    fn iterates_row_major() {
        let g = Grid::new(3, 2);
        let mut order = Vec::new();
        g.for_each(|x, y, _| order.push((x, y)));
        assert_eq!(order, vec![(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]);
    }

    #[test]
    fn out_of_bounds_access_is_none_and_writes_are_ignored() {
        let mut g = Grid::new(4, 4);
        assert!(g.get(-1, 0).is_none());
        assert!(g.get(0, -1).is_none());
        assert!(g.get(4, 0).is_none());
        assert!(g.get(0, 4).is_none());

        g.set_type(99, 99, CellType::Floor); // must not panic
        let mut floors = 0;
        g.for_each(|_, _, c| {
            if c.kind == CellType::Floor {
                floors += 1
            }
        });
        assert_eq!(floors, 0);
    }

    #[test]
    fn interior_excludes_the_border_ring() {
        let g = Grid::new(5, 5);
        assert!(!g.is_interior(0, 2));
        assert!(!g.is_interior(4, 2));
        assert!(!g.is_interior(2, 0));
        assert!(!g.is_interior(2, 4));
        assert!(g.is_interior(1, 1));
        assert!(g.is_interior(3, 3));
    }

    #[test]
    fn cardinal_neighbors_are_clipped_at_the_edge() {
        let g = Grid::new(3, 3);
        assert_eq!(g.cardinal_neighbors(1, 1).len(), 4);
        assert_eq!(g.cardinal_neighbors(0, 0).len(), 2);
        assert_eq!(g.cardinal_neighbors(2, 2).len(), 2);
    }

    #[test]
    fn out_of_bounds_neighbors_count_only_when_asked() {
        let g = Grid::new(3, 3);
        // corner: 3 real neighbours (all Empty) + 5 off-grid
        assert_eq!(g.count_neighbors(0, 0, CellType::Empty, true), 8);
        assert_eq!(g.count_neighbors(0, 0, CellType::Empty, false), 3);
    }
}
