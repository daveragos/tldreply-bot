import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateNewSecret,
  isPlaceholderSecret,
  generateSecret,
  parseStoredKeys,
} from './db_rekey';

const CURRENT = 'the-current-secret-value-32-chars-long';

describe('rekey secret validation', () => {
  test('accepts a strong new secret', () => {
    assert.equal(validateNewSecret(generateSecret(), CURRENT), null);
  });

  test('rejects a short secret', () => {
    assert.match(String(validateNewSecret('too-short', CURRENT)), /at least 32/);
  });

  test('rejects reusing the current secret', () => {
    assert.match(String(validateNewSecret(CURRENT, CURRENT)), /identical/);
  });

  test('rejects the example placeholders', () => {
    const placeholder = 'your_random_secret_here_min_32_chars';
    assert.match(String(validateNewSecret(placeholder, CURRENT)), /placeholder/);
  });

  test('recognises every shipped placeholder', () => {
    assert.ok(isPlaceholderSecret('your_random_secret_here_min_32_chars'));
    assert.ok(isPlaceholderSecret('your_random_secret_key_min_32_characters'));
    assert.ok(isPlaceholderSecret('  your_random_secret_here_min_32_chars  '));
    assert.equal(isPlaceholderSecret(generateSecret()), false);
  });

  test('generates a 64-character hex secret', () => {
    assert.match(generateSecret(), /^[0-9a-f]{64}$/);
  });
});

describe('parseStoredKeys', () => {
  test('reads the multi-key array format', () => {
    const r = parseStoredKeys(JSON.stringify(['test-key-one', 'test-key-two']));
    assert.deepEqual(r.keys, ['test-key-one', 'test-key-two']);
    assert.equal(r.wasBareString, false);
  });

  // Regression: records predating multi-key support store a bare key string.
  // Requiring JSON rejected them even though they decrypted correctly.
  test('reads a bare key string', () => {
    const r = parseStoredKeys('test-key-bare-string-000001');
    assert.deepEqual(r.keys, ['test-key-bare-string-000001']);
    assert.equal(r.wasBareString, true);
  });

  test('reads the newer AQ. key format as a bare string', () => {
    const r = parseStoredKeys('AQ.' + 'x'.repeat(48));
    assert.equal(r.keys.length, 1);
    assert.equal(r.wasBareString, true);
  });

  test('trims surrounding whitespace on a bare string', () => {
    assert.deepEqual(parseStoredKeys('  test-key-padded  ').keys, ['test-key-padded']);
  });

  test('reads a JSON-quoted single string', () => {
    const r = parseStoredKeys('"test-key-quoted"');
    assert.deepEqual(r.keys, ['test-key-quoted']);
    assert.equal(r.wasBareString, true);
  });

  test('drops empty entries from an array', () => {
    assert.deepEqual(parseStoredKeys(JSON.stringify(['test-key-ok', '', null])).keys, ['test-key-ok']);
  });

  test('reports an empty result for blank input', () => {
    assert.deepEqual(parseStoredKeys('   ').keys, []);
    assert.deepEqual(parseStoredKeys('[]').keys, []);
  });
});
