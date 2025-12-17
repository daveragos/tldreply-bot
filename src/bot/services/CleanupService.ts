import { Bot } from 'grammy';
import { Database } from '../../db/database';
import { EncryptionService } from '../../utils/encryption';
import { GeminiService } from '../../services/gemini';
import { logger } from '../../utils/logger';
import { MyContext } from '../commands/BaseCommand';

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

  async summarizeAndCleanupOldMessages(): Promise<void> {
    try {
      // Get messages that are about to be deleted (48 hours old)
      const messagesToCleanup = await this.db.getMessagesToCleanup(48);

      if (messagesToCleanup.length === 0) {
        logger.info('No messages to cleanup');
        return;
      }

      // Group messages by chat ID
      const messagesByChat = new Map<number, any[]>();
      for (const msg of messagesToCleanup) {
        if (!messagesByChat.has(msg.telegram_chat_id)) {
          messagesByChat.set(msg.telegram_chat_id, []);
        }
        messagesByChat.get(msg.telegram_chat_id)!.push(msg);
      }

      // Summarize messages for each group before deletion
      let totalSummarized = 0;
      let totalDeleted = 0;

      for (const [chatId, messages] of messagesByChat.entries()) {
        try {
          // Get group info to access API key
          const group = await this.db.getGroup(chatId);

          if (!group || !group.gemini_api_key_encrypted) {
            // Group not configured or no API key, just delete messages
            logger.info(`Group ${chatId} not configured, skipping summarization`);
            continue;
          }

          // Skip if no valid messages (empty content)
          const validMessages = messages.filter(
            msg => msg.content && msg.content.trim().length > 0
          );
          if (validMessages.length === 0) {
            logger.info(`Group ${chatId} has no valid messages to summarize`);
            continue;
          }

          // Find the time range of messages
          const timestamps = validMessages
            .map(m => new Date(m.timestamp))
            .sort((a, b) => a.getTime() - b.getTime());
          const periodStart = timestamps[0];
          const periodEnd = timestamps[timestamps.length - 1];

          // Format messages for summarization
          const formattedMessages = validMessages.map(msg => ({
            username: msg.username,
            firstName: msg.first_name,
            content: msg.content,
            timestamp: msg.timestamp,
          }));

          // Generate summary
          const decryptedKey = this.encryption.decrypt(group.gemini_api_key_encrypted);
          const gemini = new GeminiService(decryptedKey);
          const summaryText = await gemini.summarizeMessages(formattedMessages);

          // Store summary
          await this.db.insertSummary({
            chatId,
            summaryText,
            messageCount: validMessages.length,
            periodStart,
            periodEnd,
          });

          // Ensure group settings exist
          await this.db.createGroupSettings(chatId);

          totalSummarized++;
          logger.info(`Summarized ${validMessages.length} messages for group ${chatId}`);
        } catch (error) {
          logger.error(`Error summarizing messages for group ${chatId}:`, error);
          // Continue with other groups even if one fails
        }
      }

      // Delete all old messages (regardless of whether summarization succeeded)
      await this.db.cleanupOldMessages(48);
      totalDeleted = messagesToCleanup.length;

      logger.info(
        `✅ Cleanup complete: ${totalSummarized} groups summarized, ${totalDeleted} messages deleted`
      );
    } catch (error) {
      logger.error('Error in summarizeAndCleanupOldMessages:', error);
      throw error;
    }
  }
}
