import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateNewSecret, isPlaceholderSecret, generateSecret } from './db_rekey';

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
