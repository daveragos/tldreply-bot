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

async function purge(db: Database, retentionHours: number, compact: boolean): Promise<void> {
  const before = await db.getDatabaseSizeBytes();
  const stale = await db.messages.countMessagesOlderThan(retentionHours);

  if (stale === 0) {
    console.log(`\nNothing past the ${retentionHours}h window. Database at ${mb(before)}.\n`);
    return;
  }

  console.log(`\nDeleting ${stale.toLocaleString()} messages older than ${retentionHours}h...`);
  console.log('These are NOT summarized first - run the bot for that. This is a raw purge.\n');

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

void main();
