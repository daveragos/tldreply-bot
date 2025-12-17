import { Bot, GrammyError, HttpError, Context } from 'grammy';
import { conversations, createConversation, ConversationFlavor } from '@grammyjs/conversations';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import { CommandRegistry } from './CommandRegistry';
import { setupApiKey, updateApiKey, excludeUsers } from './conversations';
import { setServices, clearExpiredState } from '../services/services';
import { logger } from '../utils/logger';
import { CleanupService } from './services/CleanupService';
import { SchedulerService } from './services/SchedulerService';

type MyContext = ConversationFlavor<Context>;

export class TLDRBot {
  private bot: Bot<MyContext>;
  private db: Database;
  private encryption: EncryptionService;
  private cleanupService: CleanupService;
  private schedulerService: SchedulerService;

  private cleanupInterval: NodeJS.Timeout | null = null;
  private summaryCleanupInterval: NodeJS.Timeout | null = null;
  private scheduledSummaryInterval: NodeJS.Timeout | null = null;
  private groupCleanupInterval: NodeJS.Timeout | null = null;

  constructor(telegramToken: string, db: Database, encryption: EncryptionService) {
    this.db = db;
    this.encryption = encryption;

    // Set global services for conversations
    setServices(db, encryption);

    this.bot = new Bot<MyContext>(telegramToken);

    // Add conversations plugin
    this.bot.use(conversations());

    // Register conversations
    this.bot.use(createConversation(setupApiKey));
    this.bot.use(createConversation(updateApiKey));
    this.bot.use(createConversation(excludeUsers));

    // Register Commands
    const registry = new CommandRegistry(this.bot, this.db, this.encryption);
    registry.registerAll();

    // Initialize services
    this.cleanupService = new CleanupService(this.bot, this.db, this.encryption);
    this.schedulerService = new SchedulerService(this.bot, this.db, this.encryption);

    // Handle bot removal from groups
    this.bot.on('my_chat_member', async ctx => {
      try {
        const update = ctx.update.my_chat_member;
        const chat = update.chat;
        const newStatus = update.new_chat_member.status;

        // Check if bot was removed or left
        if (newStatus === 'left' || newStatus === 'kicked') {
          // Only cleanup if it's a group (not private chat)
          if (chat.type === 'group' || chat.type === 'supergroup') {
            const deleted = await this.db.deleteGroup(chat.id);
            if (deleted) {
              logger.info(`Bot removed from group ${chat.id}, cleaned up database entry`);
            }
          }
        }
      } catch (error) {
        logger.error('Error handling bot removal:', error);
      }
    });

    // Error handling
    this.bot.catch(err => {
      const ctx = err.ctx;
      logger.error(`Error while handling update ${ctx.update.update_id}:`);
      const e = err.error;
      if (e instanceof GrammyError) {
        logger.error('Error in request:', e.description);
      } else if (e instanceof HttpError) {
        logger.error('Could not contact Telegram:', e);
      } else {
        logger.error('Unknown error:', e);
      }
    });

    // Start message
    logger.info('🤖 TLDR Bot initialized');
  }

  async start() {
    await this.bot.start();
    logger.info('✅ Bot is running!');

    // Run cleanup every 12 hours (summarize and delete messages older than 48 hours)
    this.cleanupInterval = setInterval(
      async () => {
        try {
          await this.cleanupService.summarizeAndCleanupOldMessages();
        } catch (error) {
          logger.error('Error during message cleanup:', error);
        }
      },
      12 * 60 * 60 * 1000
    );

    // Run summary cleanup every 24 hours (delete summaries older than 2 weeks)
    this.summaryCleanupInterval = setInterval(
      async () => {
        try {
          await this.db.cleanupOldSummaries(14); // 14 days = 2 weeks
        } catch (error) {
          logger.error('Error during summary cleanup:', error);
        }
      },
      24 * 60 * 60 * 1000
    );

    // Check for scheduled summaries every hour
    this.scheduledSummaryInterval = setInterval(
      async () => {
        try {
          await this.schedulerService.checkAndRunScheduledSummaries();
        } catch (error) {
          logger.error('Error checking scheduled summaries:', error);
        }
      },
      60 * 60 * 1000
    ); // Check every hour

    // Run initial check after 5 minutes
    setTimeout(
      async () => {
        try {
          await this.schedulerService.checkAndRunScheduledSummaries();
        } catch (error) {
          logger.error('Error in initial scheduled summary check:', error);
        }
      },
      5 * 60 * 1000
    );

    // Periodic job to check if bot is still in groups (every 24 hours)
    this.groupCleanupInterval = setInterval(
      async () => {
        try {
          await this.cleanupService.checkAndCleanupOrphanedGroups();
        } catch (error) {
          logger.error('Error during group cleanup check:', error);
        }
      },
      24 * 60 * 60 * 1000
    );

    // Run initial check after 10 minutes
    setTimeout(
      async () => {
        try {
          await this.cleanupService.checkAndCleanupOrphanedGroups();
        } catch (error) {
          logger.error('Error in initial group cleanup check:', error);
        }
      },
      10 * 60 * 1000
    );

    // Periodic cleanup of expired update state (every hour)
    setInterval(
      () => {
        clearExpiredState();
      },
      60 * 60 * 1000
    );
  }

  async stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.summaryCleanupInterval) {
      clearInterval(this.summaryCleanupInterval);
    }
    if (this.scheduledSummaryInterval) {
      clearInterval(this.scheduledSummaryInterval);
    }
    if (this.groupCleanupInterval) {
      clearInterval(this.groupCleanupInterval);
    }
    await this.bot.stop();
    logger.info('⏹️ Bot stopped');
  }

  getBot(): Bot<MyContext> {
    return this.bot;
  }
}
