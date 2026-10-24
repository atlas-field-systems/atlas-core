import { visit } from 'jsonc-parser';
import { parse, isLosslessNumber } from 'lossless-json';
import { z } from 'zod';
import { ProtocolError } from './failure.js';
import { validNumberToken, wellFormed } from './scalars.js';
import { Geometry, LineString, Point, Polygon } from './geometry.js';
import { NegotiatedLimits } from './administration.js';
import { inputSections, readSections } from './reports.js';
import type { BoundaryCode } from './failure.js';
const geometryRoots: readonly (readonly [z.ZodType, readonly string[]])[] = [
  [Geometry, []],
  [LineString, []],
  [Point, []],
  [Polygon, []],
  [inputSections.geometry, ['value']],
  [readSections.geometry, ['value']],
];

export type Budget = Readonly<{
  maxBytes: number;
  maxValues: number;
  maxDepth: number;
  maxChanges: number;
  maxGeometryWork: number;
}>;
export type Boundary = 'http_request' | 'http_response' | 'wss_control' | 'wss_data';
const requestBudget: Budget = Object.freeze({
  maxBytes: 1048576,
  maxValues: 65536,
  maxDepth: 32,
  maxChanges: 1000,
  maxGeometryWork: 4194304,
});
const responseBudget: Budget = Object.freeze({
  maxBytes: 4194304,
  maxValues: 262144,
  maxDepth: 32,
  maxChanges: 1000,
  maxGeometryWork: 4194304,
});
const controlBudget: Budget = Object.freeze({
  maxBytes: 16384,
  maxValues: 4096,
  maxDepth: 32,
  maxChanges: 1000,
  maxGeometryWork: 4194304,
});
export const budgets = Object.freeze({
  http_request: requestBudget,
  http_response: responseBudget,
  wss_control: controlBudget,
  wss_data: responseBudget,
});
export type JsonContract<S extends z.ZodType = z.ZodType> = Readonly<{
  schema: S;
  boundary: Boundary;
  controlTypes?: readonly string[];
  messageLimits?: Readonly<{ path: readonly string[]; frameType?: string }>;
}>;
export function contract<S extends z.ZodType>(
  schema: S,
  boundary: Boundary = 'http_request',
): JsonContract<S> {
  return { schema, boundary };
}

export function effectiveBudget(boundary: Boundary, lower?: Partial<Budget>): Budget {
  const caps = budgets[boundary];
  const result = { ...caps };
  for (const key of [
    'maxBytes',
    'maxValues',
    'maxDepth',
    'maxChanges',
    'maxGeometryWork',
  ] as const) {
    const value = lower?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolError('invalid_budget');
    result[key] = Math.min(value, caps[key]);
  }
  return result;
}

export function messageBudget(budget: Budget, limits: z.output<typeof NegotiatedLimits>): Budget {
  return {
    ...budget,
    maxBytes: Math.min(budget.maxBytes, limits.max_message_bytes),
    maxValues: Math.min(budget.maxValues, limits.max_json_values),
    maxChanges: Math.min(budget.maxChanges, limits.max_changes),
  };
}

