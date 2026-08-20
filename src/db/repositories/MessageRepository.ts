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
    isBot?: boolean;
    isChannel?: boolean;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO messages (telegram_chat_id, message_id, user_id, username, first_name, content, is_bot, is_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (telegram_chat_id, message_id)
       DO UPDATE SET
         content = EXCLUDED.content,
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         user_id = EXCLUDED.user_id,
         is_bot = EXCLUDED.is_bot,
         is_channel = EXCLUDED.is_channel`,
      [
        data.chatId,
        data.messageId,
        data.userId,
        data.username,
        data.firstName,
        data.content,
        data.isBot || false,
        data.isChannel || false,
      ]
    );
  }

  async getMessagesSinceTimestamp(
    chatId: number,
    since: Date,
    limit: number = 1000,
    username?: string
  ): Promise<any[]> {
    // Allow up to 10000 messages for hierarchical summarization
    const maxLimit = Math.min(limit, 10000);
    let query = 'SELECT * FROM messages WHERE telegram_chat_id = $1 AND timestamp >= $2';
    const params: any[] = [chatId, since];

    if (username) {
      // Telegram usernames are case-insensitive, and the stored casing is
      // whatever the user had when the message was cached.
      query += ` AND LOWER(username) = LOWER($${params.length + 1})`;
      params.push(username);
    }

    query += ` ORDER BY timestamp ASC LIMIT $${params.length + 1}`;
    params.push(maxLimit);

    const result = await this.db.query(query, params);
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

  async getLastNMessages(chatId: number, count: number, username?: string): Promise<any[]> {
    // Get the last N messages, ordered by timestamp descending, then reverse to chronological order
    const maxCount = Math.min(count, 10000); // Limit to 10000 messages
    let query = 'SELECT * FROM messages WHERE telegram_chat_id = $1';
    const params: any[] = [chatId];

    if (username) {
      query += ` AND LOWER(username) = LOWER($${params.length + 1})`;
      params.push(username);
    }

    query += ` ORDER BY timestamp DESC, message_id DESC LIMIT $${params.length + 1}`;
    params.push(maxCount);

    const result = await this.db.query(query, params);
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

  /**
   * Deletes messages past the retention window in batches.
   *
   * A single unbounded DELETE over a large backlog holds one long transaction
   * and bloats the WAL, which matters on a small managed instance. Batching
   * keeps each statement short and lets other queries interleave.
   *
   * @returns the number of rows deleted
   */
  async cleanupOldMessages(hoursAgo: number, batchSize: number = 5000): Promise<number> {
    let totalDeleted = 0;

    for (;;) {
      const result = await this.db.query(
        `DELETE FROM messages
         WHERE id IN (
           SELECT id FROM messages
           WHERE timestamp < NOW() - (INTERVAL '1 hour' * $1)
           LIMIT $2
         )`,
        [hoursAgo, batchSize]
      );

      const deleted = result.rowCount ?? 0;
      totalDeleted += deleted;

      if (deleted < batchSize) break;
    }

    if (totalDeleted > 0) {
      logger.info(`Cleaned up ${totalDeleted} old messages`);
    }
    return totalDeleted;
  }

  /** Counts messages older than the retention window without loading them. */
  async countMessagesOlderThan(hoursAgo: number): Promise<number> {
    const result = await this.db.query(
      "SELECT COUNT(*)::int AS count FROM messages WHERE timestamp < NOW() - (INTERVAL '1 hour' * $1)",
      [hoursAgo]
    );
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Streams the chat IDs that have messages due for cleanup, so the caller can
   * process one group at a time instead of loading every stale row into memory.
   */
  async getChatIdsWithMessagesOlderThan(hoursAgo: number): Promise<number[]> {
    const result = await this.db.query(
      `SELECT DISTINCT telegram_chat_id
       FROM messages
       WHERE timestamp < NOW() - (INTERVAL '1 hour' * $1)`,
      [hoursAgo]
    );
    return result.rows.map((row: { telegram_chat_id: string | number }) =>
      Number(row.telegram_chat_id)
    );
  }

  /** Stale messages for a single chat, oldest first. */
  async getMessagesToCleanupForChat(chatId: number, hoursAgo: number): Promise<any[]> {
    const result = await this.db.query(
      `SELECT * FROM messages
       WHERE telegram_chat_id = $1
         AND timestamp < NOW() - (INTERVAL '1 hour' * $2)
       ORDER BY timestamp ASC`,
      [chatId, hoursAgo]
    );
    return result.rows;
  }

  /**
   * Streams messages in batches, oldest first, for export.
   *
   * Uses keyset pagination on the primary key rather than OFFSET: the table is
   * large, and OFFSET makes the database re-scan everything it already skipped.
   * Yielding batches keeps memory flat regardless of table size.
   *
   * @param olderThanHours when set, only messages past this age
   * @param batchSize      rows fetched per round trip
   */
  async *streamMessages(
    olderThanHours?: number,
    batchSize: number = 2000
  ): AsyncGenerator<any[], void, undefined> {
    let afterId = 0;

    for (;;) {
      const params: any[] = [afterId];
      let where = 'id > $1';

      if (olderThanHours !== undefined) {
        where += ` AND timestamp < NOW() - (INTERVAL '1 hour' * $${params.length + 1})`;
        params.push(olderThanHours);
      }

      params.push(batchSize);
      const result = await this.db.query(
        `SELECT * FROM messages WHERE ${where} ORDER BY id ASC LIMIT $${params.length}`,
        params
      );

      if (result.rows.length === 0) return;

      yield result.rows;
      afterId = Number(result.rows[result.rows.length - 1].id);

      if (result.rows.length < batchSize) return;
    }
  }

  /** Total rows, optionally restricted to messages past a given age. */
  async countMessages(olderThanHours?: number): Promise<number> {
    if (olderThanHours === undefined) {
      const all = await this.db.query('SELECT COUNT(*)::int AS count FROM messages', []);
      return all.rows[0]?.count ?? 0;
    }
    return this.countMessagesOlderThan(olderThanHours);
  }

  /**
   * Re-inserts an exported message.
   *
   * Distinct from insertMessage: restore must not overwrite a live row that
   * has since been edited, so a conflict is left alone rather than updated.
   * The original timestamp is preserved.
   */
  async restoreMessage(row: {
    telegram_chat_id: number | string;
    message_id: number | string;
    user_id?: number | string | null;
    username?: string | null;
    first_name?: string | null;
    content?: string | null;
    is_bot?: boolean;
    is_channel?: boolean;
    timestamp?: string | Date;
  }): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO messages
         (telegram_chat_id, message_id, user_id, username, first_name, content, is_bot, is_channel, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, CURRENT_TIMESTAMP))
       ON CONFLICT (telegram_chat_id, message_id) DO NOTHING`,
      [
        row.telegram_chat_id,
        row.message_id,
        row.user_id ?? null,
        row.username ?? null,
        row.first_name ?? null,
        row.content ?? null,
        row.is_bot ?? false,
        row.is_channel ?? false,
        row.timestamp ?? null,
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
