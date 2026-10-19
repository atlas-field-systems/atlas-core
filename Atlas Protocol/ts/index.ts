import {Ajv2020} from 'ajv/dist/2020.js';
import type {ValidateFunction} from 'ajv';
import addFormats from 'ajv-formats';
import document from '../openapi.json' with {type: 'json'};
import type {components} from './wire.gen.js';
import {schemaNames} from './metadata.gen.js';
import {DefaultLimits, isRecord, parse, stringify} from './scan.js';
import type {Limits} from './scan.js';
import {geometry} from './geometry.js';
import {NumericSources, NumericPlan, exactInteger} from './numeric.js';
import type {NumberSite, IntegerSchema} from './numeric.js';
export {PluginNumberText} from './numeric.js';
export {Version, Catalog} from './metadata.gen.js';
export {DefaultLimits} from './scan.js';
export type {Limits} from './scan.js';
export type {components, operations, paths} from './wire.gen.js';
export type SchemaName = keyof components['schemas'];

interface Schema extends IntegerSchema {
 [keyword: string]: unknown;
 description?: string;
 type?: string | string[];
 format?: string;
 $ref?: string;
 properties?: Record<string, Schema>;
 items?: Schema;
 oneOf?: Schema[];
 anyOf?: Schema[];
 allOf?: Schema[];
 not?: Schema;
 additionalProperties?: boolean | Schema;
 'x-atlas-geometry'?: boolean;
 'x-atlas-dependent-required'?: Record<string, string[]>;
 'x-atlas-unique-by'?: Record<string, string>;
}
const schemas: Record<string, Schema> = document.components.schemas;
const ajv = new Ajv2020({strict: true, allErrors: false, validateFormats: true, useDefaults: false, coerceTypes: false, removeAdditional: false});
addFormats.default(ajv, {mode: 'full'});
for (const keyword of ['components', 'x-go-type', 'x-atlas-geometry', 'x-atlas-unique-by', 'x-atlas-dependent-required', 'discriminator']) ajv.addKeyword(keyword);
const timestampGrammar = new RegExp(document.components.schemas.Timestamp.pattern);
ajv.addFormat('date-time', value => {
 if (!timestampGrammar.test(value)) return false;
 const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
 const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
 return day <= ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0);
});
ajv.addFormat('uint64-decimal', value => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n);
ajv.addFormat('base64url-json', /^[A-Za-z0-9_-]+$/);
ajv.addSchema({$id: 'urn:atlas:protocol', components: {schemas: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, candidateSchemaWithGeometryPolicy(schema, 'urn:atlas:protocol', 'validate')]))}});
const references: Record<string, object> = Object.fromEntries(schemaNames.map(name => [name, {$ref: 'urn:atlas:protocol#/components/schemas/' + name}]));
export function isSchemaName(name: string): name is SchemaName { return schemaNames.some(n => n === name); }

