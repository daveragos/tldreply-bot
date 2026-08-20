import { Context } from 'grammy';
import { logger } from '../utils/logger';
import { escapeHtml } from '../utils/formatter';
import { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { GeminiService } from '../services/gemini';
import { invalidateGeminiService } from '../services/geminiPool';
import {
  db,
  encryption,
  getUpdateState,
  clearUpdateState,
  setUpdateState,
} from '../services/services';

type MyContext = ConversationFlavor<Context>;

type MyConversationContext = Context;

/**
 * Waits for a text message from one specific user, ignoring everyone else.
 *
 * A conversation in a group consumes the next matching update in that chat,
 * regardless of who sent it. Without this, any member could answer a prompt
 * that only an admin was authorised to open - supplying the group's custom
 * summarization prompt, its schedule timezone, or its excluded-user list.
 *
 * Messages from other users are skipped rather than rejected, so ordinary
 * group chatter during the exchange is simply ignored.
 */
async function waitForTextFrom(conversation: Conversation<MyContext>, userId: number) {
  for (;;) {
    const next = await conversation.waitFor('message:text');
    if (next.from?.id === userId) return next;
  }
}

/**
 * Same, but returns the whole update so callers can inspect reply_to_message.
 */
async function waitForMessageFrom(conversation: Conversation<MyContext>, userId: number) {
  for (;;) {
    const next = await conversation.wait();
    if (next.from?.id === userId) return next;
  }
}

export async function setupApiKey(
  conversation: Conversation<MyContext>,
  ctx: MyConversationContext
) {
  const chat = ctx.chat;
  if (!chat || chat.type !== 'private') return;

  await ctx.reply('Please paste your Gemini API key:');

  // Wait for API key input, handling command interruptions
  let apiKey: string | null = null;
  let lastCtx: MyConversationContext | null = null;
  while (!apiKey) {
    const update = await conversation.wait();
    lastCtx = update;

    // Check if it's a text message
    if (!update.message || !update.message.text) {
      continue;
    }

    const input = update.message.text.trim();

    // Check if user sent a command instead of API key
    if (input.startsWith('/')) {
      // Handle cancel command
      if (input.toLowerCase() === '/cancel') {
        await update.reply('❌ Setup cancelled.');
        return;
      }
      // For other commands, remind user what we're waiting for
      await update.reply(
        '⏳ <b>Waiting for API key...</b>\n\n' +
          'Please paste your Gemini API key to continue.\n\n' +
          'Send /cancel to exit the setup process.',
        { parse_mode: 'HTML' }
      );
      continue;
    }

    apiKey = input;
  }

  // Use the last context for replies (the one with the API key)
  const replyCtx = lastCtx || ctx;

  // Parse input into separate keys
  const rawKeys = apiKey
    .split(/[\n,]/) // Split by newline or comma
    .map(k => k.trim())
    .filter(k => k.length > 0);

  if (rawKeys.length === 0) {
    await replyCtx.reply('❌ No API keys found. Please try again with /setup_group.');
    return;
  }

  // Validate format of each key
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
    await replyCtx.reply(
      '❌ Invalid API key format.\n\nNone of the provided keys looked like valid Gemini API keys. Please paste the full key exactly as shown, with no extra spaces.\n\n💡 Get a key from: https://makersuite.google.com/app/apikey'
    );
    return;
  }

  // Test the API keys
  try {
    // Not pooled: these keys are not saved yet, and the throwaway client must
    // dispose so its quota-recovery timers do not outlive the check.
    const gemini = new GeminiService(validFormatKeys);
    try {
      await gemini.summarizeMessages([{ content: 'test', timestamp: new Date().toISOString() }]);
    } finally {
      gemini.dispose();
    }

    // If successful, save the encrypted key(s)
    if (!encryption || !db) {
      throw new Error('Database or encryption service not available');
    }

    // Find the most recent group setup for this user
    const groups = await db.query(
      'SELECT telegram_chat_id FROM groups WHERE setup_by_user_id = $1 ORDER BY setup_at DESC LIMIT 1',
      [chat.id]
    );

    if (groups.rows.length === 0) {
      throw new Error('No group found for setup');
    }

    const groupChatId = groups.rows[0].telegram_chat_id;

    // Final security check: verify user is still admin before saving API key
    try {
      const member = await replyCtx.api.getChatMember(groupChatId, chat.id);
      if (member.status !== 'administrator' && member.status !== 'creator') {
        await replyCtx.reply(
          '❌ You must be an admin of the group to complete setup.\n\n' +
            'If you were removed as admin, please ask a current admin to run /setup in the group.'
        );
        return;
      }
    } catch (error) {
      await replyCtx.reply(
        '❌ Could not verify admin status. Please try again or ask a group admin to run /setup.'
      );
      return;
    }

    const serializedKeys = JSON.stringify(validFormatKeys);
    const encryptedKey = encryption.encrypt(serializedKeys);
    await db.updateGroupApiKey(groupChatId, encryptedKey);
    invalidateGeminiService(groupChatId);

    let successMessage = `✅ Successfully configured ${validFormatKeys.length} API key(s)! You can now use /tldr in your group.`;
    if (invalidFormatKeys.length > 0) {
      successMessage += `\n\n⚠️ ${invalidFormatKeys.length} keys were skipped due to invalid format.`;
    }

    await replyCtx.reply(successMessage);
  } catch (error: any) {
    logger.error('API key validation error:', error);

    // Provide specific error messages
    const errorMessage = error.message || 'Unknown error';
    if (
      errorMessage.includes('Invalid API key') ||
      errorMessage.includes('API_KEY_INVALID') ||
      errorMessage.includes('401')
    ) {
      await replyCtx.reply(
        '❌ Invalid API keys. The keys were rejected by the API. Please check your keys and try again.\n\n💡 Get a new key from: https://makersuite.google.com/app/apikey'
      );
    } else if (
      errorMessage.includes('quota') ||
      errorMessage.includes('QUOTA_EXCEEDED') ||
      errorMessage.includes('429')
    ) {
      await replyCtx.reply(
        '❌ API quota exceeded during test. However, since the format looks valid, please try /update_api_key later or try adding DIFFERENT keys.'
      );
    } else if (
      errorMessage.includes('Permission denied') ||
      errorMessage.includes('PERMISSION_DENIED') ||
      errorMessage.includes('403')
    ) {
      await replyCtx.reply(
        '❌ Permission denied. Your API key may not have access to the Gemini API. Please check your API key permissions.'
      );
    } else if (
      errorMessage.includes('network') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ENOTFOUND')
    ) {
      await replyCtx.reply(
        '❌ Network error. Could not connect to the Gemini API. Please check your internet connection and try again.'
      );
    } else {
      await replyCtx.reply(
        `❌ Failed to validate API key: ${errorMessage}. Please check your key and try again.`
      );
    }
  }
}

