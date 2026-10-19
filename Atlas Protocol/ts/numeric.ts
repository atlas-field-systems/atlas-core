const numericToken = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const nativeJSON = JSON;
if (!('rawJSON' in nativeJSON) || typeof nativeJSON.rawJSON !== 'function' || !('isRawJSON' in nativeJSON) || typeof nativeJSON.isRawJSON !== 'function') throw new Error('Atlas requires native JSON.rawJSON and JSON.isRawJSON');
const rawJSON = nativeJSON.rawJSON, isRawJSON = nativeJSON.isRawJSON;
let hasNumericSource = false;
JSON.parse('1', (_key: string, value: unknown, context?: unknown): unknown => {
 hasNumericSource = typeof context === 'object' && context !== null && 'source' in context && context.source === '1';
 return value;
});
if (!hasNumericSource) throw new Error('Atlas requires numeric source in the JSON.parse reviver');

export function nativeRaw(value: unknown): boolean {return isRawJSON(value) === true;}
export function PluginNumberText(value: unknown): string | undefined {
 if (!nativeRaw(value) || typeof value !== 'object' || value === null || !('rawJSON' in value) || typeof value.rawJSON !== 'string' || !numericToken.test(value.rawJSON)) return undefined;
 return value.rawJSON;
}
function numberAtom(text: string): object {
 const atom: unknown = rawJSON(text);
 if (typeof atom !== 'object' || atom === null || PluginNumberText(atom) !== text || !Object.isFrozen(atom)) throw new Error('invalid native numeric atom');
 return atom;
}
try {
 numberAtom('1.0');
 if (nativeRaw({rawJSON: '1.0'})) throw new Error('raw JSON lookalike');
} catch {
 throw new Error('Atlas requires native numeric JSON.rawJSON and JSON.isRawJSON');
}
export interface NumberSite {readonly holder: object; readonly key: string; readonly text: string}
export class NumericSources {
 private readonly holders = new WeakMap<object, Map<string, NumberSite>>();
 root: NumberSite | undefined;
 reviver(holder: unknown, key: string, value: unknown, context: unknown): unknown {
  this.root = undefined;
  if (typeof value !== 'number') return value;
  if (typeof holder !== 'object' || holder === null || typeof context !== 'object' || context === null || !('source' in context) || typeof context.source !== 'string') throw new Error('missing numeric source');
  const site = {holder, key, text: context.source};
  let keys = this.holders.get(holder);
  if (!keys) {keys = new Map(); this.holders.set(holder, keys);}
  keys.set(key, site); this.root = site;
  return value;
 }
 at(holder: object, key: string): NumberSite | undefined {return this.holders.get(holder)?.get(key);}
}

export class Decimal {
 private first = -1;
 private last = 0;
 private dot = -1;
 private digits = 0;
 private power = 0;
 private negative = false;
 constructor(private readonly source: string) {
  this.negative = source.startsWith('-');
  const exp = source.search(/[eE]/), end = exp < 0 ? source.length : exp;
  let fractional = 0, trailing = 0;
  for (let i = 0; i < end; i++) {
   const c = source.charAt(i);
   if (c === '.') {this.dot = i; continue;}
   if (c === '-') continue;
   if (this.dot >= 0) fractional++;
   if (c !== '0') {if (this.first < 0) this.first = i; this.last = i; trailing = 0;} else trailing++;
  }
  if (this.first < 0) {this.negative = false; return;}
  this.digits = this.last - this.first + 1;
  if (this.dot > this.first && this.dot < this.last) this.digits--;
  if (exp >= 0) {
   let i = exp + 1;
   const negativeExponent = source.charAt(i) === '-';
   if (['+', '-'].includes(source.charAt(i))) i++;
   // The scanner already requires finite binary64, with at most 309 integer digits.
   const cap = source.length + 309 + 1;
   for (; i < source.length; i++) {
    const digit = source.charCodeAt(i) - 48;
    if (this.power > Math.floor((cap - digit) / 10)) {this.power = cap; break;}
    this.power = this.power * 10 + digit;
   }
   if (negativeExponent) this.power = -this.power;
  }
  this.power += trailing - fractional;
 }
 private digit(i: number): string {
  if (i >= this.digits) return '0';
  let pos = this.first + i;
  if (this.dot >= this.first && pos >= this.dot) pos++;
  return this.source.charAt(pos);
 }
 compare(other: Decimal): number {
  if (this.first < 0 && other.first < 0) return 0;
  if (this.negative !== other.negative) return this.negative ? -1 : 1;
  let result = 0;
  if (this.first < 0) result = -1;
  else if (other.first < 0) result = 1;
  else if (this.digits + this.power !== other.digits + other.power) result = this.digits + this.power < other.digits + other.power ? -1 : 1;
  else for (let i = 0; i < Math.max(this.digits, other.digits); i++) if (this.digit(i) !== other.digit(i)) {result = this.digit(i) < other.digit(i) ? -1 : 1; break;}
  return this.negative ? -result : result;
 }
 integerSize(): number {
  if (this.first < 0) return 1;
  if (this.power < 0) throw new Error('invalid_payload: noninteger');
  return this.digits + this.power + Number(this.negative);
 }
}
export interface IntegerSchema {minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; enum?: unknown[]}
export function exactInteger(schema: IntegerSchema, site: NumberSite): Decimal {
 const d = new Decimal(site.text); d.integerSize();
 for (const [bound, direction, exclusive] of [[schema.minimum, -1, false], [schema.maximum, 1, false], [schema.exclusiveMinimum, -1, true], [schema.exclusiveMaximum, 1, true]] as const) {
  if (bound === undefined) continue;
  const cmp = d.compare(new Decimal(String(bound)));
  if (cmp === direction || exclusive && cmp === 0) throw new Error('invalid_payload: integer bound');
 }
 if (schema.enum && !schema.enum.some(n => typeof n === 'number' && d.compare(new Decimal(String(n))) === 0)) throw new Error('invalid_payload: integer enum');
 return d;
}
export class NumericPlan {
 readonly integers = new Map<NumberSite, Decimal>();
 readonly plugins = new Set<NumberSite>();
 merge(other: NumericPlan): void {
  for (const [site, d] of other.integers) this.integers.set(site, d);
  for (const site of other.plugins) this.plugins.add(site);
 }
 preserve(value: unknown, site: NumberSite | undefined, sources: NumericSources): void {
  if (typeof value === 'number') {if (!site) throw new Error('missing numeric source'); this.plugins.add(site);}
  else if (Array.isArray(value)) {for (const [i, child] of value.entries()) this.preserve(child, sources.at(value, String(i)), sources);}
  else if (typeof value === 'object' && value !== null) for (const [key, child] of Object.entries(value)) this.preserve(child, sources.at(value, key), sources);
 }
 materialize(value: unknown, sources: NumericSources, originalSize: number, maxBytes: number): unknown {
  let size = originalSize;
  for (const site of this.integers.keys()) size -= site.text.length;
  for (const [site, d] of this.integers) {
   if (this.plugins.has(site)) throw new Error('ambiguous Plugin and typed numeric roles');
   const n = d.integerSize(); if (n > maxBytes - size) throw new Error('payload_too_large: canonical integers'); size += n;
  }
  for (const site of this.plugins) {
   const atom = numberAtom(site.text);
   if (site === sources.root) value = atom;
   else if (!Reflect.set(site.holder, site.key, atom)) throw new Error('numeric holder is immutable');
  }
  return value;
 }
}
