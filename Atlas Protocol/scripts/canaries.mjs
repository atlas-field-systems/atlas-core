import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const scratch = mkdtempSync(join(tmpdir(), 'atlas-gates-'));
function run(command, args, env = process.env) {
 const result = spawnSync(command, args, {encoding:'utf8', env, maxBuffer: 4 << 20});
 assert.ifError(result.error);
 assert.equal(result.signal, null, result.stderr);
 assert.notEqual(result.status, null, result.stderr);
 return result;
}
function rejects(command, args, env = process.env) {
 const result = run(command, args, env);
 assert.notEqual(result.status, 0, `canary unexpectedly passed ${command} ${args.join(' ')}`);
 return result;
}
let failure;
try {
 const contract = JSON.parse(readFileSync('openapi.json', 'utf8'));
 const file = join(scratch, 'contract.json');
 contract.info.version = '0.1.1'; writeFileSync(file, JSON.stringify(contract)); rejects('node', ['scripts/contract.mjs', '--contract', file]);
 contract.info.version = '0.1.0'; contract['x-atlas-catalog'].push({command:'scan'}); writeFileSync(file, JSON.stringify(contract)); rejects('node', ['scripts/contract.mjs', '--contract', file]);
 const pristine = JSON.parse(readFileSync('openapi.json', 'utf8'));
 for (const invalid of ['unsupported', 'ambiguous']) {
  const changed = structuredClone(pristine);
  changed.components.schemas.NumericTraversalProbe = invalid === 'unsupported'
   ? {type: 'array', contains: {type: 'integer'}}
   : {anyOf: [{$ref: '#/components/schemas/PluginPayload'}, {type: 'integer'}]};
  writeFileSync(file, JSON.stringify(changed));
  const failed = rejects(process.execPath, ['scripts/contract.mjs', '--contract', file]);
  assert.match(failed.stderr, invalid === 'unsupported' ? /numeric schema under unsupported contains/ : /ambiguous Plugin and typed numeric roles/);
 }
 const wide = structuredClone(pristine);
 wide.components.schemas.NumericTraversalProbe = {type: 'integer', minimum: -1e100, maximum: 1e100};
 writeFileSync(file, JSON.stringify(wide));
 const noProfile = run(process.execPath, ['scripts/contract.mjs', '--contract', file]); assert.equal(noProfile.status, 0, noProfile.stdout + noProfile.stderr);
 const target = new URL('../dist/ts/index.js', import.meta.url).href;
 const roundedSource = `const native = JSON.parse; JSON.parse = (text, reviver) => native(text, reviver ? function(key, value, context) {return reviver.call(this, key, value, typeof value === 'number' ? {...context, source: String(value)} : context);} : undefined);`;
 const numericChecks = [
  `assert.throws(() => Decode('ErrorDetails', new TextEncoder().encode('{"retry_after_seconds":100.0000000000000000001}')), 'hidden fraction must refuse');`,
  `assert.equal(new TextDecoder().decode(Encode('PluginPayload', Decode('PluginPayload', new TextEncoder().encode('9007199254740993')))), '9007199254740993', 'Plugin digits must survive');`,
 ];
 for (const check of numericChecks) {
  const body = `const {default: assert} = await import('node:assert/strict'); const {Decode, Encode} = await import(${JSON.stringify(target)}); ` + check;
  const control = run(process.execPath, ['--input-type=module', '-e', body]); assert.equal(control.status, 0, control.stdout + control.stderr);
  const mutant = rejects(process.execPath, ['--input-type=module', '-e', roundedSource + body]);
  assert.match(mutant.stderr, /AssertionError/); assert.match(mutant.stderr, /hidden fraction must refuse|Plugin digits must survive/);
 }
 console.log('Numeric gates caught rounded source and unsupported or ambiguous traversal without capping integer ranges');
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
 const runtime = join(scratch, 'dist-test'); cpSync('dist-test', runtime, {recursive:true});
 symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'dir');
 const fixtureEnv = {...process.env, ATLAS_FIXTURES: resolve('fixtures')};
 const goArgs = ['test','-count=1','-run','^TestSharedFixtures$','-json','.'];
 const tsArgs = ['--test','--test-reporter=tap','--test-name-pattern=^shared independent fixtures',join(runtime, 'test/protocol.test.js')];
 for (const [command, args] of [['go', goArgs], [process.execPath, tsArgs]]) {
  const control = run(command, args, fixtureEnv);
  assert.equal(control.status, 0, control.stdout + control.stderr);
 }
 for (const rule of ['Identifier', 'first_check_in']) {
  const weakened = JSON.parse(readFileSync('openapi.json', 'utf8'));
  const schemas = weakened.components.schemas;
  const expected = rule === 'Identifier' ? ['malformed UUID text', 'malformed UUID hex'] : ['replacement missing first_check_in'];
  if (rule === 'Identifier') schemas.Identifier = {type:'string'};
  else schemas.ReplaceAssetProcessRequest.required = schemas.ReplaceAssetProcessRequest.required.filter(field => field !== 'first_check_in');
  writeFileSync(file, JSON.stringify(weakened));
  writeFileSync(join(runtime, 'openapi.json'), JSON.stringify(weakened));
  const overlay = join(scratch, 'overlay.json'); writeFileSync(overlay, JSON.stringify({Replace: {[resolve('openapi.json')]: file}}));
  const go = rejects('go', ['test','-overlay=' + overlay, ...goArgs.slice(1)], fixtureEnv);
  const events = go.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const goNames = expected.map(name => 'TestSharedFixtures/' + name.replaceAll(' ', '_'));
  assert.deepEqual(events.filter(event => event.Action === 'fail' && event.Test).map(event => event.Test), [...goNames, 'TestSharedFixtures'], go.stdout + go.stderr);
  for (const name of goNames) assert(events.some(event => event.Test === name && event.Output?.includes('negative fixture unexpectedly passed')), go.stdout + go.stderr);
  const ts = rejects(process.execPath, tsArgs, fixtureEnv);
  assert.deepEqual([...ts.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(match => match[1]), [...expected, 'shared independent fixtures execute generated types and both validation boundaries'], ts.stdout + ts.stderr);
  assert.equal([...ts.stdout.matchAll(/error: 'Missing expected exception\.'/g)].length, expected.length, ts.stdout + ts.stderr);
  console.log(`Shared fixtures caught weakened ${rule} through the new negatives in Go and TypeScript`);
 }
 console.log('Gate canaries rejected version, Catalog, generation drift, missing fixtures and passing negatives in both consumers');
} catch (error) {failure = error; throw error;}
finally {
 try {rmSync(scratch,{recursive:true,force:true});}
 catch (cleanup) {throw failure ? new AggregateError([failure, cleanup], 'Gate canaries and cleanup failed') : cleanup;}
}
