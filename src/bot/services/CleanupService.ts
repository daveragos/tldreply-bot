import { Bot } from 'grammy';
import { Database } from '../../db/database';
import { EncryptionService } from '../../utils/encryption';
import { getGeminiService } from '../../services/geminiPool';
import { logger } from '../../utils/logger';
import { MyContext } from '../commands/BaseCommand';
import { config } from '../../config';

export class CleanupService {
  private bot: Bot<MyContext>;
  private db: Database;
  private encryption: EncryptionService;

  constructor(bot: Bot<MyContext>, db: Database, encryption: EncryptionService) {
    this.bot = bot;
    this.db = db;
    this.encryption = encryption;
  }

  async checkAndCleanupOrphanedGroups(): Promise<void> {
    try {
      // Get all configured groups
      const result = await this.db.query(
        'SELECT telegram_chat_id FROM groups WHERE gemini_api_key_encrypted IS NOT NULL',
        []
      );

      const groups = result.rows;
      let cleanedCount = 0;

      // Get bot info once for all groups
      const botInfo = await this.bot.api.getMe();

      for (const group of groups) {
        try {
          // Try to get chat info - this will fail if bot is not in the group
          await this.bot.api.getChat(group.telegram_chat_id);

          // If we get here, bot is still in the group - verify by trying to get chat member
          try {
            const botMember = await this.bot.api.getChatMember(group.telegram_chat_id, botInfo.id);

            // If bot is left or kicked, cleanup
            if (botMember.status === 'left' || botMember.status === 'kicked') {
              await this.db.deleteGroup(group.telegram_chat_id);
              cleanedCount++;
              logger.info(`Cleaned up orphaned group ${group.telegram_chat_id} (bot not in group)`);
            }
          } catch (memberError: any) {
            // If we can't get member status (403 or 400), bot is likely not in group
            if (memberError.error_code === 400 || memberError.error_code === 403) {
              await this.db.deleteGroup(group.telegram_chat_id);
              cleanedCount++;
              logger.info(
                `Cleaned up orphaned group ${group.telegram_chat_id} (cannot verify membership)`
              );
            }
          }
        } catch (error: any) {
          // If getChat fails, bot is likely not in the group anymore
          if (error.error_code === 400 || error.error_code === 403) {
            await this.db.deleteGroup(group.telegram_chat_id);
            cleanedCount++;
            logger.info(`Cleaned up orphaned group ${group.telegram_chat_id} (bot not in group)`);
          }
        }
      }

      if (cleanedCount > 0) {
        logger.info(`✅ Group cleanup complete: ${cleanedCount} orphaned group(s) removed`);
      }
    } catch (error) {
      logger.error('Error in checkAndCleanupOrphanedGroups:', error);
      throw error;
    }
  }

  /**
   * Summarizes messages past the retention window, stores the summary, then
   * deletes the raw rows.
   *
   * Processes one chat at a time: the previous implementation loaded every
   * stale row across every group into memory before doing anything, which is
   * the one query guaranteed to grow without bound.
   */
  async summarizeAndCleanupOldMessages(): Promise<void> {
    try {
      const retentionHours = await this.effectiveRetentionHours();
      const chatIds = await this.db.messages.getChatIdsWithMessagesOlderThan(retentionHours);

      if (chatIds.length === 0) {
        logger.info('No messages to cleanup');
        return;
      }

      let totalSummarized = 0;

      for (const chatId of chatIds) {
        try {
          const archived = await this.archiveChatMessages(chatId, retentionHours);
          if (archived) totalSummarized++;
        } catch (error) {
          logger.error(`Error summarizing messages for group ${chatId}:`, error);
          // Continue with other groups even if one fails
        }
      }

      // Delete regardless of whether summarization succeeded - retention is a
      // promise to users, not something conditional on the AI call working.
      const deleted = await this.db.cleanupOldMessages(retentionHours, config.cleanupBatchSize);

      if (deleted > 0) {
        await this.db.vacuumMessages().catch(error => {
          logger.warn('VACUUM after cleanup failed (non-fatal)', { error: String(error) });
        });
      }

      logger.info(
        `✅ Cleanup complete: ${totalSummarized} groups summarized, ${deleted} messages deleted`
      );

      await this.reportDatabaseUsage();
    } catch (error) {
      logger.error('Error in summarizeAndCleanupOldMessages:', error);
      throw error;
    }
  }

