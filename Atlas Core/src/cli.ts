#!/usr/bin/env node
import { resolve } from 'node:path';
import { z } from 'zod';
import { Administration } from './admin.js';
import { installationLock, readJsonFile } from './installation.js';
import { Settings } from './settings.js';
import { Uuid, exchanges } from '@atlas/protocol';
import { faultFrames } from './diagnostics.js';

const args = process.argv.slice(2);
const command = args.shift();
function option(name: string): string | undefined { const position = args.indexOf(`--${name}`); if (position < 0) return undefined; const value = args[position + 1]; if (value === undefined || value.startsWith('--')) throw new Error('invalid_arguments'); args.splice(position, 2); return value; }
function flag(name: string): boolean { const position = args.indexOf(`--${name}`); if (position < 0) return false; args.splice(position, 1); return true; }
function required(value: string | undefined): string { if (value === undefined) throw new Error('invalid_arguments'); return value; }
try {
  const root = resolve(required(option('installation')));
  const admin = new Administration(root);
  const perform = async (): Promise<unknown> => {
    switch (command) {
      case 'setup': {
        const image = required(option('image')), certificate = resolve(required(option('certificate'))), key = resolve(required(option('key')));
        const credential = await readJsonFile(resolve(required(option('credential-file'))), exchanges.CreateApiKey.request.schema);
        const settingsFile = option('settings');
        const settings = settingsFile ? await readJsonFile(resolve(settingsFile), Settings) : undefined;
        if (args.length) throw new Error('invalid_arguments');
        await admin.setup({ image, certificate, key, credential, ...(settings === undefined ? {} : { settings }) }); return { setup: true };
      }
      case 'provision': { const credential = await readJsonFile(resolve(required(option('credential-file'))), exchanges.CreateApiKey.request.schema); if (args.length) throw new Error('invalid_arguments'); await admin.provision(credential); return { provisioned: true }; }
      case 'inspect': if (args.length) throw new Error('invalid_arguments'); return admin.inspect();
      case 'start': if (args.length) throw new Error('invalid_arguments'); await admin.start(); return { started: true };
      case 'stop': { const force = flag('force'); if (args.length) throw new Error('invalid_arguments'); await admin.stop(force); return { stopped: true, writer_exit: 'verified' }; }
      case 'restart': if (args.length) throw new Error('invalid_arguments'); await admin.restart(); return { restarted: true };
      case 'reset': if (args.length) throw new Error('invalid_arguments'); await admin.destructive('reset'); return { reset: true, running: false };
      case 'hard-reset': if (!flag('confirm-destructive') || args.length) throw new Error('destructive_confirmation_required'); await admin.destructive('hard-reset'); return { hard_reset: true, setup_required: true };
      case 'update': { const image = required(option('image')); if (!flag('confirm-reset') || args.length) throw new Error('destructive_confirmation_required'); await admin.destructive('update', image); return { updated: true, running: false }; }
      case 'recover': if (args.length) throw new Error('invalid_arguments'); await admin.recover(); return { recovered: true, running: false };
      case 'settings': {
        const subcommand = args.shift();
        if (subcommand === 'show' && args.length === 0) return admin.settingsShow();
        if (subcommand === 'save') { const expected = required(option('expected-revision')), file = resolve(required(option('file'))); if (args.length) throw new Error('invalid_arguments'); return admin.settingsSave(expected, await readJsonFile(file, Settings)); }
        if (subcommand === 'apply' && flag('restart') && args.length === 0) { await admin.restart(); return { applied: true }; }
        throw new Error('invalid_arguments');
      }
      case 'export': { const out = resolve(required(option('out'))); if (args.length) throw new Error('invalid_arguments'); return admin.export(out); }
      case 'enroll': {
        const dataset = Uuid.parse(required(option('dataset'))), file = resolve(required(option('request-file')));
        if (args.length) throw new Error('invalid_arguments');
        return admin.enroll(dataset, await readJsonFile(file, exchanges.RegisterAsset.request.schema));
      }
      case 'enrollment': {
        const subcommand = args.shift();
        if (subcommand === 'inspect' && args.length === 0) return admin.enrollmentInspect();
        if (subcommand === 'revoke') {
          const binding = Uuid.parse(required(option('binding'))), key = Uuid.parse(required(option('api-key')));
          if (!flag('confirm') || args.length) throw new Error('destructive_confirmation_required');
          return admin.revokeEnrollment(binding, key);
        }
        throw new Error('invalid_arguments');
      }
      default: throw new Error('invalid_arguments');
    }
  };
  const result = command === 'inspect' || command === 'settings' && args[0] === 'show' || command === 'enrollment' && args[0] === 'inspect' ? await perform() : await installationLock(root, perform);
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), severity: 'INFO', event: 'command_completed', component: 'lifecycle', release: '0.3.0', ok: true, data: result }) + '\n');
} catch (error) {
  const safe = z.enum(['invalid_arguments', 'management_busy', 'destructive_confirmation_required', 'recovery_required', 'repair_required', 'settings_revision_changed', 'writer_exit_unverified', 'already_setup', 'start_failed', 'docker_unavailable', 'docker_failed', 'maintenance_unavailable', 'setup_required', 'storage_limit', 'offline_operation_failed', 'incompatible_format']);
  const code = safe.safeParse(error instanceof Error ? error.message : undefined);
  const classify = (value: unknown) => { const parsed = safe.safeParse(value instanceof Error ? value.message : undefined); return parsed.success ? parsed.data : 'management_failed'; };
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), severity: 'ERROR', event: 'command_failed', component: 'lifecycle', release: '0.3.0', ok: false, code: code.success ? code.data : 'management_failed', ...faultFrames(error),
    ...(error instanceof AggregateError ? { primary_failure: classify(error.errors[0]), cleanup_failure: classify(error.errors[1]), failures: error.errors.slice(0, 8).map(classify) } : {}) }) + '\n');
  process.exitCode = 1;
}
