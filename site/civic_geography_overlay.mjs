// Exact-geometry overlay contract for build-time civic crosswalks. It uses
// full-fidelity rings, triangulates concave polygons and holes, then sums real
// triangle intersections in EPSG:2263 (US survey feet). Simplified delivery
// geometry is rejected by default so tolerance never becomes a civic fact.

import { civicFeaturePolygons } from "./civic_geography.mjs";

export const GEOGRAPHY_OVERLAY_SCHEMA = "cityscroll.geography_crosswalk.v1";

const EPSILON = 1e-8;
const US_SURVEY_FOOT_METERS = 1200 / 3937;
const EPSG2263_TRIANGLE_CACHE = new WeakMap();

const radians = (degrees) => Number(degrees) * Math.PI / 180;

// NAD83 / New York Long Island (ftUS), EPSG:2263. Parameters are the EPSG
// Lambert Conformal Conic 2SP definition; output units are US survey feet.
export function projectEpsg2263(point) {
  const longitude = radians(point?.[0]);
  const latitude = radians(point?.[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const semiMajor = 6378137;
  const inverseFlattening = 298.257222101;
  const flattening = 1 / inverseFlattening;
  const eccentricity = Math.sqrt(2 * flattening - flattening * flattening);
  const centralMeridian = radians(-74);
  const latitudeOrigin = radians(40 + 10 / 60);
  const standardParallel1 = radians(40 + 40 / 60);
  const standardParallel2 = radians(41 + 2 / 60);
  const falseEastingMeters = 984250 * US_SURVEY_FOOT_METERS;

  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - eccentricity ** 2 * Math.sin(phi) ** 2);
  const t = (phi) => Math.tan(Math.PI / 4 - phi / 2)
    / (((1 - eccentricity * Math.sin(phi)) / (1 + eccentricity * Math.sin(phi))) ** (eccentricity / 2));
  const m1 = m(standardParallel1);
  const m2 = m(standardParallel2);
  const t1 = t(standardParallel1);
  const t2 = t(standardParallel2);
  const exponent = (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
  const factor = m1 / (exponent * t1 ** exponent);
  const rho = semiMajor * factor * t(latitude) ** exponent;
  const rhoOrigin = semiMajor * factor * t(latitudeOrigin) ** exponent;
  const theta = exponent * (longitude - centralMeridian);
  return [
    (falseEastingMeters + rho * Math.sin(theta)) / US_SURVEY_FOOT_METERS,
    (rhoOrigin - rho * Math.cos(theta)) / US_SURVEY_FOOT_METERS,
  ];
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index][0] * next[1] - next[0] * points[index][1];
  }
  return area / 2;
}

function samePoint(left, right) {
  return Math.abs(left[0] - right[0]) <= EPSILON && Math.abs(left[1] - right[1]) <= EPSILON;
}

function cleanRing(ring, projector) {
  const points = [];
  for (const coordinate of Array.isArray(ring) ? ring : []) {
    const planarCoordinate = projector(coordinate);
    if (!Array.isArray(planarCoordinate) || !planarCoordinate.every(Number.isFinite)) continue;
    if (!points.length || !samePoint(points[points.length - 1], planarCoordinate)) points.push(planarCoordinate);
  }
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index - 1 + points.length) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];
      if (Math.abs(cross(previous, current, next)) <= EPSILON) {
        points.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  if (points.length < 3 || Math.abs(signedArea(points)) <= EPSILON) return [];
  return signedArea(points) > 0 ? points : [...points].reverse();
}

function pointInTriangle(point, triangle) {
  const [a, b, c] = triangle;
  return cross(a, b, point) >= -EPSILON
    && cross(b, c, point) >= -EPSILON
    && cross(c, a, point) >= -EPSILON;
}

