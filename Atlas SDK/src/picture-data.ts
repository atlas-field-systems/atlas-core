import type {
  Asset,
  Track,
  Geofeature,
  Task,
  ObjectImage,
  Change,
  Put,
  Budget,
} from '@atlas/protocol';
import { SdkError } from './contracts.js';
import { freeze } from './http.js';

export type PictureLimits = Readonly<{
  bytes?: number;
  images?: number;
  journalBytes?: number;
  journalCommits?: number;
  queryLifetimeMs?: number;
  queries?: number;
  subscribers?: number;
  pageSize?: number;
}>;

function positive(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new SdkError('invalid_options');
  return result;
}

export function pictureLimits(options: PictureLimits = {}) {
  return Object.freeze({
    bytes: positive(options.bytes, 512 * 1024 * 1024, 2 ** 31 - 1),
    images: positive(options.images, 100_000, 1_000_000),
    journalBytes: positive(options.journalBytes, 16 * 1024 * 1024, 2 ** 31 - 1),
    journalCommits: positive(options.journalCommits, 10_000, 1_000_000),
    queryLifetimeMs: positive(options.queryLifetimeMs, 60_000, 3_600_000),
    queries: positive(options.queries, 128, 4096),
    subscribers: positive(options.subscribers, 128, 4096),
    pageSize: positive(options.pageSize, 100, 1000),
  });
}

// Conservative retained-heap charge includes strings, properties, arrays and map entries.
// Shared references are charged again when a query or journal can outlive the picture.
export function retainedBytes(value: unknown): number {
  if (typeof value === 'string') return 64 + value.length * 2;
  if (value === null || typeof value !== 'object') return 32;
  let bytes = 128;
  for (const key in value) {
    if (Object.hasOwn(value, key))
      bytes +=
        64 + key.length * 2 + retainedBytes(Object.getOwnPropertyDescriptor(value, key)?.value);
  }
  return bytes;
}

export function decodeReservation(budget: Budget): number {
  return budget.maxBytes * 8 + budget.maxValues * 256 + 4096;
}

export class PictureMemory {
  used = 0;
  images = 0;
  constructor(public limits: ReturnType<typeof pictureLimits>) {}
  take(bytes: number, images = 0): void {
    if (bytes > this.limits.bytes - this.used || images > this.limits.images - this.images)
      throw new SdkError('capacity');
    this.used += bytes;
    this.images += images;
  }
  release(bytes: number, images = 0): void {
    this.used -= bytes;
    this.images -= images;
  }
  reserveDecode(budget: Budget): () => void {
    const bytes = decodeReservation(budget);
    this.take(bytes);
    return () => this.release(bytes);
  }
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  const a = Object.entries(left),
    b = Object.entries(right);
  if (a.length !== b.length || Array.isArray(left) !== Array.isArray(right)) return false;
  return a.every(
    ([key, value]) =>
      Object.hasOwn(right, key) && equal(value, Object.getOwnPropertyDescriptor(right, key)?.value),
  );
}

export class PictureData {
  readonly assets = new Map<string, Asset>();
  readonly tracks = new Map<string, Track>();
  readonly geofeatures = new Map<string, Geofeature>();
  readonly tasks = new Map<string, Task>();
  readonly objects = new Map<string, ObjectImage>();
  readonly #versions = new Map<string, Readonly<{ change: Change; bytes: number }>>();
  #bytes = 0;
  #images = 0;
  constructor(readonly memory: PictureMemory) {}

  apply(changes: readonly Change[], journalBytes = 0): void {
    let added = 0,
      removed = 0,
      delta = 0;
    for (const change of changes) {
      const previous = this.#versions.get(`${change.resource_kind}:${change.resource_id}`);
      if (previous) {
        const order = BigInt(change.version) - BigInt(previous.change.version);
        if (order < 0n || (order === 0n && !equal(change, previous.change)))
          throw new SdkError('invalid_value');
        if (order === 0n) continue;
        removed += previous.bytes;
      }
      delta += Number(change.kind === 'put') - Number(previous?.change.kind === 'put');
      added += retainedBytes(change) + 512;
    }
    this.memory.take(added + journalBytes, Math.max(delta, 0));
    for (const change of changes) {
      const key = `${change.resource_kind}:${change.resource_id}`;
      const previous = this.#versions.get(key);
      if (previous?.change.version === change.version) continue;
      freeze(change);
      this.#versions.set(key, { change, bytes: retainedBytes(change) + 512 });
      if (change.kind === 'delete') {
        switch (change.resource_kind) {
          case 'asset':
            this.assets.delete(change.resource_id);
            break;
          case 'geofeature':
            this.geofeatures.delete(change.resource_id);
            break;
          case 'object':
            this.objects.delete(change.resource_id);
            break;
        }
      } else this.#put(change);
    }
    this.memory.release(removed, Math.max(-delta, 0));
    this.#bytes += added - removed;
    this.#images += delta;
  }
  #put(change: Put): void {
    switch (change.resource_kind) {
      case 'asset':
        this.assets.set(change.resource_id, change.image);
        break;
      case 'track':
        this.tracks.set(change.resource_id, change.image);
        break;
      case 'geofeature':
        this.geofeatures.set(change.resource_id, change.image);
        break;
      case 'task':
        this.tasks.set(change.resource_id, change.image);
        break;
      case 'object':
        this.objects.set(change.resource_id, change.image);
        break;
    }
  }
  clear(): void {
    this.memory.release(this.#bytes, this.#images);
    this.#bytes = 0;
    this.#images = 0;
    this.#versions.clear();
    this.assets.clear();
    this.tracks.clear();
    this.geofeatures.clear();
    this.tasks.clear();
    this.objects.clear();
  }
}
