import assert from 'node:assert/strict';
import document from '../dist/openapi.json' with {type: 'json'};

const mode = process.argv[2], schemas = document.components.schemas;
schemas.NumericProbeInteger = {type: 'integer', minimum: 0, maximum: 1000};
const integer = {$ref: '#/components/schemas/NumericProbeInteger'};
const fraction = {type: 'number', minimum: 100, maximum: 100.5};
let selected, tests;
switch (mode) {
 case 'oneOf': case 'anyOf': case 'allOf':
  selected = {[mode]: [integer, fraction]};
  tests = [['100.0000000000000000001', mode !== 'allOf', 0], ['100.0', mode !== 'oneOf', 0], ['1e-400', false, 0]]; break;
 case 'not':
  selected = {type: 'number', not: integer};
  tests = [['100.0000000000000000001', true, 0], ['100.0', false, 0], ['1e-400', true, 0]]; break;
 case 'arrays':
  selected = {type: 'array', items: integer};
  tests = [['[100.0,1e2]', true, 0], ['[100.0,100.0000000000000000001]', false, 0]]; break;
 case 'properties':
  selected = {type: 'object', properties: {fixed: integer}, additionalProperties: integer};
  tests = [['{"fixed":100.0,"10":1e2,"2":1000e-1}', true, 0], ['{"fixed":100.0,"2":100.0000000000000000001}', false, 0]]; break;
 case 'rollback':
  selected = {anyOf: [{allOf: [integer, {not: {enum: [1000]}}]}, {type: 'number'}]};
  tests = [['1e3', true, 0]]; break;
 case 'duplicate':
  selected = {anyOf: [integer, integer]};
  tests = [['1e3', true, 1]]; break;
 case 'wide':
  selected = {type: 'integer', minimum: 1e100, maximum: 1e100};
  tests = [['1e100', true, 96]]; break;
 default: throw new Error('unknown numeric composition');
}
schemas.EntityListQuery.properties.page_size = selected;
const {Decode, DefaultLimits} = await import('../dist/ts/index.js');
for (const [token, valid, growth] of tests) {
 const wire = new TextEncoder().encode('{"page_size":' + token + '}');
 const limits = {...DefaultLimits(), maxJSONBytes: wire.length + growth};
 const check = () => Decode('EntityListQuery', wire, limits);
 if (valid) check(); else assert.throws(check);
 if (growth) assert.throws(() => Decode('EntityListQuery', wire, {...limits, maxJSONBytes: limits.maxJSONBytes - 1}), /payload_too_large/);
}
console.log(`${mode} exact numeric branch acceptance and source accounting passed`);
