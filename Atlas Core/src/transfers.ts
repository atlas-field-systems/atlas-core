import { createHash } from 'node:crypto';
import { open, link, unlink, stat, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ObjectImage, Uuid } from '@atlas/protocol';
import type { UploadDescriptor } from '@atlas/protocol';
import { Attempt, WriterIdentity } from './objects.js';
import { id } from './exact.js';
import { Refusal, refuse } from './fault.js';
import { currentWriter, exited, flushDirectory, ownedDirectory } from './ownership.js';
import type { Context } from './engine.js';
import type { DatabaseWorker } from './rpc.js';
import type { Settings } from './settings.js';
import type { Diagnostics } from './diagnostics.js';
import { faultFrames } from './diagnostics.js';

export class Transfers {
  private uploads = 0;
  private downloads = 0;
  private closing = false;
  private cleanupFailure: AggregateError | undefined;
  private readonly active = new Set<Promise<unknown>>();
  private readonly streams = new Set<Readable>();
  private readonly receivers = new Map<FastifyRequest, { context: Context; stream?: Readable }>();
  private owner: WriterIdentity | undefined;
  constructor(private readonly rpc: DatabaseWorker, private readonly directory: string, private readonly settings: Settings, private readonly diagnostics: Diagnostics, private readonly exitedLaunches: ReadonlySet<Uuid>) {}
  async initialize(): Promise<void> {
    this.owner = await currentWriter();
    await ownedDirectory(join(this.directory, 'staging'));
    await ownedDirectory(join(this.directory, 'installed'));
    if ((await stat(join(this.directory, 'staging'))).dev !== (await stat(join(this.directory, 'installed'))).dev) throw new Error('object_filesystem_mismatch');
    let after: Uuid | undefined;
    while (true) {
      const attempts = z.array(Attempt).max(32).parse(await this.rpc.call('attempts', after === undefined ? {} : { after }, 1024, true));
      if (attempts.length === 0) break;
      for (const attempt of attempts) {
        const owner = WriterIdentity.parse(JSON.parse(attempt.owner));
        if (owner.launch !== undefined && this.exitedLaunches.has(owner.launch) || await exited(owner)) await this.cleanup(attempt.id);
        after = attempt.id;
      }
    }
  }
  private async authorize(context: Context): Promise<void> { await this.rpc.call('authorize', { context, discovery: false }, 256, true); }
  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.then(() => this.active.delete(work), () => this.active.delete(work));
    return work;
  }
  upload(request: FastifyRequest, context: Context, descriptor: (bytes: Uint8Array) => UploadDescriptor) {
    return this.track(this.receive(request, context, descriptor));
  }
  private async receive(request: FastifyRequest, context: Context, parse: (bytes: Uint8Array) => UploadDescriptor) {
    if (this.closing || this.uploads >= this.settings.maxUploads) refuse('resource_limit');
    this.uploads++;
    const receiver: { context: Context; stream?: Readable } = { context };
    this.receivers.set(request, receiver);
    const attemptId = id();
    let attempt: Attempt | undefined, file: FileHandle | undefined, primary: unknown;
    const checkOpen = () => { if (request.raw.aborted) refuse('invalid_request'); if (this.closing) refuse('resource_limit'); };
    const discard = async () => {
      if (file !== undefined) { await file.close(); file = undefined; }
      if (attempt !== undefined) { await this.cleanup(attemptId); attempt = undefined; }
    };
    try {
      if (this.owner === undefined) throw new Error('transfer_not_initialized');
      let descriptor: UploadDescriptor | undefined, seenFile = false, length = 0, replay = false;
      let deferred: Refusal | undefined;
      const hash = createHash('sha256');
      // Multipart only observes request closes after iteration starts.
      checkOpen();
      for await (const part of request.parts()) {
        checkOpen();
        if (part.type !== 'file' || part.encoding !== '7bit' && part.encoding !== 'binary' && part.encoding !== '8bit') refuse('invalid_request');
        this.streams.add(part.file);
        receiver.stream = part.file;
        try {
          if (part.fieldname === 'descriptor' && descriptor === undefined) {
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const raw of part.file) {
              if (!Buffer.isBuffer(raw)) refuse('invalid_request');
              if (bytes + raw.byteLength > this.settings.limits.max_request_bytes) refuse('payload_too_large');
              bytes += raw.byteLength; chunks.push(raw);
            }
            if (part.file.truncated) refuse('payload_too_large');
            descriptor = parse(Buffer.concat(chunks, bytes));
            if (descriptor.byte_length !== String(length) && seenFile) refuse('invalid_request');
            replay = z.boolean().parse(await this.rpc.call('upload-retry', { context, descriptor }, bytes + 1024));
            checkOpen();
            if (replay) await discard();
            else {
              if (deferred !== undefined) throw deferred;
              if (attempt === undefined) attempt = Attempt.parse(await this.rpc.call('prepare-upload', { context, attempt: attemptId, owner: this.owner, descriptor }, bytes + 1024));
              else await this.rpc.call('describe-upload', { context, attempt: attemptId, descriptor }, bytes + 1024);
              checkOpen();
            }
          } else if (part.fieldname === 'file' && !seenFile) {
            seenFile = true;
            if (descriptor === undefined) {
              try { attempt = Attempt.parse(await this.rpc.call('prepare-upload', { context, attempt: attemptId, owner: this.owner }, 1024)); }
              catch (error) { if (!(error instanceof Refusal) || error.code !== 'storage_limit') throw error; deferred = error; }
              checkOpen();
            }
            for await (const raw of part.file) {
              checkOpen();
              if (!Buffer.isBuffer(raw)) refuse('invalid_request');
              if (length + raw.byteLength > this.settings.limits.max_object_bytes || descriptor !== undefined && BigInt(length + raw.byteLength) > BigInt(descriptor.byte_length)) refuse('payload_too_large');
              if (!replay && deferred === undefined) {
                try { await this.rpc.call('reserve-upload', { context, attempt: attemptId, bytes: length + raw.byteLength, written: length }, 512); }
                catch (error) {
                  if (descriptor !== undefined || !(error instanceof Refusal) || error.code !== 'storage_limit') throw error;
                  deferred = error; await discard();
                }
                checkOpen();
              }
              if (replay || deferred !== undefined) { await this.authorize(context); checkOpen(); }
              else {
                if (attempt === undefined) throw new Error('missing_upload_attempt');
                file ??= await open(join(this.directory, attempt.staging), 'wx', 0o600);
                checkOpen();
                let offset = 0;
                while (offset < raw.byteLength) { const write = await file.write(raw, offset); if (write.bytesWritten === 0) throw new Error('file_write_incomplete'); offset += write.bytesWritten; checkOpen(); }
              }
              hash.update(raw); length += raw.byteLength;
            }
            if (part.file.truncated) refuse('payload_too_large');
            if (!replay && deferred === undefined) {
              if (attempt === undefined) throw new Error('missing_upload_attempt');
              file ??= await open(join(this.directory, attempt.staging), 'wx', 0o600);
              await this.rpc.call('upload-written', { attempt: attemptId, written: length }, 256);
              checkOpen();
            }
          } else refuse('invalid_request');
        } finally { delete receiver.stream; this.streams.delete(part.file); if (!part.file.readableEnded) part.file.destroy(); }
      }
      checkOpen();
      if (!seenFile || descriptor === undefined || String(length) !== descriptor.byte_length || hash.digest('hex') !== descriptor.sha256) refuse('invalid_request');
      this.diagnostics.emit({ severity: 'INFO', component: 'objects', event: 'content_verified', bytes: length });
      if (replay) {
        const response = await this.rpc.exchangeDetailed('UploadObject', descriptor, context, Buffer.byteLength(JSON.stringify(descriptor)));
        this.diagnostics.emit({ severity: 'INFO', component: 'objects', event: 'content_published', bytes: length, outcome: response.execution });
        return { ...response, request: descriptor };
      }
      if (attempt === undefined || file === undefined) throw new Error('missing_upload_attempt');
      await file.sync(); await file.close(); file = undefined;
      this.diagnostics.emit({ severity: 'INFO', component: 'objects', event: 'content_flushed', bytes: length });
      await link(join(this.directory, attempt.staging), join(this.directory, attempt.installed));
      await flushDirectory(join(this.directory, 'installed'));
      await unlink(join(this.directory, attempt.staging)); await flushDirectory(join(this.directory, 'staging'));
      await this.rpc.call('installed', attemptId, 128);
      this.diagnostics.emit({ severity: 'INFO', component: 'objects', event: 'content_installed', bytes: length });
      const response = await this.rpc.exchangeDetailed('UploadObject', descriptor, { ...context, attempt: attemptId }, Buffer.byteLength(JSON.stringify(descriptor)));
      this.diagnostics.emit({ severity: 'INFO', component: 'objects', event: 'content_published', bytes: length, outcome: response.execution });
      await this.cleanup(attemptId);
      return { ...response, request: descriptor };
    } catch (error) { primary = error; throw error; }
    finally {
      let cleanup: unknown;
      try { if (file) await file.close(); if (attempt !== undefined && primary !== undefined && this.rpc.available) await this.cleanup(attemptId); }
      catch (error) { cleanup = error; }
      this.uploads--;
      this.receivers.delete(request);
      if (cleanup !== undefined) throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup], 'upload_cleanup_failed');
    }
  }
  async recheck(): Promise<void> {
    await Promise.all([...this.receivers].map(async ([request, receiver]) => {
      try { await this.authorize(receiver.context); }
      catch { receiver.stream?.destroy(new Refusal('unauthorized')); request.raw.destroy(); }
    }));
  }
  private async cleanup(attemptId: Uuid): Promise<void> {
    const attempt = Attempt.parse(await this.rpc.call('attempt', attemptId, 128, true));
    if (attempt.state === 'published' || attempt.state === 'reclaimed') return;
    await this.rpc.call('abandon', attemptId, 128, true);
    await rm(join(this.directory, attempt.staging), { force: true });
    await rm(join(this.directory, attempt.installed), { force: true });
    await flushDirectory(join(this.directory, 'installed')); await flushDirectory(join(this.directory, 'staging'));
    await this.rpc.call('reclaim', attemptId, 128, true);
  }
  async reclaimDeleted(): Promise<void> {
    if (this.downloads > 0 || this.closing) return;
    const retired = z.array(z.object({ object: Uuid, path: z.string() })).max(32).parse(await this.rpc.call('retired-files', {}, 8192, true));
    for (const file of retired) {
      if (this.downloads > 0 || this.closing) return;
      if (!/^installed\/[0-9a-f-]{36}-[0-9a-f-]{36}$/.test(file.path)) throw new Error('invalid_owned_file');
      await rm(join(this.directory, file.path), { force: true });
      await flushDirectory(join(this.directory, 'installed'));
      await this.rpc.call('file-reclaimed', file.object, 128, true);
      this.diagnostics.emit({ severity: 'INFO', component: 'objects', event: 'content_reclaimed', count: 1 });
    }
  }
  download(objectId: Uuid, context: Context): Promise<{ image: ObjectImage; stream: Readable }> {
    return this.track(this.prepareDownload(objectId, context));
  }
  private checkDownload(): void { if (this.closing) refuse('resource_limit'); }
  private downloadCleanupFailed(errors: readonly unknown[]): AggregateError {
    const failure = new AggregateError(errors, 'download_cleanup_failed');
    this.cleanupFailure ??= failure;
    this.diagnostics.emit({ severity: 'ERROR', component: 'objects', event: 'download_cleanup_failed', ...faultFrames(errors.at(-1)) });
    return failure;
  }
  private async prepareDownload(objectId: Uuid, context: Context): Promise<{ image: ObjectImage; stream: Readable }> {
    if (this.closing || this.downloads >= this.settings.maxDownloads) refuse('resource_limit');
    this.downloads++;
    let file: FileHandle | undefined;
    try {
      const metadata = z.object({ image: ObjectImage, path: z.string() }).parse(await this.rpc.call('file', { context, object: objectId }, 512));
      this.checkDownload();
      if (!/^installed\/[0-9a-f-]{36}-[0-9a-f-]{36}$/.test(metadata.path)) refuse('integrity_fault');
      file = await open(join(this.directory, metadata.path), 'r');
      this.checkDownload();
      const info = await file.stat();
      this.checkDownload();
      if (!info.isFile() || String(info.size) !== metadata.image.byte_length) refuse('integrity_fault');
      const hash = createHash('sha256');
      const scan = file.createReadStream({ autoClose: false, start: 0 });
      this.streams.add(scan);
      try { for await (const chunk of scan) { await this.authorize(context); this.checkDownload(); hash.update(chunk); } }
      finally { this.streams.delete(scan); }
      if (hash.digest('hex') !== metadata.image.sha256) refuse('integrity_fault');
      await this.authorize(context);
      this.checkDownload();
      await this.rpc.call('integrity', { object: objectId, fault: false }, 128);
      this.checkDownload();
      const handle = file;
      const content = handle.createReadStream({ autoClose: false, start: 0 });
      content.on('error', error => this.diagnostics.emit({ severity: 'ERROR', component: 'objects', event: 'content_stream_failed', ...faultFrames(error) }));
      file = undefined;
      const authorize = () => this.authorize(context);
      async function* bytes() { try { for await (const chunk of content) { await authorize(); yield chunk; } } finally { content.destroy(); } }
      const stream = Readable.from(bytes()); this.streams.add(stream);
      const finished = new Promise<void>((resolve, reject) => stream.once('close', () => {
        content.destroy();
        void handle.close().then(resolve, error => reject(this.downloadCleanupFailed([error])));
      })).finally(() => { this.streams.delete(stream); this.downloads--; });
      this.track(finished);
      return { image: metadata.image, stream };
    } catch (error) {
      this.downloads--;
      if (file) {
        try { await file.close(); }
        catch (cleanup) { throw this.downloadCleanupFailed([error, cleanup]); }
      }
      if (error instanceof Refusal && error.code === 'integrity_fault' || error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        await this.rpc.call('integrity', { object: objectId, fault: true }, 128);
        refuse('integrity_fault');
      }
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const [request, receiver] of this.receivers) { receiver.stream?.destroy(); request.raw.destroy(); }
    for (const stream of this.streams) stream.destroy();
    await Promise.allSettled(this.active);
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
  }
}