/**
 * Helper function to validate and update API key(s)
 */
async function validateAndUpdateApiKey(
  apiKeysInput: string,
  groupChatId: number,
  userId: number,
  ctx: MyConversationContext
): Promise<{ success: boolean; message: string }> {
  logger.info(
    `validateAndUpdateApiKey: Starting validation for group ${groupChatId}, user ${userId}`
  );

  // Parse input into separate keys
  // Split by newline or comma, then trim and filter empty
  const rawKeys = apiKeysInput
    .split(/[\n,]/)
    .map(k => k.trim())
    .filter(k => k.length > 0);

  if (rawKeys.length === 0) {
    return {
      success: false,
      message: '❌ No API keys found in input. Please paste your keys again.',
    };
  }

  // Validate format of each key
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
    logger.info(`validateAndUpdateApiKey: No valid API keys format found`);
    return {
      success: false,
      message:
        '❌ Invalid API key format.\n\nNone of the provided keys looked like valid Gemini API keys. Please paste the full key exactly as shown, with no extra spaces.\n\n💡 Get a key from: https://makersuite.google.com/app/apikey',
    };
  }

  if (!encryption || !db) {
    logger.error(
      `validateAndUpdateApiKey: Services not available - encryption: ${!!encryption}, db: ${!!db}`
    );
    return { success: false, message: '❌ Database or encryption service not available.' };
  }

  // Verify user is still admin of the group
  try {
    const member = await ctx.api.getChatMember(groupChatId, userId);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      return {
        success: false,
        message:
          '❌ You must be an admin of the group to update the API key.\n\nIf you were removed as admin, please ask a current admin to update it.',
      };
    }
  } catch (error) {
    return {
      success: false,
      message:
        '❌ Could not verify admin status. Please make sure the bot is in the group and you are an admin.',
    };
  }

  // Test the API keys
  let hadQuotaError = false;
  try {
    logger.info(
      `validateAndUpdateApiKey: Testing ${validFormatKeys.length} API keys for group ${groupChatId}`
    );
    // Pass all valid keys to service
    const gemini = new GeminiService(validFormatKeys);
    try {
      await gemini.summarizeMessages([{ content: 'test', timestamp: new Date().toISOString() }]);
    } finally {
      gemini.dispose();
    }
    logger.info(`validateAndUpdateApiKey: API key test successful for group ${groupChatId}`);
  } catch (error: any) {
    // If it's a quota error or simple test failure, we might still want to save valid-formatted keys
    logger.error(`validateAndUpdateApiKey: API key test failed for group ${groupChatId}:`, error);
    const errorMessage = error.message || 'Unknown error';

    if (
      errorMessage.includes('quota') ||
      errorMessage.includes('QUOTA_EXCEEDED') ||
      errorMessage.includes('429')
    ) {
      logger.info(`validateAndUpdateApiKey: Quota error during validation - will save keys anyway`);
      hadQuotaError = true;
    } else if (
      errorMessage.includes('Invalid API key') ||
      errorMessage.includes('API_KEY_INVALID') ||
      errorMessage.includes('401')
    ) {
      return {
        success: false,
        message:
          '❌ Invalid API keys. The keys were rejected by the API. Please check and try again.',
      };
    } else if (
      errorMessage.includes('Permission denied') ||
      errorMessage.includes('PERMISSION_DENIED') ||
      errorMessage.includes('403')
    ) {
      return {
        success: false,
        message: '❌ Permission denied. Your API keys may not have access to the Gemini API.',
      };
    } else {
      // Other errors (network etc) - warn but save
      logger.warn(`validateAndUpdateApiKey: Unexpected error: ${errorMessage}`);
    }
  }

  const serializedKeys = JSON.stringify(validFormatKeys);

  // Update the encrypted key
  try {
    logger.info(`validateAndUpdateApiKey: Encrypting and saving ${validFormatKeys.length} keys`);
    const encryptedKey = encryption.encrypt(serializedKeys);
    await db.updateGroupApiKey(groupChatId, encryptedKey);
    invalidateGeminiService(groupChatId);
    logger.info(`validateAndUpdateApiKey: API keys successfully saved for group ${groupChatId}`);

    let successMessage = `✅ <b>Success!</b> Updated ${validFormatKeys.length} API key(s).`;

    if (invalidFormatKeys.length > 0) {
      successMessage += `\n\n⚠️ <b>Note:</b> ${invalidFormatKeys.length} keys were skipped due to invalid format.`;
    }

    const quotaWarning =
      "\n\n⚠️ Note: The keys were saved but couldn't be fully tested due to quota limits. They will be validated on first use.";

    return {
      success: true,
      message: successMessage + (hadQuotaError ? quotaWarning : ''),
    };
  } catch (error) {
    logger.error(`validateAndUpdateApiKey: Error saving API key for group ${groupChatId}:`, error);
    return { success: false, message: '❌ Error saving API keys. Please try again.' };
  }
}