function preflight(source: string, budget: Budget, messageLimits?: JsonContract['messageLimits']) {
  let values = 0,
    depth = 0;
  let property = '',
    rootType: string | undefined;
  const limits: Record<string, unknown> = {};
  const objects: (Set<string> | null)[] = [];
  const value = () => {
    if (++values > budget.maxValues || depth + 1 > budget.maxDepth)
      throw new ProtocolError('resource_limit');
  };
  const begin = (keys: Set<string> | null) => {
    value();
    depth++;
    objects.push(keys);
  };
  const end = () => {
    depth--;
    objects.pop();
  };
  visit(
    source,
    {
      onObjectBegin: () => begin(new Set()),
      onObjectEnd: end,
      onArrayBegin: () => begin(null),
      onArrayEnd: end,
      onObjectProperty: (name) => {
        property = name;
        if (!wellFormed(name)) throw new ProtocolError('invalid_json');
        const keys = objects[objects.length - 1];
        if (!keys || keys.has(name)) throw new ProtocolError('invalid_json');
        keys.add(name);
      },
      onLiteralValue: (literal, offset, length, _line, _character, pathSupplier) => {
        value();
        if (depth === 1 && property === 'type' && typeof literal === 'string') rootType = literal;
        if (typeof literal === 'string' && !wellFormed(literal))
          throw new ProtocolError('invalid_json');
        if (typeof literal === 'number' && !validNumberToken(source.slice(offset, offset + length)))
          throw new ProtocolError('invalid_value');
        if (
          messageLimits &&
          depth === messageLimits.path.length + 1 &&
          Object.hasOwn(NegotiatedLimits.shape, property)
        ) {
          const path = pathSupplier();
          if (messageLimits.path.every((part, index) => part === path[index]))
            limits[property] = parse(source.slice(offset, offset + length));
        }
      },
      onError: () => {
        throw new ProtocolError('invalid_json');
      },
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
  );
  if (values === 0 || depth !== 0) throw new ProtocolError('invalid_json');
  const declared =
    messageLimits && (messageLimits.frameType === undefined || messageLimits.frameType === rootType)
      ? NegotiatedLimits.safeParse(limits)
      : undefined;
  return { rootType, values, limits: declared?.success ? declared.data : undefined };
}

function record(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}
function reserveWork(value: unknown, budget: Budget): void {
  let work = 0,
    changes = 0;
  const walk = (item: unknown): void => {
    if (!item || typeof item !== 'object' || isLosslessNumber(item)) return;
    if (record(item)) {
      if (item.type === 'Polygon' && Array.isArray(item.coordinates) && item.coordinates.length > 1)
        throw new ProtocolError('unsupported_geometry');
      if (
        item.type === 'LineString' &&
        Array.isArray(item.coordinates) &&
        item.coordinates.length > 1024
      )
        throw new ProtocolError('geometry_limit_exceeded');
      if (
        item.type === 'Polygon' &&
        Array.isArray(item.coordinates) &&
        Array.isArray(item.coordinates[0])
      ) {
        const count = item.coordinates[0].length;
        if (count > 1024) throw new ProtocolError('geometry_limit_exceeded');
        const cost = count * count + 8 * count;
        if (cost > budget.maxGeometryWork - work) throw new ProtocolError('resource_limit');
        work += cost;
      }
      if (Array.isArray(item.changes)) changes += item.changes.length;
      if (
        Array.isArray(item.items) &&
        item.items.some(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            'kind' in entry &&
            entry.kind === 'put' &&
            'resource_kind' in entry,
        )
      )
        changes += item.items.length;
      if (changes > budget.maxChanges) throw new ProtocolError('resource_limit');
      for (const member of Object.values(item)) walk(member);
    } else if (Array.isArray(item)) for (const member of item) walk(member);
  };
  walk(value);
}

function* leafIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): Generator<z.core.$ZodIssue> {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length) {
      for (const branch of issue.errors) yield* leafIssues(branch, path);
    } else yield { ...issue, path };
  }
}
function atPath(value: unknown, path: readonly PropertyKey[]): unknown {
  for (const part of path) {
    if (Array.isArray(value) && typeof part === 'number') value = value[part];
    else if (
      value !== null &&
      typeof value === 'object' &&
      record(value) &&
      typeof part === 'string'
    )
      value = value[part];
    else return undefined;
  }
  return value;
}
function geometryCode(
  schema: z.ZodType,
  value: unknown,
  issue: z.core.$ZodIssue,
): BoundaryCode | undefined {
  const ownCode: unknown = issue.code === 'custom' ? issue.params?.geometryCode : undefined;
  if (
    ownCode === 'invalid_geometry' ||
    ownCode === 'unsupported_geometry' ||
    ownCode === 'geometry_limit_exceeded'
  )
    return ownCode;
  const root = geometryRoots.find(([definition]) => definition === schema)?.[1];
  let path: readonly PropertyKey[] | undefined = root?.every(
    (part, index) => part === issue.path[index],
  )
    ? root
    : undefined;
  for (let index = 0; path === undefined && index < issue.path.length; index++) {
    if (
      issue.path[index] !== 'geometry' ||
      issue.path[index - 1] === 'source_times' ||
      issue.path[index - 1] === 'reserves'
    )
      continue;
    const candidate = issue.path.slice(0, index + 1);
    const owner = atPath(value, issue.path.slice(0, index));
    if (
      issue.path[index - 1] === 'sections' ||
      (owner !== null &&
        typeof owner === 'object' &&
        'entity_type' in owner &&
        (owner.entity_type === 'observation' || owner.entity_type === 'track'))
    ) {
      if (issue.path[index + 1] === 'value') path = issue.path.slice(0, index + 2);
    } else path = candidate;
  }
  if (path === undefined) return undefined;
  const geometry = atPath(value, path);
  return geometry !== null &&
    typeof geometry === 'object' &&
    'type' in geometry &&
    typeof geometry.type === 'string' &&
    !['Point', 'LineString', 'Polygon'].includes(geometry.type)
    ? 'unsupported_geometry'
    : 'invalid_geometry';
}
function validate<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  let code: BoundaryCode = 'invalid_value';
  const diagnostics: { path: string; message: string }[] = [];
  for (const issue of leafIssues(result.error.issues)) {
    const geometry = geometryCode(schema, value, issue);
    if (
      geometry &&
      (code === 'invalid_value' ||
        geometry === 'unsupported_geometry' ||
        geometry === 'geometry_limit_exceeded')
    )
      code = geometry;
    if (diagnostics.length < 16)
      diagnostics.push({
        path: issue.path.map((part) => (typeof part === 'number' ? String(part) : '*')).join('.'),
        message: issue.code,
      });
  }
  throw new ProtocolError(code, diagnostics);
}

export function checkJsonBytes(
  bytes: Uint8Array,
  boundary: Boundary = 'http_request',
  lower?: Partial<Budget>,
): void {
  const budget = effectiveBudget(boundary, lower);
  if (bytes.byteLength > budget.maxBytes) throw new ProtocolError('payload_too_large');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ProtocolError('invalid_utf8');
  }
  preflight(source, budget);
}

