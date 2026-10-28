import { isLosslessNumber } from 'lossless-json';
import { z } from 'zod';

export const PROTOCOL_VERSION = '0.3.0';
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/;
export const Uuid = z.string().regex(UUID_PATTERN).brand<'Uuid'>().meta({ id: 'Uuid' });
export const NewId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/)
  .brand<'Uuid'>()
  .brand<'UuidV4'>()
  .meta({ id: 'NewId' });

export function wellFormed(value: string): boolean {
  return !/[\ud800-\udfff]/u.test(value);
}

export function text(maxLength: number, nonblank = false) {
  const string = z
    .string()
    .refine(wellFormed, 'Malformed Unicode')
    .refine((value) => {
      let count = 0;
      for (const _scalar of value) if (++count > maxLength) return false;
      return true;
    }, 'String limit exceeded')
    .meta({ maxLength });
  return nonblank
    ? string
        .regex(
          /[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u,
          'Blank string',
        )
        .meta({ minLength: 1 })
    : string;
}

export const Opaque = text(4 * 1024 * 1024)
  .refine((value) => value.length > 0, 'Empty token')
  .meta({ id: 'Opaque', minLength: 1 });
export const Alias = text(128, true).meta({ id: 'Alias' });
export function decimalCounter(maximum: string, positive = false) {
  const alternatives = [
    positive
      ? '[1-9][0-9]{0,' + (maximum.length - 2) + '}'
      : '(?:0|[1-9][0-9]{0,' + (maximum.length - 2) + '})',
  ];
  for (let i = 0; i < maximum.length; i++) {
    const digit = Number(maximum[i]);
    const minimum = i === 0 ? 1 : 0;
    if (digit > minimum)
      alternatives.push(
        maximum.slice(0, i) +
          (digit - 1 === minimum ? String(minimum) : '[' + minimum + '-' + (digit - 1) + ']') +
          '[0-9]{' +
          (maximum.length - i - 1) +
          '}',
      );
  }
  alternatives.push(maximum);
  return z
    .string()
    .regex(new RegExp(String.raw`^(?:${alternatives.join('|')})$(?![\s\S])`))
    .max(maximum.length)
    .brand<'Counter'>();
}
export const Counter = decimalCounter('18446744073709551615').meta({ id: 'Counter' });
export const Sequence = decimalCounter('18446744073709551615', true)
  .brand<'Sequence'>()
  .meta({ id: 'Sequence' });
export const Secret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$(?![\s\S])/)
  .meta({ id: 'Secret', minLength: 43, maxLength: 43 });

