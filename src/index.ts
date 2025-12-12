import dotenv from 'dotenv';
import { Database } from './db/database';
import { EncryptionService } from './utils/encryption';
import { TLDRBot } from './bot/bot';

// Load environment variables
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const DATABASE_URL = process.env.DATABASE_URL!;
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET!;

if (!process.env.TELEGRAM_TOKEN || !process.env.DATABASE_URL || !process.env.ENCRYPTION_SECRET) {
  console.error('❌ Missing required environment variables!');
  console.error('Required: TELEGRAM_TOKEN, DATABASE_URL, ENCRYPTION_SECRET');
  process.exit(1);
}

async function main() {
  console.log('🚀 Starting TLDR Bot...');

  // Initialize database
  const db = new Database(DATABASE_URL);
  const connectionTest = await db.testConnection();
  if (!connectionTest) {
    console.error('❌ Database connection failed!');
    process.exit(1);
  }
  console.log('✅ Database connected');

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
  console.error('Fatal error:', error);
  process.exit(1);
});
