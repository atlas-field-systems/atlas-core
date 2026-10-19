import {Ajv2020} from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import document from '../openapi.json' with {type: 'json'};
import type {components} from './wire.gen.js';
import {schemaNames} from './metadata.gen.js';
import {DefaultLimits, isRecord, parse, stringify} from './scan.js';
import type {Limits} from './scan.js';
import {geometry} from './geometry.js';
export {Version, Catalog} from './metadata.gen.js';
export {DefaultLimits} from './scan.js';
export type {Limits} from './scan.js';
export type {components, operations, paths} from './wire.gen.js';
export type SchemaName = keyof components['schemas'];

interface Schema {
 [keyword: string]: unknown;
 description?: string;
 type?: string | string[];
 $ref?: string;
 properties?: Record<string, Schema>;
 items?: Schema;
 oneOf?: Schema[];
 anyOf?: Schema[];
 allOf?: Schema[];
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
ajv.addSchema({$id: 'urn:atlas:protocol', components: document.components});
const references: Record<string, object> = Object.fromEntries(schemaNames.map(name => [name, {$ref: 'urn:atlas:protocol#/components/schemas/' + name}]));
export function isSchemaName(name: string): name is SchemaName { return schemaNames.some(n => n === name); }

function semantics(schema: Schema, value: unknown): void {
 if (value === null) return;
 if (schema.$ref) { const target = schemas[schema.$ref.split('/').at(-1) ?? '']; if (!target) throw new Error('unknown schema reference'); semantics(target, value); return; }
 if (schema['x-atlas-geometry']) {
  geometry(value); const reference = references.Geometry; if (!reference) throw new Error('missing Geometry schema'); const valid = ajv.compile(reference);
  if (!valid(value)) throw new Error('invalid_geometry'); return;
 }
 for (const group of [schema.oneOf, schema.anyOf, schema.allOf]) for (const branch of group ?? []) semantics(branch, value);
 if (isRecord(value)) {
  for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) semantics(child, value[key]);
  for (const [key, required] of Object.entries(schema['x-atlas-dependent-required'] ?? {})) if (Object.hasOwn(value, key)) for (const other of required) if (!Object.hasOwn(value, other)) throw new Error(`${key} requires ${other}`);
  for (const [key, identity] of Object.entries(schema['x-atlas-unique-by'] ?? {})) {
   const items = value[key]; if (!Array.isArray(items)) continue;
   const seen = new Set<string>();
   for (const item of items) if (isRecord(item) && typeof item[identity] === 'string') { const key = item[identity]; if (seen.has(key)) throw new Error(`duplicate ${identity}`); seen.add(key); }
  }
 }
 if (Array.isArray(value) && schema.items) for (const item of value) semantics(schema.items, item);
}
export function Decode<N extends SchemaName>(name: N, wire: Uint8Array, limits: Limits = DefaultLimits()): components['schemas'][N] {
 if (!isSchemaName(name)) throw new Error('unknown schema');
 const value = parse(wire, limits);
 const schema = schemas[name]; if (!schema) throw new Error('unknown schema');
 semantics(schema, value);
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
