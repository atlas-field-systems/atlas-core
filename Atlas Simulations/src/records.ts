import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
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
    appliedSettings: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(100)
      .optional(),
    actualSettings: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  versions: z
    .strictObject({
      protocol: z.string().max(32),
      sdk: z.string().max(32),
      core: z.string().max(32),
    })
    .optional(),
  checks: CheckResults,
  cleanup: CleanupEvidence,
  verdict: z.enum(['passed', 'failed']),
  failures: z.array(z.string().max(1024)).max(100),
  measurements: z
    .record(z.string().max(64), z.number().finite().nullable())
    .refine((m) => Object.keys(m).length <= 100, 'Measurement capacity'),
  environment: z.strictObject({
    node: z.string().max(32),
    npm: z.string().max(32).optional(),
    docker: z.string().max(64).optional(),
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
  for (const value of [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT])
    if (value !== undefined && !/^[0-9]{1,20}$/.test(value))
      throw new Error('Invalid CI record identity');
  const bytes = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(bytes) > 262144) throw new Error('Record exceeds 256 KiB');
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    `${record.scenario}-${record.at.replaceAll(':', '-')}-${record.source.commit.slice(0, 12)}-${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}.json`,
  );
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  let primary: unknown;
  try {
    await link(temporary, path);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (primary)
        throw new AggregateError(
          [primary, error],
          'Record publication and temporary cleanup failed',
        );
      throw error;
    }
  }
  return path;
}
export async function readRecord(path: string): Promise<RunRecord> {
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(262145);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 262144) throw new Error('Record exceeds 256 KiB');
    return RunRecord.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally {
    await file.close();
  }
}
