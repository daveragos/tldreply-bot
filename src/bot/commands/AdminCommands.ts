import { InlineKeyboard } from 'grammy';
import { BaseCommand, MyContext } from './BaseCommand';
import { logger } from '../../utils/logger';

export class AdminCommands extends BaseCommand {
  register() {
    this.bot.command('setup', this.handleSetup.bind(this));
    this.bot.command('tldr_settings', this.handleTLDRSettings.bind(this));
    this.bot.command('schedule', this.handleSchedule.bind(this));
    this.bot.command('filter', this.handleFilter.bind(this));

    // Callback handlers
    this.setupCallbackHandlers();
  }

  private setupCallbackHandlers() {
    // Settings navigation
    this.bot.callbackQuery('settings_style', this.handleSettingsStyle.bind(this));
    this.bot.callbackQuery('settings_prompt', this.handleSettingsPrompt.bind(this));
    this.bot.callbackQuery('settings_filter', this.handleSettingsFilterMenu.bind(this));
    this.bot.callbackQuery('settings_schedule', this.handleSchedule.bind(this)); // Redirect to schedule
    this.bot.callbackQuery('settings_view', this.handleSettingsView.bind(this));
    this.bot.callbackQuery('settings_back', this.handleSettingsBack.bind(this));

    // Schedule settings
    this.bot.callbackQuery(/^schedule_toggle_(-?\d+)$/, this.handleScheduleToggle.bind(this));
    this.bot.callbackQuery(
      /^schedule_freq_(daily|weekly)_(-?\d+)$/,
      this.handleScheduleFrequency.bind(this)
    );

    // Filters
    this.bot.callbackQuery(/^filter_bot_(-?\d+)$/, this.handleFilterBot.bind(this));
    this.bot.callbackQuery(/^filter_cmd_(-?\d+)$/, this.handleFilterCmd.bind(this));
    this.bot.callbackQuery(/^filter_users_(-?\d+)$/, this.handleFilterUsers.bind(this));

    // Styles
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

  // --- Setup (In-Group) ---

  async handleSetup(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      await ctx.reply('❌ This command can only be used in a group.');
      return;
    }

    try {
      const userId = ctx.from?.id;
      if (!userId) {
        await ctx.reply('❌ Could not identify user.');
        return;
      }

      const isAdmin = await this.isAdminOrCreator(ctx, chat.id, userId);
      if (!isAdmin) {
        await ctx.reply('❌ Only group admins can setup the bot.');
        return;
      }

      await this.db.createGroup(chat.id, userId);

      await ctx.reply(
        `👋 Hello! I'm ready to help you summarize this group.\n\n` +
          `To enable the bot, I need a <b>Google Gemini API Key</b>.\n\n` +
          `Please tap the button below to provide the key securely in private chat.`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().url(
            '🔑 Setup securely in private chat',
            `https://t.me/${ctx.me.username}?start=setup`
          ),
        }
      );
    } catch (error) {
      logger.error('Error in setup command:', error);
      await ctx.reply('❌ An error occurred during setup. Please try again.');
    }
  }

  // --- TLDR Settings ---

  async handleTLDRSettings(ctx: MyContext) {
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
        .text('📊 View Current', 'settings_view');
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
      logger.error('Error showing settings:', error);
      await ctx.reply('❌ Error loading settings.');
    }
  }

  // --- Schedule ---

  async handleSchedule(ctx: MyContext) {
    // Check if it's a callback or command
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery('Use in group');
      else await ctx.reply('❌ This command can only be used in a group.');
      return;
    }

    // Need to re-auth for callback/command logic consistency or rely on previous checks?
    // Best to re-check admin if it's a fresh command
    if (!ctx.callbackQuery) {
      const userId = ctx.from?.id;
      if (!userId) return;
      const isAdmin = await this.isAdminOrCreator(ctx, chat.id, userId);
      if (!isAdmin) {
        await ctx.reply('❌ Only group admins can configure scheduling.');
        return;
      }
    } else {
      await ctx.answerCallbackQuery();
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

      const messageText =
        '⏰ <b>Scheduled Summaries</b>\n\n' +
        `Status: ${settings.scheduled_enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `Frequency: ${settings.schedule_frequency || 'daily'}\n` +
        `Time: ${settings.schedule_time || '09:00'} UTC\n\n` +
        'Configure automatic summaries:';

      if (ctx.callbackQuery) {
        await ctx.editMessageText(messageText, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.reply(messageText, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } catch (error) {
      logger.error('Error showing schedule:', error);
      if (ctx.callbackQuery) {
        await ctx.editMessageText('❌ Error loading schedule settings.');
      } else {
        await ctx.reply('❌ Error loading schedule settings.');
      }
    }
  }

  // --- Filter ---

  async handleFilter(ctx: MyContext) {
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery('Use in group');
      else await ctx.reply('❌ This command can only be used in a group.');
      return;
    }

    if (!ctx.callbackQuery) {
      const userId = ctx.from?.id;
      if (!userId) return;
      const isAdmin = await this.isAdminOrCreator(ctx, chat.id, userId);
      if (!isAdmin) {
        await ctx.reply('❌ Only group admins can configure filters.');
        return;
      }
    } else {
      await ctx.answerCallbackQuery();
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

      const messageText =
        '🚫 <b>Message Filtering</b>\n\n' +
        'Configure which messages to exclude from summaries:\n\n' +
        `<b>Current Filters:</b>\n` +
        `Bot Messages: ${settings.exclude_bot_messages ? '✅ Excluded' : '❌ Included'}\n` +
        `Commands: ${settings.exclude_commands ? '✅ Excluded' : '❌ Included'}\n` +
        `Excluded Users: ${excludedCount} user${excludedCount !== 1 ? 's' : ''}${excludedUsersList}\n\n` +
        'Tap to toggle:';

      if (ctx.callbackQuery) {
        await ctx.editMessageText(messageText, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.reply(messageText, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } catch (error) {
      logger.error('Error showing filters:', error);
      if (ctx.callbackQuery) await ctx.editMessageText('❌ Error loading filter settings.');
      else await ctx.reply('❌ Error loading filter settings.');
    }
  }

  // --- Handlers for Callback Queries ---

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

    const chat = ctx.chat;
    if (!chat) return;

    try {
      const settings = await this.db.getGroupSettings(chat.id);
      const keyboard = new InlineKeyboard()
        .text('📝 Summary Style', 'settings_style')
        .text('🔧 Custom Prompt', 'settings_prompt')
        .row()
        .text('🚫 Message Filters', 'settings_filter')
        .text('⏰ Schedule', 'settings_schedule')
        .row()
        .text('📊 View Current', 'settings_view');

      await ctx.editMessageText(
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
      await ctx.editMessageText('❌ Error loading settings.');
    }
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
      // error
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
      // error
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
      // error
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
      // error
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
      return;
    }

    await ctx.conversation.enter('excludeUsers', { overwrite: true });
  }
}
