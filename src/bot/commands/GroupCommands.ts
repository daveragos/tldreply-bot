import { BaseCommand, MyContext } from './BaseCommand';
import { GeminiService } from '../../services/gemini';
import { logger } from '../../utils/logger';
import { markdownToHtml, splitMessage } from '../../utils/formatter';

export class GroupCommands extends BaseCommand {
  private rateLimitMap = new Map<string, number>();
  private readonly RATE_LIMIT_SECONDS = 60; // 1 minute per user/group

  register() {
    this.bot.command('tldr', this.handleTLDR.bind(this));
    this.bot.command('tldr_info', this.handleTLDRInfo.bind(this));
    this.bot.command('enable', this.handleEnable.bind(this));
    this.bot.command('disable', this.handleDisable.bind(this));

    // Message handlers for caching
    this.bot.on('message', this.handleMessageCache.bind(this));
    this.bot.on('edited_message', this.handleEditedMessageCache.bind(this));
  }

  // --- TLDR Command ---

  async handleTLDR(ctx: MyContext) {
    const chat = ctx.chat;
    let loadingMsg: any = null;

    if (!chat || chat.type === 'private') {
      await ctx.reply('❌ This command can only be used in a group.');
      return;
    }

    try {
      // Rate limiting: check if user/group has used command recently
      const userId = ctx.from?.id;
      const rateLimitKey = `${chat.id}:${userId || 'unknown'}`;
      const lastCommandTime = this.rateLimitMap.get(rateLimitKey);
      const now = Date.now();

      if (lastCommandTime && now - lastCommandTime < this.RATE_LIMIT_SECONDS * 1000) {
        const remainingSeconds = Math.ceil(
          (this.RATE_LIMIT_SECONDS * 1000 - (now - lastCommandTime)) / 1000
        );
        await ctx.reply(
          `⏳ Please wait ${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''} before requesting another summary.`
        );
        return;
      }

      // Update rate limit
      this.rateLimitMap.set(rateLimitKey, now);

      // Check if group is configured
      const group = await this.db.getGroup(chat.id);

      if (!group || !group.gemini_api_key_encrypted) {
        await ctx.reply(
          '❌ This group is not configured yet.\n\n' +
            'Ask an admin to set it up in private chat using /setup_group.'
        );
        return;
      }

      if (!group.enabled) {
        await ctx.reply('❌ TLDR is currently disabled for this group.');
        return;
      }

      // Handle reply-to message case
      const replyToMessage = ctx.message?.reply_to_message;
      if (replyToMessage) {
        await this.handleTLDRFromMessage(ctx, replyToMessage.message_id);
        return;
      }

      // Handle time-based or count-based summary
      const args = ctx.message?.text?.split(' ') || [];
      // Parse arguments to extract timeframe/count and optional style preference
      const parsedArgs = this.parseTLDRArgs(args.slice(1));

      loadingMsg = await ctx.reply('⏳ Generating summary...');

      // Check if input is a count (pure number) or time-based (has h/d suffix or keywords)
      let messages: any[];
      let summaryLabel: string;

      if (this.isCountBased(parsedArgs.input)) {
        // Count-based: Get last N messages
        const count = this.parseCount(parsedArgs.input);
        summaryLabel = `last ${count} messages`;
        messages = await this.db.getLastNMessages(chat.id, count);
      } else {
        // Time-based: Get messages since timestamp
        const since = this.parseTimeframe(parsedArgs.input);
        summaryLabel = parsedArgs.input;
        messages = await this.db.getMessagesSinceTimestamp(chat.id, since, 10000);
      }
      if (messages.length === 0) {
        const errorMsg = this.isCountBased(parsedArgs.input)
          ? '📭 No messages found in the database.'
          : '📭 No messages found in the specified time range.';
        await ctx.api.editMessageText(chat.id, loadingMsg.message_id, errorMsg);
        return;
      }

      // Update loading message if processing large set
      if (messages.length > 1000) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          `⏳ Processing ${messages.length} messages in chunks... This may take a moment.`
        );
      }

      // Get group settings for customization
      const settings = await this.db.getGroupSettings(chat.id);

      // Filter messages based on settings
      const filteredMessages = this.filterMessages(messages, settings, ctx);

