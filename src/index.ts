import dotenv from 'dotenv';
import { Database } from './db/database';
import { EncryptionService } from './utils/encryption';
import { TLDRBot } from './bot/bot';
import { logger } from './utils/logger';
import { HealthServer } from './utils/healthServer';

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

  // Only binds when PORT is set, which is how a platform signals it expects
  // an HTTP service rather than a background worker.
  const health = new HealthServer(db);
  health.start();

  // Register shutdown handlers before starting: bot.start() does not return until
  // the bot stops, so anything registered after it would never be installed.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`📴 Received ${signal}, shutting down...`);
    try {
      await bot.stop();
      await health.stop();
      await db.close();
      logger.info('👋 Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Start bot
  try {
    logger.info('🔄 Attempting to start bot...');
    await bot.start();
    logger.info('✅ Bot started successfully!');
  } catch (error) {
    logger.error('❌ Failed to start bot:', error);
    if (error instanceof Error) {
      logger.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      // Check for common error types
      if (error.message.includes('Unauthorized') || error.message.includes('401')) {
        logger.error(
          '💡 This usually means the TELEGRAM_TOKEN is invalid or revoked. Please check your bot token.'
        );
      } else if (error.message.includes('network') || error.message.includes('ECONNREFUSED')) {
        logger.error(
          '💡 Network error: Unable to connect to Telegram API. Check your internet connection.'
        );
      }
    }
    throw error; // Re-throw to exit with error code
  }
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
