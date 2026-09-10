import type { SeededRandom } from "../lib/random.ts";
import { distance } from "../lib/math.ts";

export interface Edge {
  a: number;
  b: number;
  weight: number;
}

export interface Triangle {
  a: number;
  b: number;
  c: number;
}

interface Point {
  x: number;
  y: number;
}

function circumcircleContains(
  points: Point[],
  tri: Triangle,
  point: Point,
): boolean {
  const a = points[tri.a]!;
  const b = points[tri.b]!;
  const c = points[tri.c]!;

  const ax = a.x - point.x;
  const ay = a.y - point.y;
  const bx = b.x - point.x;
  const by = b.y - point.y;
  const cx = c.x - point.x;
  const cy = c.y - point.y;

  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);

  return det > 0;
}

function edgesEqual(
  e1a: number,
  e1b: number,
  e2a: number,
  e2b: number,
): boolean {
  return (e1a === e2a && e1b === e2b) || (e1a === e2b && e1b === e2a);
}

export function delaunayTriangulation(
  points: Array<{ x: number; y: number }>,
): Edge[] {
  if (points.length < 2) return [];
  if (points.length === 2) {
    return [
      {
        a: 0,
        b: 1,
        weight: distance(points[0]!, points[1]!),
      },
    ];
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const dx = maxX - minX;
  const dy = maxY - minY;
  const dmax = Math.max(dx, dy);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  const allPoints: Point[] = [...points];
  const st0 = allPoints.length;
  const st1 = allPoints.length + 1;
  const st2 = allPoints.length + 2;

  allPoints.push({ x: midX - 20 * dmax, y: midY - dmax });   // top-left
  allPoints.push({ x: midX + 20 * dmax, y: midY - dmax });   // top-right
  allPoints.push({ x: midX, y: midY + 20 * dmax });           // bottom

  let triangles: Triangle[] = [{ a: st0, b: st1, c: st2 }];

  for (let i = 0; i < points.length; i++) {
    const point = allPoints[i]!;
    const badTriangles: Triangle[] = [];

    for (const tri of triangles) {
      if (circumcircleContains(allPoints, tri, point)) {
        badTriangles.push(tri);
      }
    }

    const polygon: Array<{ a: number; b: number }> = [];
    for (const tri of badTriangles) {
      const triEdges = [
        { a: tri.a, b: tri.b },
        { a: tri.b, b: tri.c },
        { a: tri.c, b: tri.a },
      ];
      for (const edge of triEdges) {
        let shared = false;
        for (const otherTri of badTriangles) {
          if (otherTri === tri) continue;
          const otherEdges = [
            { a: otherTri.a, b: otherTri.b },
            { a: otherTri.b, b: otherTri.c },
            { a: otherTri.c, b: otherTri.a },
          ];
          for (const otherEdge of otherEdges) {
            if (edgesEqual(edge.a, edge.b, otherEdge.a, otherEdge.b)) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }
        if (!shared) {
          polygon.push(edge);
        }
      }
    }

    triangles = triangles.filter((tri) => !badTriangles.includes(tri));

    for (const edge of polygon) {
      triangles.push({ a: edge.a, b: edge.b, c: i });
    }
  }

  triangles = triangles.filter(
    (tri) =>
      tri.a !== st0 &&
      tri.a !== st1 &&
      tri.a !== st2 &&
      tri.b !== st0 &&
      tri.b !== st1 &&
      tri.b !== st2 &&
      tri.c !== st0 &&
      tri.c !== st1 &&
      tri.c !== st2,
  );

  const edgeSet = new Set<string>();
  const edges: Edge[] = [];

  for (const tri of triangles) {
    const triEdges = [
      [tri.a, tri.b],
      [tri.b, tri.c],
      [tri.c, tri.a],
    ] as const;
    for (const [a, b] of triEdges) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo},${hi}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({
          a: lo,
          b: hi,
          weight: distance(points[lo]!, points[hi]!),
        });
      }
    }
  }

  return edges;
}

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]!);
    }
    return this.parent[x]!;
  }

  union(x: number, y: number): boolean {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX === rootY) return false;

    if (this.rank[rootX]! < this.rank[rootY]!) {
      this.parent[rootX] = rootY;
    } else if (this.rank[rootX]! > this.rank[rootY]!) {
      this.parent[rootY] = rootX;
    } else {
      this.parent[rootY] = rootX;
      this.rank[rootX]!++;
    }
    return true;
  }
}

export function minimumSpanningTree(
  edges: Edge[],
  pointCount: number,
): Edge[] {
  const sorted = [...edges].sort((a, b) => a.weight - b.weight);
  const uf = new UnionFind(pointCount);
  const mst: Edge[] = [];

  for (const edge of sorted) {
    if (uf.union(edge.a, edge.b)) {
      mst.push(edge);
      if (mst.length === pointCount - 1) break;
    }
  }

  return mst;
}

export function selectCorridorEdges(
  triangulationEdges: Edge[],
  mstEdges: Edge[],
  complexity: number,
  rng: SeededRandom,
): Edge[] {
  const mstSet = new Set<string>();
  for (const e of mstEdges) {
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    mstSet.add(`${lo},${hi}`);
  }

  const nonMst = triangulationEdges.filter((e) => {
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    return !mstSet.has(`${lo},${hi}`);
  });

  // Shortest first: extra edges exist to add loops between neighbours, and
  // taking the longest ones instead produces exactly the map-spanning hallways
  // the triangulation was chosen to avoid.
  nonMst.sort((a, b) => a.weight - b.weight);

  const extraCount = Math.floor(nonMst.length * complexity);
  const selected = [...mstEdges];

  for (let i = 0; i < extraCount && i < nonMst.length; i++) {
    selected.push(nonMst[i]!);
  }

  return selected;
}
