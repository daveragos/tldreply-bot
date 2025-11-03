import { Context } from 'grammy';
import { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { GeminiService } from '../services/gemini';

type MyContext = ConversationFlavor<Context> & {
  db?: any;
  encryption?: any;
};

type MyConversationContext = Context & {
  db?: any;
  encryption?: any;
};

export async function setupApiKeyConversation(conversation: Conversation<MyContext>, ctx: MyConversationContext) {
  const chat = ctx.chat;
  if (!chat || chat.type !== 'private') return;

  await ctx.reply('Please paste your Gemini API key:');

  const apiKeyCtx = await conversation.waitFor('message:text');
  const apiKey = apiKeyCtx.message.text.trim();

  // Validate API key format
  if (!GeminiService.validateApiKey(apiKey)) {
    await ctx.reply('❌ Invalid API key format. Please try again with /setup_group.');
    return;
  }

  // Test the API key
  try {
    const gemini = new GeminiService(apiKey);
    await gemini.summarizeMessages([{ content: 'test', timestamp: new Date().toISOString() }]);
    
    // If successful, save the encrypted key
    const encryption = ctx.encryption;
    const db = ctx.db;
    
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
    const encryptedKey = encryption.encrypt(apiKey);
    await db.updateGroupApiKey(groupChatId, encryptedKey);

    await ctx.reply('✅ Successfully configured! You can now use /tldr in your group.');
  } catch (error) {
    console.error('API key validation error:', error);
    await ctx.reply('❌ Invalid or expired API key. Please check your key and try again.');
  }
}
