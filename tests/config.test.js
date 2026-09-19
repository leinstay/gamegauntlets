import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, applyEnv, deepMerge, need, env } from '../src/config.js';

test('parseEnv: basic KEY=VALUE pairs', () => {
  const result = parseEnv('FOO=bar\nBAZ=qux');
  assert.deepEqual(result, { FOO: 'bar', BAZ: 'qux' });
});

test('parseEnv: blank lines and full-line comments are ignored', () => {
  const result = parseEnv([
    '# a comment',
    '',
    '  # indented comment',
    'FOO=bar',
    '',
  ].join('\n'));
  assert.deepEqual(result, { FOO: 'bar' });
});

test('parseEnv: inline comments after an unquoted value are stripped', () => {
  const result = parseEnv('FOO=bar # trailing comment');
  assert.equal(result.FOO, 'bar');
});

test('parseEnv: double-quoted values support \\n and \\" escapes', () => {
  const result = parseEnv('FOO="line1\\nline2 says \\"hi\\""');
  assert.equal(result.FOO, 'line1\nline2 says "hi"');
});

test('parseEnv: single-quoted values are taken literally (no escapes, no comment stripping)', () => {
  const result = parseEnv("FOO='literal # not a comment \\n stays as text'");
  assert.equal(result.FOO, 'literal # not a comment \\n stays as text');
});

test('parseEnv: only the first = splits key from value', () => {
  const result = parseEnv('SECRET=abc=def=ghi');
  assert.equal(result.SECRET, 'abc=def=ghi');
});

test('parseEnv: whitespace around key and value is trimmed', () => {
  const result = parseEnv('  FOO   =   bar  ');
  assert.equal(result.FOO, 'bar');
});

test('parseEnv: lines without = or with an invalid key are ignored', () => {
  const result = parseEnv('not a line\n1INVALID=x\nFOO=bar');
  assert.deepEqual(result, { FOO: 'bar' });
});

test('applyEnv: does not override keys already present on the target', () => {
  const target = { FOO: 'already-set' };
  applyEnv({ FOO: 'from-file', BAR: 'from-file' }, target);
  assert.deepEqual(target, { FOO: 'already-set', BAR: 'from-file' });
});

test('deepMerge: merges nested plain objects key by key', () => {
  const base = { a: { x: 1, y: 2 }, b: 1 };
  const override = { a: { y: 20, z: 3 } };
  assert.deepEqual(deepMerge(base, override), { a: { x: 1, y: 20, z: 3 }, b: 1 });
});

test('deepMerge: arrays and scalars in override fully replace the base value', () => {
  const base = { list: [1, 2, 3], n: 1 };
  const override = { list: [9], n: 2 };
  assert.deepEqual(deepMerge(base, override), { list: [9], n: 2 });
});

test('deepMerge: an undefined override key leaves the base value untouched', () => {
  const base = { a: 1, b: 2 };
  const override = { a: undefined };
  assert.deepEqual(deepMerge(base, override), { a: 1, b: 2 });
});

test('need: returns the value when set', () => {
  env.GG_TEST_NEED_OK = 'value';
  assert.equal(need('GG_TEST_NEED_OK'), 'value');
  delete env.GG_TEST_NEED_OK;
});

test('need: throws an Error whose message is exactly the key name when unset', () => {
  assert.throws(() => need('GG_TEST_NEED_MISSING'), (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'GG_TEST_NEED_MISSING');
    return true;
  });
});

test('need: throws when the value is an empty string', () => {
  env.GG_TEST_NEED_EMPTY = '';
  assert.throws(() => need('GG_TEST_NEED_EMPTY'), (err) => {
    assert.equal(err.message, 'GG_TEST_NEED_EMPTY');
    return true;
  });
  delete env.GG_TEST_NEED_EMPTY;
});
