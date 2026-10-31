import { z } from 'zod';
import { writeFile, rename, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export const checkNames = [
  'tasks',
  'order',
  'assets',
  'positions',
  'final_position',
  'tracks',
  'tags',
  'faults',
] as const;
export type CheckName = (typeof checkNames)[number];
export const CheckResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('passed') }),
  z.strictObject({
    kind: z.literal('failed'),
    reasons: z.array(z.string().max(1024)).min(1).max(100),
  }),
  z.strictObject({ kind: z.literal('unrun'), reason: z.string().max(1024) }),
]);
export const CheckResults = z.strictObject({
  tasks: CheckResult,
  order: CheckResult,
  assets: CheckResult,
  positions: CheckResult,
  final_position: CheckResult,
  tracks: CheckResult,
  tags: CheckResult,
  faults: CheckResult,
});
export type CheckResults = z.infer<typeof CheckResults>;
export const CleanupEvidence = z.strictObject({
  writersDrained: z.boolean(),
  createdKeysRevoked: z.boolean(),
  clientsClosed: z.boolean(),
  coreExit: z.enum(['verified', 'unverified', 'not-owned']),
  failures: z.array(z.string().max(1024)).max(100),
});
export type CleanupEvidence = z.infer<typeof CleanupEvidence>;
export const RunRecord = z.strictObject({
  scenario: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  at: z.iso.datetime(),
  source: z.strictObject({
    branch: z.string().max(256),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    dirty: z.boolean(),
  }),
  inputs: z.strictObject({
    scenario: z.string().regex(/^[a-f0-9]{64}$/),
    settings: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  checks: CheckResults,
  cleanup: CleanupEvidence,
  verdict: z.enum(['passed', 'failed']),
  failures: z.array(z.string().max(1024)).max(100),
  measurements: z.record(z.string().max(64), z.number().finite().nullable()),
  environment: z.strictObject({
    node: z.string(),
    cpu: z.string().max(256),
    cpus: z.number().int(),
    memory: z.number().int(),
    kernel: z.string().max(256),
    image: z.string().max(80),
  }),
});
export type RunRecord = z.infer<typeof RunRecord>;
export function unrun(reason: string): CheckResults {
  const item = { kind: 'unrun', reason } as const;
  return {
    tasks: item,
    order: item,
    assets: item,
    positions: item,
    final_position: item,
    tracks: item,
    tags: item,
    faults: item,
  };
}
export function passed(checks: CheckResults, cleanup: CleanupEvidence): boolean {
  return (
    checkNames.every((n) => checks[n].kind === 'passed') &&
    cleanup.writersDrained &&
    cleanup.createdKeysRevoked &&
    cleanup.clientsClosed &&
    cleanup.coreExit !== 'unverified' &&
    !cleanup.failures.length
  );
}
export async function saveRecord(directory: string, record: RunRecord): Promise<string> {
  RunRecord.parse(record);
  const bytes = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(bytes) > 262144) throw new Error('Record exceeds 256 KiB');
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    `${record.scenario}-${record.at.replaceAll(':', '-')}-${record.source.commit.slice(0, 12)}.json`,
  );
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  return path;
}
export async function readRecord(path: string): Promise<RunRecord> {
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(262145);
    const n = await file.read(bytes);
    if (n.bytesRead > 262144) throw new Error('Record exceeds 256 KiB');
    return RunRecord.parse(JSON.parse(bytes.subarray(0, n.bytesRead).toString('utf8')));
  } finally {
    await file.close();
  }
}
