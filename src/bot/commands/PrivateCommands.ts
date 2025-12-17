import { InlineKeyboard } from 'grammy';
import { BaseCommand, MyContext } from './BaseCommand';
import { setUpdateState } from '../../services/services';
import { GeminiService } from '../../services/gemini';
import { logger } from '../../utils/logger';

export class PrivateCommands extends BaseCommand {
  register() {
    // Private chat commands
    this.bot.command('start', this.handleStart.bind(this));
    this.bot.command('help', this.handleHelp.bind(this));
    this.bot.command('setup_group', this.handleSetupGroup.bind(this));
    this.bot.command('list_groups', this.handleListGroups.bind(this));
    this.bot.command('remove_group', this.handleRemoveGroup.bind(this));
    this.bot.command('continue_setup', this.handleContinueSetup.bind(this));
    this.bot.command('update_api_key', this.handleUpdateApiKey.bind(this));

    // Button handlers for private commands
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
  }

  // --- Start & Help ---

  async handleStart(ctx: MyContext) {
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
        logger.error('Error checking pending setups:', error);
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

  async handleHelp(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat) return;

    if (chat.type === 'private') {
      await this.handlePrivateHelp(ctx);
    } else {
      // If called in group, delegate or show minimal help?
      // Group help is handled by GroupCommands normally, but command routing might land here if not separated.
      // But we will register only private commands here.
      // Actually, standard practice is that /help works everywhere.
      // But since we split files, we might need a shared help command or just let GroupCommands handle group help.
      // For now, let's assume this is only for private chat help as registered.
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

  private async handleButtonHelp(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handlePrivateHelp(ctx);
  }

  private async handleButtonBack(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handleStart(ctx);
  }

  // --- Setup Group ---

  async handleSetupGroup(ctx: MyContext) {
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

      if (isPrivateGroup) {
        const chatId = parseInt(groupInput, 10);
        chatInfo = await ctx.api.getChat(chatId);

        if (chatInfo.type !== 'supergroup' && chatInfo.type !== 'group') {
          await ctx.reply(
            "❌ Invalid chat type. Please make sure you're using a group chat ID, not a private chat ID.\n\n" +
              '<b>Private group chat IDs</b> are negative numbers (e.g., <code>-123456789</code>).',
            { parse_mode: 'HTML' }
          );
          return;
        }
      } else {
        chatInfo = await ctx.api.getChat(`@${groupInput}`);
      }

      if (chatInfo.type === 'supergroup' || chatInfo.type === 'group') {
        const chatId = chatInfo.id as number;

        const isAdmin = await this.isAdminOrCreator(ctx, chatId, chat.id);
        if (!isAdmin) {
          await ctx.reply(
            '❌ Only group admins can configure the bot.\n\n' +
              'Please ask an admin to run this command.',
            { parse_mode: 'HTML' }
          );
          return;
        }

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

        const groupName = 'title' in chatInfo ? chatInfo.title : `Group ${chatId}`;

        await ctx.reply(
          `✅ Group "<b>${groupName}</b>" found!\n\n` +
            `Please provide your Gemini API key in the next message.\n\n` +
            `<i>You can get your API key from:</i>\n` +
            `https://makersuite.google.com/app/apikey\n\n` +
            `<b>🔒 Security:</b> Your API key will be encrypted and only used for this group.`,
          { parse_mode: 'HTML' }
        );

        await ctx.conversation.enter('setupApiKey');
      } else {
        await ctx.reply('❌ Invalid group type. Please provide a valid group or supergroup.');
      }
    } catch (error: any) {
      logger.error('Error setting up group:', error);

      const isPrivateGroup = /^-?\d+$/.test(args[1]?.replace('@', '') || '');

      if (isPrivateGroup) {
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

  // --- Continue Setup ---

  async handleContinueSetup(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') {
      await ctx.reply('❌ This command can only be used in private chat.');
      return;
    }

    try {
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

      try {
        const chatInfo = await ctx.api.getChat(groupChatId);
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
      logger.error('Error continuing setup:', error);
      await ctx.reply('❌ Error. Please try again.');
    }
  }

  // --- List Groups ---

  async handleListGroups(ctx: MyContext) {
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

        let groupName = `Group ${group.telegram_chat_id}`;
        try {
          const chatInfo = await ctx.api.getChat(group.telegram_chat_id);
          if ('title' in chatInfo && chatInfo.title) {
            groupName = chatInfo.title;
          }
        } catch (error) {
          groupName = `Group ${group.telegram_chat_id}`;
        }

        message += `${idx + 1}. <b>${groupName}</b>\n`;
        message += `   ID: <code>${group.telegram_chat_id}</code>\n`;
        message += `   Status: ${status}\n\n`;
      }

      message += '<i>💡 Use the chat ID with /remove_group to remove a group</i>';

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error('Error listing groups:', error);
      await ctx.reply('❌ Error retrieving groups.');
    }
  }

  private async handleButtonList(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    await this.handleListGroups(ctx);
  }

  // --- Remove Group ---

  async handleRemoveGroup(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') {
      await ctx.reply('❌ This command can only be used in private chat.');
      return;
    }

    try {
      const groups = await this.db.listGroupsForUser(chat.id);

      if (groups.length === 0) {
        await ctx.reply('📭 You have not configured any groups to remove.');
        return;
      }

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

        const group = groups.find(g => g.telegram_chat_id === chatId);
        if (!group) {
          await ctx.reply(
            "❌ Group not found or you don't have permission to remove it.\n\n" +
              'Run `/list_groups` to see your groups.',
            { parse_mode: 'HTML' }
          );
          return;
        }

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
          console.log('Could not verify group access, proceeding with removal:', error);
        }

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

      if (groups.length === 1) {
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
        const keyboard = new InlineKeyboard();
        let message = '🗑️ <b>Remove Group</b>\n\n';
        message += 'Select a group to remove:\n\n';

        groups.forEach((group, idx) => {
          const status = group.gemini_api_key_encrypted ? '✅ Configured' : '⏳ Pending';
          const groupName = `Group ${group.telegram_chat_id}`;

          // Async name fetching omitted for simple list construction in loop,
          // or we can just show IDs.
          // For now, simple ID display or sync if possible.
          // Given the async nature, doing it sequentially inside map/forEach is tricky.
          // Let's rely on ID primarily or simple placeholder.

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
      logger.error('Error removing group:', error);
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
      const groups = await this.db.listGroupsForUser(chat.id);
      const group = groups.find(g => g.telegram_chat_id === chatId);

      if (!group) {
        await ctx.editMessageText("❌ Group not found or you don't have permission to remove it.");
        return;
      }

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
        console.log('Could not verify group access, proceeding with removal:', error);
      }

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
      logger.error('Error removing group via button:', error);
      await ctx.editMessageText('❌ Error removing group. Please try again.');
    }
  }

  // --- Update API Key ---

  async handleUpdateApiKey(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private') {
      await ctx.reply('❌ This command can only be used in private chat.');
      return;
    }

    try {
      const allGroups = await this.db.listGroupsForUser(chat.id);
      const configuredGroups = allGroups.filter(g => g.gemini_api_key_encrypted);

      if (configuredGroups.length === 0) {
        await ctx.reply(
          '📭 You have no configured groups to update.\n\n' +
            'Use /setup_group or /setup to configure a group first.'
        );
        return;
      }

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

        const group = configuredGroups.find(g => g.telegram_chat_id === chatId);
        if (!group) {
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

        if (args.length >= 3) {
          const apiKeysInput = args.slice(2).join(' ').trim();
          const rawKeys = apiKeysInput
            .split(/[\n, ]/)
            .map(k => k.trim())
            .filter(k => k.length > 0);

          if (rawKeys.length === 0) {
            await ctx.reply('❌ No API keys found. Please check your input.');
            return;
          }

          const validFormatKeys: string[] = [];
          const invalidFormatKeys: string[] = [];

          for (const key of rawKeys) {
            if (GeminiService.validateApiKey(key)) {
              validFormatKeys.push(key);
            } else {
              invalidFormatKeys.push(key);
            }
          }

          if (validFormatKeys.length === 0) {
            await ctx.reply(
              '❌ Invalid API key format.\n\nNone of the provided keys looked like valid Gemini API keys.'
            );
            return;
          }

          try {
            const gemini = new GeminiService(validFormatKeys);
            await gemini.summarizeMessages([
              { content: 'test', timestamp: new Date().toISOString() },
            ]);

            const serializedKeys = JSON.stringify(validFormatKeys);
            const encryptedKey = this.encryption.encrypt(serializedKeys);
            await this.db.updateGroupApiKey(chatId, encryptedKey);

            let successMessage = `✅ <b>Success!</b> Updated ${validFormatKeys.length} API key(s).`;
            if (invalidFormatKeys.length > 0) {
              successMessage += `\n\n⚠️ ${invalidFormatKeys.length} keys were skipped due to invalid format.`;
            }

            await ctx.reply(successMessage, { parse_mode: 'HTML' });
          } catch (error: any) {
            const errorMessage = error.message || 'Unknown error';

            // If quota error, we save anyway but warn
            if (
              errorMessage.includes('quota') ||
              errorMessage.includes('QUOTA_EXCEEDED') ||
              errorMessage.includes('429')
            ) {
              const serializedKeys = JSON.stringify(validFormatKeys);
              const encryptedKey = this.encryption.encrypt(serializedKeys);
              await this.db.updateGroupApiKey(chatId, encryptedKey);

              await ctx.reply(
                `✅ Updated ${validFormatKeys.length} keys, but validation hit a quota limit.\n\n` +
                  `They will be verified on next use.`,
                { parse_mode: 'HTML' }
              );
            } else if (
              errorMessage.includes('Invalid API key') ||
              errorMessage.includes('API_KEY_INVALID') ||
              errorMessage.includes('401')
            ) {
              await ctx.reply(
                '❌ Invalid API keys. Please check your keys and try again.\n\n💡 Get a new key from: https://makersuite.google.com/app/apikey'
              );
            } else {
              await ctx.reply(
                `❌ Failed to validate API keys: ${errorMessage}. Please check and try again.`
              );
            }
          }
          return;
        }

        setUpdateState(chat.id, chatId);
        await ctx.reply('Please paste your new Gemini API key:');
        await ctx.conversation.enter('updateApiKey', { overwrite: true });
        return;
      }

      if (configuredGroups.length === 1) {
        const group = configuredGroups[0];

        try {
          const isAdmin = await this.isAdminOrCreator(ctx, group.telegram_chat_id, chat.id);
          if (!isAdmin) {
            await ctx.reply(
              '❌ You must be an admin of the group to update the API key.\n\n' +
                'If you were removed as admin, please ask a current admin to update it.'
            );
            return;
          }

          const groupName = `Group ${group.telegram_chat_id}`;

          await ctx.reply(
            `🔄 <b>Update API Key</b>\n\n` +
              `Group: <b>${groupName}</b>\n` +
              `ID: <code>${group.telegram_chat_id}</code>\n\n` +
              `Please paste your new Gemini API key(s).\n\n` +
              `You can paste multiple keys separated by commas or new lines.`,
            {
              parse_mode: 'HTML',
            }
          );

          setUpdateState(chat.id, group.telegram_chat_id);
          await ctx.conversation.enter('updateApiKey', { overwrite: true });
        } catch (error) {
          await ctx.reply(
            '❌ Could not access the group. Please make sure the bot is in the group and you are an admin.'
          );
        }
      } else {
        const keyboard = new InlineKeyboard();
        let message = '🔄 <b>Update API Key</b>\n\n';
        message += 'Select a group to update:\n\n';

        configuredGroups.forEach((group, idx) => {
          const groupName = `Group ${group.telegram_chat_id}`;
          message += `${idx + 1}. <b>${groupName}</b>\n`;
          message += `   ID: <code>${group.telegram_chat_id}</code>\n\n`;

          keyboard.text(
            `${idx + 1}. ${groupName.substring(0, 30)}`,
            `update_key_${group.telegram_chat_id}`
          );
          if ((idx + 1) % 2 === 0 || idx === configuredGroups.length - 1) {
            keyboard.row();
          }
        });

        await ctx.reply(message, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      }
    } catch (error) {
      logger.error('Error updating API key:', error);
      await ctx.reply('❌ Error. Please try again.');
    }
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

      const groupFromDb = await this.db.getGroup(chatId);
      if (!groupFromDb) {
        await ctx.editMessageText(
          '❌ Group not found in database.\n\n' +
            'The group may not be set up yet. Run /setup in the group or /setup_group in private chat.'
        );
        return;
      }

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

      try {
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

      setUpdateState(chat.id, chatId);

      await ctx.editMessageText(
        `🔄 <b>Update API Key</b>\n\n` +
          `Please paste your new Gemini API key(s).\n\n` +
          `You can paste multiple keys separated by commas or new lines.`,
        { parse_mode: 'HTML' }
      );

      await ctx.conversation.enter('updateApiKey', { overwrite: true });
    } catch (error) {
      logger.error('Error updating API key via button:', error);
      await ctx.editMessageText('❌ Error. Please try again.');
    }
  }
}
