import { NextFunction } from 'grammy';
import { BaseCommand, MyContext } from './BaseCommand';
import { GeminiService } from '../../services/gemini';
import { logger } from '../../utils/logger';
import { markdownToHtml, splitMessage } from '../../utils/formatter';
import { config } from '../../config';

export class GroupCommands extends BaseCommand {
  private rateLimitMap = new Map<string, number>();
  private readonly RATE_LIMIT_SECONDS = 60; // 1 minute per user/group

  register() {
    this.bot.command('tldr', this.handleTLDR.bind(this));
    this.bot.command('tldr_info', this.handleTLDRInfo.bind(this));
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
      const parsedArgs = this.parseTLDRArgs(args.slice(1));

      loadingMsg = await ctx.reply('⏳ Generating summary...');

      // Check if input is a count (pure number) or time-based (has h/d suffix or keywords)
      let messages: any[];
      let summaryLabel: string;

      if (this.isCountBased(parsedArgs.input)) {
        // Count-based: Get last N messages
        const count = this.parseCount(parsedArgs.input);
        const countLabel = `last ${count} messages`;
        const userLabel = parsedArgs.username ? ` from @${parsedArgs.username}` : '';
        const topicLabel = parsedArgs.topicFocus ? ` on topic "${parsedArgs.topicFocus}"` : '';
        summaryLabel = `${countLabel}${userLabel}${topicLabel}`;
        messages = await this.db.getLastNMessages(chat.id, count, parsedArgs.username);
      } else {
        // Time-based: Get messages since timestamp
        const since = this.parseTimeframe(parsedArgs.input);
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
      }

      logger.info(
        `Generating summary for ${chat.id}: ${summaryLabel} (${messages.length} messages)`
      );
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

      // Validate topic one more time before sending to API
      const validatedTopic = parsedArgs.topicFocus
        ? this.sanitizeTopic(parsedArgs.topicFocus)
        : undefined;

      if (parsedArgs.topicFocus && !validatedTopic) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          '❌ Invalid topic provided. Topics cannot contain instructions or commands. Please use a simple topic description instead.\n\nExample: <code>/tldr 1000 meeting</code>'
        );
        return;
      }

      const decryptedKey = this.encryption.decrypt(group.gemini_api_key_encrypted);
      const gemini = new GeminiService(decryptedKey);

      const formattedMessages = filteredMessages.map(msg => ({
        username: msg.username,
        firstName: msg.first_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isBot: msg.is_bot,
        isChannel: msg.is_channel,
        messageId: msg.message_id,
      }));

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

      const formattedMessages = filteredMessages.map(msg => ({
        username: msg.username,
        firstName: msg.first_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isBot: msg.is_bot,
        isChannel: msg.is_channel,
        messageId: msg.message_id,
      }));

      // Validate topic one more time before sending to API
      const validatedTopic = parsedArgs.topicFocus
        ? this.sanitizeTopic(parsedArgs.topicFocus)
        : undefined;

      if (parsedArgs.topicFocus && !validatedTopic) {
        await ctx.api.editMessageText(
          chat.id,
          loadingMsg.message_id,
          '❌ Invalid topic provided. Topics cannot contain instructions or commands. Please use a simple topic description instead.\n\nExample: <code>/tldr meeting</code>'
        );
        return;
      }

      const gemini = new GeminiService(decryptedKey);
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
   * Sanitizes and validates topic input using a whitelist approach to prevent prompt injection
   * Uses standard input validation: character whitelist, length limits, and pattern detection
   */
  private sanitizeTopic(topic: string): string | null {
    if (!topic || topic.trim().length === 0) {
      return null;
    }

    // Standard length limit to prevent abuse
    const MAX_TOPIC_LENGTH = 200;
    const MIN_TOPIC_LENGTH = 1;
    const trimmedTopic = topic.trim();

    if (trimmedTopic.length < MIN_TOPIC_LENGTH || trimmedTopic.length > MAX_TOPIC_LENGTH) {
      return null;
    }

    // Standard character whitelist: allow alphanumeric, spaces, hyphens, apostrophes, and basic punctuation
    // This prevents injection of code, special characters, and control sequences
    const ALLOWED_CHARS = /^[a-zA-Z0-9\s\-'.,!?()]+$/;

    if (!ALLOWED_CHARS.test(trimmedTopic)) {
      logger.warn(`Rejected topic with invalid characters: ${trimmedTopic.substring(0, 100)}`);
      return null;
    }

    // Normalize whitespace (standard practice)
    const normalized = trimmedTopic
      .replace(/\s+/g, ' ') // Collapse multiple spaces
      .replace(/^\s+|\s+$/g, '') // Trim
      .trim();

    // Check for excessive punctuation (might indicate code/injection attempts)
    const punctuationCount = (normalized.match(/[.,!?()]/g) || []).length;
    const charCount = normalized.length;
    const punctuationRatio = punctuationCount / charCount;

    // Reject if more than 30% of characters are punctuation (likely not a natural topic)
    if (punctuationRatio > 0.3) {
      logger.warn(`Rejected topic with excessive punctuation: ${normalized.substring(0, 100)}`);
      return null;
    }

    // Check for suspicious patterns: multiple consecutive special characters or unusual sequences
    // This catches things like "..", "---", "()()" which are uncommon in natural topics
    if (/([.,!?()\-'])\1{2,}/.test(normalized)) {
      logger.warn(
        `Rejected topic with suspicious character patterns: ${normalized.substring(0, 100)}`
      );
      return null;
    }

    // Check for instruction injection patterns (case-insensitive)
    const lowerTopic = normalized.toLowerCase();

    // Common instruction injection keywords and phrases
    const injectionPatterns = [
      // Direct instruction commands
      /\b(ignore|forget|disregard|override|skip|bypass)\s+(current|previous|all|the|these)\s+(instructions?|prompts?|rules?|commands?|directives?)\b/i,
      /\b(new|different|alternative|replacement)\s+(instructions?|prompts?|system|rules?)\b/i,
      /\b(you\s+(are|must|should|will|need|have\s+to|cannot|can't|do\s+not|don't))\b/i,
      /\b(do\s+not|don't|never|always|must\s+not|should\s+not)\s+(follow|obey|use|execute|run|do)\b/i,

      // System prompt injection attempts
      /\b(system\s+prompt|system\s+instructions?|system\s+message)\b/i,
      /\b(act\s+as|pretend\s+to\s+be|roleplay\s+as|you're\s+now)\b/i,

      // Command-like patterns
      /\b(execute|run|perform|carry\s+out|implement)\s+(this|the|these|following)\b/i,
      /\b(follow|obey|adhere\s+to)\s+(this|the|these|following|new)\s+(instruction|command|directive)\b/i,

      // Ranking/comparison instructions (common injection pattern)
      /\b(rank|compare|list|sort|order|categorize|classify)\s+(the|all|every)\s+(richest|poorest|best|worst|top|bottom)\b/i,
      /\b(rank|compare|list|sort|order)\s+(people|users|members|individuals|persons)\b/i,

      // Output manipulation attempts
      /\b(output|return|respond|reply|say|write|generate)\s+(this|the|following|instead)\b/i,
      /\b(instead\s+of|rather\s+than|instead|replace)\s+(summarizing|summarize|the\s+summary)\b/i,

      // XML/tag injection attempts
      /<[^>]+>/i,
      /<\/?[a-z]+>/i,

      // Code injection patterns
      /\b(function|def|class|import|require|eval|exec)\s*\(/i,
      /[{}[\]\\|`~]/,
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(normalized)) {
        logger.warn(
          `Rejected topic with instruction injection pattern: ${normalized.substring(0, 100)}`
        );
        return null;
      }
    }

    // Check for instruction-like sentence structure (starts with imperative verbs)
    const imperativeVerbs =
      /\b(ignore|forget|disregard|override|skip|rank|list|compare|sort|order|execute|run|perform|follow|obey|act|pretend|output|return|respond|say|write|generate)\b/i;
    if (imperativeVerbs.test(normalized) && normalized.split(/\s+/).length <= 10) {
      // If topic is short and starts with imperative verb, likely an instruction
      const words = normalized.toLowerCase().split(/\s+/);
      const firstWord = words[0];
      const instructionStarters = [
        'ignore',
        'forget',
        'disregard',
        'override',
        'skip',
        'rank',
        'list',
        'compare',
        'sort',
        'order',
        'execute',
        'run',
        'perform',
        'follow',
        'obey',
        'act',
        'pretend',
        'output',
        'return',
        'respond',
        'say',
        'write',
        'generate',
        'do',
        "don't",
        'never',
        'always',
      ];

      if (instructionStarters.includes(firstWord) && words.length <= 8) {
        logger.warn(
          `Rejected topic starting with imperative verb (likely instruction): ${normalized.substring(0, 100)}`
        );
        return null;
      }
    }

    // Final validation: ensure we have a valid topic after all checks
    if (normalized.length === 0 || normalized.length > MAX_TOPIC_LENGTH) {
      return null;
    }

    return normalized;
  }

  private parseTLDRArgs(args: string[]): {
    input: string;
    style?: string;
    topicFocus?: string;
    username?: string;
  } {
    const validStyles = ['default', 'detailed', 'brief', 'bullet', 'timeline'];
    let input = '1h';
    let style: string | undefined;
    let username: string | undefined;
    const topicParts: string[] = [];

    for (const arg of args) {
      const lowerArg = arg.toLowerCase();

      // Check if it's a style
      if (validStyles.includes(lowerArg)) {
        style = lowerArg;
        continue;
      }

      // Check if it's a mention
      if (arg.startsWith('@')) {
        username = arg.slice(1);
        continue;
      }

      // Check if it's timeframe/count (only if we haven't set one yet)
      const isTimeframe =
        /^\d+(h|d|h)$/.test(lowerArg) ||
        ['day', 'week'].includes(lowerArg) ||
        /^\d+$/.test(lowerArg);

      if (isTimeframe && input === '1h') {
        input = lowerArg;
        continue;
      }

      // Otherwise, it's part of the topic focus
      topicParts.push(arg);
    }

    // Sanitize the topic before returning
    const rawTopic = topicParts.length > 0 ? topicParts.join(' ') : undefined;
    const sanitizedTopic = rawTopic ? this.sanitizeTopic(rawTopic) : undefined;

    return {
      input,
      style,
      username,
      topicFocus: sanitizedTopic || undefined,
    };
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
