import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';

const [tarball, trustedManifest, ...extra] = process.argv.slice(2);
assert.ok(
  tarball &&
    trustedManifest &&
    isAbsolute(tarball) &&
    isAbsolute(trustedManifest) &&
    extra.length === 0,
  'Usage: node verify-operator-tarball.mjs /absolute/package.tgz /absolute/trusted-manifest.json',
);
const record = await open(
  trustedManifest,
  constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
);
let manifest;
try {
  assert.ok((await record.stat()).isFile(), 'Manifest must be a regular file');
  const bytes = Buffer.alloc(65_537);
  let size = 0;
  while (size < bytes.length) {
    const read = await record.read(bytes, size, bytes.length - size);
    if (!read.bytesRead) break;
    size += read.bytesRead;
  }
  assert.ok(size <= 65_536, 'Manifest exceeds record limit');
  manifest = JSON.parse(bytes.subarray(0, size).toString('utf8'));
} finally {
  await record.close();
}
const artifact = manifest.operatorPackage;
assert.ok(
  artifact &&
    /^[0-9a-f]{64}$/.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.bytes) &&
    artifact.bytes > 0,
);
assert.equal(basename(tarball), artifact.file);
const file = await open(tarball, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
try {
  const info = await file.stat();
  assert.ok(info.isFile(), 'Tarball must be a regular file');
  assert.equal(info.size, artifact.bytes, 'Tarball byte length mismatch');
  const hash = createHash('sha256');
  let count = 0;
  for await (const chunk of file.createReadStream()) {
    count += chunk.byteLength;
    assert.ok(count <= artifact.bytes, 'Tarball grew beyond its manifest byte length');
    hash.update(chunk);
  }
  assert.equal(count, artifact.bytes, 'Tarball byte length changed');
  assert.equal(hash.digest('hex'), artifact.sha256, 'Tarball SHA-256 mismatch');
} finally {
  await file.close();
}
process.stdout.write(
  'Verified operator tarball against trusted manifest. No npm command was run.\n',
);