const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$(?![\s\S])/;
export function timestampNanoseconds(value: string): bigint {
  const match = timestampPattern.exec(value);
  if (!match) throw new RangeError('Invalid timestamp');
  const [
    ,
    yearText = '',
    monthText = '',
    dayText = '',
    hourText = '',
    minuteText = '',
    secondText = '',
    fraction = '',
  ] = match;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const hour = Number(hourText),
    minute = Number(minuteText),
    second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthDays = days[month - 1];
  if (
    year < 1 ||
    !monthDays ||
    day < 1 ||
    day > monthDays ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw new RangeError('Invalid calendar');
  const prior = year - 1;
  const dayCount =
    365 * prior +
    Math.floor(prior / 4) -
    Math.floor(prior / 100) +
    Math.floor(prior / 400) +
    days.slice(0, month - 1).reduce((sum, n) => sum + n, 0) +
    day -
    1;
  return (
    BigInt(((dayCount * 24 + hour) * 60 + minute) * 60 + second) * 1000000000n +
    BigInt(fraction.padEnd(9, '0'))
  );
}
export const Timestamp = z
  .string()
  .regex(timestampPattern)
  .refine((value) => {
    try {
      timestampNanoseconds(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid Gregorian timestamp')
  .brand<'Timestamp'>()
  .meta({ id: 'Timestamp', maxLength: 30 });

export function binary64(value: number): { coefficient: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  return {
    coefficient: sign * (exponent === 0 ? fraction : fraction + (1n << 52n)),
    exponent: exponent === 0 ? -1074 : exponent - 1075,
  };
}

type Domain = Readonly<{
  integer?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
}>;
function exactDecimal(raw: string) {
  const [mantissa = '', exp = '0'] = raw.toLowerCase().split('e');
  const dot = mantissa.indexOf('.');
  return {
    coefficient: BigInt(mantissa.replace('.', '')),
    exponent: Number(exp) - (dot < 0 ? 0 : mantissa.length - dot - 1),
  };
}
export function validNumberToken(raw: string): boolean {
  if (
    raw.length > 128 ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$(?![\s\S])/.test(raw)
  )
    return false;
  const exp = raw.toLowerCase().split('e')[1];
  return exp === undefined || (Number(exp) >= -10000 && Number(exp) <= 10000);
}
function exactRatio(decimal: ReturnType<typeof exactDecimal>) {
  if (decimal.coefficient === 0n) return { numerator: 0n, denominator: 1n };
  const scale = 10n ** BigInt(Math.abs(decimal.exponent));
  return decimal.exponent >= 0
    ? { numerator: decimal.coefficient * scale, denominator: 1n }
    : { numerator: decimal.coefficient, denominator: scale };
}
function compareRatioToBinary(ratio: ReturnType<typeof exactRatio>, bound: number): number {
  const dyadic = binary64(bound);
  let left = ratio.numerator,
    right = dyadic.coefficient * ratio.denominator;
  if (dyadic.exponent >= 0) right <<= BigInt(dyadic.exponent);
  else left <<= BigInt(-dyadic.exponent);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function numeric(domain: Domain = {}) {
  let number = z.number().min(-Number.MAX_VALUE).max(Number.MAX_VALUE);
  if (domain.integer) number = number.int();
  if (domain.min !== undefined) number = number.min(domain.min);
  if (domain.max !== undefined) number = number.max(domain.max);
  if (domain.exclusiveMin !== undefined) number = number.gt(domain.exclusiveMin);
  if (domain.exclusiveMax !== undefined) number = number.lt(domain.exclusiveMax);
  return z.preprocess((input, ctx) => {
    if (!isLosslessNumber(input)) return input;
    const raw = input.value;
    if (!validNumberToken(raw)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid numeric token' });
      return z.NEVER;
    }
    const decimal = exactDecimal(raw);
    const converted = Number(raw);
    if (!Number.isFinite(converted) || (decimal.coefficient !== 0n && converted === 0)) {
      ctx.addIssue({ code: 'custom', message: 'Exact number outside domain' });
      return z.NEVER;
    }
    const ratio = exactRatio(decimal);
    const within =
      compareRatioToBinary(ratio, -Number.MAX_VALUE) >= 0 &&
      compareRatioToBinary(ratio, Number.MAX_VALUE) <= 0 &&
      (domain.min === undefined || compareRatioToBinary(ratio, domain.min) >= 0) &&
      (domain.max === undefined || compareRatioToBinary(ratio, domain.max) <= 0) &&
      (domain.exclusiveMin === undefined || compareRatioToBinary(ratio, domain.exclusiveMin) > 0) &&
      (domain.exclusiveMax === undefined || compareRatioToBinary(ratio, domain.exclusiveMax) < 0) &&
      (!domain.integer || ratio.numerator % ratio.denominator === 0n);
    if (!within) {
      ctx.addIssue({ code: 'custom', message: 'Exact number outside domain' });
      return z.NEVER;
    }
    return converted;
  }, number);
}
export const Float = numeric().meta({ id: 'Float' });
export const Integer = numeric({ integer: true, min: 0, max: 2147483647 }).meta({ id: 'Integer' });
export const PageSize = numeric({ integer: true, min: 1, max: 1000 }).meta({ id: 'PageSize' });
export const Latitude = numeric({ min: -90, max: 90 }).meta({ id: 'Latitude' });
export const Longitude = numeric({ min: -180, max: 180 }).meta({ id: 'Longitude' });
export const Time = Timestamp.nullable();
export const Position = z
  .strictObject({ latitude: Latitude, longitude: Longitude })
  .meta({ id: 'Position' });
export const Altitude = z
  .strictObject({ metres: Float, reference: z.literal('wgs84_ellipsoid') })
  .meta({ id: 'Altitude' });

export function unique<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}
export function bytewiseCompare(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left),
    b = encoder.encode(right);
  let index = 0;
  for (const byte of a) {
    const other = b[index++];
    if (other === undefined) return 1;
    if (byte !== other) return byte < other ? -1 : 1;
  }
  return a.length < b.length ? -1 : 0;
}
export function ordered<T>(values: readonly T[], key: (value: T) => string): boolean {
  let prior: string | undefined;
  for (const value of values) {
    const current = key(value);
    if (prior !== undefined && bytewiseCompare(prior, current) >= 0) return false;
    prior = current;
  }
  return true;
}
export function uniqueArray<S extends z.ZodType>(schema: S, maximum = 1000) {
  return z
    .array(schema)
    .max(maximum)
    .refine((values) => unique(values, (value) => String(value)), 'Duplicate entry')
    .meta({ uniqueItems: true });
}
export type Uuid = z.output<typeof Uuid>;
export type Timestamp = z.output<typeof Timestamp>;
export type Counter = z.output<typeof Counter>;
export type Position = z.output<typeof Position>;
export type Altitude = z.output<typeof Altitude>;
export type NewId = z.output<typeof NewId>;
export type Opaque = z.output<typeof Opaque>;
export type Alias = z.output<typeof Alias>;
export type Sequence = z.output<typeof Sequence>;
export type Secret = z.output<typeof Secret>;
export type Float = z.output<typeof Float>;
export type Integer = z.output<typeof Integer>;
export type PageSize = z.output<typeof PageSize>;
export type Latitude = z.output<typeof Latitude>;
export type Longitude = z.output<typeof Longitude>;
export type Time = z.output<typeof Time>;
