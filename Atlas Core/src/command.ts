import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { lstat } from 'node:fs/promises';
import { readLocalJson } from './local-json.js';
import { Uuid, Counter, exchanges } from '@atlas/protocol';
import type { Uuid as UuidValue } from '@atlas/protocol';
import { Administration } from './admin.js';
import { installationLock, readJsonFile, ImageId, optionalJson, Action } from './installation.js';
import { Settings } from './settings.js';
import { faultFrames } from './operator-report.js';
import { checkCompatibility, releaseMetadata, verifyImage } from './release.js';
import type { ReleaseMetadata } from './release.js';
import { doctor } from './doctor.js';
import { tlsView, validateTls, tlsBytes } from './tls.js';

export const OperatorPort = Settings.shape.port.min(1);

export type ReadOperation = {
  kind: 'inspect' | 'doctor' | 'settings-show' | 'enrollment-inspect' | 'tls-show';
};
export type WriteOperation =
  | {
      kind: 'setup';
      certificate: string;
      key: string;
      credential: z.infer<typeof exchanges.CreateApiKey.request.schema>;
      settings?: Settings;
    }
  | { kind: 'provision'; credential: z.infer<typeof exchanges.CreateApiKey.request.schema> }
  | { kind: 'start' | 'restart' | 'reset' | 'hard-reset' | 'update' | 'recover' | 'settings-apply' }
  | { kind: 'stop'; force: boolean }
  | { kind: 'tls-replace'; certificate: string; key: string; restart: boolean }
  | { kind: 'settings-save'; expectedRevision: string; settings: Settings }
  | { kind: 'export'; out: string }
  | {
      kind: 'enroll';
      dataset: UuidValue;
      request: z.infer<typeof exchanges.RegisterAsset.request.schema>;
    }
  | { kind: 'enrollment-revoke'; binding: UuidValue; apiKey: UuidValue };
export type Operation =
  | { effect: 'read'; command: ReadOperation }
  | { effect: 'write'; command: WriteOperation };
