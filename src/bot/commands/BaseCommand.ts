import { Bot, Context } from 'grammy';
import { ConversationFlavor } from '@grammyjs/conversations';
import { Database } from '../../db/database';
import { EncryptionService } from '../../utils/encryption';
import { logger } from '../../utils/logger';

export type MyContext = ConversationFlavor<Context>;

export abstract class BaseCommand {
  protected bot: Bot<MyContext>;
  protected db: Database;
  protected encryption: EncryptionService;

  constructor(bot: Bot<MyContext>, db: Database, encryption: EncryptionService) {
    this.bot = bot;
    this.db = db;
    this.encryption = encryption;
  }

  /**
   * Check if a user is an admin or creator of a group
   */
  protected async isAdminOrCreator(
    ctx: MyContext,
    chatId: number,
    userId: number
  ): Promise<boolean> {
    try {
      const member = await ctx.api.getChatMember(chatId, userId);
      return member.status === 'administrator' || member.status === 'creator';
    } catch (error) {
      logger.error('Error checking admin status:', error);
      return false;
    }
  }

  /**
   * Admin guard for callback queries.
   *
   * Callback queries fire for whoever taps the button, not whoever opened the
   * message, so checking admin status when a menu is opened proves nothing
   * about who is pressing its buttons. Every settings callback must re-check.
   *
   * On denial the callback is answered with a toast rather than editing the
   * message, so a non-admin tapping around cannot clobber the admin's menu.
   *
   * @returns true if the caller may proceed
   */
  protected async requireAdminForCallback(ctx: MyContext): Promise<boolean> {
    const chat = ctx.chat;
    const userId = ctx.from?.id;

    if (!chat || chat.type === 'private' || !userId) {
      await ctx.answerCallbackQuery({
        text: 'This can only be used in a group.',
        show_alert: true,
      });
      return false;
    }

    const isAdmin = await this.isAdminOrCreator(ctx, chat.id, userId);
    if (!isAdmin) {
      await ctx.answerCallbackQuery({
        text: 'Only group admins can change these settings.',
        show_alert: true,
      });
      return false;
    }

    await ctx.answerCallbackQuery();
    return true;
  }

  /**
   * Confirms a chat ID embedded in callback data matches the chat the callback
   * arrived from, so crafted or stale callback data cannot target another group.
   */
  protected callbackChatIdMatches(ctx: MyContext, chatId: number): boolean {
    return ctx.chat?.id === chatId;
  }

  // Abstract method to register commands
  abstract register(): void;
}
