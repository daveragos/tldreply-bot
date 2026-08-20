import { Bot, GrammyError, HttpError, Context } from 'grammy';
import { conversations, createConversation, ConversationFlavor } from '@grammyjs/conversations';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import { CommandRegistry } from './CommandRegistry';
import {
  setupApiKey,
  updateApiKey,
  excludeUsers,
  setCustomPrompt,
  setScheduleTimezone,
} from './conversations';
import { setServices, clearExpiredState } from '../services/services';
import { logger } from '../utils/logger';
import { CleanupService } from './services/CleanupService';
import { SchedulerService } from './services/SchedulerService';
import { config } from '../config';
import { clearGeminiPool } from '../services/geminiPool';

type MyContext = ConversationFlavor<Context>;

/** How often to summarize-and-purge messages past the retention window. */
const CLEANUP_INTERVAL_HOURS = 6;

export class TLDRBot {
  private bot: Bot<MyContext>;
  private db: Database;
  private encryption: EncryptionService;
  private cleanupService: CleanupService;
  private schedulerService: SchedulerService;

  private timers: NodeJS.Timeout[] = [];
  private pollingPromise: Promise<void> | null = null;
  private stopping = false;
  private maintenanceHeartbeat: NodeJS.Timeout | null = null;

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
    this.bot.use(createConversation(setCustomPrompt));
    this.bot.use(createConversation(setScheduleTimezone));

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

  async start(): Promise<void> {
    if (config.maintenanceMode) {
      logger.warn('🔧 MAINTENANCE_MODE is on: not polling, no background jobs.');
      logger.warn('   The bot will not respond to any command until it is unset.');

      // Keep the event loop alive so the platform sees a healthy long-running
      // process rather than a container that exited.
      this.maintenanceHeartbeat = setInterval(
        () => logger.info('🔧 Idle in maintenance mode'),
        15 * 60 * 1000
      );
      return;
    }

    logger.info('🔄 Starting bot connection...');

    // Background jobs are registered BEFORE polling starts. `bot.start()` runs the
    // long-polling loop and its promise only settles once the bot stops, so anything
    // sequenced after an `await` on it would never execute while the bot is alive.
    this.startBackgroundJobs();

    return new Promise<void>((resolve, reject) => {
      let started = false;

      this.pollingPromise = this.bot.start({
        onStart: info => {
          started = true;
          logger.info(`✅ Bot is running as @${info.username}`);
          resolve();
        },
      });

      this.pollingPromise.then(
        () => {
          // Resolves when polling stops. Expected during shutdown, fatal otherwise.
          if (!this.stopping) {
            logger.error('❌ Long polling stopped unexpectedly');
            this.stopBackgroundJobs();
          }
        },
        error => {
          logger.error('❌ Long polling failed:', error);
          this.stopBackgroundJobs();
          if (started) {
            // Already reported success to the caller; nothing left to reject.
            // Exit so the process manager restarts us.
            process.exit(1);
          } else {
            reject(error);
          }
        }
      );
    });
  }

  /**
   * Registers every recurring maintenance job. Safe to call once per start().
   */
  private startBackgroundJobs(): void {
    const HOUR = 60 * 60 * 1000;

    // Summarize and delete messages past the retention window.
    this.every(CLEANUP_INTERVAL_HOURS * HOUR, 'message cleanup', () =>
      this.cleanupService.summarizeAndCleanupOldMessages()
    );

    // Delete stored summaries older than the summary retention window.
    this.every(24 * HOUR, 'summary cleanup', () =>
      this.db.cleanupOldSummaries(config.summaryRetentionDays)
    );

    // Fire due scheduled summaries.
    this.every(HOUR, 'scheduled summaries', () =>
      this.schedulerService.checkAndRunScheduledSummaries()
    );

    // Drop groups the bot is no longer a member of.
    this.every(24 * HOUR, 'orphaned group cleanup', () =>
      this.cleanupService.checkAndCleanupOrphanedGroups()
    );

    // Expire abandoned /update_api_key state.
    this.every(HOUR, 'update-state sweep', async () => clearExpiredState());

    // Staggered first runs so startup is not competing with itself.
    this.after(2 * 60 * 1000, 'initial message cleanup', () =>
      this.cleanupService.summarizeAndCleanupOldMessages()
    );
    this.after(5 * 60 * 1000, 'initial scheduled summary check', () =>
      this.schedulerService.checkAndRunScheduledSummaries()
    );
    this.after(10 * 60 * 1000, 'initial group cleanup', () =>
      this.cleanupService.checkAndCleanupOrphanedGroups()
    );

    logger.info(`🕒 ${this.timers.length} background jobs registered`);
  }

  private stopBackgroundJobs(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers = [];
  }

  /** Runs `task` on an interval, never letting a rejection escape. */
  private every(ms: number, label: string, task: () => Promise<unknown>): void {
    this.timers.push(
      setInterval(() => {
        void task().catch(error => logger.error(`Error during ${label}:`, error));
      }, ms)
    );
  }

  /** Runs `task` once after a delay, never letting a rejection escape. */
  private after(ms: number, label: string, task: () => Promise<unknown>): void {
    this.timers.push(
      setTimeout(() => {
        void task().catch(error => logger.error(`Error during ${label}:`, error));
      }, ms)
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.maintenanceHeartbeat) {
      clearInterval(this.maintenanceHeartbeat);
      this.maintenanceHeartbeat = null;
    }

    this.stopBackgroundJobs();
    clearGeminiPool();

    // Nothing to stop if polling never started.
    if (!config.maintenanceMode) {
      await this.bot.stop();
    }

    // Let in-flight middleware finish before the caller closes the database.
    if (this.pollingPromise) {
      await this.pollingPromise.catch(() => undefined);
    }

    logger.info('⏹️ Bot stopped');
  }

  getBot(): Bot<MyContext> {
    return this.bot;
  }
}