type GeometryPolicy = 'validate' | 'ignoreForBranchSelection';
function candidateSchemaWithGeometryPolicy(schema: Schema, root: string, policy: GeometryPolicy): Schema {
 if (schema['x-go-type'] === 'json.RawMessage') return {};
 if (policy === 'ignoreForBranchSelection' && schema['x-atlas-geometry']) return {};
 const copy = {...schema};
 if (schema.$ref) copy.$ref = root + schema.$ref;
 if (schema.properties) copy.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, candidateSchemaWithGeometryPolicy(child, root, policy)]));
 if (schema.items) copy.items = candidateSchemaWithGeometryPolicy(schema.items, root, policy);
 for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) if (schema[keyword]) copy[keyword] = schema[keyword].map(branch => candidateSchemaWithGeometryPolicy(branch, root, policy));
 copy.anyOf = [...(copy.anyOf ?? []), ...(copy.oneOf ?? [])];
 if (!copy.anyOf.length) delete copy.anyOf;
 delete copy.oneOf;
 delete copy.not;
 if (typeof schema.additionalProperties === 'object') copy.additionalProperties = candidateSchemaWithGeometryPolicy(schema.additionalProperties, root, policy);
 return copy;
}
ajv.addSchema({$id: 'urn:atlas:shape', components: {schemas: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, candidateSchemaWithGeometryPolicy(schema, 'urn:atlas:shape', 'ignoreForBranchSelection')]))}});
const shapeValidators = new WeakMap<Schema, ValidateFunction>(), semanticValidators = new WeakMap<Schema, ValidateFunction>();
function matches(schema: Schema, value: unknown, policy: GeometryPolicy): boolean {
 const cache = policy === 'ignoreForBranchSelection' ? shapeValidators : semanticValidators;
 let validate = cache.get(schema);
 if (!validate) {validate = ajv.compile(candidateSchemaWithGeometryPolicy(schema, policy === 'ignoreForBranchSelection' ? 'urn:atlas:shape' : 'urn:atlas:protocol', policy)); cache.set(schema, validate);}
 return validate(value) === true;
}
function schemaValue(schema: Schema): Schema {
 if (!schema.$ref) return schema;
 const target = schemas[schema.$ref.split('/').at(-1) ?? ''];
 if (!target) throw new Error('unknown schema reference');
 return target;
}
function uuidProperty(schema: Schema, field: string): boolean {
 const resolved = schemaValue(schema), property = resolved.properties?.[field];
 if (property) return schemaValue(property).format === 'uuid';
 return [resolved.oneOf, resolved.anyOf, resolved.allOf].some(group => group?.some(branch => uuidProperty(branch, field)));
}
function semantics(schema: Schema, value: unknown, site: NumberSite | undefined, sources: NumericSources, plan: NumericPlan): void {
 if (schema.$ref) {semantics(schemaValue(schema), value, site, sources, plan); return;}
 if (schema['x-go-type'] === 'json.RawMessage') {plan.preserve(value, site, sources); return;}
 if (schema['x-atlas-geometry']) {
  geometry(value); if (!matches(schema, value, 'validate')) throw new Error('invalid_geometry'); return;
 }
 if ((schema.type === 'integer' || Array.isArray(schema.type) && schema.type.includes('integer')) && typeof value === 'number') {
  if (!site) throw new Error('missing numeric source');
  plan.integers.set(site, exactInteger(schema, site));
 }
 for (const [group, one] of [[schema.oneOf, true], [schema.anyOf, false]] as const) {
  if (!group?.length) continue;
  let failure: unknown, accepted = 0;
  const marks = new NumericPlan();
  for (const branch of group) if (matches(branch, value, 'ignoreForBranchSelection')) {
   const candidate = new NumericPlan();
   try {semantics(branch, value, site, sources, candidate); accepted++; marks.merge(candidate);} catch (error) {failure ??= error;}
  }
  if (!accepted) throw failure ?? new Error('invalid_payload: no matching branch');
  if (one && accepted !== 1) throw new Error('invalid_payload: multiple oneOf branches');
  plan.merge(marks);
 }
 for (const branch of schema.allOf ?? []) {
  if (!matches(branch, value, 'ignoreForBranchSelection')) throw new Error('invalid_payload: allOf');
  semantics(branch, value, site, sources, plan);
 }
 if (schema.not && matches(schema.not, value, 'ignoreForBranchSelection')) {
  let accepted = false;
  try {semantics(schema.not, value, site, sources, new NumericPlan()); accepted = true;} catch {}
  if (accepted) throw new Error('invalid_payload: not');
 }

 if (isRecord(value)) {
  for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) semantics(child, value[key], sources.at(value, key), sources, plan);
  if (typeof schema.additionalProperties === 'object') for (const [key, child] of Object.entries(value)) if (!Object.hasOwn(schema.properties ?? {}, key)) semantics(schema.additionalProperties, child, sources.at(value, key), sources, plan);
  for (const [key, required] of Object.entries(schema['x-atlas-dependent-required'] ?? {})) if (Object.hasOwn(value, key)) for (const other of required) if (!Object.hasOwn(value, other)) throw new Error(`${key} requires ${other}`);
  for (const [key, identity] of Object.entries(schema['x-atlas-unique-by'] ?? {})) {
   const items = value[key]; if (!Array.isArray(items)) continue;
   const listSchema = schema.properties?.[key];
   const itemSchema = listSchema ? schemaValue(listSchema).items : undefined;
   const uuidIdentity = itemSchema !== undefined && uuidProperty(itemSchema, identity);
   const seen = new Set<string>();
   for (const item of items) if (isRecord(item) && typeof item[identity] === 'string') { const key = uuidIdentity ? item[identity].toLowerCase() : item[identity]; if (seen.has(key)) throw new Error(`duplicate ${identity}`); seen.add(key); }
  }
 }
 if (Array.isArray(value) && schema.items) for (const [i, item] of value.entries()) semantics(schema.items, item, sources.at(value, String(i)), sources, plan);
}
export function Decode<N extends SchemaName>(name: N, wire: Uint8Array, limits: Limits = DefaultLimits()): components['schemas'][N] {
 if (!isSchemaName(name)) throw new Error('unknown schema');
 const sources = new NumericSources();
 let value = parse(wire, limits, sources);
 const schema = schemas[name]; if (!schema) throw new Error('unknown schema');
 const plan = new NumericPlan();
 semantics(schema, value, sources.root, sources, plan);
 value = plan.materialize(value, sources, wire.byteLength, limits.maxJSONBytes);
 const reference = references[name]; if (!reference) throw new Error('unknown schema');
 const validate = ajv.compile<components['schemas'][N]>(reference);
 if (!validate(value)) throw new Error('invalid_payload: ' + ajv.errorsText(validate.errors));
 return value;
}
export function Encode<N extends SchemaName>(name: N, value: components['schemas'][N], limits: Limits = DefaultLimits()): Uint8Array {
 const wire = stringify(value, limits); Decode(name, wire, limits); return wire;
}
export {ValidateRequest, ValidateResponse, CheckContent} from './http.js';
export type {HTTPResponse, RequestData, ResponseContext} from './http.js';
export {ValidateFrame} from './websocket.js';
export type {FrameContext} from './websocket.js';
