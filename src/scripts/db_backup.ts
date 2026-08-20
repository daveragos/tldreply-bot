/**
 * Raw message export and restore.
 *
 *   npm run db:export                      export every cached message
 *   npm run db:export -- --older-than 48   export only what cleanup would delete
 *   npm run db:export -- --out ~/backups   choose the destination directory
 *   npm run db:export -- --no-gzip         write plain JSONL instead
 *
 *   npm run db:verify -- <file>            check a backup reads cleanly
 *   npm run db:restore -- <file>           re-insert messages from a backup
 *   npm run db:restore -- <file> --dry-run count what would be inserted
 *
 * Format is newline-delimited JSON, gzipped by default. One message per line,
 * so a truncated file still yields every complete line before the break, and
 * the whole thing streams without ever being held in memory.
 *
 * Run this from your own machine against DATABASE_URL, not from the host: a
 * managed platform's filesystem is usually ephemeral, so a backup written
 * there disappears on the next deploy.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Database } from '../db/database';
import { logger } from '../utils/logger';

dotenv.config();

interface Manifest {
  createdAt: string;
  file: string;
  messageCount: number;
  chatIds: number[];
  oldestMessage: string | null;
  newestMessage: string | null;
  olderThanHours: number | null;
  sha256: string;
  bytes: number;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Opens a backup for reading, transparently handling gzip.
 *
 * A truncated or corrupt archive surfaces as a stream error, which would
 * otherwise reach the process as an unhandled exception and print a stack
 * trace. Translated here into a message that says what to do about it.
 */
function openBackup(filePath: string): NodeJS.ReadableStream {
  const file = fs.createReadStream(filePath);

  file.on('error', error => {
    console.error(`\n  ✗ Could not read ${filePath}: ${(error as Error).message}\n`);
    process.exit(1);
  });

  if (!filePath.endsWith('.gz')) return file;

  const gunzip = zlib.createGunzip();
  gunzip.on('error', () => {
    console.error('\n  ✗ This archive is corrupt or truncated — it cannot be fully read.');
    console.error('    If it was copied or downloaded, the transfer was probably incomplete.');
    console.error('    Do NOT purge based on this file; take a fresh export.\n');
    process.exit(1);
  });

  return file.pipe(gunzip);
}

async function exportMessages(db: Database): Promise<void> {
  const outDir = path.resolve(arg('out') ?? './backups');
  const gzip = !hasFlag('no-gzip');
  const olderThanRaw = arg('older-than');
  const olderThanHours = olderThanRaw ? Number.parseInt(olderThanRaw, 10) : undefined;

  if (olderThanRaw && Number.isNaN(olderThanHours)) {
    console.error('--older-than expects a number of hours.');
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const total = await db.messages.countMessages(olderThanHours);
  if (total === 0) {
    console.log('\nNothing to export.\n');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `messages-${stamp}.jsonl${gzip ? '.gz' : ''}`;
  const filePath = path.join(outDir, base);

  console.log(`\nExporting ${total.toLocaleString()} messages`);
  if (olderThanHours !== undefined) {
    console.log(`  Filter: older than ${olderThanHours}h`);
  }
  console.log(`  To: ${filePath}\n`);

  const sink = fs.createWriteStream(filePath);
  const out = gzip ? zlib.createGzip({ level: 9 }) : null;
  if (out) out.pipe(sink);
  const target = out ?? sink;

  // A single persistent error handler. Attaching one per write() call leaks
  // listeners across millions of rows and trips MaxListenersExceededWarning.
  let streamError: Error | null = null;
  const captureError = (error: Error) => {
    streamError = error;
  };
  target.on('error', captureError);
  sink.on('error', captureError);

  /** Applies backpressure, so a slow disk cannot balloon memory. */
  const write = (line: string): Promise<void> => {
    if (streamError) return Promise.reject(streamError);

    // A true return means the buffer accepted it; only wait when it is full.
    if (target.write(line)) return Promise.resolve();

    return new Promise<void>(resolve => {
      const onDrain = () => {
        target.off('drain', onDrain);
        resolve();
      };
      target.once('drain', onDrain);
    });
  };

  const chatIds = new Set<number>();
  let written = 0;
  let oldest: string | null = null;
  let newest: string | null = null;

  for await (const batch of db.messages.streamMessages(olderThanHours)) {
    for (const row of batch) {
      const ts = new Date(row.timestamp).toISOString();
      if (oldest === null || ts < oldest) oldest = ts;
      if (newest === null || ts > newest) newest = ts;
      chatIds.add(Number(row.telegram_chat_id));

      await write(
        JSON.stringify({
          telegram_chat_id: String(row.telegram_chat_id),
          message_id: String(row.message_id),
          user_id: row.user_id === null ? null : String(row.user_id),
          username: row.username,
          first_name: row.first_name,
          content: row.content,
          is_bot: row.is_bot,
          is_channel: row.is_channel,
          timestamp: ts,
        }) + '\n'
      );
      written++;
    }

    process.stdout.write(`\r  ${written.toLocaleString()} / ${total.toLocaleString()}`);
  }

  await new Promise<void>((resolve, reject) => {
    sink.on('finish', resolve);
    sink.on('error', reject);
    target.end();
  });

  if (streamError) {
    console.error(`\n  \u2717 Export failed while writing: ${(streamError as Error).message}\n`);
    process.exit(1);
  }

  process.stdout.write('\n');

  const bytes = fs.statSync(filePath).size;
  const manifest: Manifest = {
    createdAt: new Date().toISOString(),
    file: base,
    messageCount: written,
    chatIds: [...chatIds],
    oldestMessage: oldest,
    newestMessage: newest,
    olderThanHours: olderThanHours ?? null,
    sha256: await sha256File(filePath),
    bytes,
  };

  const manifestPath = filePath.replace(/\.jsonl(\.gz)?$/, '.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n  Wrote ${written.toLocaleString()} messages (${human(bytes)})`);
  console.log(`  Groups: ${chatIds.size}`);
  console.log(`  Covers: ${oldest?.slice(0, 16)} to ${newest?.slice(0, 16)} UTC`);
  console.log(`  Manifest: ${path.basename(manifestPath)}`);
  console.log(`  SHA-256: ${manifest.sha256.slice(0, 16)}...`);
  console.log('\n  Verify it before deleting anything:');
  console.log(`    npm run db:verify -- ${filePath}\n`);
}

/**
 * Reads a backup end to end without touching the database.
 *
 * An unverified backup is not a backup - this is what makes it safe to purge.
 */
async function verifyBackup(): Promise<void> {
  const filePath = process.argv[3];
  if (!filePath || filePath.startsWith('--')) {
    console.error('Usage: npm run db:verify -- <file>');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`No such file: ${filePath}`);
    process.exit(1);
  }

  console.log(`\nVerifying ${filePath}\n`);

  const manifestPath = filePath.replace(/\.jsonl(\.gz)?$/, '.manifest.json');
  let manifest: Manifest | null = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } else {
    console.log('  ! No manifest alongside this file; checking contents only.');
  }

  if (manifest) {
    const actual = await sha256File(filePath);
    if (actual === manifest.sha256) {
      console.log('  ✓ Checksum matches the manifest');
    } else {
      console.error('  ✗ CHECKSUM MISMATCH — this file has changed since export');
      console.error(`      expected ${manifest.sha256}`);
      console.error(`      actual   ${actual}`);
      process.exit(1);
    }
  }

  const rl = readline.createInterface({ input: openBackup(filePath), crlfDelay: Infinity });

  let lines = 0;
  let bad = 0;
  const chatIds = new Set<string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    try {
      const row = JSON.parse(line);
      if (!row.telegram_chat_id || !row.message_id) throw new Error('missing keys');
      chatIds.add(String(row.telegram_chat_id));
    } catch {
      bad++;
      if (bad <= 3) console.error(`  ✗ Unreadable line ${lines}`);
    }
  }

  console.log(`  ✓ ${lines.toLocaleString()} readable messages across ${chatIds.size} groups`);

  if (bad > 0) {
    console.error(`  ✗ ${bad} unreadable line(s)`);
    process.exit(1);
  }

  if (manifest && lines !== manifest.messageCount) {
    console.error(`  ✗ Expected ${manifest.messageCount} messages, found ${lines}`);
    process.exit(1);
  }

  console.log('\n  Backup is valid. Safe to purge.\n');
}

