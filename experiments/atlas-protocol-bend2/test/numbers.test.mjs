import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const bend = process.env.BEND ?? '/tmp/atlas-bend2-toolchain/bin/bend';
const output = mkdtempSync('/tmp/atlas-bend2-numbers-');
after(() => rmSync(output, { recursive: true, force: true }));

function compile(source, name) {
  for (const args of [[source, '--check-only'], [source, '-o', join(output, name)]]) {
    const result = spawnSync(bend, args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
  }
  return import(pathToFileURL(join(output, name)).href);
}

const { default: N } = await compile(resolve(directory, '../numbers.bend'), 'numbers.mjs');
const { default: G } = await compile(join(directory, 'numbers-geometry.bend'), 'geometry.mjs');

function unwrap(result, label) {
  assert.equal(result.$, 'Some', label);
  return result.value;
}

function integer(value) {
  let magnitude = value.magnitude;
  let result = 0n;
  let shift = 0n;
  while (magnitude.$ === 'Limb') {
    result += BigInt(magnitude.low) << shift;
    shift += 16n;
    magnitude = magnitude.rest;
  }
  assert.equal(magnitude.$, 'MagZero');
  return value.negative ? -result : result;
}

function scaled(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const result = exponent === 0 ? fraction : ((1n << 52n) + fraction) << BigInt(exponent - 1);
  return bits >> 63n ? -result : result;
}

function read(raw) {
  return unwrap(N.read(raw), raw);
}

function accept(raw, min = '', max = '', integer = false, exclusiveMin = false, exclusiveMax = false) {
  return N.accept(raw, min, max, integer, exclusiveMin, exclusiveMax);
}

test('JSON token grammar, ASCII length and bounded exponent', () => {
  for (const raw of [
    '0', '-0', '1', '-1.25', '100.0', '1e2', '1E+002', '1e-10000',
    '0e10000', '-0e-00010000', '0e+000010000', '1'.repeat(128),
    `0.${'0'.repeat(126)}`, `0e${'0'.repeat(126)}`,
  ]) assert.equal(N.token_valid(raw), true, raw);
  for (const raw of [
    '', '-', '+0', '00', '-01', '.1', '1.', '1.e2', '1e', '1e+', '1e--1',
    '1e1.0', '1e10001', '0e-10001', `0e${'9'.repeat(126)}`, '1'.repeat(129),
    `0.${'0'.repeat(127)}`, ' 1', '1 ', '1\n', '1\r\n', 'NaN', 'Infinity',
    '-Infinity', '0x10', '1_000', '１', '1é', '1\u0000', '1\u2028',
  ]) assert.equal(N.token_valid(raw), false, JSON.stringify(raw));
});

test('contract-derived scalar fixtures run through Bend acceptance', () => {
  for (const name of ['acceptance.json', 'independent-cases.json']) {
    const corpus = JSON.parse(readFileSync(join(root, 'Atlas Protocol/test/fixtures', name), 'utf8'));
    const cases = corpus.cases.filter((item) => ['OrdinaryInteger', 'Integer', 'TypedFloat'].includes(item.schema_name));
    assert.ok(cases.length > 0);
    for (const item of cases) {
      const isInteger = item.schema_name !== 'TypedFloat';
      assert.equal(accept(item.raw_json, isInteger ? '0' : '', isInteger ? '2147483647' : '', isInteger),
        item.expected === 'accept', `${name} ${item.id}`);
      if (item.canonical_json !== undefined) assert.equal(N.format(item.raw_json), item.canonical_json, item.id);
    }
  }
});

test('coordinate fixture tokens retain their exact source spelling', () => {
  const acceptance = JSON.parse(readFileSync(join(root, 'Atlas Protocol/test/fixtures/acceptance.json'), 'utf8'));
  const independent = JSON.parse(readFileSync(join(root, 'Atlas Protocol/test/fixtures/independent-cases.json'), 'utf8'));
  const cases = [
    ...acceptance.cases.filter((item) => item.id.startsWith('coordinate-')),
    ...independent.cases.filter((item) => ['independent-01', 'independent-04', 'independent-05',
      'independent-06', 'independent-07', 'independent-08'].includes(item.id)),
  ];
  for (const item of cases) {
    const latitude = /"latitude":([^,}]+)/.exec(item.raw_json)?.[1];
    const longitude = /"longitude":([^,}]+)/.exec(item.raw_json)?.[1];
    assert.ok(latitude && longitude, item.id);
    assert.equal(accept(latitude, '-90', '90') && accept(longitude, '-180', '180'),
      item.expected === 'accept', item.id);
  }
});

