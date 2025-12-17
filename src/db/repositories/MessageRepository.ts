import { BaseRepository } from './BaseRepository';
import { logger } from '../../utils/logger';

export class MessageRepository extends BaseRepository {
  async insertMessage(data: {
    chatId: number;
    messageId: number;
    userId?: number;
    username?: string;
    firstName?: string;
    content: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO messages (telegram_chat_id, message_id, user_id, username, first_name, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (telegram_chat_id, message_id)
       DO UPDATE SET
         content = EXCLUDED.content,
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         user_id = EXCLUDED.user_id`,
      [data.chatId, data.messageId, data.userId, data.username, data.firstName, data.content]
    );
  }

  async getMessagesSinceTimestamp(
    chatId: number,
    since: Date,
    limit: number = 1000
  ): Promise<any[]> {
    // Allow up to 10000 messages for hierarchical summarization
    const maxLimit = Math.min(limit, 10000);
    const result = await this.db.query(
      'SELECT * FROM messages WHERE telegram_chat_id = $1 AND timestamp >= $2 ORDER BY timestamp ASC LIMIT $3',
      [chatId, since, maxLimit]
    );
    return result.rows;
  }

  async getMessagesSinceMessageId(
    chatId: number,
    sinceMessageId: number,
    limit: number = 1000
  ): Promise<any[]> {
    // Allow up to 10000 messages for hierarchical summarization
    const maxLimit = Math.min(limit, 10000);
    const result = await this.db.query(
      'SELECT * FROM messages WHERE telegram_chat_id = $1 AND message_id >= $2 ORDER BY message_id ASC LIMIT $3',
      [chatId, sinceMessageId, maxLimit]
    );
    return result.rows;
  }

  async getLastNMessages(chatId: number, count: number): Promise<any[]> {
    // Get the last N messages, ordered by timestamp descending, then reverse to chronological order
    const maxCount = Math.min(count, 10000); // Limit to 10000 messages
    const result = await this.db.query(
      'SELECT * FROM messages WHERE telegram_chat_id = $1 ORDER BY timestamp DESC, message_id DESC LIMIT $2',
      [chatId, maxCount]
    );
    // Reverse to get chronological order (oldest first)
    return result.rows.reverse();
  }

  async getMessagesToCleanup(hoursAgo: number): Promise<any[]> {
    // Get messages that are about to be deleted, grouped by chat
    const result = await this.db.query(
      "SELECT * FROM messages WHERE timestamp < NOW() - (INTERVAL '1 hour' * $1) ORDER BY telegram_chat_id, timestamp ASC",
      [hoursAgo]
    );
    return result.rows;
  }

  async cleanupOldMessages(hoursAgo: number): Promise<void> {
    const result = await this.db.query(
      "DELETE FROM messages WHERE timestamp < NOW() - (INTERVAL '1 hour' * $1)",
      [hoursAgo]
    );
    logger.info(`Cleaned up ${result.rowCount} old messages`);
  }
}
