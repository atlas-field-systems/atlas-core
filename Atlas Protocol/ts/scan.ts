export interface Limits {
 maxJSONBytes: number;
 maxDepth: number;
 maxValues: number;
 maxFileBytes: bigint;
}
export function DefaultLimits(): Limits { return {maxJSONBytes: 1 << 20, maxDepth: 64, maxValues: 100000, maxFileBytes: 2000000000n}; }
export function checkLimits(limits: Limits) {
 if (!Number.isSafeInteger(limits.maxJSONBytes) || limits.maxJSONBytes < 1 || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 256 || !Number.isSafeInteger(limits.maxValues) || limits.maxValues < 1 || limits.maxFileBytes < 0n) throw new Error('invalid boundary limits');
}
export function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }

export function parse(wire: Uint8Array, limits: Limits): unknown {
 checkLimits(limits);
 if (wire.byteLength > limits.maxJSONBytes) throw new Error('payload_too_large');
 const raw = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(wire);
 let i = 0, count = 0;
 const fail = (reason: string): never => { throw new Error('invalid_json: ' + reason); };
 function space() { while (i < raw.length && /[ \n\r\t]/.test(raw.charAt(i))) i++; }
 function take(c: string) { space(); if (raw.charAt(i) === c) { i++; return true; } return false; }
 function hex() {
  const chars = raw.slice(i, i + 4); i += 4;
  if (!/^[0-9a-fA-F]{4}$/.test(chars)) return fail('Unicode escape');
  return Number.parseInt(chars, 16);
 }
 function str(): string {
  space(); const start = i;
  if (raw.charAt(i++) !== '"') return fail('expected string');
  while (i < raw.length) {
   const c = raw.charAt(i++);
   if (c === '"') {
    const decoded: unknown = JSON.parse(raw.slice(start, i));
    if (typeof decoded !== 'string') return fail('string');
    return decoded;
   }
   if (c.charCodeAt(0) < 32) return fail('control character');
   if (c !== '\\') continue;
   const esc = raw.charAt(i++);
   if (esc === 'u') {
    const n = hex();
    if (n >= 0xdc00 && n <= 0xdfff) return fail('lone surrogate');
    if (n >= 0xd800 && n <= 0xdbff) {
     if (raw.slice(i, i + 2) !== '\\u') return fail('lone surrogate');
     i += 2; const low = hex();
     if (low < 0xdc00 || low > 0xdfff) return fail('lone surrogate');
    }
   } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(esc)) return fail('escape');
  }
  return fail('unterminated string');
 }
 function value(depth: number): void {
  space(); if (++count > limits.maxValues || depth > limits.maxDepth) return fail('work limit');
  const c = raw.charAt(i);
  if (c === '{') {
   i++; const keys = new Set<string>(); if (take('}')) return;
   for (;;) {
    if (++count > limits.maxValues) return fail('work limit');
    const key = str(); if (keys.has(key)) return fail('duplicate member'); keys.add(key);
    if (!take(':')) return fail('expected colon');
    value(depth + 1); if (take('}')) return; if (!take(',')) return fail('expected comma');
   }
  }
  if (c === '[') { i++; if (take(']')) return; for (;;) { value(depth + 1); if (take(']')) return; if (!take(',')) return fail('expected comma'); } }
  if (c === '"') { str(); return; }
  const start = i;
  while (i < raw.length && !/[\s,\]}]/.test(raw.charAt(i))) i++;
  const token = raw.slice(start, i);
  if (['true', 'false', 'null'].includes(token)) return;
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(token) || !Number.isFinite(Number(token))) return fail('nonfinite or invalid number');
 }
 value(0); space(); if (i !== raw.length) fail('trailing values');
 const result: unknown = JSON.parse(raw); return result;
}

export function stringify(value: unknown, limits: Limits): Uint8Array {
 checkLimits(limits);
 let count = 0, size = 0;
 const active = new Set<object>();
 function walk(v: unknown, depth: number): void {
  if (++count > limits.maxValues || depth > limits.maxDepth || size > limits.maxJSONBytes) throw new Error('outbound work limit');
  if (v === null || typeof v === 'boolean') { size++; return; }
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('nonfinite number'); size++; return; }
  if (typeof v === 'string') {
   size += v.length;
   if (!v.isWellFormed()) throw new Error('lone surrogate');
  } else if (typeof v === 'object') {
   if (active.has(v)) throw new Error('cyclic value'); active.add(v);
   if (Array.isArray(v)) { size += v.length; if (v.length > limits.maxValues) throw new Error('outbound work limit'); for (const item of v) walk(item, depth + 1);
   } else {
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('expected plain JSON object');
    for (const key in v) {
     if (!Object.hasOwn(v, key)) continue;
     const descriptor = Object.getOwnPropertyDescriptor(v, key);
     if (!descriptor || !('value' in descriptor)) throw new Error('JSON accessor');
     const item: unknown = descriptor.value;
     size += key.length; walk(item, depth + 1);
    }
   }
   active.delete(v);
  } else { throw new Error('unsupported JSON value'); }
  if (size > limits.maxJSONBytes) throw new Error('outbound size limit');
 }
 walk(value, 0);
 const raw = JSON.stringify(value); if (raw === undefined) throw new Error('missing JSON value');
 if (raw.length > limits.maxJSONBytes) throw new Error('payload_too_large');
 return new TextEncoder().encode(raw);
}
