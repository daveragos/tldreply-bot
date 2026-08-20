import crypto from 'crypto';

/**
 * Encrypts API keys at rest.
 *
 * Records are written as AES-256-GCM, which authenticates the ciphertext:
 * tampering is detected on decrypt rather than silently producing garbage.
 * Each record carries its own random salt, so two groups with the same key
 * do not share a derived encryption key.
 *
 * Format (all hex, colon-separated):
 *
 *   v2:<salt>:<iv>:<authTag>:<ciphertext>     current
 *   <iv>:<ciphertext>                          legacy AES-256-CBC
 *
 * The legacy format is still readable so existing rows keep working. Anything
 * re-saved is written as v2, so the database migrates as keys are updated.
 */

const ALGORITHM = 'aes-256-gcm';
const LEGACY_ALGORITHM = 'aes-256-cbc';
const LEGACY_SALT = 'tldr-salt';

const KEY_LENGTH = 32;
const IV_LENGTH = 12; // GCM standard nonce length
const LEGACY_IV_LENGTH = 16;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

const VERSION_PREFIX = 'v2';

export class EncryptionService {
  private secretKey: string;
  /** Legacy key, derived once from the fixed salt. */
  private legacyKey: Buffer;

  constructor(secretKey: string) {
    if (!secretKey || secretKey.length < 16) {
      throw new Error('ENCRYPTION_SECRET must be at least 16 characters');
    }

    this.secretKey = secretKey;
    this.legacyKey = crypto.pbkdf2Sync(
      secretKey,
      LEGACY_SALT,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      'sha256'
    );
  }

  private deriveKey(salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(this.secretKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
  }

  encrypt(text: string): string {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = this.deriveKey(salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      VERSION_PREFIX,
      salt.toString('hex'),
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');
  }

  decrypt(encryptedData: string): string {
    if (!encryptedData) {
      throw new Error('Invalid encrypted data format');
    }

    const parts = encryptedData.split(':');

    if (parts[0] === VERSION_PREFIX) {
      return this.decryptV2(parts);
    }

    if (parts.length === 2) {
      return this.decryptLegacy(parts);
    }

    throw new Error('Invalid encrypted data format');
  }

  private decryptV2(parts: string[]): string {
    if (parts.length !== 5) {
      throw new Error('Invalid encrypted data format');
    }

    const [, saltHex, ivHex, authTagHex, ciphertextHex] = parts;

    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH) {
      throw new Error('Invalid encrypted data format');
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Invalid encrypted data format');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, this.deriveKey(salt), iv);
    decipher.setAuthTag(authTag);

    // final() throws if the ciphertext was modified.
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Reads records written before authenticated encryption was introduced. */
  private decryptLegacy(parts: string[]): string {
    const iv = Buffer.from(parts[0], 'hex');
    if (iv.length !== LEGACY_IV_LENGTH) {
      throw new Error('Invalid encrypted data format');
    }

    const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, this.legacyKey, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /** True when a record still uses the legacy unauthenticated format. */
  static isLegacyFormat(encryptedData: string): boolean {
    return !encryptedData.startsWith(`${VERSION_PREFIX}:`) && encryptedData.split(':').length === 2;
  }
}
