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

  // Abstract method to register commands
  abstract register(): void;
}
