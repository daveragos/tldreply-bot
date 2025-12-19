import { Bot } from 'grammy';
import { Database } from '../../db/database';
import { EncryptionService } from '../../utils/encryption';
import { GeminiService } from '../../services/gemini';
import { logger } from '../../utils/logger';
import { markdownToHtml, splitMessage } from '../../utils/formatter';
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

          // Evaluate current time in the group's timezone
          let currentHour: number;
          let currentMinute: number;
          let currentDay: number;

          try {
            const tz = settings.schedule_timezone || 'UTC';
            const formatter = new Intl.DateTimeFormat('en-US', {
              timeZone: tz,
              hour: 'numeric',
              minute: 'numeric',
              hour12: false,
            });

            const parts = formatter.formatToParts(now);
            const getPart = (type: string) => parts.find(p => p.type === type)?.value;

            currentHour = parseInt(getPart('hour') || '0', 10);
            currentMinute = parseInt(getPart('minute') || '0', 10);
            // Intl weekday is 1-7 (Mon-Sun) or something else? actually en-US usually 0-6 but check.
            // Day calculation: Sun=0, Mon=1...
            const dayFormatter = new Intl.DateTimeFormat('en-US', {
              timeZone: tz,
              weekday: 'short',
            });
            const dayName = dayFormatter.format(now);
            const days: { [key: string]: number } = {
              Sun: 0,
              Mon: 1,
              Tue: 2,
              Wed: 3,
              Thu: 4,
              Fri: 5,
              Sat: 6,
            };
            currentDay = days[dayName] ?? now.getUTCDay();
          } catch (e) {
            // Fallback to UTC if timezone is invalid
            currentHour = now.getUTCHours();
            currentMinute = now.getUTCMinutes();
            currentDay = now.getUTCDay();
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

          // Check if we already ran today
          if (settings.last_scheduled_summary) {
            const lastRun = new Date(settings.last_scheduled_summary);
            const hoursSinceLastRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60);
            if (hoursSinceLastRun < 23) {
              continue;
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
        if (settings.exclude_bot_messages && msg.is_bot) return false;
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

      const formattedMessages = filteredMessages.map(msg => ({
        username: msg.username,
        firstName: msg.first_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isBot: msg.is_bot,
        isChannel: msg.is_channel,
        messageId: msg.message_id,
      }));

      const decryptedKey = this.encryption.decrypt(group.gemini_api_key_encrypted);
      const gemini = new GeminiService(decryptedKey);
      const summary = await gemini.summarizeMessages(formattedMessages, {
        customPrompt: settings.custom_prompt,
        summaryStyle: settings.summary_style,
        chatId: chatId,
        chatUsername: group.username,
      });

      // Convert markdown to HTML
      const formattedSummary = markdownToHtml(summary);

      const frequencyText = settings.schedule_frequency === 'weekly' ? 'Weekly' : 'Daily';
      const header = `📅 <b>${frequencyText} Scheduled Summary</b>`;

      const MAX_LENGTH = 4000;
      if (formattedSummary.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(chatId, `${header}\n\n${formattedSummary}`, {
          parse_mode: 'HTML',
        });
      } else {
        const chunks = splitMessage(formattedSummary, MAX_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
          const chunkHeader = `${header} (${i + 1}/${chunks.length})`;
          await this.bot.api.sendMessage(chatId, `${chunkHeader}\n\n${chunks[i]}`, {
            parse_mode: 'HTML',
          });
        }
      }
    } catch (error) {
      logger.error(`Error generating scheduled summary for group ${chatId}:`, error);
    }
  }
}