export async function updateApiKey(
  conversation: Conversation<MyContext>,
  ctx: MyConversationContext
) {
  const chat = ctx.chat;
  if (!chat || chat.type !== 'private') {
    logger.info('updateApiKey: Not a private chat');
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) {
    logger.info('updateApiKey: Could not identify user');
    await ctx.reply('❌ Could not identify user.');
    return;
  }

  logger.info(`updateApiKey: Starting for user ${userId}`);

  // Get the group chat ID from the update state
  const groupChatId = getUpdateState(chat.id);

  if (!groupChatId) {
    logger.info(`updateApiKey: No group selected for user ${userId}`);
    await ctx.reply('❌ No group selected for update. Please run /update_api_key again.');
    return;
  }

  logger.info(`updateApiKey: Group ${groupChatId} selected for user ${userId}`);

  // Wait for API key input
  try {
    logger.info(`updateApiKey: Waiting for API key from user ${userId}`);
    const apiKeyCtx = await conversation.waitFor('message:text');
    const apiKey = apiKeyCtx.message.text.trim();

    logger.info(`updateApiKey: Received input from user ${userId}, length: ${apiKey.length}`);

    clearUpdateState(chat.id);

    // Handle cancel
    if (apiKey.toLowerCase() === '/cancel') {
      logger.info(`updateApiKey: User ${userId} cancelled`);
      await apiKeyCtx.reply('❌ API key update cancelled.');
      return;
    }

    // Validate and update
    logger.info(`updateApiKey: Validating and updating API key for group ${groupChatId}`);
    const result = await validateAndUpdateApiKey(apiKey, groupChatId, userId, apiKeyCtx);
    logger.info(`updateApiKey: Result - success: ${result.success}`);

    await apiKeyCtx.reply(result.message);
    logger.info(`updateApiKey: Response sent to user ${userId}`);
  } catch (error: any) {
    clearUpdateState(chat.id);
    logger.error('Error in updateApiKey conversation:', error);
    logger.error('Error stack:', error.stack);
    try {
      await ctx.reply(
        `❌ An error occurred: ${error.message || 'Unknown error'}. Please try again with /update_api_key.`
      );
    } catch (replyError) {
      logger.error('Failed to send error message:', replyError);
    }
  }
}

