/**
 * Rotates ENCRYPTION_SECRET without losing stored API keys.
 *
 *   npm run db:rekey -- --new <secret> --dry-run   report what would change
 *   npm run db:rekey -- --new <secret>             re-encrypt in place
 *
 * The secret is only ever a key-derivation input; it is not stored. So changing
 * it makes every existing record undecryptable unless each one is decrypted
 * with the old secret and re-encrypted with the new one first. That is what
 * this does, in a single transaction.
 *
 * The current secret comes from ENCRYPTION_SECRET in the environment, so run
 * this BEFORE changing it anywhere.
 *
 * Every encrypted blob is written to a timestamped file before anything is
 * modified, so a failed rotation can be undone by restoring that file.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import { logger } from '../utils/logger';

dotenv.config();

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Placeholder values shipped in the example env files. */
const KNOWN_PLACEHOLDERS = [
  'your_random_secret_here_min_32_chars',
  'your_random_secret_key_min_32_characters',
  'your_encryption_secret_here',
];

export function isPlaceholderSecret(secret: string): boolean {
  return KNOWN_PLACEHOLDERS.includes(secret.trim());
}

/**
 * Rejects a new secret that would not actually improve anything.
 * @returns a reason to refuse, or null when acceptable
 */
export function validateNewSecret(next: string, current: string): string | null {
  if (next.length < 32) {
    return `it is ${next.length} characters; use at least 32 (openssl rand -hex 32)`;
  }
  if (next === current) {
    return 'it is identical to the current secret';
  }
  if (isPlaceholderSecret(next)) {
    return 'it is one of the example placeholder values';
  }
  return null;
}

/**
 * Reads a decrypted key blob in either storage format.
 *
 * Records written before multi-key support hold a bare "AIzaSy..." string
 * rather than a JSON array. GeminiService already accepts both, so requiring
 * JSON here would reject perfectly valid records that decrypted fine.
 */
export function parseStoredKeys(plaintext: string): { keys: string[]; wasBareString: boolean } {
  try {
    const parsed = JSON.parse(plaintext);

    if (Array.isArray(parsed)) {
      return {
        keys: parsed.filter(k => typeof k === 'string' && k.length > 0),
        wasBareString: false,
      };
    }

    // Valid JSON but not an array, e.g. a bare quoted string.
    if (typeof parsed === 'string' && parsed.length > 0) {
      return { keys: [parsed], wasBareString: true };
    }

    return { keys: [], wasBareString: false };
  } catch {
    // Not JSON at all: the original single-key format.
    const trimmed = plaintext.trim();
    return { keys: trimmed ? [trimmed] : [], wasBareString: true };
  }
}

/**
 * Reports how many stored keys the given secret can read.
 *
 * A mismatch between the secret here and the one the bot actually runs with
 * shows up as records that will not decrypt, which is otherwise only visible
 * as "Invalid API key" errors in the groups themselves.
 */
