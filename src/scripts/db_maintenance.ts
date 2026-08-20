/**
 * Database maintenance CLI.
 *
 *   npm run db:stats            show size breakdown and what cleanup would remove
 *   npm run db:purge            delete messages past the retention window
 *   npm run db:purge -- --hours 24    purge with an explicit window
 *   npm run db:purge -- --compact     also VACUUM FULL to return disk to the OS
 *
 * Written for a free-tier instance where the hard size cap is a real ceiling.
 *
 * Note on reclaiming space: a plain DELETE marks rows dead but does not shrink
 * the file. VACUUM returns that space for reuse by the same table (stopping
 * growth); only VACUUM FULL returns it to the filesystem, and it needs an
 * exclusive lock plus temporary room for a full table rewrite.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Database } from '../db/database';
import { config } from '../config';
import { logger } from '../utils/logger';

dotenv.config();

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function showStats(db: Database, retentionHours: number): Promise<void> {
  const totalBytes = await db.getDatabaseSizeBytes();
  const limitBytes = config.databaseSoftLimitMb * 1024 * 1024;
  const pct = (totalBytes / limitBytes) * 100;

  console.log('\nDatabase');
  console.log('─'.repeat(58));
  console.log(
    `  Total ${mb(totalBytes).padStart(10)} of ${config.databaseSoftLimitMb} MB  (${pct.toFixed(1)}%)`
  );

  const tables = await db.getTableSizes();
  if (tables.length > 0) {
    console.log('\nTables');
    console.log('─'.repeat(58));
    for (const t of tables) {
      console.log(
        `  ${t.table.padEnd(20)} ${mb(t.bytes).padStart(10)}  ~${t.rows.toLocaleString()} rows`
      );
    }
  }

  const stale = await db.messages.countMessagesOlderThan(retentionHours);
  const totalMessages = await db.query('SELECT COUNT(*)::int AS count FROM messages', []);

  console.log('\nMessage cache');
  console.log('─'.repeat(58));
  console.log(`  Retention window     ${retentionHours}h`);
  console.log(`  Total messages       ${(totalMessages.rows[0]?.count ?? 0).toLocaleString()}`);
  console.log(`  Past retention       ${stale.toLocaleString()}  ← removable now`);
  console.log('');
}

/**
 * Looks for an export that covers everything the purge would delete.
 *
 * Deleting raw messages is irreversible, so a purge refuses to run unless a
 * backup manifest proves the data exists somewhere else first.
 *
 * @returns a reason to refuse, or null when a covering backup was found
 */
export function findCoveringBackup(outDir: string, retentionHours: number): string | null {
  if (!fs.existsSync(outDir)) {
    return `no backup directory at ${outDir}`;
  }

  const manifests = fs
    .readdirSync(outDir)
    .filter(f => f.endsWith('.manifest.json'))
    .map(f => {
      try {
        return { file: f, data: JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter((m): m is { file: string; data: any } => m !== null)
    .sort((a, b) => String(b.data.createdAt).localeCompare(String(a.data.createdAt)));

  if (manifests.length === 0) {
    return `no backup manifests found in ${outDir}`;
  }

  const latest = manifests[0];
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
  const newestBackedUp = latest.data.newestMessage ? new Date(latest.data.newestMessage) : null;

  if (!newestBackedUp) {
    return `${latest.file} does not record which messages it covers`;
  }

  // The backup must reach at least as far forward as the deletion cutoff.
  if (newestBackedUp < cutoff) {
    return (
      `the newest backup (${latest.file}) only covers up to ` +
      `${newestBackedUp.toISOString().slice(0, 16)} UTC, but the purge deletes everything ` +
      `before ${cutoff.toISOString().slice(0, 16)} UTC`
    );
  }

  console.log(`  Backup found: ${latest.file}`);
  console.log(
    `    ${Number(latest.data.messageCount).toLocaleString()} messages, ` +
      `covers up to ${newestBackedUp.toISOString().slice(0, 16)} UTC`
  );
  return null;
}

async function purge(db: Database, retentionHours: number, compact: boolean): Promise<void> {
  const before = await db.getDatabaseSizeBytes();
  const stale = await db.messages.countMessagesOlderThan(retentionHours);

  if (stale === 0) {
    console.log(`\nNothing past the ${retentionHours}h window. Database at ${mb(before)}.\n`);
    return;
  }

  console.log(
    `\nAbout to delete ${stale.toLocaleString()} messages older than ${retentionHours}h.`
  );
  console.log('This is a raw purge - messages are NOT summarized first.\n');

  // A purge is irreversible, so require proof the data exists elsewhere.
  if (hasFlag('skip-backup-check')) {
    console.log('  ! Skipping the backup check (--skip-backup-check).\n');
  } else {
    const problem = findCoveringBackup(
      path.resolve(arg('backup-dir') ?? './backups'),
      retentionHours
    );
    if (problem) {
      console.error(`\n  Refusing to purge: ${problem}.\n`);
      console.error('  Export the messages first:');
      console.error(`    npm run db:export -- --older-than ${retentionHours}`);
      console.error('    npm run db:verify -- backups/<file>\n');
      console.error('  Or pass --skip-backup-check to delete without a backup.\n');
      process.exit(1);
    }
    console.log('');
  }

  const deleted = await db.cleanupOldMessages(retentionHours, config.cleanupBatchSize);
  console.log(`  Deleted ${deleted.toLocaleString()} rows`);

  if (compact) {
    console.log('  Running VACUUM FULL (exclusive lock, this may take a while)...');
    const client = await db.getClient();
    try {
      await client.query('VACUUM FULL messages');
      await client.query('ANALYZE messages');
    } finally {
      client.release();
    }
  } else {
    console.log('  Running VACUUM...');
    await db.vacuumMessages();
  }

  const after = await db.getDatabaseSizeBytes();
  console.log(`\n  Before ${mb(before)}  →  after ${mb(after)}`);

  if (!compact && after >= before * 0.95) {
    console.log('\n  Size barely moved: plain VACUUM frees space for reuse but does not');
    console.log('  return it to disk. Re-run with --compact to actually shrink the file.');
  }
  console.log('');
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Check your .env file.');
    process.exit(1);
  }

  const command = process.argv[2] ?? 'stats';
  const retentionHours = Number.parseInt(arg('hours') ?? '', 10) || config.messageRetentionHours;

  const db = new Database(process.env.DATABASE_URL);

  try {
    if (!(await db.testConnection())) {
      console.error('Could not connect to the database.');
      process.exit(1);
    }

    switch (command) {
      case 'stats':
        await showStats(db, retentionHours);
        break;
      case 'purge':
        await purge(db, retentionHours, hasFlag('compact'));
        await showStats(db, retentionHours);
        break;
      default:
        console.error(`Unknown command "${command}". Use "stats" or "purge".`);
        process.exit(1);
    }
  } catch (error) {
    logger.error('Maintenance failed:', error);
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
