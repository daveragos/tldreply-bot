import { Bot } from 'grammy';
import { Database } from '../../db/database';
import { EncryptionService } from '../../utils/encryption';
import { GeminiService } from '../../services/gemini';
import { logger } from '../../utils/logger';
import { markdownToHtml } from '../../utils/formatter';
import { MyContext } from '../commands/BaseCommand';

export class SchedulerService {
  private bot: Bot<MyContext>;
  private db: Database;
  private encryption: EncryptionService;

  constructor(bot: Bot<MyContext>, db: Database, encryption: EncryptionService) {
    this.bot = bot;
    this.db = db;
    this.encryption = encryption;
  }

  async checkAndRunScheduledSummaries(): Promise<void> {
    try {
      const groupsWithSchedules = await this.db.getGroupsWithScheduledSummaries();
      const now = new Date();
      const currentHour = now.getUTCHours();
      const currentMinute = now.getUTCMinutes();
      const currentDay = now.getUTCDay(); // 0 = Sunday, 6 = Saturday

      for (const settings of groupsWithSchedules) {
        try {
          const group = await this.db.getGroup(settings.telegram_chat_id);
          if (!group || !group.gemini_api_key_encrypted || !group.enabled) {
            continue;
          }

          // Parse schedule time
          const [scheduleHour, scheduleMinute] = (settings.schedule_time || '09:00:00')
            .split(':')
            .map(Number);

          // Check if it's time to run
          const isTimeToRun =
            currentHour === scheduleHour &&
            currentMinute >= scheduleMinute &&
            currentMinute < scheduleMinute + 5;

          if (!isTimeToRun) continue;

          // Check frequency
          if (settings.schedule_frequency === 'weekly') {
            // Run weekly summaries on Sunday (day 0) at the scheduled time
            if (currentDay !== 0) continue;
          }
          // For daily, any day is fine

          // Check if we already ran today
          if (settings.last_scheduled_summary) {
            const lastRun = new Date(settings.last_scheduled_summary);
            const hoursSinceLastRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60);
            if (hoursSinceLastRun < 23) {
              continue; // Already ran in the last 23 hours
            }
          }

          // Generate summary
          await this.generateScheduledSummary(settings.telegram_chat_id, settings);

          // Update last run time
          await this.db.updateLastScheduledSummary(settings.telegram_chat_id);
        } catch (error) {
          logger.error(
            `Error processing scheduled summary for group ${settings.telegram_chat_id}:`,
            error
          );
        }
      }
    } catch (error) {
      logger.error('Error checking scheduled summaries:', error);
      throw error;
    }
  }

  private async generateScheduledSummary(chatId: number, settings: any): Promise<void> {
    try {
      const group = await this.db.getGroup(chatId);
      if (!group || !group.gemini_api_key_encrypted) return;

      // Get messages from the last period
      const hoursAgo = settings.schedule_frequency === 'weekly' ? 168 : 24; // 7 days or 1 day
      const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

      const messages = await this.db.getMessagesSinceTimestamp(chatId, since, 1000);
      if (messages.length === 0) {
        return; // No messages to summarize
      }

      // Filter messages based on settings
      const filteredMessages = messages.filter(msg => {
        if (settings.exclude_bot_messages && msg.username === 'bot') return false;
        if (settings.exclude_commands && msg.content?.startsWith('/')) return false;
        if (
          settings.excluded_user_ids &&
          msg.user_id &&
          settings.excluded_user_ids.includes(msg.user_id)
        )
          return false;
        return true;
      });

      if (filteredMessages.length === 0) return;

      const decryptedKey = this.encryption.decrypt(group.gemini_api_key_encrypted);
      const gemini = new GeminiService(decryptedKey);
      const summary = await gemini.summarizeMessages(filteredMessages, {
        customPrompt: settings.custom_prompt,
        summaryStyle: settings.summary_style,
      });

      // Convert markdown to HTML
      const formattedSummary = markdownToHtml(summary);

      const frequencyText = settings.schedule_frequency === 'weekly' ? 'Weekly' : 'Daily';
      await this.bot.api.sendMessage(
        chatId,
        `📅 <b>${frequencyText} Scheduled Summary</b>\n\n${formattedSummary}`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      logger.error(`Error generating scheduled summary for group ${chatId}:`, error);
    }
  }
}