export async function excludeUsers(
  conversation: Conversation<MyContext>,
  ctx: MyConversationContext
) {
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') {
    await ctx.reply('❌ This feature can only be used in group chats.');
    return;
  }

  // Get chat ID from context
  const groupChatId = chat.id;

  // Only the admin who opened this may answer it.
  const initiatorId = ctx.from?.id;
  if (!initiatorId) {
    await ctx.reply('❌ Could not identify who started this.');
    return;
  }

  if (!db) {
    await ctx.reply('❌ Database service not available.');
    return;
  }

  await ctx.reply(
    '👤 <b>Exclude Users</b>\n\n' +
      'You can exclude users in three ways:\n\n' +
      '1️⃣ <b>Reply to a message</b> - Reply to any message from the user you want to exclude\n' +
      '2️⃣ <b>Enter username</b> - Send username (with or without @)\n' +
      '   Example: <code>@username</code> or <code>username</code>\n' +
      '3️⃣ <b>Enter multiple</b> - Send multiple usernames separated by commas\n' +
      '   Example: <code>@user1, @user2, user3</code>\n\n' +
      'Send /cancel to go back.',
    { parse_mode: 'HTML' }
  );

  const inputCtx = await waitForMessageFrom(conversation, initiatorId);

  // Check if user sent /cancel
  if (inputCtx.message?.text?.toLowerCase() === '/cancel') {
    await ctx.reply('❌ Cancelled.');
    return;
  }

  // Check if user replied to a message
  if (inputCtx.message?.reply_to_message) {
    const repliedUser = inputCtx.message.reply_to_message.from;
    if (repliedUser && repliedUser.id) {
      const settings = await db.getGroupSettings(groupChatId);
      const excludedIds = settings.excluded_user_ids || [];

      if (excludedIds.includes(repliedUser.id)) {
        await ctx.reply(
          `❌ User ${repliedUser.username ? '@' + repliedUser.username : repliedUser.first_name || 'Unknown'} is already excluded.`
        );
        return;
      }

      excludedIds.push(repliedUser.id);
      await db.updateGroupSettings(groupChatId, {
        excludedUserIds: excludedIds,
      });

      const username = repliedUser.username
        ? `@${repliedUser.username}`
        : repliedUser.first_name || 'Unknown';
      await ctx.reply(`✅ User ${username} has been excluded from summaries.`);
      return;
    }
  }

  // Handle text input (username(s))
  const text = inputCtx.message?.text?.trim();
  if (!text) {
    await ctx.reply('❌ Please provide a username or reply to a message.');
    return;
  }

  // Parse usernames (with or without @, separated by commas)
  const usernames = text.split(',').map(u => u.trim().replace(/^@/, ''));

  if (!db) {
    await ctx.reply('❌ Database service not available.');
    return;
  }

  // Get recent messages to find user IDs by username
  const recentMessages = await db.query(
    `SELECT DISTINCT user_id, username, first_name
     FROM messages
     WHERE telegram_chat_id = $1
     AND username IS NOT NULL
     AND user_id IS NOT NULL
     ORDER BY timestamp DESC
     LIMIT 100`,
    [groupChatId]
  );

  const settings = await db.getGroupSettings(groupChatId);
  const excludedIds = [...(settings.excluded_user_ids || [])];
  const foundUsers: string[] = [];
  const notFound: string[] = [];

  for (const username of usernames) {
    // Find user ID by username
    const user = recentMessages.rows.find(
      (msg: any) => msg.username?.toLowerCase() === username.toLowerCase()
    );

    if (user && user.user_id) {
      if (!excludedIds.includes(user.user_id)) {
        excludedIds.push(user.user_id);
        foundUsers.push(`@${user.username}`);
      }
    } else {
      notFound.push(username);
    }
  }

  if (foundUsers.length > 0) {
    await db.updateGroupSettings(groupChatId, {
      excludedUserIds: excludedIds,
    });
    await ctx.reply(`✅ Excluded ${foundUsers.length} user(s): ${foundUsers.join(', ')}`);
  }

  if (notFound.length > 0) {
    await ctx.reply(
      `⚠️ Could not find these users: ${notFound.join(', ')}\n\n` +
        `Make sure they have sent at least one message in this group.`
    );
  }
}

