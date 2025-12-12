import { Bot, Context, InlineKeyboard } from 'grammy';
import { ConversationFlavor } from '@grammyjs/conversations';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import { GeminiService } from '../services/gemini';
import { setUpdateState, clearUpdateState, getUpdateState } from '../services/services';

type MyContext = ConversationFlavor<Context>;

export class Commands {
  private db: Database;
  private encryption: EncryptionService;
  private bot: Bot<MyContext>;
  private setupState: Map<number, number> = new Map(); // userId -> chatId
  // Rate limiting: track last command time per user/group
  private rateLimitMap: Map<string, number> = new Map(); // key -> timestamp
  private readonly RATE_LIMIT_SECONDS = 30; // 30 seconds between commands
  constructor(bot: Bot<MyContext>, db: Database, encryption: EncryptionService) {
    this.bot = bot;
    this.db = db;
    this.encryption = encryption;
    this.setupCommands();
  }

  /**
   * Check if a user is an admin or creator of a group
   */
  private async isAdminOrCreator(ctx: MyContext, chatId: number, userId: number): Promise<boolean> {
    try {
      const member = await ctx.api.getChatMember(chatId, userId);
      return member.status === 'administrator' || member.status === 'creator';
    } catch (error) {
      console.error('Error checking admin status:', error);
      return false;
    }
  }

  private setupCommands() {
    // Private chat commands
    this.bot.command('start', this.handleStart.bind(this));
    this.bot.command('help', this.handleHelp.bind(this));
    this.bot.command('setup_group', this.handleSetupGroup.bind(this));
    this.bot.command('list_groups', this.handleListGroups.bind(this));
    this.bot.command('remove_group', this.handleRemoveGroup.bind(this));
    this.bot.command('continue_setup', this.handleContinueSetup.bind(this));
    this.bot.command('update_api_key', this.handleUpdateApiKey.bind(this));

    // Group chat commands
    this.bot.command('setup', this.handleSetup.bind(this));
    this.bot.command('tldr', this.handleTLDR.bind(this));
    this.bot.command('tldr_info', this.handleTLDRInfo.bind(this));
    this.bot.command('tldr_settings', this.handleTLDRSettings.bind(this));
    this.bot.command('tldr_help', this.handleTLDRHelp.bind(this));
    this.bot.command('schedule', this.handleSchedule.bind(this));
    this.bot.command('filter', this.handleFilter.bind(this));
    this.bot.command('enable', this.handleEnable.bind(this));
    this.bot.command('disable', this.handleDisable.bind(this));

    // Button handlers
    this.bot.callbackQuery('command_setup_group', this.handleButtonSetup.bind(this));
    this.bot.callbackQuery('command_list_groups', this.handleButtonList.bind(this));
    this.bot.callbackQuery('command_help', this.handleButtonHelp.bind(this));
    this.bot.callbackQuery('command_back', this.handleButtonBack.bind(this));
    this.bot.callbackQuery('command_continue_setup', async (ctx: MyContext) => {
      await ctx.answerCallbackQuery();
      await this.handleContinueSetup(ctx);
    });

    // Remove group button handlers
    this.bot.callbackQuery(/^remove_group_(-?\d+)$/, this.handleRemoveGroupButton.bind(this));
    this.bot.callbackQuery('cancel_remove', async (ctx: MyContext) => {
      await ctx.answerCallbackQuery('Cancelled');
      await ctx.editMessageText('❌ Group removal cancelled.');
    });

    // Update API key button handlers
    this.bot.callbackQuery(/^update_key_(-?\d+)$/, this.handleUpdateApiKeyButton.bind(this));

    // Settings button handlers
    this.bot.callbackQuery('settings_style', this.handleSettingsStyle.bind(this));
    this.bot.callbackQuery('settings_prompt', this.handleSettingsPrompt.bind(this));
    this.bot.callbackQuery('settings_filter', this.handleSettingsFilterMenu.bind(this));
    this.bot.callbackQuery('settings_schedule', this.handleSchedule.bind(this));
    this.bot.callbackQuery('settings_view', this.handleSettingsView.bind(this));
    this.bot.callbackQuery('settings_back', this.handleSettingsBack.bind(this));

    // Schedule button handlers
    this.bot.callbackQuery(/^schedule_toggle_(-?\d+)$/, this.handleScheduleToggle.bind(this));
    this.bot.callbackQuery(
      /^schedule_freq_(daily|weekly)_(-?\d+)$/,
      this.handleScheduleFrequency.bind(this)
    );

    // Filter button handlers
    this.bot.callbackQuery(/^filter_bot_(-?\d+)$/, this.handleFilterBot.bind(this));
    this.bot.callbackQuery(/^filter_cmd_(-?\d+)$/, this.handleFilterCmd.bind(this));
    this.bot.callbackQuery(/^filter_users_(-?\d+)$/, this.handleFilterUsers.bind(this));

    // Style button handlers
    this.setupStyleHandlers();

    // Message handler for caching
    this.bot.on('message', this.handleMessageCache.bind(this));

    // Handle edited messages - update the cached message content
    this.bot.on('edited_message', this.handleEditedMessageCache.bind(this));
  }

  private async handleStart(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat) return;