test('exact endpoint checks precede rounding and exclusive bounds are rechecked', () => {
  for (const raw of ['100', '100.0', '1e2', '10000.01e2', '0e-10000', '-0e10000']) {
    assert.equal(accept(raw, '0', '2147483647', true), true, raw);
  }
  for (const raw of ['100.0000000000000000001', '2147483647.000000001',
    '-0.0000000000000000001', '1e-10000', '1e10000']) {
    assert.equal(accept(raw, '0', '2147483647', true), false, raw);
  }
  for (const [raw, min, max, exclusiveMin, exclusiveMax, expected] of [
    ['180', '-180', '180', false, false, true],
    ['180.00000000000000000001', '-180', '180', false, false, false],
    ['-90.00000000000000000001', '-90', '90', false, false, false],
    ['359.999999999999999999999', '0', '360', false, true, false],
    ['359.9999999999999', '0', '360', false, true, true],
    ['0', '0', '180', true, true, false],
    ['180', '0', '180', true, true, false],
    ['90', '0', '180', true, true, true],
    ['-0', '0', '', false, false, true],
    ['-0', '0', '', true, false, false],
    ['0.1', '0.1', '', false, false, false],
    ['0.10000000000000001', '0.1', '', false, false, true],
    ['0.10000000000000001', '0.1', '', true, false, false],
    ['0.1', '', '0.1', false, false, true],
    ['0.100000000000000006', '', '0.1', false, false, false],
    ['1', '2', '1', false, false, false],
    ['1', 'NaN', '', false, false, false],
  ]) assert.equal(accept(raw, min, max, false, exclusiveMin, exclusiveMax), expected, raw);
  assert.equal(accept('9007199254740991', '', '', true), true);
  assert.equal(accept('9007199254740992', '', '', true), false);
});

test('finite maximum, nonzero underflow and subnormal boundaries', () => {
  const exactMax = ((1n << 1024n) - (1n << 971n)).toString();
  const belowMax = `${exactMax.slice(0, 120)}e189`;
  const aboveMax = `${BigInt(exactMax.slice(0, 120)) + 1n}e189`;
  for (const raw of ['1.7976931348623157e308', belowMax, `-${belowMax}`,
    '5e-324', '-5e-324', '2.4703282292062328e-324',
    '2.2250738585072011e-308', '2.2250738585072012e-308', '2.2250738585072014e-308']) {
    assert.equal(accept(raw), true, raw);
    assert.equal(integer(read(raw)), scaled(Number(raw)), raw);
  }
  for (const raw of ['1.7976931348623158e308', aboveMax, `-${aboveMax}`, '1e309',
    '-1e309', '1e10000', '1e-324', '-1e-324', '2.4703282292062327e-324', '1e-10000']) {
    assert.equal(accept(raw), false, raw);
    assert.equal(N.read(raw).$, 'None', raw);
    assert.equal(N.format(raw), '', raw);
  }
  assert.equal(integer(read('7.410984687618698e-324')), 1n);
  assert.equal(integer(read('7.410984687618699e-324')), 2n);
});

test('binary64 ties round to even in both directions', () => {
  const midpoint = '1.00000000000000011102230246251565404236316680908203125';
  const above = '1.000000000000000111022302462515654042363166809082031251';
  const nextMidpoint = '1.00000000000000033306690738754696212708950042724609375';
  for (const [raw, expected] of [
    [midpoint, 1], [above, 1.0000000000000002], [nextMidpoint, 1.0000000000000004],
    [`-${midpoint}`, -1], [`-${above}`, -1.0000000000000002],
    ['9007199254740993', 9007199254740992], ['9007199254740995', 9007199254740996],
  ]) {
    assert.equal(integer(read(raw)), scaled(expected), raw);
    assert.equal(N.format(raw), String(expected), raw);
  }
});

