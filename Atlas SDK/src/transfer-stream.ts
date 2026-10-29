import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { SdkError } from './contracts.js';
import type { LocalCode } from './contracts.js';
import { CleanupFailure, failureCode, readerCancellation } from './http.js';

// Bound SDK-owned copies and work per pull independently of the complete file size.
const maximumChunk = 1024 * 1024;

export class TransferReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #cancel: () => Promise<void>;
  readonly #hash = sha256.create();
  readonly #signal: AbortSignal;
  readonly #length: number;
  readonly #digest: string;
  readonly #readFailure: LocalCode;
  #stopping: Promise<void> | undefined;
  #eof = false;
  #bytes = 0;
  #observed = 0;
  #failure: unknown;
  constructor(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    length: number,
    digest: string,
    readFailure: LocalCode,
  ) {
    this.#reader = stream.getReader();
    this.#cancel = readerCancellation(this.#reader);
    this.#signal = signal;
    this.#length = length;
    this.#digest = digest;
    this.#readFailure = readFailure;
    signal.addEventListener('abort', this.#abort, { once: true });
    if (signal.aborted) this.#abort();
  }
  get bytes(): number {
    return this.#observed;
  }
  get failure(): unknown {
    return this.#failure;
  }
  readonly #abort = () => {
    void this.stop().catch(() => undefined);
  };
  stop(): Promise<void> {
    this.#stopping ??= this.#cancel();
    return this.#stopping;
  }
  async read(): Promise<Uint8Array | undefined> {
    try {
      this.#signal.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await this.#reader.read();
      } catch {
        throw new SdkError(this.#readFailure);
      }
      this.#signal.throwIfAborted();
      if (this.#stopping) throw new SdkError('cancelled');
      if (chunk.done) {
        this.#eof = true;
        if (this.#bytes !== this.#length || bytesToHex(this.#hash.digest()) !== this.#digest)
          throw new SdkError('integrity_mismatch');
        return undefined;
      }
      if (!(chunk.value instanceof Uint8Array)) throw new SdkError('invalid_value');
      this.#observed += chunk.value.byteLength;
      if (chunk.value.byteLength > this.#length - this.#bytes)
        throw new SdkError('integrity_mismatch');
      if (chunk.value.byteLength > maximumChunk) throw new SdkError('resource_limit');
      // The source may reuse its storage on its next pull. Own only this bounded chunk.
      const bytes = new Uint8Array(chunk.value);
      this.#hash.update(bytes);
      this.#bytes += bytes.byteLength;
      return bytes;
    } catch (error) {
      this.#failure ??= error;
      throw error;
    }
  }
  async close(primary?: unknown): Promise<void> {
    this.#signal.removeEventListener('abort', this.#abort);
    try {
      if (!this.#eof || this.#stopping) await this.stop();
    } catch (error) {
      throw new CleanupFailure(failureCode(primary ?? this.#failure ?? error), failureCode(error));
    } finally {
      this.#reader.releaseLock();
      this.#hash.destroy();
    }
  }
}

export function verifiedStream(reader: TransferReader, signal: AbortSignal) {
  let finish: (error?: unknown) => Promise<void>;
  let resolve: () => void;
  let reject: (error: unknown) => void;
  const completed = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let ending: Promise<void> | undefined;
        const abort = () => {
          void finish(signal.reason);
        };
        finish = (primary?: unknown) => {
          if (ending) return ending;
          ending = (async () => {
            signal.removeEventListener('abort', abort);
            let error = primary;
            try {
              await reader.close(primary);
            } catch (cleanup) {
              error = cleanup;
            }
            if (error === undefined && cancelled) error = new SdkError('cancelled');
            if (error !== undefined) {
              controller.error(new SdkError(failureCode(error)));
              reject(error);
            } else {
              controller.close();
              resolve();
            }
          })();
          return ending;
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const bytes = await reader.read();
          if (bytes === undefined) await finish();
          else controller.enqueue(bytes);
        } catch (error) {
          await finish(error);
        }
      },
      cancel() {
        cancelled = true;
        return finish(new SdkError('cancelled'));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, completed };
}
