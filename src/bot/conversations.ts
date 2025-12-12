import { Context } from 'grammy';
import { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { GeminiService } from '../services/gemini';
import {
  db,
  encryption,
  getUpdateState,
  clearUpdateState,
  setUpdateState,
} from '../services/services';

type MyContext = ConversationFlavor<Context>;

type MyConversationContext = Context;

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

  // Validate API key format
  if (!apiKey || !GeminiService.validateApiKey(apiKey)) {
    await replyCtx.reply('❌ Invalid API key format. Please try again with /setup_group.');
    return;
  }

  // Test the API key
  try {
    const gemini = new GeminiService(apiKey);
    await gemini.summarizeMessages([{ content: 'test', timestamp: new Date().toISOString() }]);

    // If successful, save the encrypted key
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

    const encryptedKey = encryption.encrypt(apiKey);
    await db.updateGroupApiKey(groupChatId, encryptedKey);

    await replyCtx.reply('✅ Successfully configured! You can now use /tldr in your group.');
  } catch (error: any) {
    console.error('API key validation error:', error);

    // Provide specific error messages
    const errorMessage = error.message || 'Unknown error';
    if (
      errorMessage.includes('Invalid API key') ||
      errorMessage.includes('API_KEY_INVALID') ||
      errorMessage.includes('401')
    ) {
      await replyCtx.reply(
        '❌ Invalid API key. The API key format is incorrect or the key is invalid. Please check your key and try again.\n\n💡 Get a new key from: https://makersuite.google.com/app/apikey'
      );
    } else if (
      errorMessage.includes('quota') ||
      errorMessage.includes('QUOTA_EXCEEDED') ||
      errorMessage.includes('429')
    ) {
      await replyCtx.reply(
        '❌ API quota exceeded. Your Gemini API key has reached its rate limit or quota. Please try again later or check your API usage.'
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
 * Helper function to validate and update API key
 */
async function validateAndUpdateApiKey(
  apiKey: string,
  groupChatId: number,
  userId: number,
  ctx: MyConversationContext
): Promise<{ success: boolean; message: string }> {
  console.log(
    `validateAndUpdateApiKey: Starting validation for group ${groupChatId}, user ${userId}`
  );

  // Validate API key format
  if (!GeminiService.validateApiKey(apiKey)) {
    console.log(`validateAndUpdateApiKey: Invalid API key format`);
    return {
      success: false,
      message: '❌ Invalid API key format. Please check your key and try again.',
    };
  }

  if (!encryption || !db) {
    console.error(
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

  // Test the API key (optional - quota errors don't mean the key is invalid)
  let hadQuotaError = false;
  try {
    console.log(`validateAndUpdateApiKey: Testing API key for group ${groupChatId}`);
    const gemini = new GeminiService(apiKey);
    await gemini.summarizeMessages([{ content: 'test', timestamp: new Date().toISOString() }]);
    console.log(`validateAndUpdateApiKey: API key test successful for group ${groupChatId}`);
  } catch (error: any) {
    console.error(`validateAndUpdateApiKey: API key test failed for group ${groupChatId}:`, error);
    const errorMessage = error.message || 'Unknown error';

    // If it's a quota error during validation, we'll still save the key
    // The key might be valid but just hit quota limits during testing
    if (
      errorMessage.includes('quota') ||
      errorMessage.includes('QUOTA_EXCEEDED') ||
      errorMessage.includes('429')
    ) {
      console.log(
        `validateAndUpdateApiKey: Quota error during validation - will save key anyway for group ${groupChatId}`
      );
      hadQuotaError = true;
      // Continue to save the key - quota errors during test don't mean the key is invalid
    } else if (
      errorMessage.includes('Invalid API key') ||
      errorMessage.includes('API_KEY_INVALID') ||
      errorMessage.includes('401')
    ) {
      return {
        success: false,
        message:
          '❌ Invalid API key. The API key format is incorrect or the key is invalid. Please check your key and try again.\n\n💡 Get a new key from: https://makersuite.google.com/app/apikey',
      };
    } else if (
      errorMessage.includes('Permission denied') ||
      errorMessage.includes('PERMISSION_DENIED') ||
      errorMessage.includes('403')
    ) {
      return {
        success: false,
        message:
          '❌ Permission denied. Your API key may not have access to the Gemini API. Please check your API key permissions.',
      };
    } else if (
      errorMessage.includes('network') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ENOTFOUND')
    ) {
      // Network errors during validation - we'll save the key anyway
      console.log(
        `validateAndUpdateApiKey: Network error during validation - will save key anyway for group ${groupChatId}`
      );
    } else {
      // Other errors - warn but still save (might be temporary issues)
      console.warn(
        `validateAndUpdateApiKey: Unexpected error during validation: ${errorMessage} - will save key anyway`
      );
    }
  }

  // Update the encrypted key
  try {
    console.log(`validateAndUpdateApiKey: Encrypting and saving API key for group ${groupChatId}`);
    const encryptedKey = encryption.encrypt(apiKey);
    await db.updateGroupApiKey(groupChatId, encryptedKey);
    console.log(`validateAndUpdateApiKey: API key successfully saved for group ${groupChatId}`);

    const successMessage =
      '✅ API key updated successfully! The bot will now use the new key for summaries.';
    const quotaWarning =
      "\n\n⚠️ Note: The key was saved but couldn't be fully tested due to quota limits. It will be validated on first use.";

    return {
      success: true,
      message: successMessage + (hadQuotaError ? quotaWarning : ''),
    };
  } catch (error) {
    console.error(`validateAndUpdateApiKey: Error saving API key for group ${groupChatId}:`, error);
    return { success: false, message: '❌ Error saving API key. Please try again.' };
  }
}

export async function updateApiKey(
  conversation: Conversation<MyContext>,
  ctx: MyConversationContext
) {
  const chat = ctx.chat;
  if (!chat || chat.type !== 'private') {
    console.log('updateApiKey: Not a private chat');
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) {
    console.log('updateApiKey: Could not identify user');
    await ctx.reply('❌ Could not identify user.');
    return;
  }

  console.log(`updateApiKey: Starting for user ${userId}`);

  // Get the group chat ID from the update state
  const groupChatId = getUpdateState(chat.id);

  if (!groupChatId) {
    console.log(`updateApiKey: No group selected for user ${userId}`);
    await ctx.reply('❌ No group selected for update. Please run /update_api_key again.');
    return;
  }

  console.log(`updateApiKey: Group ${groupChatId} selected for user ${userId}`);

  // Wait for API key input
  try {
    console.log(`updateApiKey: Waiting for API key from user ${userId}`);
    const apiKeyCtx = await conversation.waitFor('message:text');
    const apiKey = apiKeyCtx.message.text.trim();

    console.log(`updateApiKey: Received input from user ${userId}, length: ${apiKey.length}`);

    clearUpdateState(chat.id);

    // Handle cancel
    if (apiKey.toLowerCase() === '/cancel') {
      console.log(`updateApiKey: User ${userId} cancelled`);
      await apiKeyCtx.reply('❌ API key update cancelled.');
      return;
    }

    // Validate and update
    console.log(`updateApiKey: Validating and updating API key for group ${groupChatId}`);
    const result = await validateAndUpdateApiKey(apiKey, groupChatId, userId, apiKeyCtx);
    console.log(`updateApiKey: Result - success: ${result.success}`);

    await apiKeyCtx.reply(result.message);
    console.log(`updateApiKey: Response sent to user ${userId}`);
  } catch (error: any) {
    clearUpdateState(chat.id);
    console.error('Error in updateApiKey conversation:', error);
    console.error('Error stack:', error.stack);
    try {
      await ctx.reply(
        `❌ An error occurred: ${error.message || 'Unknown error'}. Please try again with /update_api_key.`
      );
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
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

  const inputCtx = await conversation.wait();

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
