import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parse as parseContentType} from 'content-type';
import {parse as parseDisposition} from 'content-disposition';
import document from '../openapi.json' with {type: 'json'};
import {Decode, Encode, isSchemaName} from './index.js';
import {Version} from './metadata.gen.js';
import {checkLimits, DefaultLimits, isRecord, parse} from './scan.js';
import type {Limits} from './scan.js';
import type {components} from './wire.gen.js';
type Descriptor = components['schemas']['UploadObjectDescriptor'];
interface Schema {[keyword: string]: unknown; type?: string | string[]; $ref?: string; properties?: Record<string, Schema>}
interface Parameter {name?: string; in?: string; required?: boolean; schema?: Schema; $ref?: string; content?: Record<string, {schema: Schema}>}
interface HeaderContract {required?: boolean; $ref?: string}
interface ResponseContract {[keyword: string]: unknown; $ref?: string; headers?: Record<string, HeaderContract>; content?: Record<string, {schema: Schema}>}
interface Operation {operationId: string; parameters: Parameter[]; responses: Record<string, ResponseContract>; 'x-atlas-binding': {query_schema: string; body_schema: string | null; response_schema: string | null; mutation: boolean}}
const paths: Record<string, Record<string, Operation>> = document.paths;
const responses: Record<string, ResponseContract> = document.components.responses;
const headerContracts: Record<string, HeaderContract> = document.components.headers;
const schemas: Record<string, Schema> = document.components.schemas;
const bytes = (s: string) => new TextEncoder().encode(s);
const sameID = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function operation(name: string) {
 for (const [path, methods] of Object.entries(paths)) for (const [method, op] of Object.entries(methods)) if (op.operationId === name) return {path, method: method.toUpperCase(), op};
 throw new Error('unknown operation');
}
function header(headers: Headers, key: string): string {const v = headers.get(key); if (!v) throw new Error(`missing ${key}`); return v;}
function context(headers: Headers) {
 const dataset = header(headers, 'Atlas-Dataset-ID'), version = header(headers, 'Atlas-Protocol-Version');
 Decode('Identifier', bytes(JSON.stringify(dataset)));
 if (version.includes(',') || version.length > 128) throw new Error('invalid version header');
 return {dataset, version};
}
// These strict parsers accept spaces around separators. Preserve quoted values
// while admitting HTTP horizontal whitespace in the same positions.
function parameterSpacing(raw: string): string {return raw.replace(/"(?:[^"\\]|\\.)*"|[ \t]+/g, part => part.startsWith('"') ? part : ' ');}
function mediaType(raw: string) {
 const spaced = parameterSpacing(raw), {type, parameters} = parseContentType(spaced);
 // The parser keeps the last parameter. Refuse duplicates before trusting charset.
 const seen = new Set<string>();
 for (const [parameter] of spaced.matchAll(/;(?:[^;"]|"(?:[^"\\]|\\.)*")*/g)) {
  const name = parameter.slice(1, parameter.indexOf('=')).trim().toLowerCase();
  if (seen.has(name)) throw new Error('duplicate media parameter'); seen.add(name);
 }
 if (parameters.charset !== undefined && parameters.charset.toLowerCase() !== 'utf-8') throw new Error('unsupported_media_type');
 return type;
}
function media(headers: Headers) {return mediaType(header(headers, 'Content-Type'));}
async function* chunks(body: ReadableStream<Uint8Array> | null) {
 if (!body) return;
 const reader = body.getReader();
 try {for (;;) {const next = await reader.read(); if (next.done) return; yield next.value;}} finally {reader.releaseLock();}
}
async function bounded(body: ReadableStream<Uint8Array> | null, limits: Limits): Promise<Uint8Array> {
 checkLimits(limits); const parts: Uint8Array[] = []; let size = 0;
 for await (const part of chunks(body)) {if (part.byteLength === 0) continue; size += part.byteLength; if (size > limits.maxJSONBytes) throw new Error('payload_too_large'); parts.push(part);}
 return Buffer.concat(parts, size);
}
function pathFacts(pattern: string, path: string) {
 const wanted = pattern.split('/'), got = path.split('/'); if (wanted.length !== got.length) throw new Error('wrong path');
 const facts: Record<string, string> = {};
 for (const [i, part] of wanted.entries()) {
  const actual = got[i]; if (actual === undefined) throw new Error('wrong path');
  if (part.startsWith('{')) facts[part.slice(1, -1)] = decodeURIComponent(actual);
  else if (part !== actual) throw new Error('wrong path');
 }
 return facts;
}
function queryStringSize(value: string, budget: number): number {
 let size = 2;
 if (size > budget) throw new Error('payload_too_large');
 for (const c of value) {
  let n = Buffer.byteLength(c);
  if ('"\\\b\f\n\r\t'.includes(c)) n = 2;
  else if (c.charCodeAt(0) < 32 || c === '\u2028' || c === '\u2029') n = 6;
  if (n > budget - size) throw new Error('payload_too_large');
  size += n;
 }
 return size;
}
function quoteQueryString(value: string): string {return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');}
function query(raw: string, op: Operation, limits: Limits) {
 const encoded = raw.slice(1);
 if (Buffer.byteLength(encoded) > limits.maxJSONBytes) throw new Error('payload_too_large');
 // URLSearchParams repairs malformed text. Decode each original pair first.
 for (const pair of encoded.split('&')) if (pair) for (const part of pair.split('=')) decodeURIComponent(part.replaceAll('+', ' '));
 const values = new URLSearchParams(raw), seen = new Set<string>(), members: string[] = [];
 let size = 2;
 if (size > limits.maxJSONBytes) throw new Error('payload_too_large');
 for (const [key, value] of values) {
  if (seen.size >= limits.maxValues) throw new Error('query work limit');
  if (seen.has(key)) throw new Error('duplicate query'); seen.add(key);
  const parameter = op.parameters.find(p => p.in === 'query' && p.name === key); if (!parameter) throw new Error('unsupported_filter');
  let schema = parameter.schema ?? parameter.content?.['application/json']?.schema;
  if (schema?.$ref) schema = schemas[schema.$ref.split('/').at(-1) ?? ''];
  const quoted = schema?.type === 'string', punctuation = 1 + Number(members.length > 0);
  const keySize = queryStringSize(key, limits.maxJSONBytes - size - punctuation);
  const remaining = limits.maxJSONBytes - size - punctuation - keySize;
  const valueSize = quoted ? queryStringSize(value, remaining) : Buffer.byteLength(value);
  if (valueSize > remaining) throw new Error('payload_too_large');
  size += punctuation + keySize + valueSize;
  if (!quoted) parse(bytes(value), limits);
  members.push(quoteQueryString(key) + ':' + (quoted ? quoteQueryString(value) : value));
 }
 const wire = bytes('{' + members.join(',') + '}');
 const name = op['x-atlas-binding'].query_schema; if (!isSchemaName(name)) throw new Error('unknown query schema');
 Decode(name, wire, limits); return wire;
}
export async function CheckContent(descriptor: Descriptor, content: AsyncIterable<Uint8Array>, limits: Limits = DefaultLimits()): Promise<void> {
 Encode('UploadObjectDescriptor', descriptor, limits);
 const size = BigInt(descriptor.byte_length); if (size > limits.maxFileBytes) throw new Error('payload_too_large');
 const hash = createHash('sha256'); let received = 0n;
 for await (const chunk of content) {received += BigInt(chunk.byteLength); if (received > size || received > limits.maxFileBytes) throw new Error('integrity_fault'); hash.update(chunk);}
 if (received !== size || hash.digest('hex') !== descriptor.sha256) throw new Error('integrity_fault');
}
export interface RequestData {json?: Uint8Array; upload?: Descriptor; query: Uint8Array}
export async function ValidateRequest(name: string, request: Request, expectedDataset: string, limits: Limits = DefaultLimits()): Promise<RequestData> {
 checkLimits(limits);
 const {path, method, op} = operation(name); if (request.method !== method) throw new Error('wrong method');
 const url = new URL(request.url), facts = pathFacts(path, url.pathname);
 if (name !== 'SubscribeChanges') {
  const key = header(request.headers, 'Authorization'); if (key.slice(0, 7).toLowerCase() !== 'bearer ') throw new Error('unauthenticated');
  try {Encode('APIKeySecret', key.slice(7));} catch {throw new Error('unauthenticated');}
  if (name !== 'GetHealth') {const {dataset, version} = context(request.headers); if (expectedDataset && !sameID(dataset, expectedDataset)) throw new Error('dataset_mismatch'); if (version !== Version) throw new Error('protocol_mismatch');}
 }
 for (const parameter of op.parameters) if (parameter.in === 'header' && parameter.required && parameter.name) header(request.headers, parameter.name);
 for (const [key, value] of Object.entries(facts)) {
  const param = op.parameters.find(p => p.in === 'path' && p.name === key), schema = param?.schema?.$ref?.split('/').at(-1);
  if (!schema || !isSchemaName(schema)) throw new Error('unknown path schema'); Decode(schema, bytes(JSON.stringify(value)), limits);
 }
 const checkedQuery = query(url.search, op, limits);
 if (name === 'SubscribeChanges') {
  if (header(request.headers, 'Upgrade').toLowerCase() !== 'websocket' || header(request.headers, 'Sec-WebSocket-Version') !== '13' || !header(request.headers, 'Connection').toLowerCase().split(',').some(x => x.trim() === 'upgrade')) throw new Error('invalid WebSocket upgrade');
  const key = header(request.headers, 'Sec-WebSocket-Key'), decoded = Buffer.from(key, 'base64'); if (decoded.byteLength !== 16 || decoded.toString('base64') !== key) throw new Error('invalid WebSocket key'); if ((await bounded(request.body, limits)).byteLength) throw new Error('unexpected body'); return {query: checkedQuery};
 }
 if (name === 'UploadObject') {
  if (media(request.headers) !== 'application/octet-stream') throw new Error('unsupported_media_type');
  const raw = header(request.headers, 'Atlas-Object-Descriptor');
  if (raw.length > Math.ceil(limits.maxJSONBytes * 4 / 3)) throw new Error('payload_too_large');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('invalid descriptor encoding');
  const wire = Buffer.from(raw, 'base64url'); if (wire.toString('base64url') !== raw) throw new Error('invalid descriptor encoding');
  const descriptor = Decode('UploadObjectDescriptor', wire, limits); await CheckContent(descriptor, chunks(request.body), limits); return {upload: descriptor, query: checkedQuery};
 }
 const wire = await bounded(request.body, limits), schema = op['x-atlas-binding'].body_schema;
 if (schema) {
  if (media(request.headers) !== 'application/json') throw new Error('unsupported_media_type');
  if (!isSchemaName(schema)) throw new Error('unknown request schema');
  const value = Decode(schema, wire, limits);
  if (isRecord(value)) {
   for (const [key, actual] of Object.entries(facts)) if (typeof value[key] === 'string' && !sameID(value[key], actual)) throw new Error('path/body identity conflict');
   const source = isRecord(value.report) ? value.report.source : value.source;
   if (facts.asset_id && isRecord(source) && typeof source.asset_id === 'string' && !sameID(source.asset_id, facts.asset_id)) throw new Error('source/path identity conflict');
  }
  return {json: wire, query: checkedQuery};
 }
 if (wire.byteLength) throw new Error('unexpected body'); return {query: checkedQuery};
}
export interface HTTPResponse {status: number; headers: Headers; body: ReadableStream<Uint8Array> | null}
export interface ResponseContext {datasetID: string; object?: components['schemas']['Object']; webSocketKey?: string; disposition?: 'inline' | 'attachment'}
export async function ValidateResponse(name: string, response: HTTPResponse, ctx: ResponseContext, limits: Limits = DefaultLimits()): Promise<Uint8Array | undefined> {
 const expectedDataset = ctx.datasetID, expectedObject = ctx.object;
 const {op} = operation(name); let declared = op.responses[String(response.status)]; if (!declared) throw new Error('undeclared response status');
 if (declared.$ref) declared = responses[declared.$ref.split('/').at(-1) ?? '']; if (!declared) throw new Error('unknown response');
 for (const [name, declaration] of Object.entries(declared.headers ?? {})) {
  const contract = declaration.$ref ? headerContracts[declaration.$ref.split('/').at(-1) ?? ''] : declaration;
  if (!contract) throw new Error('unknown header contract'); if (contract.required) header(response.headers, name);
 }
 const {dataset, version} = context(response.headers), refusal = response.status >= 400;
 if (!refusal && (version !== Version || expectedDataset && !sameID(dataset, expectedDataset))) throw new Error('response context mismatch');
 if (response.status === 101) {
  if (name !== 'SubscribeChanges' || header(response.headers, 'Upgrade').toLowerCase() !== 'websocket' || header(response.headers, 'Connection').toLowerCase() !== 'upgrade') throw new Error('invalid WebSocket response');
  const accept = header(response.headers, 'Sec-WebSocket-Accept'), decoded = Buffer.from(accept, 'base64'); if (decoded.byteLength !== 20 || decoded.toString('base64') !== accept || !ctx.webSocketKey || createHash('sha1').update(ctx.webSocketKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') !== accept) throw new Error('invalid WebSocket accept'); return;
 }
 const kind = media(response.headers);
 if (name === 'ReadObjectContent' && !refusal) {
  const size = header(response.headers, 'Content-Length'), digest = header(response.headers, 'Content-Digest'), match = /^sha-256=:([A-Za-z0-9+/]+={0,2}):$/.exec(digest);
  if (!match?.[1]) throw new Error('invalid digest');
  const hash = Buffer.from(match[1], 'base64'); if (hash.byteLength !== 32 || hash.toString('base64') !== match[1]) throw new Error('invalid digest');
  const mode = parseDisposition(parameterSpacing(header(response.headers, 'Content-Disposition'))).type;
  if (mode !== 'inline' && mode !== 'attachment') throw new Error('invalid disposition');
  if (ctx.disposition && mode !== ctx.disposition) throw new Error('wrong disposition');
  const descriptor: Descriptor = {object_id: dataset, request_id: dataset, byte_length: size, sha256: hash.toString('hex'), content_type: kind, metadata: {name: 'content', entity_ids: [], task_ids: []}};
  if (expectedObject && (expectedObject.byte_length !== size || expectedObject.sha256 !== descriptor.sha256 || mediaType(expectedObject.content_type) !== kind)) throw new Error('object response mismatch');
  await CheckContent(descriptor, chunks(response.body), limits); return;
 }
 const content = declared.content?.[kind]; if (!content) throw new Error('undeclared response media');
 const wire = await bounded(response.body, limits);
 if (kind === 'text/html') {new TextDecoder('utf-8', {fatal: true}).decode(wire); return wire;}
 if (name === 'GetReferenceDocument' && !refusal) {if (!isDeepStrictEqual(parse(wire, limits), document)) throw new Error('reference document mismatch'); return wire;}
 const schema = content.schema.$ref?.split('/').at(-1); if (!schema || !isSchemaName(schema)) throw new Error('unknown response schema');
 const value = Decode(schema, wire, limits);
 if (!isRecord(value)) throw new Error('invalid response');
 if (typeof value.dataset_id === 'string' && !sameID(value.dataset_id, dataset)) throw new Error('body/header Dataset mismatch');
 const code = isRecord(value.error) ? value.error.code : undefined;
 if (expectedDataset && !sameID(dataset, expectedDataset) && code !== 'dataset_mismatch') throw new Error('response Dataset mismatch');
 if (version !== Version && code !== 'protocol_mismatch') throw new Error('response Protocol mismatch'); return wire;
}
