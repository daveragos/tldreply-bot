import { Bot, Context, InlineKeyboard } from 'grammy';
import { ConversationFlavor } from '@grammyjs/conversations';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import { GeminiService } from '../services/gemini';

type MyContext = ConversationFlavor<Context>;

export class Commands {
  private db: Database;
  private encryption: EncryptionService;
  private bot: Bot<MyContext>;
  private setupState: Map<number, number> = new Map(); // userId -> chatId

  constructor(bot: Bot<MyContext>, db: Database, encryption: EncryptionService) {
    this.bot = bot;
    this.db = db;
    this.encryption = encryption;
    this.setupCommands();
  }

  private setupCommands() {
    // Private chat commands
    this.bot.command('start', this.handleStart.bind(this));
    this.bot.command('setup_group', this.handleSetupGroup.bind(this));
    this.bot.command('list_groups', this.handleListGroups.bind(this));
    this.bot.command('remove_group', this.handleRemoveGroup.bind(this));

    // Group chat commands
    this.bot.command('tldr', this.handleTLDR.bind(this));
    this.bot.command('tldr_info', this.handleTLDRInfo.bind(this));

    // Button handlers
    this.bot.callbackQuery('command_setup_group', this.handleButtonSetup.bind(this));
    this.bot.callbackQuery('command_list_groups', this.handleButtonList.bind(this));
    this.bot.callbackQuery('command_help', this.handleButtonHelp.bind(this));
    this.bot.callbackQuery('command_back', this.handleButtonBack.bind(this));

    // Message handler for caching
    this.bot.on('message', this.handleMessageCache.bind(this));
  }

  private async handleStart(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat) return;

