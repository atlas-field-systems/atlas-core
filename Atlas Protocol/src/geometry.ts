import { z } from 'zod';
import { binary64, Latitude, Longitude } from './scalars.js';
import type { BoundaryCode } from './failure.js';

function refuse(
  ctx: z.RefinementCtx,
  code: Extract<
    BoundaryCode,
    'invalid_geometry' | 'unsupported_geometry' | 'geometry_limit_exceeded'
  >,
): void {
  ctx.addIssue({ code: 'custom', message: code, params: { geometryCode: code } });
}

const Pair = z.tuple([Longitude, Latitude]);
type Pair = z.output<typeof Pair>;
type ExactPoint = readonly [bigint, bigint];
function equal(a: Pair, b: Pair): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
function orientation(a: ExactPoint, b: ExactPoint, c: ExactPoint): bigint {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function between(value: bigint, a: bigint, b: bigint): boolean {
  return value >= (a < b ? a : b) && value <= (a > b ? a : b);
}
function onSegment(a: ExactPoint, b: ExactPoint, c: ExactPoint): boolean {
  return between(c[0], a[0], b[0]) && between(c[1], a[1], b[1]);
}
function sign(n: bigint): number {
  return n < 0n ? -1 : n > 0n ? 1 : 0;
}
function intersects(a: ExactPoint, b: ExactPoint, c: ExactPoint, d: ExactPoint): boolean {
  const x = orientation(a, b, c),
    y = orientation(a, b, d),
    p = orientation(c, d, a),
    q = orientation(c, d, b);
  return (
    (x === 0n && onSegment(a, b, c)) ||
    (y === 0n && onSegment(a, b, d)) ||
    (p === 0n && onSegment(c, d, a)) ||
    (q === 0n && onSegment(c, d, b)) ||
    (sign(x) * sign(y) < 0 && sign(p) * sign(q) < 0)
  );
}
function topology(points: readonly Pair[]): boolean {
  const boxes = points.map((a, index) => {
    const b = points[index + 1] ?? a;
    return {
      minX: Math.min(a[0], b[0]),
      maxX: Math.max(a[0], b[0]),
      minY: Math.min(a[1], b[1]),
      maxY: Math.max(a[1], b[1]),
    };
  });
  const parts = points.map((point) => [binary64(point[0]), binary64(point[1])] as const);
  let exponent = 0;
  for (const pair of parts)
    for (const part of pair)
      if (part.coefficient !== 0n) exponent = Math.min(exponent, part.exponent);
  const exact: ExactPoint[] = parts.map((pair) => [
    pair[0].coefficient === 0n ? 0n : pair[0].coefficient << BigInt(pair[0].exponent - exponent),
    pair[1].coefficient === 0n ? 0n : pair[1].coefficient << BigInt(pair[1].exponent - exponent),
  ]);
  let area = 0n;
  const edges = exact.length - 1;
  for (let i = 0; i < edges; i++) {
    const a = exact[i],
      b = exact[i + 1];
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return false;
    area += a[0] * b[1] - b[0] * a[1];
    const c = exact[(i + 2) % edges];
    if (c && orientation(a, b, c) === 0n && (onSegment(a, b, c) || onSegment(b, c, a)))
      return false;
    for (let j = i + 2; j < edges; j++) {
      if (i === 0 && j === edges - 1) continue;
      const first = boxes[i],
        second = boxes[j];
      if (
        first &&
        second &&
        (first.maxX < second.minX ||
          second.maxX < first.minX ||
          first.maxY < second.minY ||
          second.maxY < first.minY)
      )
        continue;
      const c2 = exact[j],
        d = exact[j + 1];
      if (c2 && d && intersects(a, b, c2, d)) return false;
    }
  }
  return area !== 0n;
}
function longitudeStep(a: number, b: number): boolean {
  const rounded = Math.abs(a - b);
  if (rounded !== 180) return rounded > 180;
  const x = binary64(a),
    y = binary64(b),
    limit = binary64(180);
  const exponent = Math.min(x.exponent, y.exponent, limit.exponent);
  const delta =
    (x.coefficient << BigInt(x.exponent - exponent)) -
    (y.coefficient << BigInt(y.exponent - exponent));
  return (delta < 0n ? -delta : delta) > limit.coefficient << BigInt(limit.exponent - exponent);
}
function checkPath(points: readonly Pair[], polygon: boolean, ctx: z.RefinementCtx): void {
  if (points.length > 1024) {
    refuse(ctx, 'geometry_limit_exceeded');
    return;
  }
  let min = 180,
    max = -180;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point) continue;
    min = Math.min(min, point[0]);
    max = Math.max(max, point[0]);
    const previous = points[index - 1];
    if (
      previous &&
      (longitudeStep(point[0], previous[0]) ||
        (polygon &&
          Math.abs(point[1]) === 90 &&
          point[1] === previous[1] &&
          point[0] !== previous[0]))
    ) {
      refuse(ctx, 'unsupported_geometry');
      return;
    }
  }
  if (max === 180 && min === -180) {
    refuse(ctx, 'unsupported_geometry');
    return;
  }
  if (!polygon) return;
  const first = points[0],
    last = points[points.length - 1];
  if (!first || !last || !equal(first, last) || !topology(points)) refuse(ctx, 'invalid_geometry');
}
export const Point = z
  .strictObject({ type: z.literal('Point'), coordinates: Pair })
  .meta({ id: 'Point' });
export const LineString = z
  .strictObject({ type: z.literal('LineString'), coordinates: z.array(Pair).min(2).max(1024) })
  .superRefine((value, ctx) => checkPath(value.coordinates, false, ctx))
  .meta({ id: 'LineString' });
export const Polygon = z
  .strictObject({
    type: z.literal('Polygon'),
    coordinates: z.tuple([z.array(Pair).min(4).max(1024)]),
  })
  .superRefine((value, ctx) => checkPath(value.coordinates[0], true, ctx))
  .meta({ id: 'Polygon' });
export const Geometry = z
  .discriminatedUnion('type', [Point, LineString, Polygon])
  .meta({ id: 'Geometry' });
export type Geometry = z.output<typeof Geometry>;
export type Point = z.output<typeof Point>;
export type LineString = z.output<typeof LineString>;
export type Polygon = z.output<typeof Polygon>;
