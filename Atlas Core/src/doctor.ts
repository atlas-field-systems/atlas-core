import { execFile } from 'node:child_process';
import { lstat, statfs, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer, isIP } from 'node:net';
import { z } from 'zod';
import {
  Action,
  ContainerWriter,
  Manifest,
  SavedSettings,
  optionalJson as readOptionalJson,
} from './installation.js';
import { defaults } from './settings.js';
import type { Settings } from './settings.js';
import { savedTls, tlsView } from './tls.js';
import type { ReleaseMetadata } from './release.js';

async function optionalJson<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536)
      throw new Error('record_limit');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  return readOptionalJson(path, schema);
}
type Check = { status: 'pass' | 'fail' | 'unavailable'; instruction: string };
async function hostProbe(program: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      program,
      args,
      { timeout, maxBuffer: 65_536, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim());
          return;
        }
        const code =
          error.code === 'ENOENT' || /command not found/.test(stderr)
            ? 'missing_tool'
            : /password|not allowed|permission denied/i.test(stderr)
              ? 'docker_authority'
              : /daemon|cannot connect/i.test(stderr)
                ? 'docker_daemon'
                : 'probe_failed';
        reject(new Error(code));
      },
    ),
  );
}
export async function doctor(
  root: string,
  release: ReleaseMetadata | undefined,
  candidate?: Settings,
  setup = false,
  suppliedImage?: string,
) {
  const checks: Record<string, Check> = {};
  const deadline = Date.now() + 10_000;
  const probe = (program: string, args: string[]) =>
    hostProbe(program, args, Math.max(1, Math.min(1800, deadline - Date.now())));
  const check = async (name: string, instruction: string, run: () => Promise<boolean>) => {
    if (Date.now() >= deadline) {
      checks[name] = {
        status: 'unavailable',
        instruction:
          'Doctor reached its ten-second probe budget. Resolve host prerequisites and run it explicitly again.',
      };
      return;
    }
    try {
      checks[name] = { status: (await run()) ? 'pass' : 'fail', instruction };
    } catch (error) {
      const instructions: Record<string, string> = {
        missing_tool: 'Install Docker Engine and sudo. Atlas does not install host software.',
        docker_authority: 'Authorize sudo -n docker without a password prompt for this operator.',
        docker_daemon: 'Start Docker Engine and check local daemon access.',
      };
      const advice =
        name === 'docker' && error instanceof Error ? instructions[error.message] : undefined;
      const invalidTls =
        name === 'tls' &&
        error instanceof Error &&
        ['tls_invalid', 'repair_required', 'tls_conversion_required', 'recovery_required'].includes(
          error.message,
        );
      checks[name] = {
        status: invalidTls ? 'fail' : 'unavailable',
        instruction: advice ?? instruction,
      };
    }
  };
  checks.runtime_node = {
    status: process.versions.node === '24.22.1' ? 'pass' : 'fail',
    instruction: 'Install Node.js 24.22.1 and run this command with it.',
  };
  checks.platform = {
    status: process.platform === 'linux' && process.arch === 'x64' ? 'pass' : 'fail',
    instruction: 'Use a qualified Linux amd64 host.',
  };
  await check(
    'runtime_npm',
    'Install npm 11.19.0 alongside the pinned Node runtime.',
    async () =>
      (process.env.npm_execpath
        ? await probe(process.execPath, [process.env.npm_execpath, '--version'])
        : await probe('npm', ['--version'])) === '11.19.0',
  );
  await check('flock', 'Install util-linux providing /usr/bin/flock.', async () => {
    await access('/usr/bin/flock', constants.X_OK);
    return true;
  });
  await check(
    'docker',
    'Install Docker Engine, start its daemon, and authorize sudo -n docker without a prompt.',
    async () => {
      await probe('sudo', ['-n', 'docker', 'info', '--format', '{{.ServerVersion}}']);
      return true;
    },
  );
  let settings = candidate ?? defaults;
  await check(
    'records',
    'Inspect protected setup records with the matching package. Do not remove ambiguous state.',
    async () => {
      const saved = await optionalJson(join(root, 'setup', 'settings.json'), SavedSettings);
      if (!candidate && saved) settings = saved.saved;
      return true;
    },
  );
  await check(
    'storage',
    'Choose a directory owned by your user with private permissions and sufficient free space. Atlas does not change host permissions.',
    async () => {
      let path = root;
      while (true) {
        try {
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
            return false;
          if (path === root && (info.mode & 0o077) !== 0) return false;
          await access(path, constants.W_OK | constants.X_OK);
          const disk = await statfs(path, { bigint: true });
          return (
            disk.bavail * disk.bsize >=
            BigInt(settings.freeDiskBytes + settings.reserveBytes + 1_048_576)
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ENOENT' ||
            path === dirname(path)
          )
            throw error;
          path = dirname(path);
        }
      }
    },
  );
  await check(
    'compatibility',
    'Use the package matching this installation image, or perform an explicit compatible update.',
    async () => {
      const manifest = await optionalJson(join(root, 'setup', 'installation.json'), Manifest);
      return !manifest || !release || release.image === manifest.image;
    },
  );
  await check(
    'image',
    'Preload the exact release image with docker load. Setup can pull only the immutable registry reference recorded by the release.',
    async () => {
      const manifest = await optionalJson(join(root, 'setup', 'installation.json'), Manifest);
      const image = suppliedImage ?? release?.image ?? manifest?.image;
      if (!image) return false;
      const result = z
        .array(z.object({ Id: z.string(), Os: z.string(), Architecture: z.string() }))
        .length(1)
        .parse(JSON.parse(await probe('sudo', ['-n', 'docker', 'image', 'inspect', image])))[0];
      return result?.Id === image && result.Os === 'linux' && result.Architecture === 'amd64';
    },
  );
  await check(
    'port',
    'Use a numeric bind address with a free port, or localhost. Do not stop unrelated services.',
    async () => {
      const writer = await optionalJson(join(root, 'control', 'writer.json'), ContainerWriter);
      if (writer && !setup) {
        const manifest = await optionalJson(join(root, 'setup', 'installation.json'), Manifest);
        const records = z
          .array(
            z.object({
              Id: z.string(),
              State: z.object({ Running: z.boolean() }),
              Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
            }),
          )
          .length(1)
          .parse(JSON.parse(await probe('sudo', ['-n', 'docker', 'inspect', writer.container])));
        const actual = records[0];
        if (
          actual?.State.Running &&
          actual.Id === writer.container &&
          actual.Config.Labels?.['atlas.installation'] === manifest?.installation_id &&
          actual.Config.Labels?.['atlas.launch'] === writer.launch
        )
          return true;
      }
      const host = settings.host === 'localhost' ? '127.0.0.1' : settings.host;
      if (!isIP(host)) return false;
      return new Promise<boolean>((resolve) => {
        const server = createServer();
        const timer = setTimeout(() => {
          server.close();
          resolve(false);
        }, 1800);
        server.once('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        server.listen({ host, port: settings.port }, () =>
          server.close(() => {
            clearTimeout(timer);
            resolve(true);
          }),
        );
      });
    },
  );
  await check(
    'tls',
    'Supply a current matching PEM certificate and private key. Convert legacy files explicitly with tls replace.',
    async () => {
      const manifest = await optionalJson(join(root, 'setup', 'installation.json'), Manifest);
      await optionalJson(join(root, 'setup', 'tls-state.json'), z.unknown());
      await optionalJson(join(root, 'setup', 'tls-journal.json'), z.unknown());
      if (!manifest) {
        const tls = await tlsView(root);
        return tls.conversionRequired && !tls.recoveryRequired;
      }
      await savedTls(root);
      return true;
    },
  );
  await check(
    'recovery',
    'Inspect pending work and use explicit recover with the matching package after all writers have stopped. For incomplete first setup, preserve its evidence for repair and select a fresh installation path.',
    async () => {
      const action = await optionalJson(join(root, 'recovery', 'action.json'), Action);
      await optionalJson(join(root, 'setup', 'tls-state.json'), z.unknown());
      await optionalJson(join(root, 'setup', 'tls-journal.json'), z.unknown());
      const tls = await tlsView(root);
      return (!action || action.phase === 'complete') && !tls.recoveryRequired;
    },
  );
  return { ok: Object.values(checks).every((value) => value.status === 'pass'), checks };
}
