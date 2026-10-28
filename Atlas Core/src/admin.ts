import { copyFile, mkdir, rm, open, readdir, stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { Uuid, exchanges } from '@atlas/protocol';
import { Action, ContainerWriter, ExitProof, ImageId, Manifest, Marker, Proof, SavedSettings, optionalJson, readJsonFile, recoveryDecision } from './installation.js';
import type { Action as ActionRecord, ContainerWriter as Writer } from './installation.js';
import { createContainer, docker, inspectContainer, startContainer, verifyWriterExit } from './docker.js';
import { atomicJson, flushDirectory, ownedDirectory } from './ownership.js';
import { maintenance, saveSettings } from './maintenance.js';
import { defaults, Settings } from './settings.js';
import { id, zero } from './exact.js';
import { retainedEvent } from './diagnostics.js';
import { createSecureContext } from 'node:tls';

export class Administration {
  constructor(readonly root: string) {}
  private async manifest() {
    const manifest = await optionalJson(join(this.root, 'setup', 'installation.json'), Manifest);
    if (manifest) return manifest;
    const action = await this.action();
    if (action?.kind === 'hard-reset' && (action.phase === 'established' || action.phase === 'complete')) return Manifest.parse({ format: 1, installation_id: action.installation_id, image: action.image });
    throw new Error('setup_required');
  }
  private settings() { return readJsonFile(join(this.root, 'setup', 'settings.json'), SavedSettings); }
  private writer() { return optionalJson(join(this.root, 'control', 'writer.json'), ContainerWriter); }
  private action() { return optionalJson(join(this.root, 'recovery', 'action.json'), Action); }
  async setup(input: { image: string; certificate: string; key: string; credential: unknown; settings?: Settings }): Promise<void> {
    await ownedDirectory(this.root);
    for (const dir of ['setup', 'data', 'control', 'recovery']) await ownedDirectory(join(this.root, dir));
    if (await optionalJson(join(this.root, 'setup', 'installation.json'), Manifest)) throw new Error('already_setup');
    const action = await this.action();
    if (action && (action.phase !== 'complete' || action.kind !== 'hard-reset')) throw new Error('repair_required');
    const image = ImageId.parse(input.image);
    const settings: SavedSettings = { revision: zero, saved: Settings.parse(input.settings ?? defaults), effective: null, last_working: null, apply_failure: null };
    createSecureContext({ cert: await readFile(input.certificate), key: await readFile(input.key) });
    await copyFile(input.certificate, join(this.root, 'setup', 'tls.pem'));
    await copyFile(input.key, join(this.root, 'setup', 'tls.key'));
    await atomicJson(join(this.root, 'setup', 'settings.json'), settings);
    await atomicJson(join(this.root, 'setup', 'installation.json'), { format: 1, installation_id: id(), image });
    await atomicJson(join(this.root, 'software.json'), { image });
    if (action) {
      const exits = join(this.root, 'control', 'exits');
      for (const file of await readdir(exits)) {
        const proof = await readJsonFile(join(exits, file), ExitProof);
        if (proof.installation !== action.installation_id || file !== `${proof.container}.json`) throw new Error('repair_required');
        await rm(join(exits, file));
      }
      await flushDirectory(exits);
      await rm(join(this.root, 'recovery', 'action.json')); await rm(join(this.root, 'recovery', 'proof.json'), { force: true }); await flushDirectory(join(this.root, 'recovery'));
    }
    await this.provision(input.credential);
  }
  private async requireComplete(): Promise<void> { const action = await this.action(); if (action && action.phase !== 'complete') throw new Error('recovery_required'); }
  private async verifyExit(writer: Writer, installation: Uuid): Promise<void> {
    const proofPath = join(this.root, 'control', 'exits', `${writer.container}.json`);
    const proof = await optionalJson(proofPath, ExitProof);
    if (proof?.container === writer.container && proof.launch === writer.launch && proof.installation === installation) return;
    await verifyWriterExit(writer, installation);
    await mkdir(join(this.root, 'control', 'exits'), { recursive: true, mode: 0o700 });
    await atomicJson(proofPath, { container: writer.container, launch: writer.launch, installation });
  }
  private async removeStopped(writer: Writer, installation: Uuid): Promise<void> {
    await this.verifyExit(writer, installation);
    if (await this.containerExists(writer)) await docker(['rm', writer.container]);
    if (writer.kind === 'service') {
      const lock = await optionalJson(join(this.root, 'control', 'core.lock'), z.object({ launch: Uuid, owner: z.unknown() }));
      if (lock && lock.launch !== writer.launch) throw new Error('writer_identity_mismatch');
      await rm(join(this.root, 'control', 'core.lock'), { force: true });
      await rm(join(this.root, 'control', 'maintenance.sock'), { force: true });
    }
    const saved = await this.writer();
    if (saved?.container === writer.container) await rm(join(this.root, 'control', 'writer.json'), { force: true });
    if (writer.kind === 'oneshot' && (await this.action())?.writer?.container !== writer.container) {
      await rm(join(this.root, 'control', 'exits', `${writer.container}.json`), { force: true });
      await flushDirectory(join(this.root, 'control', 'exits'));
    }
    await flushDirectory(join(this.root, 'control'));
  }
  private async containerExists(writer: Writer): Promise<boolean> {
    const found = await docker(['ps', '--all', '--no-trunc', '--filter', `id=${writer.container}`, '--format', '{{.ID}}']);
    if (found !== '' && found !== writer.container) throw new Error('writer_identity_mismatch');
    return found !== '';
  }
  private async offline(mode: 'inspect-marker' | 'establish' | 'provision', input: unknown = {}, image?: string) {
    const manifest = await this.manifest();
    if (mode === 'inspect-marker') {
      const container = await createContainer(this.root, manifest.installation_id, image ?? manifest.image, mode);
      let primary: unknown;
      try {
        const value: unknown = JSON.parse(await docker(['start', '--attach', '--interactive', container.container], JSON.stringify(input)));
        return value;
      } catch (error) { primary = error; throw error; }
      finally {
        try {
          const state = await inspectContainer(container, manifest.installation_id);
          if (state.State.Running) { await docker(['kill', '--signal=TERM', container.container]); await docker(['wait', container.container]); }
          await verifyWriterExit(container, manifest.installation_id);
          await docker(['rm', container.container]);
        } catch (cleanup) { if (primary !== undefined) throw new AggregateError([primary, cleanup], 'inspection_cleanup_failed'); throw cleanup; }
      }
    }
    const writer = await this.writer();
    if (writer) await this.verifyExit(writer, manifest.installation_id);
    if (writer) await this.removeStopped(writer, manifest.installation_id);
    const container = await createContainer(this.root, manifest.installation_id, image ?? manifest.image, mode);
    const output = await startContainer(this.root, container, manifest.installation_id, true, JSON.stringify(input));
    await this.verifyExit(container, manifest.installation_id);
    await this.removeStopped(container, manifest.installation_id);
    const value: unknown = JSON.parse(output);
    return value;
  }
  async inspect(): Promise<unknown> {
    const manifest = await this.manifest().catch(error => {
      if (error instanceof Error && error.message === 'setup_required') return undefined;
      throw error;
    });
    if (manifest === undefined) {
      return { running: false, setup_required: true, action: await this.action(), settings: await this.settingsShow() };
    }
    const writer = await this.writer();
    if (writer) {
      const container = await inspectContainer(writer, manifest.installation_id);
      if (container.State.Running) {
        try { return { running: true, action: await this.action(), service: await maintenance(this.root, { operation: 'inspect' }), settings: await this.settingsShow() }; }
        catch { return { running: true, maintenance: 'unavailable', action: await this.action() }; }
      }
    }
    return { running: false, action: await this.action(), marker: await this.offline('inspect-marker'), settings: await this.settingsShow() };
  }
  async provision(value: unknown): Promise<void> {
    await this.requireComplete();
    const request = exchanges.CreateApiKey.request.schema.parse(value);
    const manifest = await this.manifest(), writer = await this.writer();
    if (writer && (await inspectContainer(writer, manifest.installation_id)).State.Running) await maintenance(this.root, { operation: 'provision', request });
    else await this.offline('provision', { request });
  }
  async start(): Promise<void> {
    await this.requireComplete();
    const manifest = await optionalJson(join(this.root, 'setup', 'installation.json'), Manifest);
    if (!manifest) throw new Error('setup_required');
    const settings = await this.settings(), old = await this.writer();
    if (old) {
      if (await this.containerExists(old) && (await inspectContainer(old, manifest.installation_id)).State.Running) {
        if (!z.object({ ready: z.boolean() }).parse(await maintenance(this.root, { operation: 'inspect' })).ready) throw new Error('start_failed');
        return;
      }
      await this.removeStopped(old, manifest.installation_id);
    }
    const writer = await createContainer(this.root, manifest.installation_id, manifest.image, 'serve', settings.saved.port);
    try {
      await startContainer(this.root, writer, manifest.installation_id);
      const deadline = Date.now() + 30_000;
      while (true) {
        const state = await inspectContainer(writer, manifest.installation_id);
        if (!state.State.Running) throw new Error('start_failed');
        try { if (!z.object({ ready: z.boolean() }).parse(await maintenance(this.root, { operation: 'inspect' })).ready) throw new Error('not_ready'); break; }
        catch { if (Date.now() >= deadline) throw new Error('start_failed'); await setTimeout(250); }
      }
      const applied = { revision: settings.revision, value: settings.saved };
      await atomicJson(join(this.root, 'setup', 'settings.json'), { ...settings, effective: applied, last_working: applied, apply_failure: null });
    } catch (error) {
      const failures: unknown[] = [error];
      try { await atomicJson(join(this.root, 'setup', 'settings.json'), { ...settings, apply_failure: 'start_failed' }); }
      catch (bookkeeping) { failures.push(bookkeeping); }
      try {
        if ((await inspectContainer(writer, manifest.installation_id)).State.Running) await docker(['kill', '--signal=TERM', writer.container]);
        const deadline = Date.now() + 10_000;
        while ((await inspectContainer(writer, manifest.installation_id)).State.Running) {
          if (Date.now() >= deadline) throw new Error('writer_exit_unverified');
          await setTimeout(250);
        }
      } catch (shutdown) { failures.push(shutdown); }
      try { await this.verifyExit(writer, manifest.installation_id); }
      catch (cleanup) { failures.push(cleanup); }
      if (failures.length > 1) throw new AggregateError(failures, 'start_cleanup_failed');
      throw error;
    }
  }
  async stop(force = false): Promise<void> {
    const manifest = await this.manifest(), writer = await this.writer();
    if (!writer) return;
    const state = await inspectContainer(writer, manifest.installation_id);
    if (state.State.Running) {
      if (force) await docker(['kill', '--signal=KILL', writer.container]);
      else {
        await maintenance(this.root, { operation: 'stop' });
        const deadline = Date.now() + 30_000;
        while ((await inspectContainer(writer, manifest.installation_id)).State.Running) {
          if (Date.now() >= deadline) throw new Error('writer_exit_unverified');
          await setTimeout(250);
        }
      }
    }
    await this.verifyExit(writer, manifest.installation_id);
  }
  async restart(): Promise<void> { await this.requireComplete(); await this.stop(); await this.start(); }
  async destructive(kind: ActionRecord['kind'], image?: string): Promise<void> {
    await this.requireComplete();
    const manifest = await this.manifest(), writer = await this.writer();
    let old: Uuid | null = null;
    if (writer && (await inspectContainer(writer, manifest.installation_id)).State.Running) {
      const context = z.object({ dataset: Uuid }).parse(await maintenance(this.root, { operation: 'inspect' })); old = context.dataset;
    } else old = Marker.parse(await this.offline('inspect-marker')).dataset;
    const action: ActionRecord = { format: 1, action_id: id(), installation_id: manifest.installation_id, kind, old_dataset: old, intended_dataset: id(),
      writer: await this.writer() ?? null, image: kind === 'update' ? ImageId.parse(image) : manifest.image, phase: 'intent', primary_failure: null, cleanup_failure: null };
    await atomicJson(join(this.root, 'recovery', 'action.json'), action);
    await rm(join(this.root, 'recovery', 'proof.json'), { force: true }); await flushDirectory(join(this.root, 'recovery'));
    await this.recover();
  }
  async recover(): Promise<void> {
    const action = await this.action();
    if (!action) throw new Error('repair_required');
    const manifest = await this.manifest();
    if (manifest.installation_id !== action.installation_id) throw new Error('repair_required');
    try {
      const writer = await this.writer();
      if (writer) {
        const running = await this.containerExists(writer) && (await inspectContainer(writer, manifest.installation_id)).State.Running;
        if (running) {
          if (action.writer?.container !== writer.container || action.writer.launch !== writer.launch) throw new Error('writer_exit_unverified');
          await this.stop();
        }
        await this.verifyExit(writer, manifest.installation_id);
      }
      if (action.writer) await this.verifyExit(action.writer, manifest.installation_id);
      const containers = await this.stoppedInstallationContainers(manifest.installation_id);
      const marker = Marker.parse(await this.offline('inspect-marker'));
      const proof = await optionalJson(join(this.root, 'recovery', 'proof.json'), Proof);
      const decision = recoveryDecision(action, marker, proof);
      if (decision === 'establish') {
        action.phase = 'stopped'; await atomicJson(join(this.root, 'recovery', 'action.json'), action);
        for (const directory of ['objects', 'logs', 'captures']) {
          await rm(join(this.root, 'data', directory), { recursive: true, force: true });
          await mkdir(join(this.root, 'data', directory), { mode: 0o700 });
        }
        await flushDirectory(join(this.root, 'data'));
        action.phase = 'cleaned'; await atomicJson(join(this.root, 'recovery', 'action.json'), action);
        await this.offline('establish', { dataset: action.intended_dataset, action: action.action_id, hard: action.kind === 'hard-reset' }, action.image);
        const established = Marker.parse(await this.offline('inspect-marker'));
        if (recoveryDecision(action, established, undefined) !== 'preserve') throw new Error('repair_required');
      }
      await atomicJson(join(this.root, 'recovery', 'proof.json'), { action_id: action.action_id, dataset: action.intended_dataset, installation_id: action.installation_id });
      action.phase = 'established'; await atomicJson(join(this.root, 'recovery', 'action.json'), action);
      if (action.kind === 'update') { await atomicJson(join(this.root, 'setup', 'installation.json'), { ...manifest, image: action.image }); await atomicJson(join(this.root, 'software.json'), { image: action.image }); }
      if (action.kind === 'hard-reset') {
        for (const file of ['tls.pem', 'tls.key', 'settings.json', 'installation.json']) await rm(join(this.root, 'setup', file), { force: true });
        await flushDirectory(join(this.root, 'setup'));
        for (const container of containers) if (await this.containerExists(container)) await this.removeStopped(container, manifest.installation_id);
        const exits = join(this.root, 'control', 'exits');
        for (const file of await readdir(exits)) if (file !== `${action.writer?.container}.json`) await rm(join(exits, file), { force: true });
        await flushDirectory(exits);
      }
      action.phase = 'complete'; action.primary_failure = null; action.cleanup_failure = null;
      await atomicJson(join(this.root, 'recovery', 'action.json'), action);
    } catch (error) {
      action.primary_failure = error instanceof Error && error.message === 'writer_exit_unverified' ? 'writer_exit_unverified' : 'repair_required';
      try { await atomicJson(join(this.root, 'recovery', 'action.json'), action); }
      catch { action.cleanup_failure = 'cleanup_failed'; throw new AggregateError([error, new Error('cleanup_failed')], 'recovery_failed'); }
      throw error;
    }
  }
  private async stoppedInstallationContainers(installation: Uuid): Promise<Writer[]> {
    const raw = await docker(['ps', '--all', '--no-trunc', '--filter', `label=atlas.installation=${installation}`, '--format', '{{.ID}} {{.Label "atlas.launch"}} {{.Label "atlas.mode"}}']);
    const containers: Writer[] = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      const [container, launch, mode] = line.split(' ');
      const writer = ContainerWriter.parse({ container, launch, kind: mode === 'serve' ? 'service' : 'oneshot', host: null });
      const state = await inspectContainer(writer, installation);
      if (state.State.Running && mode !== 'inspect-marker') throw new Error('writer_exit_unverified');
      if (state.State.Running) continue;
      await this.verifyExit(writer, installation); containers.push(writer);
    }
    return containers;
  }
  async settingsShow() {
    const settings = await optionalJson(join(this.root, 'setup', 'settings.json'), SavedSettings);
    if (settings === undefined) return { setup_required: true };
    return { revision: settings.revision, effective: settings.effective === null ? null : { revision: settings.effective.revision },
      last_working: settings.last_working === null ? null : { revision: settings.last_working.revision }, apply_failure: settings.apply_failure,
      diagnostics: { severity: settings.saved.diagnosticLevel, max_bytes: settings.saved.diagnosticBytes } };
  }
  async enrollmentInspect(): Promise<unknown> { return maintenance(this.root, { operation: 'enrollment-inspect' }); }
  async enroll(dataset: Uuid, request: unknown): Promise<unknown> {
    await this.requireComplete();
    return maintenance(this.root, { operation: 'open-enroll', dataset, request: exchanges.RegisterAsset.request.schema.parse(request) });
  }
  async revokeEnrollment(binding: Uuid, key: Uuid): Promise<unknown> {
    await this.requireComplete();
    return maintenance(this.root, { operation: 'enrollment-revoke', binding, key, confirm: true });
  }
  async settingsSave(expected: string, candidate: Settings) {
    await this.requireComplete();
    const writer = await this.writer(), manifest = await this.manifest();
    if (writer && (await inspectContainer(writer, manifest.installation_id)).State.Running) {
      await maintenance(this.root, { operation: 'settings-save', expected_revision: SavedSettings.shape.revision.parse(expected), candidate });
    }
    await saveSettings(this.root, expected, candidate);
    return this.settingsShow();
  }
  async export(path: string): Promise<{ bytes: number; partial: boolean }> {
    const manifest = await this.manifest(), settings = await this.settings();
    const writer = await this.writer();
    const context = writer && (await inspectContainer(writer, manifest.installation_id)).State.Running
      ? await maintenance(this.root, { operation: 'export' }) : { marker: await this.offline('inspect-marker') };
    const logs = join(this.root, 'data', 'logs');
    const files = (await readdir(logs).catch(error => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; })).filter(file => /^events\.[0-7]\.jsonl$/.test(file)).sort().reverse();
    let retained = 0;
    for (const file of files) retained += (await stat(join(logs, file))).size;
    const budget = settings.saved.diagnosticBytes - Math.max(retained, Math.ceil(settings.saved.diagnosticBytes / 2));
    if (budget < 16_384) throw new Error('storage_limit');
    const output = await open(path, 'wx', 0o600);
    let bytes = 0, partial = false, events = 0, omitted = 0;
    try {
      const line = JSON.stringify({ format: 1, release: '0.1.0', image: manifest.image, context,
        configuration: { severity: settings.saved.diagnosticLevel, max_bytes: settings.saved.diagnosticBytes }, gaps: 'diagnostics_may_be_incomplete' }) + '\n';
      await output.writeFile(line); bytes = Buffer.byteLength(line);
      for (const file of files) {
        let pending = Buffer.alloc(0), oversized = false;
        for await (const chunk of createReadStream(join(logs, file), { highWaterMark: 8192 })) {
          if (!Buffer.isBuffer(chunk)) throw new Error('export_read_failed');
          let from = 0;
          while (from < chunk.byteLength) {
            const end = chunk.indexOf(10, from), until = end < 0 ? chunk.byteLength : end;
            if (pending.byteLength + until - from > 8192) { oversized = true; pending = Buffer.alloc(0); }
            if (!oversized) pending = Buffer.concat([pending, chunk.subarray(from, until)]);
            if (end < 0) break;
            let line: string | undefined;
            if (!oversized) { try { line = retainedEvent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending))); } catch { line = undefined; } }
            if (line === undefined || bytes + Buffer.byteLength(line) > budget - 4096) { partial = true; omitted++; }
            else { await output.writeFile(line); bytes += Buffer.byteLength(line); events++; }
            pending = Buffer.alloc(0); oversized = false; from = end + 1;
          }
        }
        if (pending.byteLength > 0 || oversized) { partial = true; omitted++; }
      }
      const trailer = JSON.stringify({ partial, included_events: events, omitted_events: omitted }) + '\n';
      await output.writeFile(trailer); bytes += Buffer.byteLength(trailer);
      await output.sync();
    } finally { await output.close(); }
    await flushDirectory(join(path, '..'));
    return { bytes, partial };
  }
}
