import type { Position, Altitude } from '@atlas/protocol';
import type { Scenario } from './scenario.js';
const radians = Math.PI / 180,
  radius = 6371008.8;
export function distance(a: Position, b: Position): number {
  const lat = (b.latitude - a.latitude) * radians,
    lon = (b.longitude - a.longitude) * radians;
  return (
    2 *
    radius *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(lat / 2) ** 2 +
            Math.cos(a.latitude * radians) *
              Math.cos(b.latitude * radians) *
              Math.sin(lon / 2) ** 2,
        ),
      ),
    )
  );
}
function advance(a: Position, b: Position, metres: number): Position {
  const total = distance(a, b);
  if (metres >= total || total === 0) return { ...b };
  const angular = total / radius,
    fraction = metres / total;
  const sin = Math.sin(angular);
  const left = Math.sin((1 - fraction) * angular) / sin,
    right = Math.sin(fraction * angular) / sin;
  const x =
    left * Math.cos(a.latitude * radians) * Math.cos(a.longitude * radians) +
    right * Math.cos(b.latitude * radians) * Math.cos(b.longitude * radians);
  const y =
    left * Math.cos(a.latitude * radians) * Math.sin(a.longitude * radians) +
    right * Math.cos(b.latitude * radians) * Math.sin(b.longitude * radians);
  const z = left * Math.sin(a.latitude * radians) + right * Math.sin(b.latitude * radians);
  return {
    latitude: Math.atan2(z, Math.hypot(x, y)) / radians,
    longitude: Math.atan2(y, x) / radians,
  };
}
export class World {
  readonly assets = new Map<string, { position: Position; altitude: Altitude | null }>();
  private readonly subjects: {
    alias: string;
    route: Position[];
    speed: number;
    slot: number;
    position: Position;
  }[];
  private readonly cells = new Map<string, typeof this.subjects>();
  constructor(scenario: Scenario) {
    for (const a of scenario.assets)
      this.assets.set(a.alias, { position: { ...a.position }, altitude: null });
    this.subjects = scenario.subjects.map((s) => {
      const start = s.route[0];
      if (!start) throw new Error('Missing route');
      return { ...s, slot: 1, position: { ...start } };
    });
    this.index();
  }
  private index(): void {
    this.cells.clear();
    for (const subject of this.subjects) {
      const key = `${Math.floor(subject.position.latitude)},${Math.floor(subject.position.longitude)}`;
      const cell = this.cells.get(key) ?? [];
      cell.push(subject);
      this.cells.set(key, cell);
    }
  }
  tick(seconds: number): void {
    for (const s of this.subjects) {
      let remaining = s.speed * seconds;
      for (let count = 0; remaining > 0 && count < s.route.length; count++) {
        const target = s.route[s.slot];
        if (!target) break;
        const d = distance(s.position, target);
        s.position = advance(s.position, target, remaining);
        remaining -= d;
        if (remaining >= 0) s.slot++;
      }
    }
    this.index();
  }
  move(
    alias: string,
    target: Position,
    speed: number,
    seconds: number,
    altitude?: Altitude,
  ): boolean {
    const a = this.get(alias);
    const arrived = distance(a.position, target) <= speed * seconds;
    a.position = advance(a.position, target, speed * seconds);
    if (altitude) a.altitude = { ...altitude };
    return arrived;
  }
  get(alias: string) {
    const a = this.assets.get(alias);
    if (!a) throw new Error('Unknown world Asset');
    return a;
  }
  detected(alias: string, metres: number): readonly { alias: string; position: Position }[] {
    const point = this.get(alias).position;
    const output: { alias: string; position: Position }[] = [];
    for (const cell of this.cells.values())
      for (const s of cell)
        if (distance(point, s.position) <= metres)
          output.push({ alias: s.alias, position: { ...s.position } });
    return output;
  }
}
