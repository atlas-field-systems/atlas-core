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
console.log(`contract OK, ${inventory.length} bindings, exact version and three commands`);