test('signed exact operations preserve cancellation, carries and products', () => {
  assert.equal(integer(N.zero()), 0n);
  assert.equal(N.zero().negative, false);
  const values = ['0', '-0', '1', '-1', '0.1', '-180', '5e-324', '-5e-324',
    '3.23786e-319', '2147483647', '1.7976931348623157e308'];
  for (const a of values) for (const b of values) {
    const x = scaled(Number(a)), y = scaled(Number(b));
    assert.equal(integer(N.add(read(a), read(b))), x + y, `${a} + ${b}`);
    assert.equal(integer(N.sub(read(a), read(b))), x - y, `${a} - ${b}`);
    assert.equal(integer(N.mul(read(a), read(b))), x * y, `${a} * ${b}`);
    assert.equal(N.cmp(read(a), read(b)).$, x < y ? 'LT' : x > y ? 'GT' : 'EQ', `${a} cmp ${b}`);
    assert.equal(N.equal(read(a), read(b)), x === y, `${a} == ${b}`);
  }
  for (const raw of ['-0', '-0.0', '-0e-10000']) {
    assert.equal(read(raw).negative, true);
    assert.equal(N.is_zero(read(raw)), true);
    assert.equal(N.equal(read(raw), N.zero()), true);
    assert.equal(N.format(raw), '0');
  }
  assert.equal(N.is_zero(N.mul(read('5e-324'), read('5e-324'))), false);
});

test('Bend geometry determinants retain subnormal area and near-collinear signs', () => {
  for (const [coordinates, expected] of [
    [['0', '0', '5e-324', '0', '0', '5e-324'], 1n],
    [['0', '0', '0', '5e-324', '5e-324', '0'], -1n],
    [['0', '0', '1', '0', '0', '5e-324'], 1n << 1074n],
    [['0', '0', '1', '1', '2', '2.0000000000000004'], 1n << 2097n],
    [['0', '0', '1', '1', '2', '2'], 0n],
    [['1', '1', '2', '2', '3', '3'], 0n],
  ]) assert.equal(integer(unwrap(G.orientation(...coordinates), coordinates.join(','))), expected);
  assert.equal(G.orientation('0', '0', '1e-324', '0', '0', '1').$, 'None');
  const step = N.sub(read('180'), read('-5e-324'));
  assert.equal(N.cmp(step, read('180')).$, 'GT');
});

test('shortest ECMAScript spelling for ties, subnormals and exponent thresholds', () => {
  for (const [raw, expected] of [
    ['100.000', '100'], ['1e21', '1e+21'], ['-1e21', '-1e+21'],
    ['1e20', '100000000000000000000'], ['1e-6', '0.000001'], ['1e-7', '1e-7'],
    ['0.0000010000000000000002', '0.0000010000000000000002'],
    ['0.0000009999999999999999', '0.000001'],
    ['1000000000000000128', '1000000000000000100'],
    ['5e-324', '5e-324'], ['7e-324', '5e-324'], ['1e-323', '1e-323'],
    ['2.2250738585072014e-308', '2.2250738585072014e-308'],
    ['1.7976931348623157e308', '1.7976931348623157e+308'],
    ['9.9999999999999999', '10'], ['0e10000', '0'], ['-0e-10000', '0'],
    ['0.29999999999999999', '0.3'], ['1.2345678901234567', '1.2345678901234567'],
  ]) assert.equal(N.format(raw), expected, raw);
  for (const raw of ['', 'NaN', '01', '1e-10000']) assert.equal(N.format(raw), '', raw);
});

test('generated reads and formatting agree with Node across binary64 exponents', () => {
  const view = new DataView(new ArrayBuffer(8));
  for (const exponent of [-1074, -1073, -1022, -1021, -1, 0, 1, 52, 53, 69, 70, 100, 1023]) {
    view.setFloat64(0, 2 ** exponent);
    const center = view.getBigUint64(0);
    for (const bits of [center - 1n, center, center + 1n]) {
      view.setBigUint64(0, bits);
      const value = view.getFloat64(0);
      const raw = value.toPrecision(100);
      assert.equal(integer(read(raw)), scaled(value), raw);
      assert.equal(N.format(raw), String(value), raw);
    }
  }
  let seed = 0x47a91c3d;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let index = 0; index < 256; index++) {
    const exponent = index === 0 ? 0 : index === 1 ? 1 : next() % 2047;
    const bits = (BigInt(next() & 1) << 63n) | (BigInt(exponent) << 52n) |
      (BigInt(next() & 0xfffff) << 32n) | BigInt(next());
    view.setBigUint64(0, bits);
    const value = view.getFloat64(0);
    const raw = index % 2 === 0 ? value.toPrecision(100) : value.toPrecision(17);
    assert.equal(integer(read(raw)), scaled(value), raw);
    const canonical = N.format(raw);
    assert.equal(canonical, String(value), raw);
    assert.equal(integer(read(canonical)), scaled(value), canonical);
  }
});