export function readJson<S extends z.ZodType>(
  definition: JsonContract<S>,
  bytes: Uint8Array,
  lower?: Partial<Budget>,
): z.output<S> {
  return readPreparedJson(definition, bytes, (value) => value, lower);
}

export function readPreparedJson<S extends z.ZodType>(
  definition: JsonContract<S>,
  bytes: Uint8Array,
  prepare: (value: unknown) => unknown,
  lower?: Partial<Budget>,
): z.output<S> {
  let budget = effectiveBudget(definition.boundary, lower);
  if (bytes.byteLength > budget.maxBytes) throw new ProtocolError('payload_too_large');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ProtocolError('invalid_utf8');
  }
  const facts = preflight(source, budget, definition.messageLimits);
  const type = facts.rootType;
  if (facts.limits) {
    budget = messageBudget(budget, facts.limits);
    if (bytes.byteLength > budget.maxBytes) throw new ProtocolError('payload_too_large');
    if (facts.values > budget.maxValues) throw new ProtocolError('resource_limit');
  }
  if (type && definition.controlTypes?.includes(type)) {
    const control = effectiveBudget('wss_control', lower);
    if (bytes.byteLength > control.maxBytes) throw new ProtocolError('payload_too_large');
    preflight(source, control);
  }
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw new ProtocolError('invalid_json');
  }
  reserveWork(value, budget);
  return validate(definition.schema, prepare(value));
}

function measure(value: unknown, budget: Budget): void {
  let bytes = 0,
    values = 0;
  const active = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > budget.maxBytes) throw new ProtocolError('payload_too_large');
  };
  const string = (input: string) => {
    if (!wellFormed(input)) throw new ProtocolError('invalid_value');
    add(2);
    for (const scalar of input) {
      const code = scalar.codePointAt(0) ?? 0;
      add(
        code < 32
          ? code === 8 || code === 9 || code === 10 || code === 12 || code === 13
            ? 2
            : 6
          : code === 34 || code === 92
            ? 2
            : code < 128
              ? 1
              : code < 2048
                ? 2
                : code < 65536
                  ? 3
                  : 4,
      );
    }
  };
  const walk = (item: unknown, depth: number): void => {
    if (++values > budget.maxValues || depth > budget.maxDepth)
      throw new ProtocolError('resource_limit');
    if (item === null) {
      add(4);
      return;
    }
    if (typeof item === 'string') {
      string(item);
      return;
    }
    if (typeof item === 'boolean') {
      add(item ? 4 : 5);
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      add(String(item).length);
      return;
    }
    if (typeof item !== 'object' || active.has(item)) throw new ProtocolError('invalid_value');
    if (Array.isArray(item)) {
      if (item.length > budget.maxValues - values) throw new ProtocolError('resource_limit');
      if (item.length > 0 && 2 * item.length + 1 > budget.maxBytes - bytes)
        throw new ProtocolError('payload_too_large');
    }
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new ProtocolError('invalid_value');
    if (Object.getOwnPropertySymbols(item).length) throw new ProtocolError('invalid_value');
    active.add(item);
    add(2);
    if (Array.isArray(item)) {
      if (Object.getOwnPropertyNames(item).length !== item.length + 1)
        throw new ProtocolError('invalid_value');
      for (let index = 0; index < item.length; index++) {
        if (index) add(1);
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new ProtocolError('invalid_value');
        walk(descriptor.value, depth + 1);
      }
    } else {
      let count = 0;
      for (const key of Object.getOwnPropertyNames(item)) {
        if (count++) add(1);
        string(key);
        add(1);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new ProtocolError('invalid_value');
        walk(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
  };
  walk(value, 1);
}

export function validateValue<S extends z.ZodType>(
  definition: JsonContract<S>,
  value: unknown,
  lower?: Partial<Budget>,
): z.output<S> {
  const budget = effectiveBudget(definition.boundary, lower);
  measure(value, budget);
  reserveWork(value, budget);
  return validate(definition.schema, value);
}

export function writeJson<S extends z.ZodType>(
  definition: JsonContract<S>,
  value: z.output<S>,
  lower?: Partial<Budget>,
): Uint8Array {
  const type =
    value !== null && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'type')
      : undefined;
  const control =
    type &&
    'value' in type &&
    typeof type.value === 'string' &&
    definition.controlTypes?.includes(type.value);
  let budget = effectiveBudget(control ? 'wss_control' : definition.boundary, lower);
  measure(value, budget);
  if (
    definition.messageLimits &&
    (definition.messageLimits.frameType === undefined ||
      (type && 'value' in type && type.value === definition.messageLimits.frameType))
  ) {
    const limits = NegotiatedLimits.safeParse(atPath(value, definition.messageLimits.path));
    if (limits.success) {
      budget = messageBudget(budget, limits.data);
      measure(value, budget);
    }
  }
  reserveWork(value, budget);
  const checked = validate(definition.schema, value);
  measure(checked, budget);
  return new TextEncoder().encode(JSON.stringify(checked));
}
