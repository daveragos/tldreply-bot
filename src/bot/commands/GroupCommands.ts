import { NextFunction } from 'grammy';
import { BaseCommand, MyContext } from './BaseCommand';
import { getGeminiService } from '../../services/geminiPool';
import { logger } from '../../utils/logger';
import { markdownToHtml, splitMessage, escapeHtml } from '../../utils/formatter';
import { config } from '../../config';
import {
  parseTLDRArgs,
  parseTimeframe,
  isCountBased,
  parseCount,
} from '../../utils/tldrArgs';

export class GroupCommands extends BaseCommand {
  private rateLimitMap = new Map<string, number>();
  private readonly RATE_LIMIT_SECONDS = 60; // 1 minute per user/group

  register() {
    this.bot.command('tldr', this.handleTLDR.bind(this));
    this.bot.command('tldr_info', this.handleTLDRInfo.bind(this));
    this.bot.command('history', this.handleHistory.bind(this));
    this.bot.command(['tldr_help', 'help'], this.handleTLDRHelp.bind(this));
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
      const parsedArgs = parseTLDRArgs(args.slice(1));

      loadingMsg = await ctx.reply('⏳ Generating summary...');

      // Check if input is a count (pure number) or time-based (has h/d suffix or keywords)
      let messages: any[];
      let summaryLabel: string;
      let archives: any[] = [];
      let rangeNote = '';

      if (isCountBased(parsedArgs.input)) {
        // Count-based: Get last N messages
        const count = parseCount(parsedArgs.input);
        const countLabel = `last ${count} messages`;
        const userLabel = parsedArgs.username ? ` from @${parsedArgs.username}` : '';
        const topicLabel = parsedArgs.topicFocus ? ` on topic "${parsedArgs.topicFocus}"` : '';
        summaryLabel = `${countLabel}${userLabel}${topicLabel}`;
        messages = await this.db.getLastNMessages(chat.id, count, parsedArgs.username);
      } else {
        // Time-based: Get messages since timestamp
        const since = parseTimeframe(parsedArgs.input);
        const timeframeLabel = parsedArgs.input;
        const userLabel = parsedArgs.username ? ` from @${parsedArgs.username}` : '';
        const topicLabel = parsedArgs.topicFocus ? ` on topic "${parsedArgs.topicFocus}"` : '';
        summaryLabel = `${timeframeLabel}${userLabel}${topicLabel}`;
        messages = await this.db.getMessagesSinceTimestamp(
          chat.id,
          since,
          10000,
          parsedArgs.username
        );

        // Ranges reaching past the retention window are answered from the
        // summary archive, since the raw messages for that period are gone.
        // Per-user filtering is not possible against an archive, so those
        // requests stay message-only.
        const retentionCutoff = new Date(
          Date.now() - config.messageRetentionHours * 60 * 60 * 1000
        );
        if (since < retentionCutoff) {
          if (parsedArgs.username) {
            // Archived summaries cannot be filtered by author.
            rangeNote =
              `Only the last ${config.messageRetentionHours}h could be searched for ` +
              `@${parsedArgs.username} — older messages are archived as summaries, ` +
              'which cannot be filtered by user.';
          } else {
            archives = await this.db.getSummariesInRange(chat.id, since, retentionCutoff);
            if (archives.length === 0) {
              rangeNote =
                `Only the last ${config.messageRetentionHours}h is available — older messages ` +
                'have been deleted and no archived summary covers that period yet.';
            }
          }
        }
      }

      logger.info(
        `Generating summary for ${chat.id}: ${summaryLabel} (${messages.length} messages)`
      );
      if (messages.length === 0 && archives.length === 0) {
        const errorMsg = isCountBased(parsedArgs.input)
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

      if (filteredMessages.length === 0 && archives.length === 0) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          '📭 No messages found after filtering in the specified time range.'
        );
        return;
      }

