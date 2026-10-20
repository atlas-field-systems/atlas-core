import {isRecord} from './scan.js';
type Point = readonly [number, number];
type ExactPoint = {point: Point; x: bigint; y: bigint};
function fail(code = 'invalid_geometry'): never {throw new Error(code);}
function integer(value: number): bigint {
 const data = new DataView(new ArrayBuffer(8)); data.setFloat64(0, value);
 const bits = data.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n);
 const mantissa = (bits & 4503599627370495n) | (exponent ? 4503599627370496n : 0n);
 const exact = mantissa << BigInt(exponent ? exponent - 1 : 0);
 return bits >> 63n ? -exact : exact;
}
function orientation(a: ExactPoint, b: ExactPoint, c: ExactPoint): number {
 const left = (b.point[0] - a.point[0]) * (c.point[1] - a.point[1]), right = (b.point[1] - a.point[1]) * (c.point[0] - a.point[0]), det = left - right;
 if (Math.abs(det) > (Math.abs(left) + Math.abs(right)) * 1e-14) return Math.sign(det);
 const exact = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
 return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}
function between(p: Point, a: Point, b: Point) { return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]); }
function intersects(a: ExactPoint, b: ExactPoint, c: ExactPoint, d: ExactPoint) {
 if (Math.max(a.point[0], b.point[0]) < Math.min(c.point[0], d.point[0]) || Math.max(c.point[0], d.point[0]) < Math.min(a.point[0], b.point[0]) || Math.max(a.point[1], b.point[1]) < Math.min(c.point[1], d.point[1]) || Math.max(c.point[1], d.point[1]) < Math.min(a.point[1], b.point[1])) return false;
 const ac = orientation(a, b, c), ad = orientation(a, b, d), ca = orientation(c, d, a), cb = orientation(c, d, b);
 return ac * ad < 0 && ca * cb < 0 || ac === 0 && between(c.point, a.point, b.point) || ad === 0 && between(d.point, a.point, b.point) || ca === 0 && between(a.point, c.point, d.point) || cb === 0 && between(b.point, c.point, d.point);
}
function equal(a: Point, b: Point) { return a[0] === b[0] && a[1] === b[1]; }
export function geometry(value: unknown): void {
 if (!isRecord(value) || typeof value.type !== 'string') fail();
 const kind = value.type;
 if (!['Point', 'LineString', 'Polygon'].includes(kind)) fail('unsupported_geometry');
 let raw = value.coordinates;
 if (!Array.isArray(raw)) fail();
 if (kind === 'Point') raw = [raw];
 if (kind === 'Polygon') {
  if (!Array.isArray(raw)) fail();
  if (raw.length > 1) fail('unsupported_geometry');
  if (raw.length !== 1 || !Array.isArray(raw[0])) fail();
  raw = raw[0];
 }
 if (!Array.isArray(raw)) fail();
 if (raw.length > 1024) fail('geometry_limit_exceeded');
 if (kind === 'LineString' && raw.length < 2 || kind === 'Polygon' && raw.length < 4) fail();
 const points: Point[] = [];
 let minLongitude = 180, maxLongitude = -180;
 for (const pair of raw) {
  if (!Array.isArray(pair)) fail();
  if (pair.length > 2) fail('unsupported_geometry');
  if (pair.length !== 2) fail();
  const x: unknown = pair[0], y: unknown = pair[1];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) fail();
  points.push([x, y]);
  minLongitude = Math.min(minLongitude, x); maxLongitude = Math.max(maxLongitude, x);
 }
 if (kind !== 'Point' && minLongitude === -180 && maxLongitude === 180) fail('unsupported_geometry');
 for (let i = 1; i < points.length; i++) {
  const a = points[i - 1], b = points[i]; if (!a || !b) fail();
  if (Math.abs(a[0] - b[0]) > 180) fail('unsupported_geometry');
  if (kind === 'Polygon' && a[0] !== b[0] && a[1] === b[1] && Math.abs(a[1]) === 90) fail('unsupported_geometry');
  if (kind === 'Polygon' && equal(a, b)) fail();
 }
 if (kind !== 'Polygon') return;
 const first = points[0], last = points.at(-1); if (!first || !last || !equal(first, last)) fail();
 const polygon: ExactPoint[] = points.map(point => ({point, x: integer(point[0]), y: integer(point[1])}));
 for (let i = 0; i < polygon.length - 1; i++) {
  const a = polygon[i], b = polygon[i + 1]; if (!a || !b) fail();
  for (let j = i + 1; j < polygon.length - 1; j++) {
   const c = polygon[j], d = polygon[j + 1]; if (!c || !d) fail();
   if (j === i + 1) { if (orientation(a, c, d) === 0 && (between(a.point, c.point, d.point) || between(d.point, a.point, c.point))) fail(); continue; }
   if (i === 0 && j === polygon.length - 2) continue;
   if (intersects(a, b, c, d)) fail();
  }
 }
 let area = 0n;
 for (let i = 0; i < polygon.length - 1; i++) {
  const a = polygon[i], b = polygon[i + 1]; if (!a || !b) fail();
  area += a.x * b.y - b.x * a.y;
 }
 if (area <= 0n) fail();
}