/** Ear-clip one simple ring into non-overlapping triangles. */
export function triangulateRing(ring, { projector = (point) => point } = {}) {
  const points = cleanRing(ring, projector);
  if (points.length < 3) return [];
  const remaining = points.map((_, index) => index);
  const triangles = [];
  let guard = points.length * points.length;
  while (remaining.length > 3 && guard > 0) {
    let clipped = false;
    for (let cursor = 0; cursor < remaining.length; cursor += 1) {
      const previousIndex = remaining[(cursor - 1 + remaining.length) % remaining.length];
      const currentIndex = remaining[cursor];
      const nextIndex = remaining[(cursor + 1) % remaining.length];
      const triangle = [points[previousIndex], points[currentIndex], points[nextIndex]];
      if (cross(...triangle) <= EPSILON) continue;
      const containsVertex = remaining.some((candidateIndex) => (
        candidateIndex !== previousIndex
        && candidateIndex !== currentIndex
        && candidateIndex !== nextIndex
        && pointInTriangle(points[candidateIndex], triangle)
      ));
      if (containsVertex) continue;
      triangles.push(triangle);
      remaining.splice(cursor, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("invalid or self-intersecting geography ring");
    guard -= 1;
  }
  if (remaining.length === 3) {
    const triangle = remaining.map((index) => points[index]);
    if (cross(...triangle) > EPSILON) triangles.push(triangle);
  }
  return triangles;
}

function lineIntersection(start, end, clipStart, clipEnd) {
  const direction = [end[0] - start[0], end[1] - start[1]];
  const clipDirection = [clipEnd[0] - clipStart[0], clipEnd[1] - clipStart[1]];
  const denominator = direction[0] * clipDirection[1] - direction[1] * clipDirection[0];
  if (Math.abs(denominator) <= EPSILON) return end;
  const offset = [clipStart[0] - start[0], clipStart[1] - start[1]];
  const position = (offset[0] * clipDirection[1] - offset[1] * clipDirection[0]) / denominator;
  return [start[0] + position * direction[0], start[1] + position * direction[1]];
}

function clipConvex(subject, clipPolygon) {
  let output = subject;
  for (let edge = 0; edge < clipPolygon.length; edge += 1) {
    const clipStart = clipPolygon[edge];
    const clipEnd = clipPolygon[(edge + 1) % clipPolygon.length];
    const input = output;
    output = [];
    if (!input.length) break;
    let start = input[input.length - 1];
    for (const end of input) {
      const endInside = cross(clipStart, clipEnd, end) >= -EPSILON;
      const startInside = cross(clipStart, clipEnd, start) >= -EPSILON;
      if (endInside) {
        if (!startInside) output.push(lineIntersection(start, end, clipStart, clipEnd));
        output.push(end);
      } else if (startInside) {
        output.push(lineIntersection(start, end, clipStart, clipEnd));
      }
      start = end;
    }
  }
  return output;
}

function triangleBbox(triangle) {
  return [
    Math.min(...triangle.map((point) => point[0])),
    Math.min(...triangle.map((point) => point[1])),
    Math.max(...triangle.map((point) => point[0])),
    Math.max(...triangle.map((point) => point[1])),
  ];
}

function bboxOverlaps(left, right) {
  return left[0] <= right[2] && right[0] <= left[2] && left[1] <= right[3] && right[1] <= left[3];
}

function triangleIntersectionArea(left, right) {
  if (!bboxOverlaps(triangleBbox(left), triangleBbox(right))) return 0;
  return Math.abs(signedArea(clipConvex(left, right)));
}

function weightedTriangles(feature, projector) {
  if (projector === projectEpsg2263 && feature && typeof feature === "object") {
    const cached = EPSG2263_TRIANGLE_CACHE.get(feature);
    if (cached) return cached;
  }
  const rows = [];
  for (const polygon of civicFeaturePolygons(feature)) {
    const rings = Array.isArray(polygon?.rings) ? polygon.rings : [];
    rings.forEach((ring, index) => {
      for (const triangle of triangulateRing(ring, { projector })) {
        rows.push({ triangle, weight: index === 0 ? 1 : -1, bbox: triangleBbox(triangle) });
      }
    });
  }
  if (projector === projectEpsg2263 && feature && typeof feature === "object") {
    EPSG2263_TRIANGLE_CACHE.set(feature, rows);
  }
  return rows;
}

function trianglesArea(rows) {
  return rows.reduce((sum, row) => sum + row.weight * Math.abs(signedArea(row.triangle)), 0);
}

/** Real area of A∩B. Concavity and holes are handled by signed triangulation. */
export function civicGeometryIntersectionArea(leftFeature, rightFeature, {
  projector = projectEpsg2263,
} = {}) {
  if (Array.isArray(leftFeature?.bbox) && Array.isArray(rightFeature?.bbox)
    && !bboxOverlaps(leftFeature.bbox, rightFeature.bbox)) return 0;
  const left = weightedTriangles(leftFeature, projector);
  const right = weightedTriangles(rightFeature, projector);
  let area = 0;
  for (const leftRow of left) {
    for (const rightRow of right) {
      if (!bboxOverlaps(leftRow.bbox, rightRow.bbox)) continue;
      area += leftRow.weight * rightRow.weight
        * triangleIntersectionArea(leftRow.triangle, rightRow.triangle);
    }
  }
  return Math.max(0, area);
}

export function civicGeometryArea(feature, { projector = projectEpsg2263 } = {}) {
  return Math.max(0, trianglesArea(weightedTriangles(feature, projector)));
}

function segments(ring) {
  const points = Array.isArray(ring) ? ring : [];
  if (points.length < 2) return [];
  return points.map((point, index) => [point, points[(index + 1) % points.length]]);
}

function onSegment(a, b, point) {
  return Math.abs(cross(a, b, point)) <= EPSILON
    && point[0] >= Math.min(a[0], b[0]) - EPSILON
    && point[0] <= Math.max(a[0], b[0]) + EPSILON
    && point[1] >= Math.min(a[1], b[1]) - EPSILON
    && point[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function segmentIntersects(a, b, c, d) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (Math.abs(abC) <= EPSILON && onSegment(a, b, c)) return true;
  if (Math.abs(abD) <= EPSILON && onSegment(a, b, d)) return true;
  if (Math.abs(cdA) <= EPSILON && onSegment(c, d, a)) return true;
  if (Math.abs(cdB) <= EPSILON && onSegment(c, d, b)) return true;
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function boundariesTouch(leftFeature, rightFeature) {
  const leftSegments = civicFeaturePolygons(leftFeature)
    .flatMap((polygon) => (polygon.rings || []).flatMap(segments));
  const rightSegments = civicFeaturePolygons(rightFeature)
    .flatMap((polygon) => (polygon.rings || []).flatMap(segments));
  return leftSegments.some(([a, b]) => rightSegments.some(([c, d]) => segmentIntersects(a, b, c, d)));
}

function rounded(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Build one provenance-complete quantitative crosswalk observation. */
export function overlayCivicGeographies({
  fromLayer,
  fromFeature,
  toLayer,
  toFeature,
  minAreaSqFt = 0,
  projector = projectEpsg2263,
  requireFullFidelity = true,
} = {}) {
  if (!fromLayer || !toLayer || !fromFeature || !toFeature) {
    throw new Error("geography overlay requires two layers and two features");
  }
  if (requireFullFidelity
    && (fromLayer.geometry_fidelity !== "full" || toLayer.geometry_fidelity !== "full")) {
    throw new Error("geography overlay requires full-fidelity layer artifacts");
  }
  const intersectionArea = civicGeometryIntersectionArea(fromFeature, toFeature, { projector });
  const fromArea = civicGeometryArea(fromFeature, { projector });
  const toArea = civicGeometryArea(toFeature, { projector });
  const threshold = Math.max(0, Number(minAreaSqFt) || 0);
  const touch = boundariesTouch(fromFeature, toFeature);
  const relation = intersectionArea > threshold
    ? "intersects"
    : intersectionArea > EPSILON
      ? "below_threshold"
      : touch
        ? "touches"
        : "disjoint";
  return {
    schema: GEOGRAPHY_OVERLAY_SCHEMA,
    from_key: fromFeature.key,
    to_key: toFeature.key,
    relation,
    method: projector === projectEpsg2263 ? "polygon_intersection_epsg2263" : "polygon_intersection_projected",
    intersection_area_sqft: rounded(intersectionArea, 3),
    pct_from: fromArea > 0 ? rounded(intersectionArea / fromArea * 100, 6) : null,
    pct_to: toArea > 0 ? rounded(intersectionArea / toArea * 100, 6) : null,
    source_vintages: {
      from: fromLayer.vintage?.id || null,
      to: toLayer.vintage?.id || null,
    },
    threshold: { min_area_sqft: threshold },
    generator: { name: "cityscroll_geography_crosswalk", version: 1 },
  };
}