async function checkSecret(secret: string): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const crypto = new EncryptionService(secret);
  const db = new Database(process.env.DATABASE_URL);

  try {
    const groups = await db.query(
      `SELECT telegram_chat_id, gemini_api_key_encrypted, updated_at
       FROM groups WHERE gemini_api_key_encrypted IS NOT NULL
       ORDER BY updated_at DESC NULLS LAST`,
      []
    );

    let readable = 0;
    const unreadable: string[] = [];

    for (const row of groups.rows) {
      try {
        const keys = parseStoredKeys(crypto.decrypt(row.gemini_api_key_encrypted));
        if (keys.keys.length > 0) readable++;
        else unreadable.push(String(row.telegram_chat_id));
      } catch {
        unreadable.push(String(row.telegram_chat_id));
      }
    }

    console.log(`\n  Readable with this secret : ${readable} / ${groups.rows.length}`);

    if (unreadable.length > 0) {
      console.log(`  Unreadable                : ${unreadable.length}`);
      for (const id of unreadable.slice(0, 10)) console.log(`      ${id}`);
      console.log('\n  Those groups cannot use /tldr while the bot runs with this secret.');
      console.log('  Set ENCRYPTION_SECRET to the value the bot was running with when');
      console.log('  their keys were saved, then re-check.\n');
      process.exit(1);
    }

    console.log('  ✓ Every stored key is readable with this secret.\n');
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const currentSecret = process.env.ENCRYPTION_SECRET;
  const newSecret = arg('new');
  const dryRun = hasFlag('dry-run');

  if (!process.env.DATABASE_URL || !currentSecret) {
    console.error('DATABASE_URL and ENCRYPTION_SECRET must both be set. Check your .env file.');
    process.exit(1);
  }

  // --check answers "does this secret read the stored keys?" without changing
  // anything, so a candidate can be tested before committing to a rotation.
  if (hasFlag('check')) {
    await checkSecret(currentSecret);
    return;
  }

  if (!newSecret) {
    console.error('Usage: npm run db:rekey -- --new <secret> [--dry-run]');
    console.error('       npm run db:rekey -- --check      test the current secret');
    console.error('Generate one with: openssl rand -hex 32');
    process.exit(1);
  }

  const problem = validateNewSecret(newSecret, currentSecret);
  if (problem) {
    console.error(`\nRefusing to rekey: ${problem}.\n`);
    process.exit(1);
  }

  const oldCrypto = new EncryptionService(currentSecret);
  const newCrypto = new EncryptionService(newSecret);
  const db = new Database(process.env.DATABASE_URL);

  try {
    if (!(await db.testConnection())) {
      console.error('Could not connect to the database.');
      process.exit(1);
    }

    const groups = await db.query(
      `SELECT telegram_chat_id, gemini_api_key_encrypted
       FROM groups
       WHERE gemini_api_key_encrypted IS NOT NULL
       ORDER BY telegram_chat_id`,
      []
    );

    if (groups.rows.length === 0) {
      console.log('\nNo encrypted keys stored. Change ENCRYPTION_SECRET freely.\n');
      return;
    }

    console.log(`\nFound ${groups.rows.length} group(s) with stored keys.`);
    if (isPlaceholderSecret(currentSecret)) {
      console.log('Current secret is a known placeholder — rotating is overdue.\n');
    } else {
      console.log('');
    }

    // Snapshot before touching anything.
    if (!dryRun) {
      const backupDir = path.resolve('./backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupFile = path.join(backupDir, `keys-before-rekey-${stamp}.json`);

      fs.writeFileSync(
        backupFile,
        JSON.stringify(
          groups.rows.map((r: any) => ({
            telegram_chat_id: String(r.telegram_chat_id),
            gemini_api_key_encrypted: r.gemini_api_key_encrypted,
          })),
          null,
          2
        ),
        { mode: 0o600 }
      );
      console.log(`  Snapshot written: ${path.basename(backupFile)}\n`);
    }

    // Decrypt everything with the old secret first. If any record fails, stop
    // before writing: a partial rotation is worse than none.
    const rotated: Array<{ chatId: string; blob: string }> = [];
    let failed = 0;

    for (const row of groups.rows) {
      const chatId = String(row.telegram_chat_id);
      try {
        const plaintext = oldCrypto.decrypt(row.gemini_api_key_encrypted);
        const { keys, wasBareString } = parseStoredKeys(plaintext);

        if (keys.length === 0) {
          throw new Error('decrypted to an empty key list');
        }

        // Re-encrypt in the canonical array form. Records written before
        // multi-key support hold a bare key string; GeminiService accepts both,
        // so normalising here is safe and makes storage uniform.
        rotated.push({ chatId, blob: newCrypto.encrypt(JSON.stringify(keys)) });

        const notes: string[] = [];
        if (EncryptionService.isLegacyFormat(row.gemini_api_key_encrypted)) {
          notes.push('upgrading from legacy CBC');
        }
        if (wasBareString) {
          notes.push('normalising single-key format');
        }

        console.log(
          `  ✓ ${chatId}  ${keys.length} key(s)${notes.length ? `  [${notes.join(', ')}]` : ''}`
        );
      } catch (error) {
        failed++;
        console.error(
          `  ✗ ${chatId}  could not decrypt: ${error instanceof Error ? error.message : error}`
        );
      }
    }

    if (failed > 0) {
      console.error(
        `\n${failed} record(s) could not be decrypted with the current ENCRYPTION_SECRET.`
      );
      console.error('Nothing has been changed. Confirm ENCRYPTION_SECRET matches what');
      console.error('the bot was running with when those keys were saved.\n');
      process.exit(1);
    }

    if (dryRun) {
      console.log(`\nDry run: ${rotated.length} record(s) would be re-encrypted.`);
      console.log('Re-run without --dry-run to apply.\n');
      return;
    }

    // All-or-nothing: a half-rotated table would leave some groups broken.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (const { chatId, blob } of rotated) {
        await client.query(
          'UPDATE groups SET gemini_api_key_encrypted = $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_chat_id = $2',
          [blob, chatId]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log(`\n✅ Re-encrypted ${rotated.length} record(s).\n`);
    console.log('Now update ENCRYPTION_SECRET everywhere the bot runs:');
    console.log('  - your local .env');
    console.log('  - the EthioDeploy dashboard\n');
    console.log('The bot will NOT be able to read these keys until you do.\n');
  } catch (error) {
    logger.error('Rekey failed:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Only run when invoked directly, so tests can import from this file.
if (require.main === module) {
  void main();
}

/** Convenience for generating a secret: `openssl rand -hex 32` equivalent. */
export function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
