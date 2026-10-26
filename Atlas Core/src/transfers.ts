import { createHash } from 'node:crypto';
import { open, link, unlink, mkdir, stat, rm } from 'node:fs/promises';
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
import { exited, flushDirectory, processIdentity } from './ownership.js';
import type { Context } from './engine.js';
import type { DatabaseWorker } from './rpc.js';
import type { Settings } from './settings.js';

export class Transfers {
  private uploads = 0;
  private downloads = 0;
  private closing = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly streams = new Set<Readable>();
  private owner: WriterIdentity | undefined;
  constructor(private readonly rpc: DatabaseWorker, private readonly directory: string, private readonly settings: Settings) {}
  async initialize(): Promise<void> {
    this.owner = await processIdentity();
    await mkdir(join(this.directory, 'staging'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.directory, 'installed'), { recursive: true, mode: 0o700 });
    if ((await stat(join(this.directory, 'staging'))).dev !== (await stat(join(this.directory, 'installed'))).dev) throw new Error('object_filesystem_mismatch');
    const attempts = z.array(Attempt).parse(await this.rpc.call('attempts', {}, 0, true));
    for (const attempt of attempts) {
      const owner = WriterIdentity.parse(JSON.parse(attempt.owner));
      if (await exited(owner)) await this.cleanup(attempt.id);
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
    const attemptId = id();
    let attempt: Attempt | undefined, file: FileHandle | undefined, primary: unknown;
    try {
      if (this.owner === undefined) throw new Error('transfer_not_initialized');
      attempt = Attempt.parse(await this.rpc.call('prepare-upload', { context, attempt: attemptId, owner: this.owner }, 1024));
      let descriptor: UploadDescriptor | undefined, seenFile = false, length = 0;
      const hash = createHash('sha256');
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.encoding !== '7bit' && part.encoding !== 'binary' && part.encoding !== '8bit') refuse('invalid_request');
        this.streams.add(part.file);
        try {
          if (part.fieldname === 'descriptor' && descriptor === undefined) {
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const raw of part.file) {
              if (!Buffer.isBuffer(raw)) refuse('invalid_request');
              if (bytes + raw.byteLength > this.settings.limits.max_request_bytes) refuse('payload_too_large');
              bytes += raw.byteLength; chunks.push(raw);
            }
            descriptor = parse(Buffer.concat(chunks, bytes));
            if (descriptor.byte_length !== String(length) && seenFile) refuse('invalid_request');
            await this.rpc.call('describe-upload', { context, attempt: attemptId, descriptor }, bytes + 1024);
          } else if (part.fieldname === 'file' && !seenFile) {
            seenFile = true;
            file = await open(join(this.directory, attempt.staging), 'wx', 0o600);
            for await (const raw of part.file) {
              if (!Buffer.isBuffer(raw)) refuse('invalid_request');
              if (length + raw.byteLength > this.settings.limits.max_object_bytes || descriptor !== undefined && BigInt(length + raw.byteLength) > BigInt(descriptor.byte_length)) refuse('payload_too_large');
              await this.rpc.call('reserve-upload', { context, attempt: attemptId, bytes: length + raw.byteLength }, 512);
              let offset = 0;
              while (offset < raw.byteLength) { const write = await file.write(raw, offset); if (write.bytesWritten === 0) throw new Error('file_write_incomplete'); offset += write.bytesWritten; }
              hash.update(raw); length += raw.byteLength;
            }
            if (part.file.truncated) refuse('payload_too_large');
          } else refuse('invalid_request');
        } finally { this.streams.delete(part.file); if (!part.file.readableEnded) part.file.destroy(); }
      }
      if (!seenFile || descriptor === undefined || file === undefined || String(length) !== descriptor.byte_length || hash.digest('hex') !== descriptor.sha256) refuse('invalid_request');
      await file.sync(); await file.close(); file = undefined;
      await link(join(this.directory, attempt.staging), join(this.directory, attempt.installed));
      await flushDirectory(join(this.directory, 'installed'));
      await unlink(join(this.directory, attempt.staging)); await flushDirectory(join(this.directory, 'staging'));
      await this.rpc.call('installed', attemptId, 128);
      const response = await this.rpc.exchange('UploadObject', descriptor, { ...context, attempt: attemptId }, Buffer.byteLength(JSON.stringify(descriptor)));
      await this.cleanup(attemptId);
      return response;
    } catch (error) { primary = error; throw error; }
    finally {
      let cleanup: unknown;
      try { if (file) await file.close(); if (attempt !== undefined && primary !== undefined && this.rpc.available) await this.cleanup(attemptId); }
      catch (error) { cleanup = error; }
      this.uploads--;
      if (cleanup !== undefined) throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup], 'upload_cleanup_failed');
    }
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
  async download(objectId: Uuid, context: Context): Promise<{ image: ObjectImage; stream: Readable }> {
    if (this.closing || this.downloads >= this.settings.maxDownloads) refuse('resource_limit');
    this.downloads++;
    let file: FileHandle | undefined;
    try {
      const metadata = z.object({ image: ObjectImage, path: z.string() }).parse(await this.rpc.call('file', { context, object: objectId }, 512));
      if (!/^installed\/[0-9a-f-]{36}-[0-9a-f-]{36}$/.test(metadata.path)) refuse('integrity_fault');
      file = await open(join(this.directory, metadata.path), 'r');
      const info = await file.stat();
      if (!info.isFile() || String(info.size) !== metadata.image.byte_length) refuse('integrity_fault');
      const hash = createHash('sha256');
      const scan = file.createReadStream({ autoClose: false, start: 0 });
      this.streams.add(scan);
      try { for await (const chunk of scan) { await this.authorize(context); hash.update(chunk); } }
      finally { this.streams.delete(scan); }
      if (hash.digest('hex') !== metadata.image.sha256) refuse('integrity_fault');
      await this.authorize(context);
      await this.rpc.call('integrity', { object: objectId, fault: false }, 128);
      const content = file.createReadStream({ autoClose: true, start: 0 });
      file = undefined;
      const authorize = () => this.authorize(context);
      async function* bytes() { try { for await (const chunk of content) { await authorize(); yield chunk; } } finally { content.destroy(); } }
      const stream = Readable.from(bytes()); this.streams.add(stream);
      const finished = new Promise<void>(resolve => stream.once('close', () => { this.streams.delete(stream); this.downloads--; resolve(); }));
      this.track(finished);
      return { image: metadata.image, stream };
    } catch (error) {
      this.downloads--;
      if (file) await file.close();
      if (error instanceof Refusal && error.code === 'integrity_fault' || error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        await this.rpc.call('integrity', { object: objectId, fault: true }, 128);
        refuse('integrity_fault');
      }
      throw error;
    }
  }
  async close(): Promise<void> { this.closing = true; for (const stream of this.streams) stream.destroy(); await Promise.allSettled(this.active); }
}
