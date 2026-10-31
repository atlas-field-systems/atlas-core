import { constants } from 'node:fs';
import { open, mkdir, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, X509Certificate, createPrivateKey } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { z } from 'zod';
import { Uuid } from '@atlas/protocol';
import { optionalJson, readJsonFile } from './installation.js';
import { atomicJson, flushDirectory, ownedDirectory } from './ownership.js';
import { id } from './exact.js';

const Pin = z.strictObject({
  generation: Uuid,
  certificateSha256: z.string().regex(/^[0-9a-f]{64}$/),
  notAfter: z.string().max(64),
});
export const TlsState = z.strictObject({
  format: z.literal(1),
  saved: Pin,
  active: Pin.nullable(),
  activationFailure: z.literal('start_failed').nullable(),
});
const Journal = z.strictObject({ previous: Uuid.nullable(), next: Pin });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function tlsBytes(path: string, privateFile = false): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
      throw new Error('tls_invalid');
    throw error;
  });
  let primary: unknown;
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (privateFile && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new Error('tls_invalid');
    const bytes = Buffer.alloc(65_537);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 65_536) throw new Error('record_limit');
    return bytes.subarray(0, size);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await file.close();
    } catch (error) {
      throw primary === undefined ? error : new AggregateError([primary, error], 'tls_read_failed');
    }
  }
}
export function validateTls(certificate: string, key: string) {
  return readTlsPair(certificate, key, 'current');
}
async function readTlsPair(certificate: string, key: string, validity: 'current' | 'historical') {
  const [certRead, keyRead] = await Promise.allSettled([
    tlsBytes(certificate),
    tlsBytes(key, true),
  ]);
  if (certRead.status === 'rejected' || keyRead.status === 'rejected') {
    const failures: unknown[] = [];
    if (certRead.status === 'rejected') failures.push(certRead.reason);
    if (keyRead.status === 'rejected') failures.push(keyRead.reason);
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'tls_read_failed');
  }
  const cert = certRead.value,
    privateKey = keyRead.value;
  try {
    const parsed = new X509Certificate(cert);
    if (
      (validity === 'current' &&
        (Date.parse(parsed.validFrom) > Date.now() || Date.parse(parsed.validTo) <= Date.now())) ||
      !parsed.checkPrivateKey(createPrivateKey(privateKey))
    )
      throw new Error('tls_invalid');
    createSecureContext({ cert, key: privateKey });
    return {
      cert,
      privateKey,
      certificateSha256: hash(cert),
      notAfter: new Date(parsed.validTo).toISOString(),
    };
  } catch {
    throw new Error('tls_invalid');
  }
}
const statePath = (root: string) => join(root, 'setup', 'tls-state.json');
const journalPath = (root: string) => join(root, 'setup', 'tls-journal.json');
function paths(root: string, generation: string) {
  const directory = join(root, 'setup', 'tls', generation);
  return {
    directory,
    certificate: join(directory, 'certificate.pem'),
    key: join(directory, 'private.key'),
  };
}
async function generations(root: string): Promise<string[]> {
  const result: string[] = [];
  const directory = await opendir(join(root, 'setup', 'tls')).catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!directory) return result;
  for await (const entry of directory) {
    if (result.length >= 8) throw new Error('tls_generation_limit');
    if (!entry.isDirectory() || !Uuid.safeParse(entry.name).success)
      throw new Error('repair_required');
    result.push(entry.name);
  }
  return result;
}
export async function tlsView(root: string) {
  const state = await optionalJson(statePath(root), TlsState);
  const journal = await optionalJson(journalPath(root), Journal);
  return {
    ...state,
    conversionRequired: state === undefined,
    recoveryRequired: journal !== undefined,
    pendingActivation: state !== undefined && state.saved.generation !== state.active?.generation,
  };
}
export async function savedTls(root: string) {
  if (await optionalJson(journalPath(root), Journal)) throw new Error('recovery_required');
  const state = await optionalJson(statePath(root), TlsState);
  if (!state) throw new Error('tls_conversion_required');
  const pair = paths(root, state.saved.generation);
  const checked = await validateTls(pair.certificate, pair.key);
  if (
    checked.certificateSha256 !== state.saved.certificateSha256 ||
    checked.notAfter !== state.saved.notAfter
  )
    throw new Error('repair_required');
  return { ...pair, state };
}
export async function saveTls(root: string, certificate: string, key: string): Promise<void> {
  const checked = await validateTls(certificate, key);
  if (await optionalJson(journalPath(root), Journal)) throw new Error('recovery_required');
  const previous = await optionalJson(statePath(root), TlsState);
  await ownedDirectory(join(root, 'setup', 'tls'));
  if ((await generations(root)).length >= 7) throw new Error('tls_generation_limit');
  const next = {
    generation: id(),
    certificateSha256: checked.certificateSha256,
    notAfter: checked.notAfter,
  };
  await atomicJson(journalPath(root), { previous: previous?.saved.generation ?? null, next });
  const pair = paths(root, next.generation);
  await mkdir(pair.directory, { mode: 0o700 });
  for (const [path, bytes] of [
    [pair.certificate, checked.cert],
    [pair.key, checked.privateKey],
  ] satisfies [string, Buffer][]) {
    const file = await open(path, 'wx', 0o600);
    const failures: unknown[] = [];
    try {
      await file.writeFile(bytes);
      await file.sync();
    } catch (error) {
      failures.push(error);
    }
    try {
      await file.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'tls_flush_failed');
  }
  await flushDirectory(pair.directory);
  await flushDirectory(join(root, 'setup', 'tls'));
  await atomicJson(statePath(root), {
    format: 1,
    saved: next,
    active: previous?.active ?? null,
    activationFailure: null,
  });
  await rm(journalPath(root));
  await flushDirectory(join(root, 'setup'));
}
export async function recordTlsActivation(root: string, success: boolean): Promise<void> {
  const state = await readJsonFile(statePath(root), TlsState);
  await atomicJson(statePath(root), {
    ...state,
    active: success ? state.saved : state.active,
    activationFailure: success ? null : 'start_failed',
  });
}
export async function recoverTlsAfterWriterExit(root: string): Promise<void> {
  const state = await optionalJson(statePath(root), TlsState);
  const journal = await optionalJson(journalPath(root), Journal);
  if (state) {
    const pair = paths(root, state.saved.generation);
    const checked = await readTlsPair(pair.certificate, pair.key, 'historical');
    if (
      checked.certificateSha256 !== state.saved.certificateSha256 ||
      checked.notAfter !== state.saved.notAfter
    )
      throw new Error('repair_required');
  }
  if (journal) {
    if (state?.saved.generation === journal.next.generation) {
      const pair = paths(root, journal.next.generation);
      const checked = await readTlsPair(pair.certificate, pair.key, 'historical');
      if (checked.certificateSha256 !== journal.next.certificateSha256)
        throw new Error('repair_required');
    } else if ((state?.saved.generation ?? null) !== journal.previous)
      throw new Error('repair_required');
    await rm(journalPath(root));
    await flushDirectory(join(root, 'setup'));
  }
  const retained = await generations(root);
  for (const generation of retained) {
    if (generation !== state?.saved.generation && generation !== state?.active?.generation)
      await rm(paths(root, generation).directory, { recursive: true });
  }
  if (retained.length) await flushDirectory(join(root, 'setup', 'tls'));
}
