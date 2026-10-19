import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const scratch = mkdtempSync(join(tmpdir(), 'atlas-gates-'));
function rejects(command, args, env = process.env) {
 const result = spawnSync(command, args, {encoding:'utf8', env, maxBuffer: 4 << 20});
 assert.equal(result.signal, null, result.stderr);
 assert(result.status !== null && result.status !== 0, `canary unexpectedly passed ${command} ${args.join(' ')}`);
}
try {
 const contract = JSON.parse(readFileSync('openapi.json', 'utf8'));
 const file = join(scratch, 'contract.json');
 contract.info.version = '0.1.1'; writeFileSync(file, JSON.stringify(contract)); rejects('node', ['scripts/contract.mjs', '--contract', file]);
 contract.info.version = '0.1.0'; contract['x-atlas-catalog'].push({command:'scan'}); writeFileSync(file, JSON.stringify(contract)); rejects('node', ['scripts/contract.mjs', '--contract', file]);
 for (const f of ['wire.gen.go','types.gen.go','consumers.gen_test.go','ts/wire.gen.ts','ts/metadata.gen.ts']) {cpSync(f, join(scratch, f), {recursive:true});}
 writeFileSync(join(scratch, 'wire.gen.go'), readFileSync('wire.gen.go', 'utf8') + '\n');
 rejects('bash', ['scripts/generate.sh', '--check', scratch]);
 const fixtures = join(scratch, 'fixtures'); cpSync('fixtures', fixtures, {recursive:true});
 const cases = JSON.parse(readFileSync(join(fixtures,'cases.json'), 'utf8'));
 const env = {...process.env, ATLAS_FIXTURES: fixtures};
 const missing = cases.find(c => !c.valid); assert(missing);
 writeFileSync(join(fixtures,'cases.json'), JSON.stringify(cases.filter(c => c !== missing)));
 rejects('go', ['test','-count=1','-run','^TestSharedFixtures$','.'], env);
 rejects('node', ['--test','--test-name-pattern=^shared independent fixtures','dist-test/test/protocol.test.js'], env);
 const canary = cases.find(c => c.name === 'bad counter 18446744073709551616'); assert(canary); canary.value = '0';
 writeFileSync(join(fixtures,'cases.json'), JSON.stringify(cases));
 rejects('go', ['test','-count=1','-run','^TestSharedFixtures$','.'], env);
 rejects('node', ['--test','--test-name-pattern=^shared independent fixtures','dist-test/test/protocol.test.js'], env);
 console.log('Gate canaries rejected version, Catalog, generation drift, missing fixtures and passing negatives in both consumers');
} finally {rmSync(scratch,{recursive:true,force:true});}
