import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const docker = args => execFileSync('sudo', ['-n', 'docker', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1_048_576 }).trim();
assert.equal(git(['status', '--porcelain', '--untracked-files=normal']), '', 'Release manifest requires a clean committed checkout');
const source = JSON.parse(await readFile(join(root, 'package.json')));
const inputs = JSON.parse(await readFile(join(root, 'artifacts', 'build-inputs.json')));
const revision = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
assert.equal(inputs.sourceRevision, revision); assert.equal(inputs.sourceTree, tree); assert.equal(inputs.sourceDirty, false);
const image = (await readFile(join(root, 'artifacts', 'image-id'), 'utf8')).trim();
assert.match(image, /^sha256:[0-9a-f]{64}$/);
const [inspection] = JSON.parse(docker(['image', 'inspect', image]));
assert.equal(inspection.Id, image); assert.equal(inspection.Config.Labels['org.opencontainers.image.revision'], revision);
const embedded = JSON.parse(docker(['run', '--rm', '--network=none', '--read-only', '--log-driver=none', '--entrypoint=cat', image, '/app/artifacts/build-inputs.json']));
assert.equal(embedded.sourceRevision, revision); assert.equal(embedded.sourceTree, tree); assert.equal(embedded.sourceDirty, false);
for (const name of ['lockSha256', 'openapiSha256', 'schemaProfileSha256', 'node', 'npm']) assert.equal(embedded[name], inputs[name]);
assert.deepEqual(embedded.sqlite, inputs.sqlite);
const reference = await readFile(join(root, 'artifacts', 'openapi.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(reference), inputs.openapiSha256);
const archive = await readFile(join(root, 'artifacts', 'source.tar'));
assert.equal(hash(archive), hash(execFileSync('git', ['archive', '--format=tar', '--prefix=atlas/', 'HEAD'], { cwd: root, maxBuffer: 33_554_432 })), 'Source archive must match this exact committed tree');
const manifest = { release: source.version, sourceRevision: revision, sourceTree: tree,
  sourceArchive: { file: 'source.tar', sha256: hash(archive), bytes: archive.byteLength },
  protocol: source.atlasBuild.protocol, container: source.atlasBuild.container, npmArtifact: source.atlasBuild.npm,
  inputs, image, reference: { file: 'openapi.json', sha256: hash(reference) },
  qualification: { functional: 'Run npm test, npm run test:container and npm run fixture:retention; this input manifest does not certify their results', sustainedEightHours: 'unrun', powerLoss: 'unrun' } };
await writeFile(join(root, 'artifacts', 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Release manifest matches committed source, image inputs, native engine and stock reference');
