import { Bot, GrammyError, HttpError, Context } from 'grammy';
import { conversations, createConversation, ConversationFlavor } from '@grammyjs/conversations';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import { Commands } from './commands';
import { setupApiKey } from './conversations';

type MyContext = ConversationFlavor<Context>;

export class TLDRBot {
  private bot: Bot<MyContext>;
  private db: Database;
  private encryption: EncryptionService;

  constructor(telegramToken: string, db: Database, encryption: EncryptionService) {
    this.db = db;
    this.encryption = encryption;
    
    this.bot = new Bot<MyContext>(telegramToken);
    
    // Initialize commands (pass db and encryption to conversation context)
    this.bot.use(async (ctx, next) => {
      // Store db and encryption in context for conversations
      (ctx as any).db = this.db;
      (ctx as any).encryption = this.encryption;
      await next();
    });
    
    // Add conversations plugin
    this.bot.use(conversations());
    
    // Register conversation
    this.bot.use(createConversation(setupApiKey));

    new Commands(this.bot, this.db, this.encryption);

    // Error handling
    this.bot.catch((err) => {
      const ctx = err.ctx;
      console.error(`Error while handling update ${ctx.update.update_id}:`);
      const e = err.error;
      if (e instanceof GrammyError) {
        console.error('Error in request:', e.description);
      } else if (e instanceof HttpError) {
        console.error('Could not contact Telegram:', e);
      } else {
        console.error('Unknown error:', e);
      }
    });

    // Start message
    console.log('🤖 TLDR Bot initialized');
  }

  async start() {
    await this.bot.start();
    console.log('✅ Bot is running!');
  }

  async stop() {
    await this.bot.stop();
    console.log('⏹️ Bot stopped');
  }

  getBot(): Bot<MyContext> {
    return this.bot;
  }
}
