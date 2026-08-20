import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { EncryptionService } from './encryption';

const SECRET = 'test-secret-at-least-32-characters-long';
const service = new EncryptionService(SECRET);

/** Builds a record in the pre-GCM format, to prove old rows still decrypt. */
function legacyEncrypt(secret: string, text: string): string {
  const key = crypto.pbkdf2Sync(secret, 'tldr-salt', 100000, 32, 'sha256');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

describe('EncryptionService', () => {
  test('round-trips a value', () => {
    const secret = 'test-key-round-trip-value-000001';
    assert.equal(service.decrypt(service.encrypt(secret)), secret);
  });

  test('round-trips the serialized multi-key format', () => {
    const keys = JSON.stringify([
      'test-key-first-000001',
      'AQ.SECOND_TEST_KEY_PADDED_00',
    ]);
    assert.equal(service.decrypt(service.encrypt(keys)), keys);
  });

  test('round-trips unicode', () => {
    const value = 'ገና በዓል — ключ — 鍵';
    assert.equal(service.decrypt(service.encrypt(value)), value);
  });

  test('produces different ciphertext each time', () => {
    const a = service.encrypt('same-value');
    const b = service.encrypt('same-value');
    assert.notEqual(a, b, 'random salt and IV should make records unique');
    assert.equal(service.decrypt(a), service.decrypt(b));
  });

  test('writes the versioned format', () => {
    assert.ok(service.encrypt('x').startsWith('v2:'));
  });

  test('detects tampering', () => {
    const encrypted = service.encrypt('sensitive-api-key');
    const parts = encrypted.split(':');

    // Flip the last byte of the ciphertext.
    const ciphertext = parts[4];
    const flipped = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === 'ff' ? '00' : 'ff');
    parts[4] = flipped;

    assert.throws(() => service.decrypt(parts.join(':')));
  });

  test('rejects a swapped auth tag', () => {
    const parts = service.encrypt('value-one').split(':');
    const other = service.encrypt('value-two').split(':');
    parts[3] = other[3];
    assert.throws(() => service.decrypt(parts.join(':')));
  });

  test('fails with the wrong secret', () => {
    const other = new EncryptionService('a-completely-different-secret-value');
    assert.throws(() => other.decrypt(service.encrypt('value')));
  });

  test('rejects malformed input', () => {
    assert.throws(() => service.decrypt(''));
    assert.throws(() => service.decrypt('not-encrypted'));
    assert.throws(() => service.decrypt('v2:only:three:parts'));
  });

  test('requires a non-trivial secret', () => {
    assert.throws(() => new EncryptionService('short'));
  });
});

describe('EncryptionService - legacy records', () => {
  test('still decrypts pre-GCM records', () => {
    const original = 'test-key-legacy-format-000001';
    assert.equal(service.decrypt(legacyEncrypt(SECRET, original)), original);
  });

  test('identifies the legacy format', () => {
    assert.ok(EncryptionService.isLegacyFormat(legacyEncrypt(SECRET, 'x')));
    assert.equal(EncryptionService.isLegacyFormat(service.encrypt('x')), false);
  });

  test('re-encrypting a legacy record upgrades it', () => {
    const legacy = legacyEncrypt(SECRET, 'my-key');
    const upgraded = service.encrypt(service.decrypt(legacy));

    assert.ok(upgraded.startsWith('v2:'));
    assert.equal(service.decrypt(upgraded), 'my-key');
  });
});
