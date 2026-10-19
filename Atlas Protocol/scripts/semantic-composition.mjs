import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import document from '../dist/openapi.json' with {type: 'json'};

const composition = process.argv[2];
assert(['oneOf', 'anyOf', 'allOf'].includes(composition));
// Equivalent compositions in this process leave the built contract files intact.
const resource = document.components.schemas.ResourceImage;
const alternatives = resource.oneOf;
delete resource.oneOf;
resource[composition] = composition === 'allOf' ? [{oneOf: alternatives}, {}] : alternatives;
const {Decode, ValidateFrame} = await import('../dist/ts/index.js');
const cases = JSON.parse(readFileSync(new URL('../fixtures/cases.json', import.meta.url)));
let count = 0;
for (const sample of cases) {
 if (!['snapshot Track geometry ', 'snapshot refuses Track geometry ', 'commit Track geometry ', 'commit refuses Track geometry '].some(prefix => sample.name.startsWith(prefix))) continue;
 count++;
 const wire = new TextEncoder().encode(JSON.stringify(sample.value));
 const validate = () => sample.schema === 'ChangesFrame'
  ? ValidateFrame('server', wire, {datasetID: 'A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6', coreRunID: '00000000-0000-0000-0000-000000000002', authenticated: true, subscribed: true})
  : Decode('ReadSnapshotResponse', wire);
 if (sample.valid) validate(); else assert.throws(validate, new RegExp(sample.error));
}
assert.equal(count, 8);
console.log(`${composition} semantic traversal passed independent snapshot and commit cases`);