    if (chat.type === 'private') {
      const keyboard = new InlineKeyboard()
        .text('📝 Setup Group', 'command_setup_group')
        .text('📋 List Groups', 'command_list_groups')
        .row()
        .url('🔑 Get API Key', 'https://makersuite.google.com/app/apikey')
        .text('ℹ️ Help', 'command_help');
      
      await ctx.reply(
        `👋 Welcome to TLDR Bot!\n\n` +
        `This bot helps summarize Telegram group chats using Google's Gemini AI.\n\n` +
        `<i>Use the buttons below or type commands to get started!</i>`,
        { 
          parse_mode: 'HTML',
          reply_markup: keyboard
        }
      );
    }
  }

  private async handleSetupGroup(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') {
      await ctx.reply('❌ This command can only be used in private chat.');
      return;
    }

    const args = ctx.message?.text?.split(' ') || [];
    if (args.length < 2) {
      await ctx.reply(
        '❌ Usage:\n' +
        '• For public groups: `/setup_group @group_username`\n' +
        '• For private groups: `/setup_group <chat_id>` (get ID by forwarding a message from the group to @userinfobot)',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const groupInput = args[1].replace('@', '');
    
    try {
      let chatInfo;
      
      // Check if it's a numeric ID (private group) or username (public group)
      if (/^-?\d+$/.test(groupInput)) {
        // Numeric ID - private group
        const chatId = parseInt(groupInput, 10);
        chatInfo = await ctx.api.getChat(chatId);
      } else {
        // Username - public group
        chatInfo = await ctx.api.getChat(`@${groupInput}`);
      }
      
      if (chatInfo.type === 'supergroup' || chatInfo.type === 'group') {
        await this.db.createGroup(chatInfo.id, chat.id);
        this.setupState.set(chat.id, chatInfo.id);
        await ctx.reply(
          `✅ Group found! Please provide your Gemini API key.\n\n` +
          `<i>You can get your API key from: https://makersuite.google.com/app/apikey</i>\n\n` +
          `<b>Security: Your API key will be encrypted and only used for this group.</b>`,
          { parse_mode: 'HTML' }
        );
        // Store temporary state for API key input
        await ctx.conversation.enter('setupApiKey');
      } else {
        await ctx.reply('❌ Invalid group. Please provide a valid group username or ID.');
      }
    } catch (error) {
      console.error('Error setting up group:', error);
      await ctx.reply(
        '❌ Could not find the group.\n\n' +
        '<b>For public groups:</b> Make sure the bot is added and you have the correct @username\n\n' +
        '<b>For private groups:</b>\n' +
        '1. Add @userinfobot to your group\n' +
        '2. Forward any message from your group to @userinfobot\n' +
        '3. It will reply with the chat ID\n' +
        '4. Use that ID with /setup_group',
        { parse_mode: 'HTML' }
      );
    }
  }

  private async handleApiKeyInput(ctx: MyContext) {
    // This will be handled by the conversation handler
  }

  private async handleButtonSetup(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '📝 <b>Setup a Group</b>\n\n' +
      '<b>For public groups:</b>\n' +
      '<code>/setup_group @your_group_username</code>\n\n' +
      '<b>For private groups:</b>\n' +
      '1. Add @userinfobot to your group\n' +
      '2. Forward a message to get chat ID\n' +
      '3. Use: <code>/setup_group chat_id</code>\n\n' +
      '<i>Example: /setup_group -123456789</i>',
      { parse_mode: 'HTML' }
    );
  }

  private async handleButtonList(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handleListGroups(ctx);
  }

  private async handleButtonHelp(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard()
      .url('📚 Full Documentation', 'https://makersuite.google.com/app/apikey')
      .row()
      .text('⬅️ Back', 'command_back');
    
    await ctx.reply(
      'ℹ️ <b>TLDR Bot Help</b>\n\n' +
      '<b>Private Chat Commands:</b>\n' +
      '• /setup_group - Configure a group\n' +
      '• /list_groups - List your groups\n' +
      '• /remove_group - Remove a group\n\n' +
      '<b>Group Chat Commands:</b>\n' +
      '• /tldr 1h - Summary of last hour\n' +
      '• /tldr 6h - Summary of last 6 hours\n' +
      '• /tldr day - Summary of last day\n' +
      '• Reply with /tldr - From that message\n' +
      '• /tldr_info - Group configuration\n\n' +
      '<i>Note: Each group needs a Gemini API key.</i>',
      { 
        parse_mode: 'HTML',
        reply_markup: keyboard
      }
    );
  }

  private async handleButtonBack(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handleStart(ctx);
  }

  private async handleListGroups(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') return;

    try {
      const groups = await this.db.listGroupsForUser(chat.id);
      
      if (groups.length === 0) {
        await ctx.reply('📭 You have not configured any groups yet.\n\nUse /setup_group to get started!');
        return;
      }

      let message = '📋 Your configured groups:\n\n';
      groups.forEach((group, idx) => {
        const status = group.gemini_api_key_encrypted ? '✅ Configured' : '⏳ Pending setup';
        message += `${idx + 1}. Group ID: ${group.telegram_chat_id} ${status}\n`;
      });

      await ctx.reply(message);
    } catch (error) {
      console.error('Error listing groups:', error);
      await ctx.reply('❌ Error retrieving groups.');
    }
  }

  private async handleRemoveGroup(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') {
      await ctx.reply('❌ This command can only be used in private chat.');
      return;
    }

    // TODO: Implement group removal
    await ctx.reply('⏳ Feature coming soon!');
  }

  private async handleTLDR(ctx: MyContext) {
    const chat = ctx.chat;
    let loadingMsg: any = null;
    
    if (!chat || chat.type === 'private') {
      await ctx.reply('❌ This command can only be used in a group.');
      return;
    }

    try {
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

      // Handle time-based summary
      const args = ctx.message?.text?.split(' ') || [];
      const timeframe = args[1] || '1h';
      const since = this.parseTimeframe(timeframe);

      loadingMsg = await ctx.reply('⏳ Generating summary...');

      const messages = await this.db.getMessagesSinceTimestamp(chat.id, since);
      if (messages.length === 0) {
        await ctx.api.editMessageText(chat.id, loadingMsg.message_id, '📭 No messages found in the specified time range.');
        return;
      }

      const decryptedKey = this.encryption.decrypt(group.gemini_api_key_encrypted);
      const gemini = new GeminiService(decryptedKey);
      const summary = await gemini.summarizeMessages(messages);

      await ctx.api.editMessageText(
        chat.id,
        loadingMsg.message_id,
        `📝 <b>TLDR Summary</b> (${timeframe})\n\n${summary}`,
        { parse_mode: 'HTML' }
      );
    } catch (error: any) {
      console.error('Error generating TLDR:', error);
      console.error('Error details:', error.message, error.status);
      
      // Try to edit the loading message to show error
      try {
        if (loadingMsg) {
          await ctx.api.editMessageText(chat.id, loadingMsg.message_id, '❌ Error generating summary. Please try again later.');
        } else {
          await ctx.reply('❌ Error generating summary. Please try again later.');
        }
      } catch (editError) {
        // If edit fails, send new message
        await ctx.reply('❌ Error generating summary. Please try again later.');
      }
    }
  }

  private async handleTLDRFromMessage(ctx: MyContext, fromMessageId: number) {
    let loadingMsg: any = null;
    const chat = ctx.chat!;
    
    try {
      const group = await this.db.getGroup(chat.id);
      const decryptedKey = this.encryption.decrypt(group.gemini_api_key_encrypted);

      loadingMsg = await ctx.reply('⏳ Generating summary...');

      const messages = await this.db.getMessagesSinceMessageId(chat.id, fromMessageId);
      if (messages.length === 0) {
        await ctx.api.editMessageText(chat.id, loadingMsg.message_id, '📭 No messages found from this point.');
        return;
      }

      const gemini = new GeminiService(decryptedKey);
      const summary = await gemini.summarizeMessages(messages);

      await ctx.api.editMessageText(
        chat.id,
        loadingMsg.message_id,
        `📝 <b>TLDR Summary</b> (from message)\n\n${summary}`,
        { parse_mode: 'HTML' }
      );
    } catch (error: any) {
      console.error('Error generating TLDR from message:', error);
      console.error('Error details:', error.message, error.status);
      
      try {
        if (loadingMsg) {
          await ctx.api.editMessageText(chat.id, loadingMsg.message_id, '❌ Error generating summary. Please try again later.');
        } else {
          await ctx.reply('❌ Error generating summary. Please try again later.');
        }
      } catch (editError) {
        await ctx.reply('❌ Error generating summary. Please try again later.');
      }
    }
  }

  private async handleTLDRInfo(ctx: MyContext) {
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
        `<i>Use /tldr [timeframe] or reply to a message with /tldr</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Error getting TLDR info:', error);
      await ctx.reply('❌ Error retrieving info.');
    }
  }

  private async handleMessageCache(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }

    // Don't cache bot commands or empty messages
    if (ctx.message?.text?.startsWith('/')) {
      return;
    }

    const content = ctx.message?.text || ctx.message?.caption || '';
    if (!content || !ctx.message) {
      return;
    }

    try {
      await this.db.insertMessage({
        chatId: chat.id,
        messageId: ctx.message.message_id,
        userId: ctx.from?.id,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        content: content.substring(0, 5000), // Limit content length
      });
    } catch (error) {
      console.error('Error caching message:', error);
    }
  }

  private parseTimeframe(timeframe: string): Date {
    const now = Date.now();
    let hours = 1;

    if (timeframe.endsWith('h')) {
      hours = parseInt(timeframe.slice(0, -1), 10) || 1;
    } else if (timeframe.endsWith('d') || timeframe === 'day') {
      hours = timeframe === 'day' ? 24 : parseInt(timeframe.slice(0, -1), 10) * 24 || 24;
    } else if (timeframe === 'week') {
      hours = 168;
    } else {
      hours = 1; // Default to 1 hour
    }

    return new Date(now - hours * 60 * 60 * 1000);
  }
}