      if (filteredMessages.length === 0) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          '📭 No messages found after filtering in the specified time range.'
        );
        return;
      }

      // Use user-provided style if available, otherwise fall back to group setting
      const summaryStyle = parsedArgs.style || settings.summary_style;

      const decryptedKey = this.encryption.decrypt(group.gemini_api_key_encrypted);
      const gemini = new GeminiService(decryptedKey);
      const summary = await gemini.summarizeMessages(filteredMessages, {
        customPrompt: settings.custom_prompt,
        summaryStyle: summaryStyle,
      });

      // Convert markdown to HTML
      const formattedSummary = markdownToHtml(summary);

      // Send summary, splitting into multiple messages if too long
      await this.sendSummaryMessage(
        ctx,
        chat.id,
        loadingMsg.message_id,
        `📝 <b>TLDR Summary</b> (${summaryLabel})`,
        formattedSummary
      );
    } catch (error: any) {
      logger.error('Error generating TLDR:', error);

      const errorMessage = error.message || 'Unknown error occurred';
      const userFriendlyMessage =
        errorMessage.includes('Invalid API key') || errorMessage.includes('API key')
          ? `❌ ${errorMessage}\n\n💡 <b>Tip:</b> An admin can update the API key using /update_api_key in private chat.`
          : errorMessage.includes('quota') || errorMessage.includes('rate limit')
            ? `❌ ${errorMessage}\n\n💡 <b>Tip:</b> Please wait a moment and try again, or check your Gemini API quota.`
            : `❌ ${errorMessage}`;

      // Try to edit the loading message to show error
      try {
        if (loadingMsg) {
          await ctx.api.editMessageText(chat.id, loadingMsg.message_id, userFriendlyMessage, {
            parse_mode: 'HTML',
          });
        } else {
          await ctx.reply(userFriendlyMessage, { parse_mode: 'HTML' });
        }
      } catch (editError) {
        // If edit fails, send new message
        await ctx.reply(userFriendlyMessage, { parse_mode: 'HTML' });
      }
    }
  }

  private async handleTLDRFromMessage(ctx: MyContext, fromMessageId: number) {
    let loadingMsg: any = null;
    const chat = ctx.chat!;

    try {
      // Parse style from command arguments if provided (e.g., /tldr detailed)
      const args = ctx.message?.text?.split(' ') || [];
      const parsedArgs = this.parseTLDRArgs(args.slice(1));

      const group = await this.db.getGroup(chat.id);
      const decryptedKey = this.encryption.decrypt(group.gemini_api_key_encrypted);

      loadingMsg = await ctx.reply('⏳ Generating summary...');

      const messages = await this.db.getMessagesSinceMessageId(chat.id, fromMessageId, 10000);
      if (messages.length === 0) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          '📭 No messages found from this point.'
        );
        return;
      }

      // Update loading message if processing large set
      if (messages.length > 1000) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          `⏳ Processing ${messages.length} messages in chunks... This may take a moment.`
        );
      }

      // Get group settings for customization
      const settings = await this.db.getGroupSettings(chat.id);

      // Filter messages based on settings
      const filteredMessages = this.filterMessages(messages, settings, ctx);

      if (filteredMessages.length === 0) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          '📭 No messages found after filtering from this point.'
        );
        return;
      }

      // Use user-provided style if available, otherwise fall back to group setting
      const summaryStyle = parsedArgs.style || settings.summary_style;

      const gemini = new GeminiService(decryptedKey);
      const summary = await gemini.summarizeMessages(filteredMessages, {
        customPrompt: settings.custom_prompt,
        summaryStyle: summaryStyle,
      });

      // Convert markdown to HTML
      const formattedSummary = markdownToHtml(summary);

      // Send summary, splitting into multiple messages if too long
      await this.sendSummaryMessage(
        ctx,
        chat.id,
        loadingMsg.message_id,
        `📝 <b>TLDR Summary</b> (from message)`,
        formattedSummary
      );
    } catch (error: any) {
      logger.error('Error generating TLDR from message:', error);

      const errorMessage = error.message || 'Unknown error occurred';
      const userFriendlyMessage =
        errorMessage.includes('Invalid API key') || errorMessage.includes('API key')
          ? `❌ ${errorMessage}\n\n💡 <b>Tip:</b> An admin can update the API key using /update_api_key in private chat.`
          : errorMessage.includes('quota') || errorMessage.includes('rate limit')
            ? `❌ ${errorMessage}\n\n💡 <b>Tip:</b> Please wait a moment and try again, or check your Gemini API quota.`
            : `❌ ${errorMessage}`;

      try {
        if (loadingMsg) {
          await ctx.api.editMessageText(chat.id, loadingMsg.message_id, userFriendlyMessage, {
            parse_mode: 'HTML',
          });
        } else {
          await ctx.reply(userFriendlyMessage, { parse_mode: 'HTML' });
        }
      } catch (editError) {
        await ctx.reply(userFriendlyMessage, { parse_mode: 'HTML' });
      }
    }
  }

  // --- TLDR Info ---

  async handleTLDRInfo(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') {
      await ctx.reply('❌ This command can only be used in a group.');
      return;
    }

    try {
      const group = await this.db.getGroup(chat.id);
      if (!group) {
        await ctx.reply('❌ This group is not configured.');
        return;
      }

      const status = group.gemini_api_key_encrypted
        ? '✅ Configured and ready'
        : '⏳ Pending setup';
      const enabledStatus = group.enabled ? '✅ Enabled' : '❌ Disabled';

      await ctx.reply(
        `ℹ️ <b>TLDR Info</b>\n\n` +
          `Status: ${status}\n` +
          `Bot: ${enabledStatus}\n\n` +
          `🔒 Messages auto-delete after 48 hours\n\n` +
          `<i>Use /tldr [timeframe] or reply to a message with /tldr</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      logger.error('Error getting TLDR info:', error);
      await ctx.reply('❌ Error retrieving info.');
    }
  }

  // --- Enable/Disable ---

  async handleEnable(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') {
      await ctx.reply('❌ This command can only be used in a group.');
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ Could not identify user.');
      return;
    }

    const isAdmin = await this.isAdminOrCreator(ctx, chat.id, userId);
    if (!isAdmin) {
      await ctx.reply('❌ Only group admins can enable/disable the bot.');
      return;
    }

    try {
      const group = await this.db.getGroup(chat.id);
      if (!group) {
        await ctx.reply('❌ This group is not configured. Please run /setup first.');
        return;
      }

      await this.db.toggleGroupEnabled(chat.id, true);
      await ctx.reply(
        '✅ TLDR bot has been enabled for this group. You can now use /tldr commands.'
      );
    } catch (error) {
      logger.error('Error enabling bot:', error);
      await ctx.reply('❌ Error enabling bot. Please try again.');
    }
  }

  async handleDisable(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') {
      await ctx.reply('❌ This command can only be used in a group.');
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ Could not identify user.');
      return;
    }

    const isAdmin = await this.isAdminOrCreator(ctx, chat.id, userId);
    if (!isAdmin) {
      await ctx.reply('❌ Only group admins can enable/disable the bot.');
      return;
    }

    try {
      const group = await this.db.getGroup(chat.id);
      if (!group) {
        await ctx.reply('❌ This group is not configured. Please run /setup first.');
        return;
      }

      await this.db.toggleGroupEnabled(chat.id, false);
      await ctx.reply(
        '⏸️ TLDR bot has been disabled for this group. /tldr commands will not work until re-enabled.'
      );
    } catch (error) {
      logger.error('Error disabling bot:', error);
      await ctx.reply('❌ Error disabling bot. Please try again.');
    }
  }

  // --- Message Caching ---

  async handleMessageCache(ctx: MyContext) {
    await this.processMessageForCache(ctx, ctx.message);
  }

  async handleEditedMessageCache(ctx: MyContext) {
    const editedMessage = ctx.editedMessage || ctx.update.edited_message;
    if (editedMessage) {
      await this.processMessageForCache(ctx, editedMessage);
    }
  }

  private async processMessageForCache(ctx: MyContext, message: any) {
    const chat = ctx.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }

    try {
      const group = await this.db.getGroup(chat.id);
      if (!group) {
        return;
      }

      const settings = await this.db.getGroupSettings(chat.id);

      if (settings.exclude_commands && message?.text?.startsWith('/')) {
        return;
      }

      if (settings.exclude_bot_messages && ctx.from?.is_bot) {
        return;
      }

      if (
        ctx.from?.id &&
        settings.excluded_user_ids &&
        settings.excluded_user_ids.includes(ctx.from.id)
      ) {
        return;
      }
    } catch (error) {
      return;
    }

    const content = message?.text || message?.caption || '';
    if (!content || !message) {
      return;
    }

    try {
      await this.db.insertMessage({
        chatId: chat.id,
        messageId: message.message_id,
        userId: ctx.from?.id,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        content: content.substring(0, 5000), // Limit content length
      });
    } catch (error) {
      logger.error('Error caching message:', error);
    }
  }

  // --- Helpers ---

  private filterMessages(messages: any[], settings: any, ctx?: MyContext): any[] {
    return messages.filter(msg => {
      if (settings.exclude_bot_messages && msg.user_id && msg.username === 'bot') {
        return false;
      }

      if (settings.exclude_commands && msg.content?.startsWith('/')) {
        return false;
      }

      if (
        settings.excluded_user_ids &&
        msg.user_id &&
        settings.excluded_user_ids.includes(msg.user_id)
      ) {
        return false;
      }

      return true;
    });
  }

  private parseTLDRArgs(args: string[]): { input: string; style?: string } {
    const validStyles = ['default', 'detailed', 'brief', 'bullet', 'timeline'];

    if (args.length === 0) {
      return { input: '1h' };
    }

    const lastWord = args[args.length - 1]?.toLowerCase();

    if (lastWord && validStyles.includes(lastWord)) {
      const inputParts = args.slice(0, -1);
      const input = inputParts.length > 0 ? inputParts.join(' ').trim() : '1h';
      return { input, style: lastWord };
    }

    return { input: args.join(' ').trim() || '1h' };
  }

  private isCountBased(input: string): boolean {
    const normalized = input.toLowerCase().trim();
    return /^\d+$/.test(normalized);
  }

  private parseCount(input: string): number {
    const value = parseInt(input.trim(), 10);
    if (isNaN(value) || value <= 0) {
      return 100;
    }
    return Math.min(value, 10000);
  }

  private parseTimeframe(timeframe: string): Date {
    const now = Date.now();
    const MAX_HOURS = 168; // 7 days maximum
    let hours = 1;

    const normalized = timeframe.toLowerCase().trim().replace(/\s+/g, ' ');

    const dayMatch = normalized.match(/^(\d+)\s+(day|days)$/);
    if (dayMatch) {
      const days = Math.min(parseInt(dayMatch[1], 10), 7);
      hours = days * 24;
      return new Date(now - hours * 60 * 60 * 1000);
    }

    const hourMatch = normalized.match(/^(\d+)\s+(hour|hours|h)$/);
    if (hourMatch) {
      const value = parseInt(hourMatch[1], 10);
      hours = Math.min(value, MAX_HOURS);
      return new Date(now - hours * 60 * 60 * 1000);
    }

    const weekMatch = normalized.match(/^(\d+)\s+(week|weeks)$/);
    if (weekMatch) {
      const weeks = Math.min(parseInt(weekMatch[1], 10), 1);
      hours = weeks * 168;
      return new Date(now - hours * 60 * 60 * 1000);
    }

    // Handle compact formats and defaults (h, d, pure number fallback)
    if (normalized.endsWith('h')) {
      const value = parseInt(normalized.slice(0, -1), 10);
      hours = !isNaN(value) && value > 0 ? Math.min(value, MAX_HOURS) : 1;
    } else if (normalized.endsWith('d') || normalized === 'day') {
      const value = normalized === 'day' ? 1 : parseInt(normalized.slice(0, -1), 10);
      hours = !isNaN(value) && value > 0 ? Math.min(value, 7) * 24 : 24;
    } else if (normalized === 'week') {
      hours = 168;
    } else {
      const value = parseInt(normalized, 10);
      hours = !isNaN(value) && value > 0 ? Math.min(value, MAX_HOURS) : 1;
    }

    return new Date(now - hours * 60 * 60 * 1000);
  }

  private async sendSummaryMessage(
    ctx: MyContext,
    chatId: number,
    loadingMsgId: number,
    header: string,
    summary: string
  ): Promise<void> {
    const MAX_MESSAGE_LENGTH = 4096;
    const headerLength = header.length + 2;

    const maxSummaryLength = MAX_MESSAGE_LENGTH - headerLength - 100;

    if (summary.length <= maxSummaryLength) {
      try {
        await ctx.api.editMessageText(chatId, loadingMsgId, `${header}\n\n${summary}`, {
          parse_mode: 'HTML',
        });
        return;
      } catch (error: any) {
        if (!error.message?.includes('MESSAGE_TOO_LONG')) {
          throw error;
        }
      }
    }

    const chunks = splitMessage(summary, maxSummaryLength);

    try {
      await ctx.api.editMessageText(
        chatId,
        loadingMsgId,
        `${header} (1/${chunks.length})\n\n${chunks[0]}`,
        { parse_mode: 'HTML' }
      );
    } catch (error: any) {
      if (error.message?.includes('MESSAGE_TOO_LONG')) {
        await ctx.api.editMessageText(chatId, loadingMsgId, chunks[0], { parse_mode: 'HTML' });
      } else {
        throw error;
      }
    }

    for (let i = 1; i < chunks.length; i++) {
      await ctx.reply(`${header} (${i + 1}/${chunks.length})\n\n${chunks[i]}`, {
        parse_mode: 'HTML',
      });
    }
  }
}