async function restoreBackup(db: Database | null): Promise<void> {
  const filePath = process.argv[3];
  if (!filePath || filePath.startsWith('--')) {
    console.error('Usage: npm run db:restore -- <file> [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`No such file: ${filePath}`);
    process.exit(1);
  }

  const dryRun = hasFlag('dry-run');

  console.log(`\n${dryRun ? 'Dry run: reading' : 'Restoring from'} ${filePath}\n`);

  if (!dryRun) {
    console.log('  Groups must still exist in the groups table (foreign key).');
    console.log('  Existing messages are left untouched; only gaps are filled.\n');
  }

  const rl = readline.createInterface({ input: openBackup(filePath), crlfDelay: Infinity });

  let read = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    read++;

    try {
      const row = JSON.parse(line);
      if (dryRun || !db) continue;

      if (await db.messages.restoreMessage(row)) inserted++;
      else skipped++;
    } catch (error) {
      failed++;
      if (failed <= 3) {
        console.error(`  ! Line ${read}: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (read % 1000 === 0) process.stdout.write(`\r  ${read.toLocaleString()} processed`);
  }

  process.stdout.write('\n');
  console.log(`\n  Read     ${read.toLocaleString()}`);

  if (!dryRun) {
    console.log(`  Inserted ${inserted.toLocaleString()}`);
    console.log(`  Skipped  ${skipped.toLocaleString()} (already present)`);
    if (failed > 0) {
      console.log(`  Failed   ${failed.toLocaleString()}`);
      console.log('\n  Failures are usually a missing group row (foreign key).');
    }
  }
  console.log('');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'export';

  // Verification and dry runs only read the file; neither needs a database.
  if (command === 'verify') {
    await verifyBackup();
    return;
  }
  if (command === 'restore' && hasFlag('dry-run')) {
    await restoreBackup(null);
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Check your .env file.');
    process.exit(1);
  }

  const db = new Database(process.env.DATABASE_URL);

  try {
    if (!(await db.testConnection())) {
      console.error('Could not connect to the database.');
      process.exit(1);
    }

    switch (command) {
      case 'export':
        await exportMessages(db);
        break;
      case 'restore':
        await restoreBackup(db);
        break;
      default:
        console.error(`Unknown command "${command}". Use export, verify or restore.`);
        process.exit(1);
    }
  } catch (error) {
    logger.error('Backup operation failed:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Only run when invoked directly, so tests can import from this file without
// the CLI executing (and exiting) on import.
if (require.main === module) {
  void main();
}
