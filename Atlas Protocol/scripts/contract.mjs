import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sourceIndex = process.argv.indexOf('--contract');
const doc = JSON.parse(readFileSync(sourceIndex < 0 ? new URL('../openapi.json', import.meta.url) : process.argv[sourceIndex + 1]));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.equal(doc.info.version, pkg.version);
const inventory = readFileSync(new URL('../fixtures/inventory.tsv', import.meta.url), 'utf8').trim().split('\n').map(line => line.split('\t'));
const operations = Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({path, method: method.toUpperCase(), ...op})));
assert.equal(doc.openapi, '3.1.0');
assert.equal(doc.info.version, '0.1.0');
assert.deepEqual(doc['x-atlas-catalog'].map(x => x.command), ['move_to', 'pause', 'resume']);
assert.deepEqual(doc.components.schemas.CommandName.enum, ['move_to', 'pause', 'resume']);
assert.deepEqual(doc.components.schemas.TaskCommand.oneOf.map(x => x.$ref.split('/').at(-1)), ['MoveToCommand', 'PauseCommand', 'ResumeCommand']);
assert.deepEqual(doc.components.schemas.CommandSupport.oneOf.map(x => x.$ref.split('/').at(-1)), ['MoveToSupport', 'PauseSupport', 'ResumeSupport']);
for (const entry of doc['x-atlas-catalog']) assert(doc.components.schemas[entry.schema], entry.command);
assert.equal(operations.length, inventory.length);
assert.equal(new Set(inventory.map(x => x[0])).size, 67);
for (const [id, method, path] of inventory) {
 const op = operations.find(x => x.operationId === id);
 assert(op, `missing ${id}`);
 assert.equal(op.method, method, id);
 assert.equal(op.path, path, id);
 assert(op['x-atlas-binding'], id);
 for (const [status, response] of Object.entries(op.responses)) {
  const resolved = response.$ref ? doc.components.responses[response.$ref.split('/').at(-1)] : response;
  assert(resolved.headers['Atlas-Dataset-ID'], `${id}/${status} Dataset`);
  assert(resolved.headers['Atlas-Protocol-Version'], `${id}/${status} version`);
 }
}
for (const [name, schema] of Object.entries(doc.components.schemas)) {
 if (schema.type === 'object') assert.equal(schema.additionalProperties, false, name);
}
const traversed = new Set(['properties', 'items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', 'not']);
const schemaPositions = ['prefixItems', 'contains', 'patternProperties', 'dependentSchemas', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', '$defs', 'definitions'];
function numericRoles(schema, path = [], ancestors = new Set()) {
 if (!schema || typeof schema !== 'object') return [];
 if (schema.$ref) {
  assert(schema.$ref.startsWith('#/components/schemas/'), 'unsupported numeric schema reference');
  assert(!ancestors.has(schema.$ref), 'recursive schema needs bounded numeric traversal');
  const target = doc.components.schemas[schema.$ref.split('/').at(-1)]; assert(target);
  const roles = numericRoles(target, path, new Set([...ancestors, schema.$ref]));
  const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => !['$ref', 'description', 'summary'].includes(key)));
  const siblingRoles = numericRoles(siblings, path, ancestors);
  assert(Object.keys(siblings).length === 0 || roles.length + siblingRoles.length === 0, 'numeric ref siblings need explicit traversal');
  return roles;
 }
 if (schema['x-go-type'] === 'json.RawMessage') return [{path, role: 'plugin'}];
 const types = Array.isArray(schema.type) ? schema.type : [schema.type];
 const roles = types.some(type => type === 'integer' || type === 'number') ? [{path, role: 'typed'}] : [];
 for (const key of schemaPositions) if (schema[key]) {
  const children = Array.isArray(schema[key]) ? schema[key] : ['patternProperties', 'dependentSchemas', '$defs', 'definitions'].includes(key) ? Object.values(schema[key]) : [schema[key]];
  assert(children.every(child => numericRoles(child).length === 0), `numeric schema under unsupported ${key}`);
 }
 for (const [key, child] of Object.entries(schema)) if (traversed.has(key)) {
  if (key === 'properties') for (const [name, property] of Object.entries(child)) roles.push(...numericRoles(property, [...path, name], ancestors));
  else if (key === 'items' || key === 'additionalProperties') roles.push(...numericRoles(child, [...path, '*'], ancestors));
  else if (Array.isArray(child)) for (const branch of child) roles.push(...numericRoles(branch, path, ancestors));
  else roles.push(...numericRoles(child, path, ancestors));
 }
 return roles;
}
for (const [name, schema] of Object.entries(doc.components.schemas)) {
 const roles = numericRoles(schema);
 for (const plugin of roles.filter(item => item.role === 'plugin')) for (const typed of roles.filter(item => item.role === 'typed')) {
  const overlap = plugin.path.length <= typed.path.length && plugin.path.every((part, i) => part === '*' || typed.path[i] === '*' || part === typed.path[i]);
  assert(!overlap, `ambiguous Plugin and typed numeric roles in ${name}`);
 }
}
console.log(`contract OK, ${inventory.length} bindings, exact version and three commands`);