export type Invocation = { root: string; image?: string; operation: Operation };
export type Launch = Invocation | { screen: 'help' | 'version' | 'tui'; root: string };
export type CommandResult = { exitCode: 0 | 1 | 130; envelope: Record<string, unknown> };
export const help = `atlas-core [command] [--installation /absolute/path]
Default installation ~/.atlas/core. No command opens the TUI on a terminal, otherwise help.
help | version | tui | inspect | doctor | start | stop [--force] | restart | reset
setup [--image sha256:ID] --certificate PATH --key PATH --credential-file PATH [--settings PATH]
hard-reset --confirm-destructive | update [--image sha256:ID] --confirm-reset | recover
settings show | settings save --expected-revision N --file PATH | settings apply --restart
tls show | tls replace --certificate PATH --key PATH [--restart]
provision --credential-file PATH | export --out PATH
enroll --dataset UUID --request-file PATH
enrollment inspect | enrollment revoke --binding UUID --api-key UUID --confirm
Setup leaves Core stopped. Reset destroys operational data. Hard Reset also removes credentials.
TLS and settings saves activate only on explicit restart. Secrets belong in mode-0600 files.
`;
function absolute(value: string): string {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error('invalid_arguments');
  return value;
}
async function protectedJson<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error('credential_file_unprotected');
  return readLocalJson(await tlsBytes(path), schema);
}
export async function parseArgv(argv: readonly string[]): Promise<Launch> {
  const args = [...argv];
  const option = (name: string) => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (!value || value.startsWith('--')) throw new Error('invalid_arguments');
    args.splice(at, 2);
    return value;
  };
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) return false;
    args.splice(at, 1);
    return true;
  };
  const required = (value: string | undefined) => {
    if (value === undefined) throw new Error('invalid_arguments');
    return value;
  };
  const path = (name: string) => absolute(required(option(name)));
  const root = absolute(option('installation') ?? join(homedir(), '.atlas', 'core'));
  const supplied = option('image');
  const image = supplied === undefined ? undefined : ImageId.parse(supplied);
  const verb = args.shift() ?? (process.stdin.isTTY && process.stdout.isTTY ? 'tui' : 'help');
  let operation: Operation;
  switch (verb) {
    case '--help':
    case '-h':
    case 'help':
    case '--version':
    case 'version':
    case 'tui': {
      if (args.length || image) throw new Error('invalid_arguments');
      return {
        screen: verb === 'tui' ? 'tui' : verb.includes('version') ? 'version' : 'help',
        root,
      };
    }
    case 'inspect':
    case 'doctor':
      operation = { effect: 'read', command: { kind: verb } };
      break;
    case 'setup': {
      const certificate = path('certificate'),
        key = path('key'),
        credentialPath = path('credential-file'),
        settingsPath = option('settings');
      const credential = await protectedJson(credentialPath, exchanges.CreateApiKey.request.schema);
      const settings = settingsPath
        ? await readJsonFile(absolute(settingsPath), Settings)
        : undefined;
      operation = {
        effect: 'write',
        command: { kind: 'setup', certificate, key, credential, ...(settings ? { settings } : {}) },
      };
      break;
    }
    case 'provision':
      operation = {
        effect: 'write',
        command: {
          kind: verb,
          credential: await protectedJson(
            path('credential-file'),
            exchanges.CreateApiKey.request.schema,
          ),
        },
      };
      break;
    case 'start':
    case 'restart':
    case 'reset':
    case 'recover':
      operation = { effect: 'write', command: { kind: verb } };
      break;
    case 'stop':
      operation = { effect: 'write', command: { kind: verb, force: flag('force') } };
      break;
    case 'hard-reset':
    case 'update': {
      if (!flag(verb === 'update' ? 'confirm-reset' : 'confirm-destructive'))
        throw new Error('destructive_confirmation_required');
      operation = { effect: 'write', command: { kind: verb } };
      break;
    }
    case 'tls': {
      const sub = args.shift();
      if (sub === 'show') operation = { effect: 'read', command: { kind: 'tls-show' } };
      else if (sub === 'replace')
        operation = {
          effect: 'write',
          command: {
            kind: 'tls-replace',
            certificate: path('certificate'),
            key: path('key'),
            restart: flag('restart'),
          },
        };
      else throw new Error('invalid_arguments');
      break;
    }
    case 'settings': {
      const sub = args.shift();
      if (sub === 'show') operation = { effect: 'read', command: { kind: 'settings-show' } };
      else if (sub === 'save')
        operation = {
          effect: 'write',
          command: {
            kind: 'settings-save',
            expectedRevision: Counter.parse(required(option('expected-revision'))),
            settings: await readJsonFile(path('file'), Settings),
          },
        };
      else if (sub === 'apply' && flag('restart'))
        operation = { effect: 'write', command: { kind: 'settings-apply' } };
      else throw new Error('invalid_arguments');
      break;
    }
    case 'export':
      operation = { effect: 'write', command: { kind: verb, out: path('out') } };
      break;
    case 'enroll':
      operation = {
        effect: 'write',
        command: {
          kind: verb,
          dataset: Uuid.parse(required(option('dataset'))),
          request: await protectedJson(
            path('request-file'),
            exchanges.RegisterAsset.request.schema,
          ),
        },
      };
      break;
    case 'enrollment': {
      const sub = args.shift();
      if (sub === 'inspect')
        operation = { effect: 'read', command: { kind: 'enrollment-inspect' } };
      else if (sub === 'revoke') {
        const binding = Uuid.parse(required(option('binding'))),
          apiKey = Uuid.parse(required(option('api-key')));
        if (!flag('confirm')) throw new Error('destructive_confirmation_required');
        operation = { effect: 'write', command: { kind: 'enrollment-revoke', binding, apiKey } };
      } else throw new Error('invalid_arguments');
      break;
    }
    default:
      throw new Error('invalid_arguments');
  }
  if (args.length || (image && !['setup', 'update', 'doctor'].includes(operation.command.kind)))
    throw new Error('invalid_arguments');
  return { root, operation, ...(image ? { image } : {}) };
}
const safe = z.enum([
  'invalid_arguments',
  'management_busy',
  'destructive_confirmation_required',
  'recovery_required',
  'repair_required',
  'settings_revision_changed',
  'writer_exit_unverified',
  'already_setup',
  'start_failed',
  'docker_unavailable',
  'docker_failed',
  'maintenance_unavailable',
  'setup_required',
  'storage_limit',
  'offline_operation_failed',
  'incompatible_format',
  'record_limit',
  'record_invalid',
  'prerequisite_failed',
  'tls_invalid',
  'tls_conversion_required',
  'tls_generation_limit',
  'incompatible_image',
  'image_unavailable',
  'release_metadata_missing',
  'terminal_required',
  'credential_file_unprotected',
]);
const classify = (error: unknown) => {
  const parsed = safe.safeParse(error instanceof Error ? error.message : undefined);
  return parsed.success ? parsed.data : 'management_failed';
};
export function failure(error: unknown): CommandResult {
  return {
    exitCode: 1,
    envelope: {
      at: new Date().toISOString(),
      severity: 'ERROR',
      event: 'command_failed',
      component: 'lifecycle',
      release: '0.4.0',
      ok: false,
      code: classify(error),
      ...faultFrames(error),
      ...(error instanceof AggregateError
        ? {
            primary_failure: classify(error.errors[0]),
            cleanup_failure: classify(error.errors[1]),
            failures: error.errors.slice(0, 8).map(classify),
          }
        : {}),
    },
  };
}
function completed(data: unknown, exitCode: 0 | 130): CommandResult {
  return {
    exitCode,
    envelope: {
      at: new Date().toISOString(),
      severity: 'INFO',
      event: 'command_completed',
      component: 'lifecycle',
      release: '0.4.0',
      ok: true,
      data,
    },
  };
}
function cancelled(): CommandResult {
  return completed({ cancelled: true, committed: false }, 130);
}
export async function perform(input: Invocation, signal?: AbortSignal): Promise<CommandResult> {
  try {
    absolute(input.root);
    const release = await releaseMetadata();
    const command = input.operation.command;
    if (
      (command.kind === 'setup' || command.kind === 'settings-save') &&
      command.settings &&
      !OperatorPort.safeParse(command.settings.port).success
    )
      throw new Error('invalid_arguments');
    const admin = new Administration(input.root);
    const run = async (): Promise<unknown> => {
      await checkCompatibility(input.root, release, input.image, command.kind);
      const image = input.image ?? release?.image;
      switch (command.kind) {
        case 'doctor':
          return doctor(input.root, release, undefined, false, input.image);
        case 'inspect':
          return {
            ...z.record(z.string(), z.unknown()).parse(await admin.inspect()),
            tls: await tlsView(input.root),
          };
        case 'tls-show':
          return tlsView(input.root);
        case 'settings-show':
          return admin.settingsShow();
        case 'enrollment-inspect':
          return admin.enrollmentInspect();
        case 'setup': {
          if (!image) throw new Error('release_metadata_missing');
          await validateTls(command.certificate, command.key);
          await verifyImage(image, release, false);
          await admin.setup({ ...command, image });
          return { setup: true, running: false };
        }
        case 'provision':
          await admin.provision(command.credential);
          return { provisioned: true };
        case 'start':
          await admin.start();
          return { started: true };
        case 'stop':
          await admin.stop(command.force);
          return { stopped: true, writer_exit: 'verified' };
        case 'restart':
          await admin.restart();
          return { restarted: true };
        case 'reset':
          await admin.destructive('reset');
          return { reset: true, running: false };
        case 'hard-reset':
          await admin.destructive('hard-reset');
          return { hard_reset: true, setup_required: true };
        case 'update':
          if (!image) throw new Error('release_metadata_missing');
          await verifyImage(image, release, false);
          await admin.destructive('update', image);
          return { updated: true, running: false };
        case 'recover': {
          const action = await optionalJson(join(input.root, 'recovery', 'action.json'), Action);
          if (action && action.phase !== 'complete') await admin.recover();
          await admin.tlsRecover();
          return { recovered: true, running: false };
        }
        case 'settings-save':
          return admin.settingsSave(command.expectedRevision, command.settings);
        case 'settings-apply':
          await admin.restart();
          return { applied: true };
        case 'tls-replace':
          await admin.tlsReplace(command.certificate, command.key);
          if (command.restart) await admin.restart();
          return tlsView(input.root);
        case 'export':
          return admin.export(command.out);
        case 'enroll':
          return admin.enroll(command.dataset, command.request);
        case 'enrollment-revoke':
          return admin.revokeEnrollment(command.binding, command.apiKey);
        default: {
          const exhaustive: never = command;
          return exhaustive;
        }
      }
    };
    await checkCompatibility(input.root, release, input.image, command.kind);
    if (signal?.aborted) return cancelled();
    if (command.kind === 'setup') {
      const image = input.image ?? release?.image;
      if (!image) throw new Error('release_metadata_missing');
      await validateTls(command.certificate, command.key);
      const report = await doctor(input.root, release, command.settings, true);
      if (
        Object.entries(report.checks).some(
          ([name, check]) => name !== 'image' && check.status !== 'pass',
        )
      ) {
        const rejected = failure(new Error('prerequisite_failed'));
        return { ...rejected, envelope: { ...rejected.envelope, data: report } };
      }
    }
    if (signal?.aborted) return cancelled();
    if (command.kind === 'setup' || command.kind === 'update') {
      const image = input.image ?? release?.image;
      if (!image) throw new Error('release_metadata_missing');
      await verifyImage(image, release, true);
    }
    if (signal?.aborted) return cancelled();
    const data =
      input.operation.effect === 'read'
        ? await run()
        : await installationLock(input.root, async () => {
            if (signal?.aborted) return { cancelled: true, committed: false };
            return run();
          });
    const doctorFailed =
      command.kind === 'doctor' && z.object({ ok: z.boolean() }).parse(data).ok === false;
    if (doctorFailed) {
      const rejected = failure(new Error('prerequisite_failed'));
      return { ...rejected, envelope: { ...rejected.envelope, data } };
    }
    return completed(data, signal?.aborted ? 130 : 0);
  } catch (error) {
    return failure(error);
  }
}
export function versionText(release: ReleaseMetadata | undefined) {
  return `atlas-core 0.4.0\nCore 0.4.0; Protocol 0.4.0; database format 5\n${release ? `Image ${release.image}; ${release.platform}; package ${release.npmName ?? 'private qualification fixture'}` : 'Source build; release image metadata unavailable'}\n`;
}