/**
 * Captures a group's custom summarization prompt.
 *
 * The settings menu previously printed instructions and stopped there - the
 * TODO for this handler was never filled in, so custom_prompt was null for
 * every group while the code consuming it sat fully written in gemini.ts.
 */
export async function setCustomPrompt(
  conversation: Conversation<MyContext>,
  ctx: MyConversationContext
) {
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') {
    await ctx.reply('❌ This feature can only be used in group chats.');
    return;
  }

  if (!db) {
    await ctx.reply('❌ Database service not available.');
    return;
  }

  const groupChatId = chat.id;

  const initiatorId = ctx.from?.id;
  if (!initiatorId) {
    await ctx.reply('❌ Could not identify who started this.');
    return;
  }

  await ctx.reply(
    '🔧 <b>Custom Prompt</b>\n\n' +
      'Send the instructions you want the AI to follow when summarizing this group.\n\n' +
      '<b>Example:</b>\n' +
      '<code>Summarize in exactly 3 bullet points. Focus on decisions, ignore small talk.</code>\n\n' +
      'The messages are appended automatically — you do not need a placeholder.\n\n' +
      'Send <code>/clear</code> to remove the custom prompt and go back to the built-in styles.\n' +
      'Send <code>/cancel</code> to leave it unchanged.',
    { parse_mode: 'HTML' }
  );

  const inputCtx = await waitForTextFrom(conversation, initiatorId);
  const text = inputCtx.message.text.trim();

  if (text.toLowerCase() === '/cancel') {
    await inputCtx.reply('❌ Cancelled. The custom prompt is unchanged.');
    return;
  }

  if (text.toLowerCase() === '/clear') {
    await db.updateGroupSettings(groupChatId, { customPrompt: null });
    await inputCtx.reply('✅ Custom prompt removed. Summaries will use the selected style again.');
    return;
  }

  const MAX_PROMPT_LENGTH = 1000;
  if (text.length > MAX_PROMPT_LENGTH) {
    await inputCtx.reply(
      `❌ That prompt is ${text.length} characters. Please keep it under ${MAX_PROMPT_LENGTH}.`
    );
    return;
  }

  await db.updateGroupSettings(groupChatId, { customPrompt: text });

  await inputCtx.reply(
    '✅ <b>Custom prompt saved.</b>\n\n' +
      'It will be used for every summary in this group, in place of the style setting.\n\n' +
      '<i>Run /tldr_settings → Custom Prompt → /clear to undo.</i>',
    { parse_mode: 'HTML' }
  );
}

/**
 * Captures a group's schedule timezone.
 *
 * SchedulerService has always read schedule_timezone and resolved it with
 * Intl, but nothing ever wrote the column, so every group was pinned to UTC.
 */
export async function setScheduleTimezone(
  conversation: Conversation<MyContext>,
  ctx: MyConversationContext
) {
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') {
    await ctx.reply('❌ This feature can only be used in group chats.');
    return;
  }

  if (!db) {
    await ctx.reply('❌ Database service not available.');
    return;
  }

  const initiatorId = ctx.from?.id;
  if (!initiatorId) {
    await ctx.reply('❌ Could not identify who started this.');
    return;
  }

  await ctx.reply(
    '🌍 <b>Schedule Timezone</b>\n\n' +
      'Send your timezone name, for example:\n' +
      '<code>Africa/Addis_Ababa</code>\n' +
      '<code>Europe/London</code>\n' +
      '<code>America/New_York</code>\n' +
      '<code>Asia/Dubai</code>\n\n' +
      'Send <code>/cancel</code> to keep the current setting.',
    { parse_mode: 'HTML' }
  );

  const inputCtx = await waitForTextFrom(conversation, initiatorId);
  const input = inputCtx.message.text.trim();

  if (input.toLowerCase() === '/cancel') {
    await inputCtx.reply('❌ Cancelled. The timezone is unchanged.');
    return;
  }

  // Intl throws on an unknown zone, which is the cheapest reliable validation.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input }).format(new Date());
  } catch {
    await inputCtx.reply(
      `❌ "${escapeHtml(input)}" is not a timezone Telegram's server recognizes.\n\n` +
        'Use an IANA name like <code>Africa/Addis_Ababa</code>. ' +
        'Search "IANA timezone list" if you are unsure.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await db.updateGroupSettings(chat.id, { scheduleTimezone: input });

  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: input,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());

  await inputCtx.reply(
    `✅ Timezone set to <b>${input}</b>.\n\nIt is currently ${localTime} there.`,
    { parse_mode: 'HTML' }
  );
}