    if (chat.type === 'private') {
      // Check if user has a pending group setup
      try {
        const pendingGroups = await this.db.query(
          'SELECT telegram_chat_id FROM groups WHERE setup_by_user_id = $1 AND gemini_api_key_encrypted IS NULL ORDER BY setup_at DESC LIMIT 1',
          [chat.id]
        );

        if (pendingGroups.rows.length > 0) {
          const groupChatId = pendingGroups.rows[0].telegram_chat_id;
          const keyboard = new InlineKeyboard()
            .text('🔑 Continue Setup', 'command_continue_setup')
            .text('📋 List Groups', 'command_list_groups')
            .row()
            .url('⭐ Give a Star', 'https://github.com/daveragos/tldreply-bot');

          await ctx.reply(
            `👋 Welcome back!\n\n` +
              `⚠️ You have a pending group setup (Chat ID: <code>${groupChatId}</code>)\n\n` +
              `Please provide your Gemini API key to complete the setup.\n\n` +
              `Run /continue_setup to provide your API key.`,
            {
              parse_mode: 'HTML',
              reply_markup: keyboard,
            }
          );
          return;
        }
      } catch (error) {
        console.error('Error checking pending setups:', error);
      }

      const keyboard = new InlineKeyboard()
        .text('📝 Setup Group', 'command_setup_group')
        .text('📋 List Groups', 'command_list_groups')
        .row()
        .url('🔑 Get API Key', 'https://makersuite.google.com/app/apikey')
        .text('ℹ️ Help', 'command_help')
        .row()
        .url('⭐ Give a Star', 'https://github.com/daveragos/tldreply-bot');

      await ctx.reply(
        `👋 Welcome to TLDR Bot!\n\n` +
          `This bot helps summarize Telegram group chats using Google's Gemini AI.\n\n` +
          `🔒 <b>Privacy:</b> Messages are cached for up to 48 hours and automatically deleted.\n\n` +
          `<i>Use the buttons below or type commands to get started!</i>\n\n` +
          `<b>💡 Tip:</b> You can run /setup directly in your group to start setup!`,
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }
      );
    }
  }

  private async handleSetup(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat) return;

    // Only work in groups
    if (chat.type === 'private') {
      await ctx.reply(
        '❌ This command should be used in a group chat.\n\n' +
          '<b>Alternative:</b> Use /setup_group in private chat to setup by username or chat ID.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      await ctx.reply('❌ This command can only be used in group chats.');
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ Could not identify user.');
      return;
    }

    // Check if user is admin or creator
    const isAdmin = await this.isAdminOrCreator(ctx, chat.id, userId);
    if (!isAdmin) {
      await ctx.reply(
        '❌ Only group admins can configure the bot.\n\n' +
          'Please ask an admin to run this command.'
      );
      return;
    }

    try {
      // Check if group already exists and is configured
      const existingGroup = await this.db.getGroup(chat.id);
      if (existingGroup && existingGroup.gemini_api_key_encrypted) {
        await ctx.reply(
          '✅ This group is already configured!\n\n' +
            'You can use /tldr to get summaries.\n' +
            'Run /tldr_info for more details.'
        );
        return;
      }

      // Create or update group entry linked to this user
      await this.db.createGroup(chat.id, userId);
      // Create default settings for the group
      await this.db.createGroupSettings(chat.id);

      const groupName = 'title' in chat ? chat.title : 'this group';

      await ctx.reply(
        `✅ <b>Setup started for "${groupName}"!</b>\n\n` +
          `<b>Next steps:</b>\n` +
          `1. Open a private chat with me (@${ctx.me.username})\n` +
          `2. Run /continue_setup\n` +
          `3. Provide your Gemini API key\n\n` +
          `<i>💡 The group ID has been automatically detected. No need to find it manually!</i>\n\n` +
          `<i>Get your API key: https://makersuite.google.com/app/apikey</i>`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }
      );
    } catch (error) {
      console.error('Error setting up group:', error);
      await ctx.reply('❌ Error starting setup. Please try again.');
    }
  }

  private async handleContinueSetup(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') {
      await ctx.reply('❌ This command can only be used in private chat.');
      return;
    }

    try {
      // Check for pending group setup
      const pendingGroups = await this.db.query(
        'SELECT telegram_chat_id FROM groups WHERE setup_by_user_id = $1 AND gemini_api_key_encrypted IS NULL ORDER BY setup_at DESC LIMIT 1',
        [chat.id]
      );

      if (pendingGroups.rows.length === 0) {
        await ctx.reply(
          '❌ No pending group setup found.\n\n' +
            '<b>To start setup:</b>\n' +
            '• Run /setup in your group (easiest!)\n' +
            '• Or run /setup_group in private chat',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const groupChatId = pendingGroups.rows[0].telegram_chat_id;

      // Verify the group still exists and bot is in it
      try {
        const chatInfo = await ctx.api.getChat(groupChatId);

        // Verify user is still admin of the group
        const isAdmin = await this.isAdminOrCreator(ctx, groupChatId, chat.id);
        if (!isAdmin) {
          await ctx.reply(
            '❌ You must be an admin of the group to complete setup.\n\n' +
              'If you were removed as admin, please ask a current admin to run /setup in the group.'
          );
          return;
        }

        const groupName = 'title' in chatInfo ? chatInfo.title : `Group ${groupChatId}`;

        await ctx.reply(
          `✅ Found pending setup for: <b>${groupName}</b>\n\n` +
            `Please paste your Gemini API key to complete the setup.\n\n` +
            `<i>Get your API key from:</i>\n` +
            `https://makersuite.google.com/app/apikey\n\n` +
            `<b>🔒 Security:</b> Your API key will be encrypted and only used for this group.`,
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          }
        );

        await ctx.conversation.enter('setupApiKey');
      } catch (error) {
        await ctx.reply(
          '❌ Could not access the group. Please make sure:\n' +
            '• The bot is still in the group\n' +
            '• The group exists\n\n' +
            'Try running /setup in your group again.'
        );
      }
    } catch (error) {
      console.error('Error continuing setup:', error);
      await ctx.reply('❌ Error. Please try again.');
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
        '❌ Usage:\n\n' +
          '<b>For public groups (with @username):</b>\n' +
          '<code>/setup_group @group_username</code>\n\n' +
          '<b>For private groups (no @username):</b>\n' +
          '<code>/setup_group &lt;chat_id&gt;</code>\n\n' +
          '<i>To get the chat ID for a private group:</i>\n' +
          '1. Add @userinfobot to your group\n' +
          '2. Forward any message from your group to @userinfobot\n' +
          '3. It will reply with the chat ID (looks like: <code>-123456789</code>)\n' +
          '4. Use that ID: <code>/setup_group -123456789</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const groupInput = args[1].replace('@', '');

    try {
      let chatInfo: any;
      const isPrivateGroup = /^-?\d+$/.test(groupInput);

      // Check if it's a numeric ID (private group) or username (public group)
      if (isPrivateGroup) {
        // Numeric ID - private group
        const chatId = parseInt(groupInput, 10);

        // Verify bot is in the group by trying to get chat info
        chatInfo = await ctx.api.getChat(chatId);

        // Additional verification: check if it's actually a group/supergroup
        if (chatInfo.type !== 'supergroup' && chatInfo.type !== 'group') {
          await ctx.reply(
            "❌ Invalid chat type. Please make sure you're using a group chat ID, not a private chat ID.\n\n" +
              '<b>Private group chat IDs</b> are negative numbers (e.g., <code>-123456789</code>).',
            { parse_mode: 'HTML' }
          );
          return;
        }
      } else {
        // Username - public group
        chatInfo = await ctx.api.getChat(`@${groupInput}`);
      }

      if (chatInfo.type === 'supergroup' || chatInfo.type === 'group') {
        // Verify the bot can actually access this group
        // (getChat will fail if bot is not a member, which is good)

        const chatId = chatInfo.id as number;

        // Check if user is admin or creator of the group
        const isAdmin = await this.isAdminOrCreator(ctx, chatId, chat.id);
        if (!isAdmin) {
          await ctx.reply(
            '❌ Only group admins can configure the bot.\n\n' +
              'Please ask an admin to run this command.',
            { parse_mode: 'HTML' }
          );
          return;
        }

        // Check if group already exists
        const existingGroup = await this.db.getGroup(chatId);
        if (existingGroup && existingGroup.gemini_api_key_encrypted) {
          await ctx.reply(
            '⚠️ This group is already configured!\n\n' +
              'If you want to update the API key, please use /remove_group first, then set it up again.',
            { parse_mode: 'HTML' }
          );
          return;
        }

        await this.db.createGroup(chatId, chat.id);
        this.setupState.set(chat.id, chatId);

        const groupName = 'title' in chatInfo ? chatInfo.title : `Group ${chatId}`;

        await ctx.reply(
          `✅ Group "<b>${groupName}</b>" found!\n\n` +
            `Please provide your Gemini API key in the next message.\n\n` +
            `<i>You can get your API key from:</i>\n` +
            `https://makersuite.google.com/app/apikey\n\n` +
            `<b>🔒 Security:</b> Your API key will be encrypted and only used for this group.`,
          { parse_mode: 'HTML' }
        );
        // Store temporary state for API key input
        await ctx.conversation.enter('setupApiKey');
      } else {
        await ctx.reply('❌ Invalid group type. Please provide a valid group or supergroup.');
      }
    } catch (error: any) {
      console.error('Error setting up group:', error);

      const isPrivateGroup = /^-?\d+$/.test(args[1]?.replace('@', '') || '');

      if (isPrivateGroup) {
        // Private group specific error
        await ctx.reply(
          '❌ <b>Could not access the private group.</b>\n\n' +
            '<b>Please verify:</b>\n' +
            '1. ✅ The bot is added to your private group\n' +
            '2. ✅ You used the correct chat ID (negative number like <code>-123456789</code>)\n' +
            '3. ✅ The bot has necessary permissions in the group\n\n' +
            '<b>To get the chat ID:</b>\n' +
            '1. Add @userinfobot to your group\n' +
            '2. Forward any message from your group to @userinfobot\n' +
            '3. Copy the chat ID it provides\n' +
            '4. Make sure the bot is in the group before running /setup_group',
          { parse_mode: 'HTML' }
        );
      } else {
        // Public group specific error
        await ctx.reply(
          '❌ <b>Could not find the public group.</b>\n\n' +
            '<b>Please verify:</b>\n' +
            '1. ✅ The group has a public @username\n' +
            '2. ✅ You spelled the username correctly (case-sensitive)\n' +
            '3. ✅ The bot is added to the group\n\n' +
            '<i>Example: /setup_group @mygroup</i>',
          { parse_mode: 'HTML' }
        );
      }
    }
  }

  private async handleApiKeyInput(ctx: MyContext) {
    // This will be handled by the conversation handler
  }

  private async handleButtonSetup(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '📝 <b>Setup a Group</b>\n\n' +
        '<b>✨ Easiest Method (Recommended):</b>\n' +
        '1. Add the bot to your group\n' +
        '2. Run <code>/setup</code> directly in the group\n' +
        '3. Follow the prompts to provide your API key\n\n' +
        '<b>Alternative Method:</b>\n' +
        '<b>For public groups:</b>\n' +
        '<code>/setup_group @your_group_username</code>\n\n' +
        '<b>For private groups:</b>\n' +
        '<code>/setup_group &lt;chat_id&gt;</code>\n' +
        '(Get chat ID by forwarding a message to @userinfobot)',
      { parse_mode: 'HTML' }
    );
  }

  private async handleButtonList(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handleListGroups(ctx);
  }

  private async handleHelp(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat) return;

    if (chat.type === 'private') {
      await this.handlePrivateHelp(ctx);
    } else {
      await this.handleGroupHelp(ctx);
    }
  }

  private async handlePrivateHelp(ctx: MyContext) {
    const keyboard = new InlineKeyboard()
      .text('📝 Setup Group', 'command_setup_group')
      .text('📋 List Groups', 'command_list_groups')
      .row()
      .url('🔑 Get API Key', 'https://makersuite.google.com/app/apikey')
      .text('⬅️ Back', 'command_back')
      .row()
      .url('⭐ Give a Star', 'https://github.com/daveragos/tldreply-bot');

    await ctx.reply(
      'ℹ️ <b>TLDR Bot Help - Private Chat</b>\n\n' +
        '<b>📋 Commands:</b>\n\n' +
        '<b>/start</b> - Welcome message\n' +
        '<i>Shows welcome screen and pending setups</i>\n\n' +
        '<b>/setup_group @group</b> or <b>/setup_group &lt;chat_id&gt;</b>\n' +
        '<i>Configure a group manually</i>\n' +
        '<i>Example: /setup_group @mygroup or /setup_group -123456789</i>\n\n' +
        '<b>/continue_setup</b>\n' +
        '<i>Complete a pending group setup with API key</i>\n\n' +
        '<b>/list_groups</b>\n' +
        '<i>List all your configured groups</i>\n\n' +
        '<b>/update_api_key &lt;chat_id&gt; [api_key]</b>\n' +
        '<i>Update API key for a group</i>\n' +
        '<i>Examples:</i>\n' +
        '<code>/update_api_key -123456789</code> - Interactive mode\n' +
        '<code>/update_api_key -123456789 AIza...</code> - Direct update\n\n' +
        '<b>/remove_group &lt;chat_id&gt;</b>\n' +
        '<i>Remove a group configuration</i>\n' +
        '<i>Example: /remove_group -123456789</i>\n\n' +
        '<b>💡 Tip:</b> Run /setup in your group for the easiest setup!\n\n' +
        '<b>🔑 Get API Key:</b> https://makersuite.google.com/app/apikey',
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }
    );
  }

  private async handleGroupHelp(ctx: MyContext) {
    await ctx.reply(
      'ℹ️ <b>TLDR Bot Help - Group Chat</b>\n\n' +
        '<b>📋 Commands:</b>\n\n' +
        '<b>/setup</b>\n' +
        '<i>Start group setup (admin only)</i>\n\n' +
        '<b>/tldr [timeframe or count] [style]</b>\n' +
        '<i>Get summary for a time period or message count</i>\n' +
        '<i>Examples:</i>\n' +
        '<code>/tldr</code> or <code>/tldr 1h</code> - Last hour\n' +
        '<code>/tldr 6h</code> - Last 6 hours\n' +
        '<code>/tldr 30h</code> - Last 30 hours\n' +
        '<code>/tldr day</code> or <code>/tldr 1 day</code> or <code>/tldr 1d</code> - Last day\n' +
        '<code>/tldr 2d</code> or <code>/tldr 2 days</code> - Last 2 days\n' +
        '<code>/tldr 3d</code> or <code>/tldr 3 days</code> - Last 3 days\n' +
        '<code>/tldr week</code> or <code>/tldr 1 week</code> - Last week\n' +
        '<code>/tldr 300</code> - Last 300 messages\n\n' +
        '<b>Style options:</b> Add style at the end (e.g., <code>/tldr 1h detailed</code>)\n' +
        '• <code>default</code> - Balanced summary with bullet points\n' +
        '• <code>detailed</code> - Comprehensive summary with all details\n' +
        '• <code>brief</code> - Very concise, only key points\n' +
        '• <code>bullet</code> - Organized as bullet list\n' +
        '• <code>timeline</code> - Chronological order of events\n' +
        "<i>If no style is specified, uses the group's default style set by admin.</i>\n\n" +
        '<b>Reply to message + /tldr [style]</b>\n' +
        '<i>Summarize from that message to now (optionally with style)</i>\n\n' +
        '<b>/tldr_info</b>\n' +
        '<i>Show group configuration and status</i>\n\n' +
        '<b>/tldr_settings</b>\n' +
        '<i>Manage summary settings (admin only)</i>\n' +
        '<i>Customize style, filters, scheduling</i>\n\n' +
        '<b>/schedule</b>\n' +
        '<i>Set up automatic daily/weekly summaries (admin only)</i>\n\n' +
        '<b>/filter</b>\n' +
        '<i>Configure message filtering (admin only)</i>\n' +
        '<i>Exclude bots, commands, or specific users</i>\n\n' +
        '<b>/enable</b>\n' +
        '<i>Enable TLDR bot for this group (admin only)</i>\n\n' +
        '<b>/disable</b>\n' +
        '<i>Disable TLDR bot for this group (admin only)</i>',
      { parse_mode: 'HTML' }
    );
  }

  private async handleTLDRHelp(ctx: MyContext) {
    await this.handleGroupHelp(ctx);
  }

  private async handleButtonHelp(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handlePrivateHelp(ctx);
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
        await ctx.reply(
          '📭 You have not configured any groups yet.\n\nUse /setup_group to get started!'
        );
        return;
      }

      let message = '📋 <b>Your configured groups:</b>\n\n';

      for (let idx = 0; idx < groups.length; idx++) {
        const group = groups[idx];
        const status = group.gemini_api_key_encrypted ? '✅ Configured' : '⏳ Pending setup';

        // Try to get group name
        let groupName = `Group ${group.telegram_chat_id}`;
        try {
          const chatInfo = await ctx.api.getChat(group.telegram_chat_id);
          if ('title' in chatInfo && chatInfo.title) {
            groupName = chatInfo.title;
          }
        } catch (error) {
          // Group might not exist or bot not in it anymore
          groupName = `Group ${group.telegram_chat_id}`;
        }

        message += `${idx + 1}. <b>${groupName}</b>\n`;
        message += `   ID: <code>${group.telegram_chat_id}</code>\n`;
        message += `   Status: ${status}\n\n`;
      }

      message += '<i>💡 Use the chat ID with /remove_group to remove a group</i>';

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Error listing groups:', error);
      await ctx.reply('❌ Error retrieving groups.');
    }
  }

  private async handleUpdateApiKey(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') {
      await ctx.reply('❌ This command can only be used in private chat.');
      return;
    }

    try {
      // Get all configured groups for this user (only ones with API keys)
      const allGroups = await this.db.listGroupsForUser(chat.id);
      const configuredGroups = allGroups.filter(g => g.gemini_api_key_encrypted);

      if (configuredGroups.length === 0) {
        await ctx.reply(
          '📭 You have no configured groups to update.\n\n' +
            'Use /setup_group or /setup to configure a group first.'
        );
        return;
      }

      // Check if group ID was provided as argument
      const args = ctx.message?.text?.split(' ') || [];
      if (args.length >= 2) {
        const groupIdInput = args[1].replace('@', '');
        const chatId = parseInt(groupIdInput, 10);

        if (isNaN(chatId)) {
          await ctx.reply(
            '❌ Invalid group ID format.\n\n' +
              'Usage: `/update_api_key <chat_id> [api_key]`\n\n' +
              'Examples:\n' +
              '• `/update_api_key -123456789` - Interactive mode\n' +
              '• `/update_api_key -123456789 AIza...` - Direct update\n\n' +
              'Run `/list_groups` to see your groups and their IDs.',
            { parse_mode: 'HTML' }
          );
          return;
        }

        // Verify the group belongs to this user and is configured
        const group = configuredGroups.find(g => g.telegram_chat_id === chatId);
        if (!group) {
          // Check if group exists but doesn't have API key
          const groupExists = allGroups.find(g => g.telegram_chat_id === chatId);
          if (groupExists) {
            await ctx.reply(
              '❌ Group found but not configured with an API key.\n\n' +
                'Please complete the setup first using /setup_group or /setup.',
              { parse_mode: 'HTML' }
            );
          } else {
            await ctx.reply(
              '❌ Group not found.\n\n' + 'Run `/list_groups` to see your configured groups.',
              { parse_mode: 'HTML' }
            );
          }
          return;
        }

        // Verify user is still admin of the group
        try {
          const chatInfo = await ctx.api.getChat(chatId);
          const isAdmin = await this.isAdminOrCreator(ctx, chatId, chat.id);
          if (!isAdmin) {
            await ctx.reply(
              '❌ You must be an admin of the group to update the API key.\n\n' +
                'If you were removed as admin, please ask a current admin to update it.'
            );
            return;
          }
        } catch (error) {
          await ctx.reply(
            '❌ Could not access the group. Please make sure:\n' +
              '• The bot is still in the group\n' +
              '• The group exists\n' +
              '• You are still an admin'
          );
          return;
        }

        // Check if API key was provided as second argument
        if (args.length >= 3) {
          // Direct update mode - API key provided as argument
          const apiKey = args.slice(2).join(' ').trim();

          // Import the validation function (we'll need to export it or move it)
          // For now, let's do the validation inline
          if (!GeminiService.validateApiKey(apiKey)) {
            await ctx.reply('❌ Invalid API key format. Please check your key and try again.');
            return;
          }

          // Test and update the API key
          try {
            const gemini = new GeminiService(apiKey);
            await gemini.summarizeMessages([
              { content: 'test', timestamp: new Date().toISOString() },
            ]);

            const encryptedKey = this.encryption.encrypt(apiKey);
            await this.db.updateGroupApiKey(chatId, encryptedKey);

            await ctx.reply(
              '✅ API key updated successfully! The bot will now use the new key for summaries.'
            );
          } catch (error: any) {
            const errorMessage = error.message || 'Unknown error';
            if (
              errorMessage.includes('Invalid API key') ||
              errorMessage.includes('API_KEY_INVALID') ||
              errorMessage.includes('401')
            ) {
              await ctx.reply(
                '❌ Invalid API key. Please check your key and try again.\n\n💡 Get a new key from: https://makersuite.google.com/app/apikey'
              );
            } else if (
              errorMessage.includes('quota') ||
              errorMessage.includes('QUOTA_EXCEEDED') ||
              errorMessage.includes('429')
            ) {
              await ctx.reply(
                '❌ API quota exceeded. Please try again later or check your API usage.'
              );
            } else {
              await ctx.reply(
                `❌ Failed to validate API key: ${errorMessage}. Please check your key and try again.`
              );
            }
          }
          return;
        }

        // Interactive mode - no API key provided, enter conversation
        setUpdateState(chat.id, chatId);

        // Send prompt message before entering conversation
        await ctx.reply('Please paste your new Gemini API key:');

        // Enter update conversation
        await ctx.conversation.enter('updateApiKey', { overwrite: true });
        return;
      }

      // No argument provided - show interactive list
      if (configuredGroups.length === 1) {
        // Only one configured group - start update directly
        const group = configuredGroups[0];

        // Verify user is still admin
        try {
          const chatInfo = await ctx.api.getChat(group.telegram_chat_id);
          const isAdmin = await this.isAdminOrCreator(ctx, group.telegram_chat_id, chat.id);
          if (!isAdmin) {
            await ctx.reply(
              '❌ You must be an admin of the group to update the API key.\n\n' +
                'If you were removed as admin, please ask a current admin to update it.'
            );
            return;
          }

          let groupName = `Group ${group.telegram_chat_id}`;
          if ('title' in chatInfo && chatInfo.title) {
            groupName = chatInfo.title;
          }

          await ctx.reply(
            `🔄 <b>Update API Key</b>\n\n` +
              `Group: <b>${groupName}</b>\n` +
              `ID: <code>${group.telegram_chat_id}</code>\n\n` +
              `Please paste your new Gemini API key:`,
            {
              parse_mode: 'HTML',
            }
          );

          // Store the group ID for the conversation
          setUpdateState(chat.id, group.telegram_chat_id);

          await ctx.conversation.enter('updateApiKey', { overwrite: true });
        } catch (error) {
          await ctx.reply(
            '❌ Could not access the group. Please make sure the bot is in the group and you are an admin.'
          );
        }
      } else {
        // Multiple groups - show list with inline keyboard buttons
        const keyboard = new InlineKeyboard();
        let message = '🔄 <b>Update API Key</b>\n\n';
        message += 'Select a group to update:\n\n';

        for (let idx = 0; idx < configuredGroups.length; idx++) {
          const group = configuredGroups[idx];
          let groupName = `Group ${group.telegram_chat_id}`;

          try {
            const chatInfo = await ctx.api.getChat(group.telegram_chat_id);
            if ('title' in chatInfo && chatInfo.title) {
              groupName = chatInfo.title;
            }
          } catch (error) {
            // Group might not exist or bot not in it
          }

          message += `${idx + 1}. <b>${groupName}</b>\n`;
          message += `   ID: <code>${group.telegram_chat_id}</code>\n\n`;

          keyboard.text(
            `${idx + 1}. ${groupName.substring(0, 30)}`,
            `update_key_${group.telegram_chat_id}`
          );
          if ((idx + 1) % 2 === 0 || idx === configuredGroups.length - 1) {
            keyboard.row();
          }
        }

        await ctx.reply(message, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      }
    } catch (error) {
      console.error('Error updating API key:', error);
      await ctx.reply('❌ Error. Please try again.');
    }
  }

  private async handleRemoveGroup(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') {
      await ctx.reply('❌ This command can only be used in private chat.');
      return;
    }

    try {
      // Get all groups for this user
      const groups = await this.db.listGroupsForUser(chat.id);

      if (groups.length === 0) {
        await ctx.reply('📭 You have not configured any groups to remove.');
        return;
      }

      // Check if group ID was provided as argument
      const args = ctx.message?.text?.split(' ') || [];
      if (args.length >= 2) {
        const groupIdInput = args[1].replace('@', '');
        const chatId = parseInt(groupIdInput, 10);

        if (isNaN(chatId)) {
          await ctx.reply(
            '❌ Invalid group ID format.\n\n' +
              'Usage: `/remove_group <chat_id>`\n\n' +
              'Example: `/remove_group -123456789`\n\n' +
              'Run `/list_groups` to see your groups and their IDs.',
            { parse_mode: 'HTML' }
          );
          return;
        }

        // Verify the group belongs to this user
        const group = groups.find(g => g.telegram_chat_id === chatId);
        if (!group) {
          await ctx.reply(
            "❌ Group not found or you don't have permission to remove it.\n\n" +
              'Run `/list_groups` to see your groups.',
            { parse_mode: 'HTML' }
          );
          return;
        }

        // Verify user is still admin of the group (if group still exists)
        try {
          const chatInfo = await ctx.api.getChat(chatId);
          const isAdmin = await this.isAdminOrCreator(ctx, chatId, chat.id);
          if (!isAdmin) {
            await ctx.reply(
              '❌ You must be an admin of the group to remove it.\n\n' +
                'If you were removed as admin, contact a current admin to remove the bot.'
            );
            return;
          }
        } catch (error) {
          // Group might not exist or bot might not be in it anymore
          // Still allow removal since it's just cleaning up the database
          console.log('Could not verify group access, proceeding with removal:', error);
        }

        // Delete the group (messages will be cascade deleted)
        const deleted = await this.db.deleteGroup(chatId);
        if (deleted) {
          await ctx.reply(
            `✅ Group removed successfully!\n\n` +
              `All cached messages for this group have been deleted.\n\n` +
              `To set it up again, run /setup in the group or /setup_group in private chat.`
          );
        } else {
          await ctx.reply('❌ Group not found in database.');
        }
        return;
      }

      // No argument provided - show interactive list
      if (groups.length === 1) {
        // Only one group - ask for confirmation
        const group = groups[0];
        const keyboard = new InlineKeyboard()
          .text('✅ Yes, remove it', `remove_group_${group.telegram_chat_id}`)
          .text('❌ Cancel', 'cancel_remove');

        await ctx.reply(
          `🗑️ <b>Remove Group</b>\n\n` +
            `Group ID: <code>${group.telegram_chat_id}</code>\n` +
            `Status: ${group.gemini_api_key_encrypted ? '✅ Configured' : '⏳ Pending setup'}\n\n` +
            `Are you sure you want to remove this group? This will delete all cached messages.\n\n` +
            `<i>Or use: /remove_group ${group.telegram_chat_id}</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          }
        );
      } else {
        // Multiple groups - show list with inline keyboard buttons
        const keyboard = new InlineKeyboard();
        let message = '🗑️ <b>Remove Group</b>\n\n';
        message += 'Select a group to remove:\n\n';

        groups.forEach((group, idx) => {
          const status = group.gemini_api_key_encrypted ? '✅ Configured' : '⏳ Pending';
          let groupName = `Group ${group.telegram_chat_id}`;

          try {
            // Try to get group name (will be async, but we'll handle it)
            ctx.api
              .getChat(group.telegram_chat_id)
              .then(chatInfo => {
                if ('title' in chatInfo && chatInfo.title) {
                  groupName = chatInfo.title;
                }
              })
              .catch(() => {});
          } catch (error) {
            // Ignore
          }

          message += `${idx + 1}. <b>${groupName}</b>\n`;
          message += `   ID: <code>${group.telegram_chat_id}</code> ${status}\n\n`;

          keyboard.text(
            `🗑️ ${groupName.substring(0, 25)}`,
            `remove_group_${group.telegram_chat_id}`
          );
          if ((idx + 1) % 2 === 0 || idx === groups.length - 1) {
            keyboard.row();
          }
        });

        await ctx.reply(message, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      }
    } catch (error) {
      console.error('Error removing group:', error);
      await ctx.reply('❌ Error removing group. Please try again.');
    }
  }

  private async handleRemoveGroupButton(ctx: MyContext) {
    await ctx.answerCallbackQuery();

    if (!ctx.callbackQuery || !ctx.callbackQuery.data) {
      await ctx.editMessageText('❌ Invalid callback data.');
      return;
    }

    const match = ctx.callbackQuery.data.match(/^remove_group_(-?\d+)$/);
    if (!match) {
      await ctx.editMessageText('❌ Invalid group ID.');
      return;
    }

    const chatId = parseInt(match[1], 10);
    const chat = ctx.chat;

    if (!chat || chat.type !== 'private') {
      await ctx.editMessageText('❌ This can only be used in private chat.');
      return;
    }

    try {
      // Verify the group belongs to this user
      const groups = await this.db.listGroupsForUser(chat.id);
      const group = groups.find(g => g.telegram_chat_id === chatId);

      if (!group) {
        await ctx.editMessageText("❌ Group not found or you don't have permission to remove it.");
        return;
      }

      // Verify user is still admin of the group (if group still exists)
      try {
        const chatInfo = await ctx.api.getChat(chatId);
        const isAdmin = await this.isAdminOrCreator(ctx, chatId, chat.id);
        if (!isAdmin) {
          await ctx.editMessageText(
            '❌ You must be an admin of the group to remove it.\n\n' +
              'If you were removed as admin, contact a current admin to remove the bot.'
          );
          return;
        }
      } catch (error) {
        // Group might not exist or bot might not be in it anymore
        // Still allow removal since it's just cleaning up the database
        console.log('Could not verify group access, proceeding with removal:', error);
      }

      // Delete the group (messages will be cascade deleted)
      const deleted = await this.db.deleteGroup(chatId);
      if (deleted) {
        await ctx.editMessageText(
          `✅ Group removed successfully!\n\n` +
            `All cached messages for this group have been deleted.\n\n` +
            `To set it up again, run /setup in the group or /setup_group in private chat.`
        );
      } else {
        await ctx.editMessageText('❌ Group not found in database.');
      }
    } catch (error) {
      console.error('Error removing group via button:', error);
      await ctx.editMessageText('❌ Error removing group. Please try again.');
    }
  }

  private async handleTLDR(ctx: MyContext) {
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
      const formattedSummary = this.markdownToHtml(summary);

      // Send summary, splitting into multiple messages if too long
      await this.sendSummaryMessage(
        ctx,
        chat.id,
        loadingMsg.message_id,
        `📝 <b>TLDR Summary</b> (${summaryLabel})`,
        formattedSummary
      );
    } catch (error: any) {
      console.error('Error generating TLDR:', error);
      console.error('Error details:', error.message, error.status);

      // Provide specific error message
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
      const formattedSummary = this.markdownToHtml(summary);

      // Send summary, splitting into multiple messages if too long
      await this.sendSummaryMessage(
        ctx,
        chat.id,
        loadingMsg.message_id,
        `📝 <b>TLDR Summary</b> (from message)`,
        formattedSummary
      );
    } catch (error: any) {
      console.error('Error generating TLDR from message:', error);
      console.error('Error details:', error.message, error.status);

      // Provide specific error message
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
          `🔒 Messages auto-delete after 48 hours\n\n` +
          `<i>Use /tldr [timeframe] or reply to a message with /tldr</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Error getting TLDR info:', error);
      await ctx.reply('❌ Error retrieving info.');
    }
  }

  private async handleMessageCache(ctx: MyContext) {
    await this.processMessageForCache(ctx, ctx.message);
  }

  private async handleEditedMessageCache(ctx: MyContext) {
    // Handle edited messages - update the cached message content
    // Access edited message from context (grammy provides ctx.editedMessage for edited_message events)
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

    // Only cache messages if group is configured (to avoid accumulating orphaned data)
    try {
      const group = await this.db.getGroup(chat.id);
      if (!group) {
        // Group not configured, don't cache messages
        return;
      }

      // Get settings for filtering
      const settings = await this.db.getGroupSettings(chat.id);

      // Check if commands should be excluded
      if (settings.exclude_commands && message?.text?.startsWith('/')) {
        return;
      }

      // Check if bot messages should be excluded
      if (settings.exclude_bot_messages && ctx.from?.is_bot) {
        return;
      }

      // Check if user is in excluded list
      if (
        ctx.from?.id &&
        settings.excluded_user_ids &&
        settings.excluded_user_ids.includes(ctx.from.id)
      ) {
        return;
      }
    } catch (error) {
      // If check fails, skip caching to be safe
      return;
    }

    // Don't cache empty messages
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
      console.error('Error caching message:', error);
    }
  }

  private filterMessages(messages: any[], settings: any, ctx?: MyContext): any[] {
    return messages.filter(msg => {
      // Exclude bot messages if setting is enabled
      if (settings.exclude_bot_messages && msg.user_id && msg.username === 'bot') {
        return false;
      }

      // Exclude commands if setting is enabled
      if (settings.exclude_commands && msg.content?.startsWith('/')) {
        return false;
      }

      // Exclude specific user IDs
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

  private async handleUpdateApiKeyButton(ctx: MyContext) {
    await ctx.answerCallbackQuery();

    if (!ctx.callbackQuery || !ctx.callbackQuery.data) {
      await ctx.editMessageText('❌ Invalid callback data.');
      return;
    }

    const match = ctx.callbackQuery.data.match(/^update_key_(-?\d+)$/);
    if (!match) {
      await ctx.editMessageText('❌ Invalid group ID.');
      return;
    }

    const chatId = parseInt(match[1], 10);
    const chat = ctx.chat;

    if (!chat || chat.type !== 'private') {
      await ctx.editMessageText('❌ This can only be used in private chat.');
      return;
    }

    try {
      const userId = ctx.from?.id;
      if (!userId) {
        await ctx.editMessageText('❌ Could not identify user.');
        return;
      }

      // First, verify the group exists in the database
      const groupFromDb = await this.db.getGroup(chatId);
      if (!groupFromDb) {
        await ctx.editMessageText(
          '❌ Group not found in database.\n\n' +
            'The group may not be set up yet. Run /setup in the group or /setup_group in private chat.'
        );
        return;
      }

      // Verify the group belongs to this user
      // Compare as numbers to avoid type mismatch issues
      const setupUserId = groupFromDb.setup_by_user_id
        ? Number(groupFromDb.setup_by_user_id)
        : null;
      if (setupUserId !== userId) {
        await ctx.editMessageText(
          '❌ You are not authorized to update this group.\n\n' +
            'Only the user who set up the group can update its API key.'
        );
        return;
      }

      // Verify the group has an API key configured
      if (
        !groupFromDb.gemini_api_key_encrypted ||
        groupFromDb.gemini_api_key_encrypted.trim().length === 0
      ) {
        await ctx.editMessageText(
          '❌ Group found but not configured with an API key.\n\n' +
            'Please complete the setup first using /setup_group or /setup.'
        );
        return;
      }

      // Verify user is still admin
      try {
        const chatInfo = await ctx.api.getChat(chatId);
        const isAdmin = await this.isAdminOrCreator(ctx, chatId, chat.id);
        if (!isAdmin) {
          await ctx.editMessageText('❌ You must be an admin of the group to update the API key.');
          return;
        }
      } catch (error) {
        await ctx.editMessageText(
          '❌ Could not access the group. Please make sure the bot is in the group and you are an admin.'
        );
        return;
      }

      // Store the group ID for the conversation
      setUpdateState(chat.id, chatId);

      await ctx.editMessageText(
        `🔄 <b>Update API Key</b>\n\n` + `Please paste your new Gemini API key:`,
        { parse_mode: 'HTML' }
      );

      await ctx.conversation.enter('updateApiKey', { overwrite: true });
    } catch (error) {
      console.error('Error updating API key via button:', error);
      await ctx.editMessageText('❌ Error. Please try again.');
    }
  }

  private async handleTLDRSettings(ctx: MyContext) {
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
      await ctx.reply('❌ Only group admins can configure settings.');
      return;
    }

    try {
      const settings = await this.db.getGroupSettings(chat.id);
      const keyboard = new InlineKeyboard()
        .text('📝 Summary Style', 'settings_style')
        .text('🔧 Custom Prompt', 'settings_prompt')
        .row()
        .text('🚫 Message Filters', 'settings_filter')
        .text('⏰ Schedule', 'settings_schedule')
        .row()
        .text('📊 View Current', 'settings_view')
        .text('↩️ Back', 'settings_back');

      await ctx.reply(
        '⚙️ <b>TLDR Settings</b>\n\n' +
          'Customize how summaries are generated:\n\n' +
          '<b>Current Settings:</b>\n' +
          `Style: <code>${settings.summary_style || 'default'}</code>\n` +
          `Custom Prompt: ${settings.custom_prompt ? '✅ Set' : '❌ Not set'}\n` +
          `Exclude Bot Messages: ${settings.exclude_bot_messages ? '✅' : '❌'}\n` +
          `Exclude Commands: ${settings.exclude_commands ? '✅' : '❌'}\n` +
          `Scheduled: ${settings.scheduled_enabled ? '✅ ' + settings.schedule_frequency : '❌'}\n\n` +
          'Select an option to configure:',
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }
      );
    } catch (error) {
      console.error('Error showing settings:', error);
      await ctx.reply('❌ Error loading settings.');
    }
  }

  private async handleSchedule(ctx: MyContext) {
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
      await ctx.reply('❌ Only group admins can configure scheduling.');
      return;
    }

    try {
      const settings = await this.db.getGroupSettings(chat.id);
      const keyboard = new InlineKeyboard()
        .text(settings.scheduled_enabled ? '⏸️ Disable' : '▶️ Enable', `schedule_toggle_${chat.id}`)
        .row()
        .text('📅 Daily', `schedule_freq_daily_${chat.id}`)
        .text('📆 Weekly', `schedule_freq_weekly_${chat.id}`)
        .row()
        .text('↩️ Back', 'settings_back');

      await ctx.reply(
        '⏰ <b>Scheduled Summaries</b>\n\n' +
          `Status: ${settings.scheduled_enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `Frequency: ${settings.schedule_frequency || 'daily'}\n` +
          `Time: ${settings.schedule_time || '09:00'} UTC\n\n` +
          'Configure automatic summaries:',
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }
      );
    } catch (error) {
      console.error('Error showing schedule:', error);
      await ctx.reply('❌ Error loading schedule settings.');
    }
  }

  private async handleFilter(ctx: MyContext) {
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
      await ctx.reply('❌ Only group admins can configure filters.');
      return;
    }

    try {
      const settings = await this.db.getGroupSettings(chat.id);
      const keyboard = new InlineKeyboard()
        .text(
          `Bot Messages: ${settings.exclude_bot_messages ? '✅' : '❌'}`,
          `filter_bot_${chat.id}`
        )
        .text(`Commands: ${settings.exclude_commands ? '✅' : '❌'}`, `filter_cmd_${chat.id}`)
        .row()
        .text('👤 Exclude Users', `filter_users_${chat.id}`)
        .row()
        .text('↩️ Back', 'settings_back');

      const excludedCount = settings.excluded_user_ids?.length || 0;

      // Get usernames for excluded users
      let excludedUsersList = '';
      if (excludedCount > 0 && settings.excluded_user_ids) {
        const userMessages = await this.db.query(
          `SELECT DISTINCT user_id, username, first_name 
           FROM messages 
           WHERE telegram_chat_id = $1 
           AND user_id = ANY($2::bigint[])
           ORDER BY username, first_name`,
          [chat.id, settings.excluded_user_ids]
        );

        const userList = userMessages.rows.map((u: any) =>
          u.username ? `@${u.username}` : u.first_name || `ID:${u.user_id}`
        );
        excludedUsersList = `\n<b>Excluded:</b> ${userList.join(', ')}`;
      }

      await ctx.reply(
        '🚫 <b>Message Filtering</b>\n\n' +
          'Configure which messages to exclude from summaries:\n\n' +
          `<b>Current Filters:</b>\n` +
          `Bot Messages: ${settings.exclude_bot_messages ? '✅ Excluded' : '❌ Included'}\n` +
          `Commands: ${settings.exclude_commands ? '✅ Excluded' : '❌ Included'}\n` +
          `Excluded Users: ${excludedCount} user${excludedCount !== 1 ? 's' : ''}${excludedUsersList}\n\n` +
          'Tap to toggle:',
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }
      );
    } catch (error) {
      console.error('Error showing filters:', error);
      await ctx.reply('❌ Error loading filter settings.');
    }
  }

  private async handleSettingsStyle(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') return;

    const keyboard = new InlineKeyboard()
      .text('📝 Default', `style_default_${chat.id}`)
      .text('📄 Detailed', `style_detailed_${chat.id}`)
      .row()
      .text('⚡ Brief', `style_brief_${chat.id}`)
      .text('🔘 Bullet Points', `style_bullet_${chat.id}`)
      .row()
      .text('📅 Timeline', `style_timeline_${chat.id}`)
      .row()
      .text('↩️ Back', 'settings_back');

    await ctx.editMessageText(
      '📝 <b>Summary Style</b>\n\n' +
        'Choose how summaries are formatted:\n\n' +
        '<b>Default:</b> Balanced summary with bullet points\n' +
        '<b>Detailed:</b> Comprehensive summary with all details\n' +
        '<b>Brief:</b> Very concise, only key points\n' +
        '<b>Bullet Points:</b> Organized as bullet list\n' +
        '<b>Timeline:</b> Chronological order of events',
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }
    );
  }

  private async handleSettingsPrompt(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      '🔧 <b>Custom Prompt</b>\n\n' +
        'Send your custom prompt. Use <code>{{messages}}</code> as a placeholder for messages.\n\n' +
        'Example:\n' +
        '<code>Summarize these messages in 3 bullet points:\n{{messages}}</code>\n\n' +
        'Send /cancel to go back.',
      { parse_mode: 'HTML' }
    );
    // TODO: Add conversation handler for custom prompt
  }

  private async handleSettingsFilterMenu(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handleFilter(ctx);
  }

  private async handleSettingsView(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') return;

    try {
      const settings = await this.db.getGroupSettings(chat.id);
      await ctx.editMessageText(
        '📊 <b>Current Settings</b>\n\n' +
          `<b>Summary Style:</b> ${settings.summary_style || 'default'}\n` +
          `<b>Custom Prompt:</b> ${settings.custom_prompt ? '✅ Set' : '❌ Not set'}\n\n` +
          `<b>Filters:</b>\n` +
          `Bot Messages: ${settings.exclude_bot_messages ? '❌ Excluded' : '✅ Included'}\n` +
          `Commands: ${settings.exclude_commands ? '❌ Excluded' : '✅ Included'}\n` +
          `Excluded Users: ${settings.excluded_user_ids?.length || 0}\n\n` +
          `<b>Scheduling:</b>\n` +
          `Enabled: ${settings.scheduled_enabled ? '✅' : '❌'}\n` +
          `Frequency: ${settings.schedule_frequency || 'daily'}\n` +
          `Time: ${settings.schedule_time || '09:00'} UTC`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('↩️ Back', 'settings_back'),
        }
      );
    } catch (error) {
      await ctx.editMessageText('❌ Error loading settings.');
    }
  }

  private async handleSettingsBack(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handleTLDRSettings(ctx);
  }

  private async handleScheduleToggle(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const match = ctx.callbackQuery?.data?.match(/^schedule_toggle_(-?\d+)$/);
    if (!match) return;
    const chatId = parseInt(match[1], 10);

    try {
      const settings = await this.db.getGroupSettings(chatId);
      await this.db.updateGroupSettings(chatId, {
        scheduledEnabled: !settings.scheduled_enabled,
      });
      await this.handleSchedule(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery('❌ Error updating schedule');
    }
  }

  private async handleScheduleFrequency(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const match = ctx.callbackQuery?.data?.match(/^schedule_freq_(daily|weekly)_(-?\d+)$/);
    if (!match) return;
    const frequency = match[1];
    const chatId = parseInt(match[2], 10);

    try {
      await this.db.updateGroupSettings(chatId, {
        scheduleFrequency: frequency,
      });
      await this.handleSchedule(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery('❌ Error updating frequency');
    }
  }

  private async handleFilterBot(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const match = ctx.callbackQuery?.data?.match(/^filter_bot_(-?\d+)$/);
    if (!match) return;
    const chatId = parseInt(match[1], 10);

    try {
      const settings = await this.db.getGroupSettings(chatId);
      await this.db.updateGroupSettings(chatId, {
        excludeBotMessages: !settings.exclude_bot_messages,
      });
      await this.handleFilter(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery('❌ Error updating filter');
    }
  }

  private async handleFilterCmd(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const match = ctx.callbackQuery?.data?.match(/^filter_cmd_(-?\d+)$/);
    if (!match) return;
    const chatId = parseInt(match[1], 10);

    try {
      const settings = await this.db.getGroupSettings(chatId);
      await this.db.updateGroupSettings(chatId, {
        excludeCommands: !settings.exclude_commands,
      });
      await this.handleFilter(ctx);
    } catch (error) {
      await ctx.answerCallbackQuery('❌ Error updating filter');
    }
  }

  private async handleFilterUsers(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') return;

    const userId = ctx.from?.id;
    if (!userId) return;

    const isAdmin = await this.isAdminOrCreator(ctx, chat.id, userId);
    if (!isAdmin) {
      await ctx.answerCallbackQuery('❌ Only admins can manage user exclusions');
      return;
    }

    // Enter the exclude users conversation
    await ctx.conversation.enter('excludeUsers', { overwrite: true });
  }

  // Add style button handlers
  private setupStyleHandlers() {
    this.bot.callbackQuery(
      /^style_(default|detailed|brief|bullet|timeline)_(-?\d+)$/,
      async (ctx: MyContext) => {
        await ctx.answerCallbackQuery();
        const match = ctx.callbackQuery?.data?.match(
          /^style_(default|detailed|brief|bullet|timeline)_(-?\d+)$/
        );
        if (!match) return;
        const style = match[1];
        const chatId = parseInt(match[2], 10);

        try {
          await this.db.updateGroupSettings(chatId, {
            summaryStyle: style,
          });
          await ctx.editMessageText(`✅ Summary style updated to: <b>${style}</b>`, {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().text('↩️ Back', 'settings_back'),
          });
        } catch (error) {
          await ctx.editMessageText('❌ Error updating style');
        }
      }
    );
  }

  private async handleEnable(ctx: MyContext) {
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
      console.error('Error enabling bot:', error);
      await ctx.reply('❌ Error enabling bot. Please try again.');
    }
  }

  private async handleDisable(ctx: MyContext) {
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
      console.error('Error disabling bot:', error);
      await ctx.reply('❌ Error disabling bot. Please try again.');
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

  /**
   * Send summary message, splitting into multiple parts if too long
   * Telegram has a 4096 character limit per message
   */
  private async sendSummaryMessage(
    ctx: MyContext,
    chatId: number,
    loadingMsgId: number,
    header: string,
    summary: string
  ): Promise<void> {
    const MAX_MESSAGE_LENGTH = 4096;
    const headerLength = header.length + 2; // +2 for \n\n

    // Calculate available length for summary (leave some buffer for safety)
    const maxSummaryLength = MAX_MESSAGE_LENGTH - headerLength - 100; // 100 char buffer

    // If summary fits in one message, send it normally
    if (summary.length <= maxSummaryLength) {
      try {
        await ctx.api.editMessageText(chatId, loadingMsgId, `${header}\n\n${summary}`, {
          parse_mode: 'HTML',
        });
        return;
      } catch (error: any) {
        // If edit fails due to message length, fall through to splitting logic
        if (!error.message?.includes('MESSAGE_TOO_LONG')) {
          throw error;
        }
      }
    }

    // Split summary into chunks
    const chunks = this.splitMessage(summary, maxSummaryLength);

    // Edit loading message with first chunk
    try {
      await ctx.api.editMessageText(
        chatId,
        loadingMsgId,
        `${header} (1/${chunks.length})\n\n${chunks[0]}`,
        { parse_mode: 'HTML' }
      );
    } catch (error: any) {
      // If even the header + first chunk is too long, send just the first chunk and continue
      if (error.message?.includes('MESSAGE_TOO_LONG')) {
        await ctx.api.editMessageText(chatId, loadingMsgId, chunks[0], { parse_mode: 'HTML' });
      } else {
        throw error;
      }
    }

    // Send remaining chunks as new messages
    for (let i = 1; i < chunks.length; i++) {
      await ctx.reply(`${header} (${i + 1}/${chunks.length})\n\n${chunks[i]}`, {
        parse_mode: 'HTML',
      });
    }
  }

  /**
   * Split a long message into chunks that fit within Telegram's message length limit
   * Tries to split at paragraph boundaries (double newlines) when possible
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to find a good split point (preferably at paragraph break)
      let splitPoint = maxLength;

      // Look for paragraph break (double newline) near the max length
      const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
      if (paragraphBreak > maxLength * 0.7) {
        // Use paragraph break if it's not too early
        splitPoint = paragraphBreak + 2; // +2 to include \n\n
      } else {
        // Look for single newline
        const lineBreak = remaining.lastIndexOf('\n', maxLength);
        if (lineBreak > maxLength * 0.8) {
          splitPoint = lineBreak + 1; // +1 to include \n
        } else {
          // Look for sentence end
          const sentenceEnd = remaining.lastIndexOf('. ', maxLength);
          if (sentenceEnd > maxLength * 0.7) {
            splitPoint = sentenceEnd + 2; // +2 to include '. '
          } else {
            // Force split at max length
            splitPoint = maxLength;
          }
        }
      }

      // Extract chunk and add continuation indicator if not the last chunk
      const chunk = remaining.substring(0, splitPoint);
      chunks.push(chunk);
      remaining = remaining.substring(splitPoint).trim();
    }

    return chunks;
  }

  /**
   * Parse TLDR command arguments to extract timeframe/count and optional style preference
   * Examples: "1h detailed", "300 brief", "1 day bullet", "default"
   * @returns Object with input (timeframe/count string) and optional style
   */
  private parseTLDRArgs(args: string[]): { input: string; style?: string } {
    const validStyles = ['default', 'detailed', 'brief', 'bullet', 'timeline'];

    if (args.length === 0) {
      return { input: '1h' };
    }

    // Join all args to handle "1 day", "2 days" etc.
    const fullInput = args.join(' ').trim();

    // Check if the last word is a valid style
    const words = args;
    const lastWord = words[words.length - 1]?.toLowerCase();

    if (lastWord && validStyles.includes(lastWord)) {
      // Last word is a style, remove it and use the rest as input
      const inputParts = words.slice(0, -1);
      const input = inputParts.length > 0 ? inputParts.join(' ').trim() : '1h';
      return { input, style: lastWord };
    }

    // No style provided, return the full input as timeframe/count
    return { input: fullInput || '1h' };
  }

  /**
   * Check if input is count-based (pure number) vs time-based (has suffix or keywords)
   */
  private isCountBased(input: string): boolean {
    const normalized = input.toLowerCase().trim();
    // If it's a pure number (no h, d, day, week), it's count-based
    return /^\d+$/.test(normalized);
  }

  /**
   * Parse count from input (e.g., "300" -> 300)
   */
  private parseCount(input: string): number {
    const value = parseInt(input.trim(), 10);
    if (isNaN(value) || value <= 0) {
      return 100; // Default to 100 messages
    }
    // Cap at 10000 messages
    return Math.min(value, 10000);
  }

  /**
   * Parse timeframe and return a Date object (for time-based summaries)
   */
  private parseTimeframe(timeframe: string): Date {
    const now = Date.now();
    const MAX_HOURS = 168; // 7 days maximum
    let hours = 1;

    // Normalize input - remove extra spaces and convert to lowercase
    const normalized = timeframe.toLowerCase().trim().replace(/\s+/g, ' ');

    // Handle formats like "1 day", "2 days", "1 hour", "2 hours"
    const dayMatch = normalized.match(/^(\d+)\s+(day|days)$/);
    if (dayMatch) {
      const days = Math.min(parseInt(dayMatch[1], 10), 7); // Cap at 7 days
      hours = days * 24;
      return new Date(now - hours * 60 * 60 * 1000);
    }

    const hourMatch = normalized.match(/^(\d+)\s+(hour|hours|h)$/);
    if (hourMatch) {
      const value = parseInt(hourMatch[1], 10);
      hours = Math.min(value, MAX_HOURS); // Cap at 7 days
      return new Date(now - hours * 60 * 60 * 1000);
    }

    const weekMatch = normalized.match(/^(\d+)\s+(week|weeks)$/);
    if (weekMatch) {
      const weeks = Math.min(parseInt(weekMatch[1], 10), 1); // Cap at 1 week (7 days)
      hours = weeks * 168;
      return new Date(now - hours * 60 * 60 * 1000);
    }

    // Handle compact formats (no spaces)
    if (normalized.endsWith('h')) {
      const value = parseInt(normalized.slice(0, -1), 10);
      if (isNaN(value) || value <= 0) {
        hours = 1; // Default to 1 hour for invalid input
      } else {
        hours = Math.min(value, MAX_HOURS); // Cap at 7 days
      }
    } else if (normalized.endsWith('d') || normalized === 'day') {
      const value = normalized === 'day' ? 1 : parseInt(normalized.slice(0, -1), 10);
      if (isNaN(value) || value <= 0) {
        hours = 24; // Default to 1 day for invalid input
      } else {
        const days = Math.min(value, 7); // Cap at 7 days
        hours = days * 24;
      }
    } else if (normalized === 'week') {
      hours = 168; // 7 days
    } else {
      // Try to parse as number of hours (fallback)
      const value = parseInt(normalized, 10);
      if (!isNaN(value) && value > 0) {
        hours = Math.min(value, MAX_HOURS);
      } else {
        hours = 1; // Default to 1 hour for unrecognized input
      }
    }

    return new Date(now - hours * 60 * 60 * 1000);
  }
}
