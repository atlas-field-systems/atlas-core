import { z } from 'zod';
import { Counter, Uuid } from '@atlas/protocol';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, exited, processIdentity } from './ownership.js';
import { Settings } from './settings.js';
import { WriterIdentity } from './objects.js';
import { id } from './exact.js';
import { readLocalJson } from './local-json.js';

export const ImageId = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const Manifest = z.strictObject({ format: z.literal(1), installation_id: Uuid, image: ImageId });
const Applied = z.strictObject({ revision: Counter, value: Settings });
export const SavedSettings = z.strictObject({ revision: Counter, saved: Settings, effective: Applied.nullable(), last_working: Applied.nullable(),
  apply_failure: z.enum(['start_failed', 'apply_required']).nullable() });
export type SavedSettings = z.infer<typeof SavedSettings>;
export const ContainerWriter = z.strictObject({ container: z.string().regex(/^[0-9a-f]{64}$/), launch: Uuid, kind: z.enum(['service', 'oneshot']), host: WriterIdentity.nullable() });
export const ExitProof = z.strictObject({ container: z.string().regex(/^[0-9a-f]{64}$/), launch: Uuid, installation: Uuid });
export type ContainerWriter = z.infer<typeof ContainerWriter>;
export const Action = z.strictObject({ format: z.literal(1), action_id: Uuid, installation_id: Uuid,
  kind: z.enum(['reset', 'hard-reset', 'update']), old_dataset: Uuid.nullable(), intended_dataset: Uuid,
  writer: ContainerWriter.nullable(), image: ImageId, phase: z.enum(['intent', 'stopped', 'cleaned', 'established', 'complete']),
  primary_failure: z.enum(['writer_exit_unverified', 'docker_failed', 'cleanup_failed', 'repair_required']).nullable(),
  cleanup_failure: z.enum(['writer_exit_unverified', 'docker_failed', 'cleanup_failed', 'repair_required']).nullable() });
export type Action = z.infer<typeof Action>;
export const Proof = z.strictObject({ action_id: Uuid, dataset: Uuid, installation_id: Uuid });
export const Marker = z.strictObject({ exists: z.boolean(), dataset: Uuid.nullable(), marker: z.object({ dataset: Uuid, actionId: Uuid }).nullable() });
export type Marker = z.infer<typeof Marker>;
export async function readJsonFile<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  const file = await readFile(path);
  if (file.byteLength > 65_536) throw new Error('record_limit');
  return readLocalJson(file, schema);
}
export async function optionalJson<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | undefined> {
  try { return await readJsonFile(path, schema); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}
export async function installationLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(join(root, 'control'), { recursive: true, mode: 0o700 });
  const path = join(root, 'control', 'command.lock');
  const schema = z.strictObject({ id: Uuid, owner: WriterIdentity });
  const token = id();
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const previous = await optionalJson(join(path, 'owner.json'), schema);
    if (previous === undefined || !await exited(previous.owner)) throw new Error('management_busy');
    await rm(path, { recursive: true });
    await mkdir(path, { mode: 0o700 });
  }
  await atomicJson(join(path, 'owner.json'), { id: token, owner: await processIdentity() });
  try { return await action(); }
  finally {
    const owner = await readJsonFile(join(path, 'owner.json'), schema);
    if (owner.id !== token) throw new Error('management_lock_changed');
    await rm(path, { recursive: true });
  }
}
export function recoveryDecision(action: Action, marker: Marker, proof: z.infer<typeof Proof> | undefined): 'preserve' | 'establish' {
  const agrees = marker.marker?.actionId === action.action_id && marker.marker.dataset === action.intended_dataset && marker.dataset === action.intended_dataset;
  const proofAgrees = proof === undefined || proof.action_id === action.action_id && proof.dataset === action.intended_dataset && proof.installation_id === action.installation_id;
  if (agrees && proofAgrees) return 'preserve';
  if (proof !== undefined || action.phase === 'established' || action.phase === 'complete') throw new Error('repair_required');
  if (marker.marker?.actionId === action.action_id || marker.dataset !== null && marker.dataset !== action.old_dataset) throw new Error('repair_required');
  if (!marker.exists && marker.dataset !== null || marker.exists && marker.dataset === null) throw new Error('repair_required');
  return 'establish';
}