      // Use user-provided style if available, otherwise fall back to group setting
      const summaryStyle = parsedArgs.style || settings.summary_style;

      // A topic the user typed but that failed validation must be reported,
      // not dropped - otherwise they get an unfocused summary with no
      // explanation of why their filter was ignored.
      if (parsedArgs.topicRejectedReason) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          `❌ Could not use "${escapeHtml(parsedArgs.rawTopic ?? '')}" as a topic — ` +
            `${parsedArgs.topicRejectedReason}.\n\n` +
            'Try a plain description, for example: <code>/tldr 500 meeting notes</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }
      const validatedTopic = parsedArgs.topicFocus;

      const gemini = getGeminiService(chat.id, group.gemini_api_key_encrypted, this.encryption);

      const formattedMessages = filteredMessages.map(msg => ({
        username: msg.username,
        firstName: msg.first_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isBot: msg.is_bot,
        isChannel: msg.is_channel,
        messageId: msg.message_id,
      }));

      const summaryOptions = {
        customPrompt: settings.custom_prompt,
        summaryStyle: summaryStyle,
        chatId: chat.id,
        chatUsername: chat.username,
        topicFocus: validatedTopic || undefined,
      };

      const summary =
        archives.length > 0
          ? await gemini.summarizeWithHistory(
              archives.map(a => ({
                summaryText: a.summary_text,
                periodStart: a.period_start,
                periodEnd: a.period_end,
                messageCount: a.message_count,
              })),
              formattedMessages,
              summaryOptions
            )
          : await gemini.summarizeMessages(formattedMessages, summaryOptions);

      if (archives.length > 0) {
        summaryLabel += `, ${archives.length} archived period${archives.length !== 1 ? 's' : ''}`;
      }

      // Convert message ID references to markdown links
      const summaryWithLinks = this.convertMessageIdsToLinks(
        summary,
        chat.id,
        chat.username,
        filteredMessages
      );

      // Convert markdown to HTML
      let formattedSummary = markdownToHtml(summaryWithLinks);

      if (rangeNote) {
        formattedSummary += `\n\n<i>ℹ️ ${rangeNote}</i>`;
      }

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
      const parsedArgs = parseTLDRArgs(args.slice(1));

      const group = await this.db.getGroup(chat.id);

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

      const formattedMessages = filteredMessages.map(msg => ({
        username: msg.username,
        firstName: msg.first_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isBot: msg.is_bot,
        isChannel: msg.is_channel,
        messageId: msg.message_id,
      }));

      if (parsedArgs.topicRejectedReason) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          `❌ Could not use "${escapeHtml(parsedArgs.rawTopic ?? '')}" as a topic — ` +
            `${parsedArgs.topicRejectedReason}.\n\n` +
            'Try a plain description, for example: <code>/tldr meeting notes</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }
      const validatedTopic = parsedArgs.topicFocus;

      const gemini = getGeminiService(chat.id, group.gemini_api_key_encrypted, this.encryption);
      const summary = await gemini.summarizeMessages(formattedMessages, {
        customPrompt: settings.custom_prompt,
        summaryStyle: summaryStyle,
        chatId: chat.id,
        chatUsername: chat.username,
        topicFocus: validatedTopic || undefined,
      });

      // Convert message ID references to markdown links
      const summaryWithLinks = this.convertMessageIdsToLinks(
        summary,
        chat.id,
        chat.username,
        filteredMessages
      );

      // Convert markdown to HTML
      const formattedSummary = markdownToHtml(summaryWithLinks);

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

  // --- History ---

