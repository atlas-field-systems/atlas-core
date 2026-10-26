import { createHash, randomUUID } from 'node:crypto';
import { Counter, NewId, Timestamp } from '@atlas/protocol';

export const id = (): NewId => NewId.parse(randomUUID());
export const now = (): Timestamp => Timestamp.parse(new Date().toISOString());
export const zero = Counter.parse('0');
export function next(value: Counter): Counter {
  if (value === '18446744073709551615') throw new RangeError('counter_exhausted');
  return Counter.parse((BigInt(value) + 1n).toString());
}
export function timeKey(value: string): string {
  return `${value.slice(0, 19)}.${value.slice(19, -1).replace('.', '').padEnd(9, '0')}Z`;
}
export function instant(value: string): bigint {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const prior = year - 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const days = 365 * prior + Math.floor(prior / 4) - Math.floor(prior / 100) +
    Math.floor(prior / 400) + months.slice(0, month - 1).reduce((a, b) => a + b, 0) + day - 1;
  const seconds = ((days * 24 + Number(value.slice(11, 13))) * 60 + Number(value.slice(14, 16))) * 60 + Number(value.slice(17, 19));
  return BigInt(seconds) * 1_000_000_000n + BigInt(value.slice(19, -1).replace('.', '').padEnd(9, '0'));
}
export const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError('Invalid retained fact');
  return result;
}
export function credentialFacts<T extends { secret: string }>(value: T) {
  const { secret, ...facts } = value;
  return { ...facts, verifier: digest(secret) };
}
