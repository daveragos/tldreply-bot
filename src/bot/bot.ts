import { Bot, GrammyError, HttpError, Context } from 'grammy';
import { conversations, createConversation, ConversationFlavor } from '@grammyjs/conversations';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import { Commands } from './commands';
import { setupApiKey, updateApiKey, excludeUsers } from './conversations';
import { setServices, clearExpiredState } from '../services/services';
import { GeminiService } from '../services/gemini';

type MyContext = ConversationFlavor<Context>;

export class TLDRBot {
  private bot: Bot<MyContext>;
  private db: Database;
  private encryption: EncryptionService;
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

    new Commands(this.bot, this.db, this.encryption);

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
              console.log(`Bot removed from group ${chat.id}, cleaned up database entry`);
            }
          }
        }
      } catch (error) {
        console.error('Error handling bot removal:', error);
      }
    });

    // Error handling
    this.bot.catch(err => {
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

    // Run cleanup every 12 hours (summarize and delete messages older than 48 hours)
    this.cleanupInterval = setInterval(
      async () => {
        try {
          await this.summarizeAndCleanupOldMessages();
        } catch (error) {
          console.error('Error during message cleanup:', error);
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
          console.error('Error during summary cleanup:', error);
        }
      },
      24 * 60 * 60 * 1000
    );

    // Check for scheduled summaries every hour
    this.scheduledSummaryInterval = setInterval(
      async () => {
        try {
          await this.checkAndRunScheduledSummaries();
        } catch (error) {
          console.error('Error checking scheduled summaries:', error);
        }
      },
      60 * 60 * 1000
    ); // Check every hour

    // Run initial check after 5 minutes
    setTimeout(
      async () => {
        try {
          await this.checkAndRunScheduledSummaries();
        } catch (error) {
          console.error('Error in initial scheduled summary check:', error);
        }
      },
      5 * 60 * 1000
    );

    // Periodic job to check if bot is still in groups (every 24 hours)
    this.groupCleanupInterval = setInterval(
      async () => {
        try {
          await this.checkAndCleanupOrphanedGroups();
        } catch (error) {
          console.error('Error during group cleanup check:', error);
        }
      },
      24 * 60 * 60 * 1000
    );

    // Run initial check after 10 minutes
    setTimeout(
      async () => {
        try {
          await this.checkAndCleanupOrphanedGroups();
        } catch (error) {
          console.error('Error in initial group cleanup check:', error);
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

  private async checkAndCleanupOrphanedGroups(): Promise<void> {
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
          // The bot should be able to get its own member status if it's in the group
          try {
            const botMember = await this.bot.api.getChatMember(group.telegram_chat_id, botInfo.id);

            // If bot is left or kicked, cleanup
            if (botMember.status === 'left' || botMember.status === 'kicked') {
              await this.db.deleteGroup(group.telegram_chat_id);
              cleanedCount++;
              console.log(`Cleaned up orphaned group ${group.telegram_chat_id} (bot not in group)`);
            }
          } catch (memberError: any) {
            // If we can't get member status (403 or 400), bot is likely not in group
            if (memberError.error_code === 400 || memberError.error_code === 403) {
              await this.db.deleteGroup(group.telegram_chat_id);
              cleanedCount++;
              console.log(
                `Cleaned up orphaned group ${group.telegram_chat_id} (cannot verify membership)`
              );
            }
          }
        } catch (error: any) {
          // If getChat fails, bot is likely not in the group anymore
          if (error.error_code === 400 || error.error_code === 403) {
            await this.db.deleteGroup(group.telegram_chat_id);
            cleanedCount++;
            console.log(`Cleaned up orphaned group ${group.telegram_chat_id} (bot not in group)`);
          }
        }
      }

      if (cleanedCount > 0) {
        console.log(`✅ Group cleanup complete: ${cleanedCount} orphaned group(s) removed`);
      }
    } catch (error) {
      console.error('Error in checkAndCleanupOrphanedGroups:', error);
      throw error;
    }
  }

  private async checkAndRunScheduledSummaries(): Promise<void> {
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
          console.error(
            `Error processing scheduled summary for group ${settings.telegram_chat_id}:`,
            error
          );
        }
      }
    } catch (error) {
      console.error('Error checking scheduled summaries:', error);
      throw error;
    }
  }

  /**
   * Convert markdown to HTML for Telegram
   * According to Telegram Bot API: https://core.telegram.org/bots/api#html-style
   * Supports: <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, <code>code</code>, <pre>pre</pre>
   */
  private markdownToHtml(text: string): string {
    if (!text) return '';

    let html = text;

    // Step 1: Convert markdown to HTML BEFORE escaping
    // This order is important - we need to convert markdown first, then escape

    // Convert **bold** to <b>bold</b> (non-greedy, handle multiple per line)
    html = html.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>');

    // Convert bullet points: * item or - item (preserve indentation)
    // Process line by line to handle nested bullets correctly
    const lines = html.split('\n');
    const processedLines = lines.map(line => {
      // Check if line starts with bullet (with optional indentation)
      // eslint-disable-next-line no-useless-escape
      const bulletMatch = line.match(/^(\s*)[\*\-]\s+(.+)$/);
      if (bulletMatch) {
        const indent = bulletMatch[1];
        // eslint-disable-next-line prefer-const
        let content = bulletMatch[2];
        // Content may already have <b> tags from previous conversion
        return indent + '• ' + content.trim();
      }
      return line;
    });
    html = processedLines.join('\n');

    // Convert single *italic* to <i>italic</i> (but not **bold** or bullets)
    // Since we already converted **bold** and bullets, remaining * are for italic
    // Match *text* that's not part of ** (already converted) and not at line start
    html = html.replace(/(?<!\*)\*([^*\n<]+?)\*(?!\*)/g, '<i>$1</i>');

    // Convert ~~strikethrough~~ to <s>strikethrough</s>
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Step 2: Escape HTML special characters (but preserve our tags)
    // Escape & first (but not already escaped entities)
    html = html.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;');

    // Escape < and > that are not part of our HTML tags
    // Simple approach: escape all < and >, then restore our tags
    const tagPlaceholders: { [key: string]: string } = {};
    let placeholderIndex = 0;

    // Temporarily replace HTML tags with placeholders
    html = html.replace(/<\/?(?:b|i|u|s|code|pre|a)\b[^>]*>/gi, match => {
      const placeholder = `__TAG_${placeholderIndex++}__`;
      tagPlaceholders[placeholder] = match;
      return placeholder;
    });

    // Now escape remaining < and >
    html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Restore HTML tags
    for (const [placeholder, tag] of Object.entries(tagPlaceholders)) {
      html = html.replace(placeholder, tag);
    }

    // Clean up excessive spacing
    html = html.replace(/\n{3,}/g, '\n\n');

    return html;
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
      const formattedSummary = this.markdownToHtml(summary);

      const frequencyText = settings.schedule_frequency === 'weekly' ? 'Weekly' : 'Daily';
      await this.bot.api.sendMessage(
        chatId,
        `📅 <b>${frequencyText} Scheduled Summary</b>\n\n${formattedSummary}`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error(`Error generating scheduled summary for group ${chatId}:`, error);
    }
  }

  private async summarizeAndCleanupOldMessages(): Promise<void> {
    try {
      // Get messages that are about to be deleted (48 hours old)
      const messagesToCleanup = await this.db.getMessagesToCleanup(48);

      if (messagesToCleanup.length === 0) {
        console.log('No messages to cleanup');
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
            console.log(`Group ${chatId} not configured, skipping summarization`);
            continue;
          }

          // Skip if no valid messages (empty content)
          const validMessages = messages.filter(
            msg => msg.content && msg.content.trim().length > 0
          );
          if (validMessages.length === 0) {
            console.log(`Group ${chatId} has no valid messages to summarize`);
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
          console.log(`Summarized ${validMessages.length} messages for group ${chatId}`);
        } catch (error) {
          console.error(`Error summarizing messages for group ${chatId}:`, error);
          // Continue with other groups even if one fails
        }
      }

      // Delete all old messages (regardless of whether summarization succeeded)
      await this.db.cleanupOldMessages(48);
      totalDeleted = messagesToCleanup.length;

      console.log(
        `✅ Cleanup complete: ${totalSummarized} groups summarized, ${totalDeleted} messages deleted`
      );
    } catch (error) {
      console.error('Error in summarizeAndCleanupOldMessages:', error);
      throw error;
    }
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
    console.log('⏹️ Bot stopped');
  }

  getBot(): Bot<MyContext> {
    return this.bot;
  }
}
