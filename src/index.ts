import dotenv from 'dotenv';
import { Database } from './db/database';
import { EncryptionService } from './utils/encryption';
import { TLDRBot } from './bot/bot';
import { logger } from './utils/logger';

// Load environment variables
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const DATABASE_URL = process.env.DATABASE_URL!;
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET!;

if (!process.env.TELEGRAM_TOKEN || !process.env.DATABASE_URL || !process.env.ENCRYPTION_SECRET) {
  logger.error('❌ Missing required environment variables!');
  logger.error('Required: TELEGRAM_TOKEN, DATABASE_URL, ENCRYPTION_SECRET');
  process.exit(1);
}

// Global error handlers to prevent crash on unhandled errors
process.on('uncaughtException', error => {
  logger.error('🔥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('🔥 Unhandled Rejection', reason, { promise: String(promise) });
});

async function main() {
  logger.info('🚀 Starting TLDR Bot...');

  // Initialize database
  const db = new Database(DATABASE_URL);
  const connectionTest = await db.testConnection();
  if (!connectionTest) {
    logger.error('❌ Database connection failed!');
    process.exit(1);
  }
  logger.info('✅ Database connected');

  // Initialize encryption
  const encryption = new EncryptionService(ENCRYPTION_SECRET);

  // Initialize bot
  const bot = new TLDRBot(TELEGRAM_TOKEN, db, encryption);

  // Start bot
  await bot.start();

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
