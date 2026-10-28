import { z } from 'zod';
import { checkJsonBytes } from '@atlas/protocol';

export function readLocalJson<S extends z.ZodType>(bytes: Uint8Array, schema: S): z.output<S> {
  checkJsonBytes(bytes, 'http_request', { maxBytes: 65_536, maxValues: 4096 });
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), (_key: string, value: unknown, context?: unknown) => {
    if (typeof value !== 'number') return value;
    if (!Number.isSafeInteger(value)) throw new Error('invalid_local_number');
    const { source } = z.object({ source: z.string().max(128) }).parse(context);
    const [mantissa = '', exponent = '0'] = source.toLowerCase().split('e');
    const dot = mantissa.indexOf('.');
    const scale = Number(exponent) - (dot < 0 ? 0 : mantissa.length - dot - 1);
    const coefficient = BigInt(mantissa.replace('.', ''));
    if (coefficient !== 0n && scale < 0 && (scale < -128 || coefficient % 10n ** BigInt(-scale) !== 0n)) throw new Error('invalid_local_number');
    return value;
  });
  return schema.parse(value);
}
