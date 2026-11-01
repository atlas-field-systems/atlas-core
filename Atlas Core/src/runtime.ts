import { savedTls } from './tls.js';
import { Worker } from 'node:worker_threads';
import { open, unlink, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Uuid } from '@atlas/protocol';
import { createCore } from './server.js';
import {
  Action,
  ExitProof,
  Manifest,
  Marker,
  Proof,
  SavedSettings,
  optionalJson,
  readJsonFile,
  recoveryDecision,
} from './installation.js';
import { maintenanceServer } from './maintenance.js';
import { flushDirectory, processIdentity } from './ownership.js';
import { faultFrames } from './diagnostics.js';

const [mode, root] = process.argv.slice(2);
let close: (() => Promise<void>) | undefined;
async function offline(data: unknown): Promise<unknown> {
  const worker = new Worker(new URL('./offline.js', import.meta.url), {
    workerData: data,
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let value: unknown;
  worker.once('message', (result) => {
    value = result;
  });
  const code = await new Promise<number>((resolve, reject) => {
    worker.once('exit', resolve);
    worker.once('error', () => reject(new Error('offline_worker_failed')));
  });
  if (
    code !== 0 ||
    value === undefined ||
    z.object({ failed: z.literal(true) }).safeParse(value).success
  )
    throw new Error('offline_operation_failed');
  return value;
}
try {
  if (!root) throw new Error('installation_required');
  if (mode !== 'serve') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const raw of process.stdin) {
      if (!Buffer.isBuffer(raw) || (bytes += raw.byteLength) > 65_536)
        throw new Error('input_limit');
      chunks.push(raw);
    }
    const raw: unknown =
      chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const readonly = mode === 'inspect-marker' || mode === 'check-update';
    const settings = readonly
      ? undefined
      : (await readJsonFile(join(root, 'setup', 'settings.json'), SavedSettings)).saved;
    const data = z.record(z.string(), z.unknown()).parse(raw);
    const value = await offline({
      ...data,
      mode,
      directory: join(root, 'data'),
      ...(readonly ? {} : { settings }),
    });
    process.stdout.write(JSON.stringify(value) + '\n');
  } else {
    const manifest = await readJsonFile(join(root, 'setup', 'installation.json'), Manifest);
    const pending = await optionalJson(join(root, 'recovery', 'action.json'), Action);
    if (pending !== undefined && pending.phase !== 'complete') throw new Error('recovery_required');
    const settings = await readJsonFile(join(root, 'setup', 'settings.json'), SavedSettings);
    const launch = Uuid.parse(process.env.ATLAS_LAUNCH_ID);
    const lock = join(root, 'control', 'core.lock');
    const lockFile = await open(lock, 'wx', 0o600);
    await lockFile.writeFile(JSON.stringify({ launch, owner: await processIdentity() }));
    await lockFile.sync();
    await lockFile.close();
    if (pending) {
      const proof = await readJsonFile(join(root, 'recovery', 'proof.json'), Proof);
      const marker = Marker.parse(
        await offline({ mode: 'inspect-marker', directory: join(root, 'data') }),
      );
      if (
        pending.installation_id !== manifest.installation_id ||
        recoveryDecision(pending, marker, proof) !== 'preserve'
      )
        throw new Error('repair_required');
    }
    const directory = join(root, 'control', 'exits');
    const proofs = await opendir(directory).catch((error) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    const verified: { file: string; launch: Uuid }[] = [];
    const exitedLaunches: Uuid[] = [];
    if (proofs)
      for await (const entry of proofs) {
        if (verified.length >= 100_000) throw new Error('exit_proof_limit');
        const file = entry.name;
        if (!/^[0-9a-f]{64}\.json$/.test(file)) continue;
        const proof = await readJsonFile(join(directory, file), ExitProof);
        if (proof.installation !== manifest.installation_id || `${proof.container}.json` !== file)
          throw new Error('repair_required');
        exitedLaunches.push(proof.launch);
        verified.push({ file, launch: proof.launch });
      }
    const tls = await savedTls(root);
    const core = await createCore({
      directory: join(root, 'data'),
      accountingRoot: root,
      certificate: tls.certificate,
      key: tls.key,
      settings: settings.saved,
      exitedLaunches,
    });
    let maintenance: Awaited<ReturnType<typeof maintenanceServer>> | undefined;
    let stopping: Promise<void> | undefined;
    let listening = false;
    close = () =>
      (stopping ??= (async () => {
        listening = false;
        const failures: unknown[] = [];
        try {
          await core.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await maintenance?.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) throw new AggregateError(failures, 'runtime_shutdown_failed');
        await unlink(lock);
      })());
    const requiredLaunches = new Set(
      z
        .array(Uuid)
        .max(8192)
        .parse(await core.rpc.call('file-owners', {}, 1024, true)),
    );
    if (pending?.writer) requiredLaunches.add(pending.writer.launch);
    for (const proof of verified)
      if (!requiredLaunches.has(proof.launch)) await unlink(join(directory, proof.file));
    if (verified.length > 0) await flushDirectory(directory);
    maintenance = await maintenanceServer(
      root,
      async (request) => {
        switch (request.operation) {
          case 'inspect':
            return {
              dataset: core.dataset,
              run: core.run,
              ready: listening && core.rpc.available,
              worker: core.rpc.available,
              queues: core.rpc.usage,
              diagnostics: core.diagnostics.inspect(),
            };
          case 'stop':
            listening = false;
            await core.rpc.call('drain', {}, 0, true);
            return { stopping: true };
          case 'settings-save': {
            const saved = await readJsonFile(join(root, 'setup', 'settings.json'), SavedSettings);
            if (saved.revision !== request.expected_revision)
              throw new Error('settings_revision_changed');
            return { validated: true, revision: saved.revision };
          }
          case 'provision':
            await core.rpc.call('provision', request.request, 65_536, true);
            return { provisioned: true };
          case 'export':
            return {
              dataset: core.dataset,
              run: core.run,
              diagnostics: core.diagnostics.inspect(),
              engine: await core.rpc.call('inspect', {}, 0, true),
            };
          case 'reserve-export':
            return core.rpc.call(
              'reserve-diagnostics',
              { reservation: request.reservation, bytes: request.bytes },
              256,
            );
          case 'release-export':
            return core.rpc.call('release-diagnostics', request.reservation, 128, true);
          case 'enrollment-inspect':
            return core.rpc.call('enrollment-inspect', {}, 65536, true);
          case 'open-enroll':
            return core.rpc.call(
              'open-enroll',
              { dataset: request.dataset, request: request.request },
              65536,
              true,
            );
          case 'enrollment-revoke':
            return core.rpc.call('enrollment-revoke', request, 1024, true);
        }
      },
      close,
    );
    process.once('SIGTERM', () => {
      void close?.().catch(() => {
        process.exitCode = 1;
      });
    });
    process.once('SIGINT', () => {
      void close?.().catch(() => {
        process.exitCode = 1;
      });
    });
    const fatal = (error: unknown) => {
      core.diagnostics.emit({
        severity: 'ERROR',
        component: 'runtime',
        event: 'fatal_failure',
        ...faultFrames(error),
      });
      void close?.().then(
        () => {
          process.exitCode = 1;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    await core.rpc.call('applied-settings', { revision: settings.revision }, 256, true);
    await core.listen('0.0.0.0');
    listening = true;
  }
} catch (error) {
  let cleanup: unknown;
  if (close) {
    try {
      await close();
    } catch (failure) {
      cleanup = failure;
    }
  }
  process.stdout.write(
    JSON.stringify({
      failed: true,
      code: 'runtime_failed',
      severity: 'ERROR',
      component: 'runtime',
      event: 'runtime_failed',
      at: new Date().toISOString(),
      release: '0.6.0',
      ...faultFrames(error),
      ...(cleanup === undefined ? {} : { cleanup_failure: 'shutdown_failed' }),
    }) + '\n',
  );
  process.exitCode = 1;
}
