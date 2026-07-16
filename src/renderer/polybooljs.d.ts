declare module "polybooljs" {
  type Point = [number, number];
  type Region = Point[];

  interface Polygon {
    regions: Region[];
    inverted: boolean;
  }

  interface Segments {
    readonly segments: unknown;
    readonly inverted: boolean;
  }

  interface Combined {
    readonly combined: unknown;
    readonly inverted1: boolean;
    readonly inverted2: boolean;
  }

  const PolyBool: {
    union(poly1: Polygon, poly2: Polygon): Polygon;
    intersect(poly1: Polygon, poly2: Polygon): Polygon;
    difference(poly1: Polygon, poly2: Polygon): Polygon;
    differenceRev(poly1: Polygon, poly2: Polygon): Polygon;
    xor(poly1: Polygon, poly2: Polygon): Polygon;
    segments(poly: Polygon): Segments;
    combine(segments1: Segments, segments2: Segments): Combined;
    selectUnion(combined: Combined): Segments;
    selectIntersect(combined: Combined): Segments;
    selectDifference(combined: Combined): Segments;
    selectDifferenceRev(combined: Combined): Segments;
    selectXor(combined: Combined): Segments;
    polygon(segments: Segments): Polygon;
  };

  export default PolyBool;
}