  /**
   * Lists archived summaries, or prints one in full.
   *
   * Messages are deleted after the retention window, but the summary written
   * just before deletion is kept for much longer. This is the only way to read
   * that archive: without it the summaries were write-only.
   */
  async handleHistory(ctx: MyContext) {
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

      const summaries = await this.db.getSummariesForGroup(chat.id, 20);

      if (summaries.length === 0) {
        await ctx.reply(
          '📭 <b>No archived summaries yet</b>\n\n' +
            `Summaries are written automatically when messages pass the ${config.messageRetentionHours}-hour ` +
            'retention window, then kept for ' +
            `${config.summaryRetentionDays} days.\n\n` +
            '<i>Come back once this group has been active for a couple of days.</i>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      // `/history 3` prints the third entry in full.
      const args = ctx.message?.text?.split(' ') ?? [];
      const requested = args.length > 1 ? parseInt(args[1], 10) : NaN;

      if (!Number.isNaN(requested)) {
        if (requested < 1 || requested > summaries.length) {
          await ctx.reply(
            `❌ Pick a number between 1 and ${summaries.length}. Run /history to see the list.`
          );
          return;
        }

        const entry = summaries[requested - 1];
        const header =
          `📚 <b>Archived Summary</b> (${this.formatPeriod(entry.period_start, entry.period_end)}, ` +
          `${entry.message_count} messages)`;
        const body = markdownToHtml(entry.summary_text);

        const chunks = splitMessage(body, 4096 - header.length - 100);
        await ctx.reply(`${header}\n\n${chunks[0]}`, { parse_mode: 'HTML' });
        for (let i = 1; i < chunks.length; i++) {
          await ctx.reply(chunks[i], { parse_mode: 'HTML' });
        }
        return;
      }

      let message =
        '📚 <b>Archived Summaries</b>\n\n' +
        `Kept for ${config.summaryRetentionDays} days after the messages are deleted.\n\n`;

      summaries.forEach((entry, idx) => {
        message +=
          `<b>${idx + 1}.</b> ${this.formatPeriod(entry.period_start, entry.period_end)}\n` +
          `    ${entry.message_count} messages\n`;
      });

      message += '\n<i>Use /history &lt;number&gt; to read one in full.</i>';

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error listing history:', error);
      await ctx.reply('❌ Error retrieving archived summaries.');
    }
  }

  /** Renders a summary's covered period compactly, collapsing same-day ranges. */
  private formatPeriod(start: Date | string, end: Date | string): string {
    const from = new Date(start);
    const to = new Date(end);

    const day = (d: Date) =>
      d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const time = (d: Date) =>
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

    if (day(from) === day(to)) {
      return `${day(from)}, ${time(from)}–${time(to)} UTC`;
    }
    return `${day(from)} ${time(from)} – ${day(to)} ${time(to)} UTC`;
  }

  // --- TLDR Help ---

  async handleTLDRHelp(ctx: MyContext) {
    const helpMessage =
      '📖 <b>TLDR Bot Help</b>\n\n' +
      'Get a summary of group conversations using Gemini AI.\n\n' +
      '📐 <b>Standard Command Rule:</b>\n' +
      '<code>/tldr [range] [@username] [style] [topic]</code>\n\n' +
      '<b>Components:</b>\n' +
      '• <b>Range</b>: <code>1h</code>, <code>6h</code>, <code>day</code>, or message count <code>100</code>\n' +
      '• <b>@username</b>: Filter messages from a specific user\n' +
      '• <b>Style</b>: <code>brief</code>, <code>detailed</code>, <code>bullet</code>, or <code>timeline</code>\n' +
      '• <b>Topic</b>: Any words to focus the summary on a specific subject\n\n' +
      '💡 <b>Examples:</b>\n' +
      '• <code>/tldr 6h</code> - Last 6 hours\n' +
      "• <code>/tldr @user 1d</code> - User's talk in last day\n" +
      '• <code>/tldr 500 Secret Santa</code> - Focus on a topic\n\n' +
      '📚 <b>Older than ' +
      config.messageRetentionHours +
      'h?</b>\n' +
      '<code>/history</code> lists archived summaries, <code>/history 2</code> reads one.\n\n' +
      '<i>Reply to any message with <code>/tldr</code> to summarize from that point forward!</i>';

    await ctx.reply(helpMessage, { parse_mode: 'HTML' });
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
          `<i>Use /tldr_help for usage guide or reply to a message with /tldr</i>`,
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

  async handleMessageCache(ctx: MyContext, next: NextFunction) {
    await this.processMessageForCache(ctx, ctx.message);
    await next();
  }

  async handleEditedMessageCache(ctx: MyContext, next: NextFunction) {
    const editedMessage = ctx.editedMessage || ctx.update.edited_message;
    if (editedMessage) {
      await this.processMessageForCache(ctx, editedMessage);
    }
    await next();
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
      // Improved identity detection
      let userId = ctx.from?.id;
      let username = ctx.from?.username;
      let firstName = ctx.from?.first_name;
      const isBot = ctx.from?.is_bot || false;
      let isChannel = false;

      // Handle message sent by a channel or anonymous admin
      if (message.sender_chat) {
        if (message.sender_chat.type === 'channel') {
          isChannel = true;
          userId = message.sender_chat.id;
          username = message.sender_chat.username;
          firstName = message.sender_chat.title;
        } else if (message.sender_chat.id === chat.id) {
          // Anonymous group admin post
          userId = message.sender_chat.id;
          username = 'admin';
          firstName = 'Group Admin';
        }
      }

      await this.db.insertMessage({
        chatId: chat.id,
        messageId: message.message_id,
        userId: userId,
        username: username,
        firstName: firstName,
        content: content.substring(0, config.messageMaxChars),
        isBot: isBot,
        isChannel: isChannel,
      });
    } catch (error) {
      logger.error('Error caching message:', error);
    }
  }

  // --- Helpers ---

  private filterMessages(messages: any[], settings: any, ctx?: MyContext): any[] {
    return messages.filter(msg => {
      if (settings.exclude_bot_messages && msg.is_bot) {
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

  /**
   * Converts message ID references to consistent format: number (link)
   * Handles both single [51364] and multiple [52343, 43242, 34234] formats
   */
  private convertMessageIdsToLinks(
    summary: string,
    chatId: number,
    chatUsername: string | undefined,
    messages: any[]
  ): string {
    let result = summary;

    // First, convert existing markdown links [number](link) to number (link) format
    result = result.replace(/\[(\d+)\]\((https?:\/\/[^\s)]+)\)/g, (match, messageIdStr, link) => {
      return `${messageIdStr} (${link})`;
    });

    // Handle multiple message IDs in brackets: [52343, 43242, 34234]
    result = result.replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (match, idsStr) => {
      const ids = idsStr
        .split(',')
        .map((id: string) => id.trim())
        .filter((id: string) => /^\d+$/.test(id));
      const formattedIds = ids.map((id: string) => {
        const messageId = parseInt(id, 10);
        const link = this.formatTelegramLink(chatId, messageId, chatUsername);
        return `${messageId} (${link})`;
      });
      // Wrap in brackets to show they're links
      return `[${formattedIds.join(', ')}]`;
    });

    // Convert single message ID references [51364] that are not already converted
    // Pattern: [ followed by digits, followed by ] that is NOT followed by (
    result = result.replace(/\[(\d+)\](?!\()/g, (match, messageIdStr) => {
      const messageId = parseInt(messageIdStr, 10);
      const link = this.formatTelegramLink(chatId, messageId, chatUsername);
      // Use consistent format: number (link)
      return `${messageId} (${link})`;
    });

    return result;
  }

  /**
   * Formats a Telegram link for a message
   */
  private formatTelegramLink(chatId: number, messageId: number, chatUsername?: string): string {
    if (chatUsername) {
      return `https://t.me/${chatUsername}/${messageId}`;
    }
    // For private groups/channels, use the c/ID format
    // Telegram IDs usually look like -100123456789. We need the part after -100
    const cleanId = Math.abs(chatId).toString().replace(/^100/, '');
    return `https://t.me/c/${cleanId}/${messageId}`;
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