  /**
   * Summarizes and stores one chat's stale messages.
   * @returns true if a summary was written
   */
  private async archiveChatMessages(chatId: number, retentionHours: number): Promise<boolean> {
    const group = await this.db.getGroup(chatId);

    if (!group || !group.gemini_api_key_encrypted) {
      // Group not configured or no API key, messages are deleted without archiving
      logger.info(`Group ${chatId} not configured, skipping summarization`);
      return false;
    }

    const settings = await this.db.getGroupSettings(chatId);
    const messages = await this.db.messages.getMessagesToCleanupForChat(chatId, retentionHours);

    const validMessages = messages.filter(
      msg =>
        msg.content &&
        msg.content.trim().length > 0 &&
        !(settings.exclude_bot_messages && msg.is_bot) &&
        !(settings.exclude_commands && msg.content.startsWith('/'))
    );

    if (validMessages.length === 0) {
      logger.info(`Group ${chatId} has no valid messages to summarize`);
      return false;
    }

    const timestamps = validMessages
      .map(m => new Date(m.timestamp))
      .sort((a, b) => a.getTime() - b.getTime());
    const periodStart = timestamps[0];
    const periodEnd = timestamps[timestamps.length - 1];

    const formattedMessages = validMessages.map(msg => ({
      username: msg.username,
      firstName: msg.first_name,
      content: msg.content,
      timestamp: msg.timestamp,
      isBot: msg.is_bot,
      isChannel: msg.is_channel,
      messageId: msg.message_id,
    }));

    const gemini = getGeminiService(chatId, group.gemini_api_key_encrypted, this.encryption);
    const summaryText = await gemini.summarizeMessages(formattedMessages, {
      summaryStyle: settings.summary_style,
      customPrompt: settings.custom_prompt,
      chatId,
      chatUsername: group.username ?? undefined,
    });

    await this.db.insertSummary({
      chatId,
      summaryText,
      messageCount: validMessages.length,
      periodStart,
      periodEnd,
    });

    logger.info(`Summarized ${validMessages.length} messages for group ${chatId}`);
    return true;
  }

  /**
   * The retention window to apply right now.
   *
   * Normally the configured value. If the database is over the pressure
   * threshold, the window is halved so a nearly-full instance sheds data
   * faster instead of hitting the hard cap and refusing writes.
   */
  private async effectiveRetentionHours(): Promise<number> {
    const configured = config.messageRetentionHours;

    try {
      const bytes = await this.db.getDatabaseSizeBytes();
      const usedMb = bytes / (1024 * 1024);
      const threshold = config.databaseSoftLimitMb * config.databasePressureRatio;

      if (usedMb >= threshold) {
        const reduced = Math.max(1, Math.floor(configured / 2));
        logger.warn(
          `⚠️ Database at ${usedMb.toFixed(0)} MB of ${config.databaseSoftLimitMb} MB - ` +
            `reducing retention from ${configured}h to ${reduced}h for this run`
        );
        return reduced;
      }
    } catch (error) {
      logger.warn('Could not read database size, using configured retention', {
        error: String(error),
      });
    }

    return configured;
  }

  /** Logs current database usage so the trend is visible without a dashboard. */
  private async reportDatabaseUsage(): Promise<void> {
    try {
      const bytes = await this.db.getDatabaseSizeBytes();
      const usedMb = bytes / (1024 * 1024);
      const pct = (usedMb / config.databaseSoftLimitMb) * 100;

      const line = `💾 Database: ${usedMb.toFixed(1)} MB of ${config.databaseSoftLimitMb} MB (${pct.toFixed(0)}%)`;
      if (pct >= config.databasePressureRatio * 100) {
        logger.warn(line);
      } else {
        logger.info(line);
      }
    } catch {
      // Size reporting is diagnostic only
    }
  }
}
