import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const bend = process.env.BEND ?? '/tmp/atlas-bend2-toolchain/bin/bend';
const temporary = mkdtempSync(resolve(tmpdir(), 'atlas-json-test-'));
const run = (program, args) => execFileSync(program, args, {
  cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
});

try {
  for (const file of ['../common.bend', '../json.bend', './json.bend']) {
    const output = run(bend, [resolve(directory, file), '--check-only']);
    assert.match(output, /ALL PROOFS CHECK/);
    assert.doesNotMatch(output, /SOME PROOFS FAIL/);
  }
  const generated = resolve(temporary, 'json.mjs');
  run(bend, [resolve(directory, '../json.bend'), '-o', generated]);
  const { default: J } = await import(pathToFileURL(generated).href);
  const list = values => values.reduceRight((tail, head) => ({ $: 'Con', head, tail }), { $: 'Nil' });
  const array = values => {
    const result = [];
    for (let xs = values; xs.$ !== 'Nil'; xs = xs.tail) {
      assert.equal(xs.$, 'Con');
      result.push(xs.head);
    }
    return result;
  };
  const budget = (lower = {}) => ({
    $: 'Budget', max_bytes: 1048576, max_values: 65536, max_depth: 32,
    max_changes: 1000, max_geometry_work: 4194304, ...lower,
  });
  const bytes = source => list([...new TextEncoder().encode(source)]);
  const resultCode = result => result.$ === 'Done' ? 'ok' : J['common:code_name'](result.error.code);
  const value = result => {
    assert.equal(resultCode(result), 'ok');
    return result.value;
  };
  const parse = (source, lower) => J.parse(bytes(source), budget(lower));
  const check = (source, lower) => J.check(bytes(source), budget(lower));
  const encode = (input, lower) => J.encode(input, budget(lower));
  const text = result => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(array(value(result))));
  const toJson = input => {
    if (input === null) return { $: 'JNull' };
    if (typeof input === 'boolean') return { $: 'JBool', value: input };
    if (typeof input === 'number') return { $: 'JNum', raw: String(input) };
    if (typeof input === 'string') return { $: 'JStr', value: input };
    if (Array.isArray(input)) return { $: 'JArr', items: list(input.map(toJson)) };
    return { $: 'JObj', members: list(Object.entries(input).map(([key, member]) => ({ $: 'Member', key, value: toJson(member) }))) };
  };
  const observed = input => {
    switch (input.$) {
      case 'JNull': return null;
      case 'JBool': case 'JStr': return input.value;
      case 'JNum': return Number(input.raw);
      case 'JArr': return array(input.items).map(observed);
      case 'JObj': return Object.fromEntries(array(input.members).map(member => [member.key, observed(member.value)]));
      default: assert.fail(`unexpected JSON constructor ${input.$}`);
    }
  };
  let checks = 0;
  const test = (name, fn) => {
    try { fn(); checks++; }
    catch (error) { throw new Error(name, { cause: error }); }
  };

  for (const source of ['null', 'true', 'false', '0', '-0', '0.1', '-0.00E+0002', '1e10000', '1e-10000',
    '1e+000010000', '[]', '{}', ' [ 1, true, null, {"b":[]} ]\r\n', '"\\/\\b\\f\\n\\r\\t\\\\\\\""',
    '"\\u0000\\u001f"', '"\\uD83D\\uDE00"', '"😀€é"', '{"__proto__":0,"constructor":1}',
    '{"a":1,"b":{"a":2}}', '"\u2028\u2029"', '1'.repeat(128)]) {
    test(`accept ${source}`, () => {
      assert.equal(resultCode(check(source)), 'ok');
      assert.equal(resultCode(parse(source)), 'ok');
    });
  }
  for (const source of ['', ' ', 'nul', 'Null', 'undefined', 'NaN', 'Infinity', '+1', '.1', '-.1', '01', '-01',
    '1.', '1e', '1e+', '1e-', '--1', '1+1', '0x10', '1_0', 'true false', '[]x', '[', '{', '[,]', '[1,]',
    '{"a":1,}', '{"a" 1}', '{"a":}', '{a:1}', '{"a":1 "b":2}', '/*x*/0', '//x\n0', '"\\x00"',
    '"\\q"', '"\\u000g"', '"\\ud800"', '"\\udc00"', '"\\ud800\\ud800"', '"\\ud800x"',
    '"\\ud800\\u0000"', '"unterminated', '"\\"', '\v0', '\f0', '\u00a00', '\ufeff0']) {
    test(`reject ${JSON.stringify(source)}`, () => {
      assert.equal(resultCode(check(source)), 'invalid_json');
      assert.equal(resultCode(parse(source)), 'invalid_json');
    });
  }
  for (let scalar = 0; scalar < 32; scalar++) {
    test(`raw control ${scalar}`, () => assert.equal(resultCode(check(`"${String.fromCharCode(scalar)}"`)), 'invalid_json'));
  }
  for (const source of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"":1,"\\u0000":2,"":3}',
    '{"😀":0,"\\ud83d\\ude00":1}', '{"/":1,"\\/":2}', '{"\\n":1,"\\u000a":2}']) {
    test(`duplicate ${source}`, () => assert.equal(resultCode(parse(source)), 'invalid_json'));
  }
  for (const source of ['1'.repeat(129), '1e10001', '1e-10001', '1e99999999', '1e' + '0'.repeat(127)]) {
    test(`number limit ${source}`, () => assert.equal(resultCode(check(source)), 'invalid_value'));
  }
  for (const raw of [[128], [192, 175], [193, 191], [224, 128, 128], [237, 160, 128], [240, 128, 128, 128],
    [244, 144, 128, 128], [245, 128, 128, 128], [255], [226], [226, 130], [240, 159, 152], [226, 40, 161], [256]]) {
    test(`UTF8 ${raw}`, () => {
      assert.equal(resultCode(J.check(list([34, ...raw, 34]), budget())), 'invalid_utf8');
      assert.equal(resultCode(J.parse(list([34, ...raw, 34]), budget())), 'invalid_utf8');
    });
  }
  for (const scalar of [0, 31, 32, 127, 128, 2047, 2048, 55295, 57344, 65535, 65536, 1114111]) {
    test(`scalar boundary ${scalar}`, () => {
      const input = String.fromCodePoint(scalar);
      assert.equal(text(encode(toJson(input))), JSON.stringify(input));
      assert.equal(value(parse(JSON.stringify(input))).value, input);
    });
  }
  for (const source of ['0', '-0', '1.00', '18446744073709551615', '1.7976931348623157e308', '1e-10000']) {
    test(`retain numeric spelling ${source}`, () => {
      assert.deepEqual(value(parse(source)), { $: 'JNum', raw: source });
      assert.equal(text(encode(value(parse(source)))), source);
    });
  }
  test('byte limit precedes invalid UTF8', () => assert.equal(resultCode(J.check(list([255]), budget({ max_bytes: 0 }))), 'payload_too_large'));
  test('invalid UTF8 precedes invalid JSON', () => assert.equal(resultCode(J.check(list([120, 255]), budget())), 'invalid_utf8'));
  test('check performs no domain work', () => assert.equal(resultCode(check('{"type":"Polygon","coordinates":[[],[]],"changes":[1,2]}', { max_changes: 0, max_geometry_work: 0 })), 'ok'));
  test('parse performs no domain work', () => assert.equal(resultCode(parse('{"changes":[0],"type":"LineString","coordinates":[]}', { max_changes: 0, max_geometry_work: 0 })), 'ok'));
  test('names excluded from count', () => assert.equal(resultCode(check('{"a":0}', { max_values: 2 })), 'ok'));
  test('root included in count', () => assert.equal(resultCode(check('[0]', { max_values: 1 })), 'resource_limit'));
  test('zero values', () => assert.equal(resultCode(check('0', { max_values: 0 })), 'resource_limit'));
  test('zero depth', () => assert.equal(resultCode(check('0', { max_depth: 0 })), 'resource_limit'));
  test('empty zero budget', () => assert.equal(resultCode(check('', { max_bytes: 0, max_values: 0, max_depth: 0 })), 'invalid_json'));
  test('depth exactly 32', () => assert.equal(resultCode(parse('['.repeat(31) + '0' + ']'.repeat(31))), 'ok'));
  test('depth above 32', () => assert.equal(resultCode(parse('['.repeat(32) + '0' + ']'.repeat(32))), 'resource_limit'));
  test('fuel covers many container transitions', () => assert.equal(resultCode(parse('[' + Array(5000).fill('{}').join(',') + ']')), 'ok'));

  for (const input of [{ $: 'JMissing' }, { $: 'JNum', raw: '' }, { $: 'JNum', raw: '01' },
    { $: 'JNum', raw: '1e10001' }, { $: 'JNum', raw: '1'.repeat(129) },
    { $: 'JObj', members: list([{ $: 'Member', key: 'a', value: toJson(0) }, { $: 'Member', key: 'a', value: toJson(1) }]) },
    { $: 'JArr', items: list([{ $: 'JMissing' }]) },
    { $: 'JStr', value: '\ud800' }, { $: 'JStr', value: '\udc00' },
    { $: 'JObj', members: list([{ $: 'Member', key: '\ud800', value: toJson(0) }]) }]) {
    test(`writer rejects ${JSON.stringify(input)}`, () => assert.equal(resultCode(encode(input)), 'invalid_value'));
  }
  test('encode depth', () => assert.equal(resultCode(encode(value(parse('[[0]]')), { max_depth: 2 })), 'resource_limit'));
  test('encode values', () => assert.equal(resultCode(encode(toJson([0]), { max_values: 1 })), 'resource_limit'));
  test('encode exact escaped byte count', () => assert.equal(text(encode(toJson('\u0000'), { max_bytes: 8 })), '"\\u0000"'));
  test('encode over escaped byte count', () => assert.equal(resultCode(encode(toJson('\u0000'), { max_bytes: 7 })), 'payload_too_large'));
  test('compact writer', () => assert.equal(text(encode(toJson({ a: [0, true, null], b: {} }))), '{"a":[0,true,null],"b":{}}'));
  test('null and missing differ', () => assert.equal(J['common:equal']({ $: 'JNull' }, { $: 'JMissing' }), false));
  test('object equality ignores member order', () => assert.equal(J['common:equal'](toJson({ a: [0], b: true }), toJson({ b: true, a: [0] })), true));
  test('equality keeps number spelling', () => assert.equal(J['common:equal']({ $: 'JNum', raw: '1' }, { $: 'JNum', raw: '1.0' }), false));
  test('object inequality', () => assert.equal(J['common:equal'](toJson({ a: 1 }), toJson({ b: 1 })), false));
  test('get missing', () => assert.equal(J['common:get'](toJson({ a: null }), 'b').$, 'JMissing'));
  test('get null', () => assert.equal(J['common:get'](toJson({ a: null }), 'a').$, 'JNull'));
  test('has null', () => assert.equal(J['common:has'](toJson({ a: null }), 'a'), true));
  test('has absent', () => assert.equal(J['common:has'](toJson({ a: null }), 'b'), false));
  test('trusted string helper', () => assert.equal(J['common:string'](toJson('x')), 'x'));
  test('non-string helper', () => assert.equal(J['common:string'](toJson(1)), ''));
  test('array helper', () => assert.equal(array(J['common:items'](toJson([0]))).length, 1));
  test('object helper', () => assert.equal(array(J['common:members'](toJson({ a: 0 }))).length, 1));
  for (const [boundary, maxBytes, maxValues] of [['http_request', 1048576, 65536], ['http_response', 4194304, 262144],
    ['wss_data', 4194304, 262144], ['wss_control', 16384, 4096]]) {
    test(`default ${boundary}`, () => assert.deepEqual(J['common:default_budget'](boundary), budget({ max_bytes: maxBytes, max_values: maxValues })));
  }

  let seed = 0x1a71a5;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const strings = ['', 'a', '\u0000\n\t\\"/', 'é€😀', '__proto__', '\u2028\u2029'];
  const generate = depth => {
    switch (random(depth ? 6 : 4)) {
      case 0: return null;
      case 1: return random(2) === 0;
      case 2: return random(20001) - 10000;
      case 3: return strings[random(strings.length)];
      case 4: return Array.from({ length: random(5) }, () => generate(depth - 1));
      default: return Object.fromEntries(Array.from({ length: random(5) }, (_, index) => [strings[random(strings.length)] + index, generate(depth - 1)]));
    }
  };
  for (let i = 0; i < 500; i++) {
    test(`independent roundtrip ${i}`, () => {
      const original = generate(4);
      const source = JSON.stringify(original);
      const parsed = value(parse(source));
      assert.deepEqual(observed(parsed), JSON.parse(source));
      assert.equal(text(encode(parsed)), source);
      assert.equal(text(encode(toJson(original))), source);
    });
  }
  const grammarSeeds = ['null', 'true', 'false', '0', '-0', '123.4e-5', '"text"', '"\\u0061"', '"\\\\\\\""', '[null,true,0,"x"]', '[[[]],{}]'];
  const alphabet = '0123456789eE+-.nultrfas[]{}:,"\\ abcxyz\t\n';
  for (let i = 0; i < 2500; i++) {
    test(`mutated JSON grammar ${i}`, () => {
      const original = grammarSeeds[random(grammarSeeds.length)];
      const offset = random(original.length + 1);
      const candidate = original.slice(0, offset) + alphabet[random(alphabet.length)] + original.slice(offset + random(2));
      let expected = 'ok';
      try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed === 'string' && !parsed.isWellFormed()) expected = 'invalid_json';
      } catch { expected = 'invalid_json'; }
      assert.equal(resultCode(check(candidate)), expected, candidate);
      assert.equal(resultCode(parse(candidate)), expected, candidate);
    });
  }
  console.log(`generated Bend module passed ${checks} behavior checks`);
  const native = resolve(temporary, 'json-native');
  run(bend, [resolve(directory, 'json.bend'), '-o', native]);
  const nativeOutput = run(native, []);
  assert.match(nativeOutput, /native JSON checks passed/);
  process.stdout.write(nativeOutput);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
