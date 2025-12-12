import { Pool, PoolClient } from 'pg';

export class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Set connection timeout to help debug connection issues
      connectionTimeoutMillis: 10000,
    });

    // Handle connection errors
    this.pool.on('error', err => {
      console.error('Unexpected error on idle database client', err);
    });
  }

  async query(text: string, params?: any[]) {
    return this.pool.query(text, params);
  }

  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.pool.query('SELECT NOW()');
      return true;
    } catch (error) {
      console.error('Database connection test failed:', error);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // Group operations
  async createGroup(chatId: number, userId: number): Promise<void> {
    // Use ON CONFLICT to update setup_by_user_id if group exists but isn't linked to this user yet
    await this.query(
      `INSERT INTO groups (telegram_chat_id, setup_by_user_id)
       VALUES ($1, $2)
       ON CONFLICT (telegram_chat_id)
       DO UPDATE SET setup_by_user_id = $2, setup_at = CURRENT_TIMESTAMP
       WHERE groups.gemini_api_key_encrypted IS NULL`,
      [chatId, userId]
    );
  }

  async getGroup(chatId: number): Promise<any> {
    const result = await this.query('SELECT * FROM groups WHERE telegram_chat_id = $1', [chatId]);
    return result.rows[0];
  }

  async updateGroupApiKey(chatId: number, encryptedKey: string): Promise<void> {
    await this.query(
      'UPDATE groups SET gemini_api_key_encrypted = $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_chat_id = $2',
      [encryptedKey, chatId]
    );
  }

  async toggleGroupEnabled(chatId: number, enabled: boolean): Promise<void> {
    await this.query(
      'UPDATE groups SET enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_chat_id = $2',
      [enabled, chatId]
    );
  }

  async listGroupsForUser(userId: number): Promise<any[]> {
    const result = await this.query(
      'SELECT * FROM groups WHERE setup_by_user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  async deleteGroup(chatId: number): Promise<boolean> {
    const result = await this.query('DELETE FROM groups WHERE telegram_chat_id = $1', [chatId]);
    // Returns true if a row was deleted, false otherwise
    return (result.rowCount ?? 0) > 0;
  }

  // Message operations
  async insertMessage(data: {
    chatId: number;
    messageId: number;
    userId?: number;
    username?: string;
    firstName?: string;
    content: string;
  }): Promise<void> {
    // SQL Injection Protection: All values are passed as parameters ($1, $2, etc.)
    // Even if user sends SQL strings like "'; DROP TABLE messages; --", they will be
    // safely stored as text content, not executed as SQL commands.
    // Use DO UPDATE to handle edited messages - update content, username, and first_name if they changed
    await this.query(
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
    // The GeminiService will handle chunking if messages exceed 1000
    const maxLimit = Math.min(limit, 10000);
    const result = await this.query(
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
    // The GeminiService will handle chunking if messages exceed 1000
    const maxLimit = Math.min(limit, 10000);
    const result = await this.query(
      'SELECT * FROM messages WHERE telegram_chat_id = $1 AND message_id >= $2 ORDER BY message_id ASC LIMIT $3',
      [chatId, sinceMessageId, maxLimit]
    );
    return result.rows;
  }

  async getLastNMessages(chatId: number, count: number): Promise<any[]> {
    // Get the last N messages, ordered by timestamp descending, then reverse to chronological order
    const maxCount = Math.min(count, 10000); // Limit to 10000 messages
    const result = await this.query(
      'SELECT * FROM messages WHERE telegram_chat_id = $1 ORDER BY timestamp DESC, message_id DESC LIMIT $2',
      [chatId, maxCount]
    );
    // Reverse to get chronological order (oldest first)
    return result.rows.reverse();
  }

  async getMessagesToCleanup(hoursAgo: number): Promise<any[]> {
    // Get messages that are about to be deleted, grouped by chat
    const result = await this.query(
      "SELECT * FROM messages WHERE timestamp < NOW() - (INTERVAL '1 hour' * $1) ORDER BY telegram_chat_id, timestamp ASC",
      [hoursAgo]
    );
    return result.rows;
  }

  async cleanupOldMessages(hoursAgo: number): Promise<void> {
    // Use proper PostgreSQL interval arithmetic to avoid SQL injection
    // Multiply 1 hour interval by the parameter value
    const result = await this.query(
      "DELETE FROM messages WHERE timestamp < NOW() - (INTERVAL '1 hour' * $1)",
      [hoursAgo]
    );
    console.log(`Cleaned up ${result.rowCount} old messages`);
  }

  // Summary operations
  async insertSummary(data: {
    chatId: number;
    summaryText: string;
    messageCount: number;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<void> {
    await this.query(
      `INSERT INTO summaries (telegram_chat_id, summary_text, message_count, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_chat_id, period_start, period_end) DO NOTHING`,
      [data.chatId, data.summaryText, data.messageCount, data.periodStart, data.periodEnd]
    );
  }

  async getSummariesForGroup(chatId: number, limit: number = 50): Promise<any[]> {
    const result = await this.query(
      'SELECT * FROM summaries WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT $2',
      [chatId, limit]
    );
    return result.rows;
  }

  async cleanupOldSummaries(daysAgo: number): Promise<void> {
    // Delete summaries older than specified days (default 2 weeks = 14 days)
    const result = await this.query(
      "DELETE FROM summaries WHERE created_at < NOW() - (INTERVAL '1 day' * $1)",
      [daysAgo]
    );
    console.log(`Cleaned up ${result.rowCount} old summaries`);
  }

  // Group settings operations
  async getGroupSettings(chatId: number): Promise<any> {
    const result = await this.query('SELECT * FROM group_settings WHERE telegram_chat_id = $1', [
      chatId,
    ]);
    if (result.rows.length === 0) {
      // Create default settings if none exist
      await this.createGroupSettings(chatId);
      return await this.getGroupSettings(chatId);
    }
    return result.rows[0];
  }

  async createGroupSettings(chatId: number): Promise<void> {
    await this.query(
      `INSERT INTO group_settings (telegram_chat_id) VALUES ($1) ON CONFLICT (telegram_chat_id) DO NOTHING`,
      [chatId]
    );
  }

  async updateGroupSettings(
    chatId: number,
    settings: {
      summaryStyle?: string;
      customPrompt?: string | null;
      excludeBotMessages?: boolean;
      excludeCommands?: boolean;
      excludedUserIds?: number[];
      scheduledEnabled?: boolean;
      scheduleFrequency?: string;
      scheduleTime?: string;
      scheduleTimezone?: string;
    }
  ): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (settings.summaryStyle !== undefined) {
      updates.push(`summary_style = $${paramIndex++}`);
      values.push(settings.summaryStyle);
    }
    if (settings.customPrompt !== undefined) {
      updates.push(`custom_prompt = $${paramIndex++}`);
      values.push(settings.customPrompt);
    }
    if (settings.excludeBotMessages !== undefined) {
      updates.push(`exclude_bot_messages = $${paramIndex++}`);
      values.push(settings.excludeBotMessages);
    }
    if (settings.excludeCommands !== undefined) {
      updates.push(`exclude_commands = $${paramIndex++}`);
      values.push(settings.excludeCommands);
    }
    if (settings.excludedUserIds !== undefined) {
      updates.push(`excluded_user_ids = $${paramIndex++}`);
      values.push(settings.excludedUserIds);
    }
    if (settings.scheduledEnabled !== undefined) {
      updates.push(`scheduled_enabled = $${paramIndex++}`);
      values.push(settings.scheduledEnabled);
    }
    if (settings.scheduleFrequency !== undefined) {
      updates.push(`schedule_frequency = $${paramIndex++}`);
      values.push(settings.scheduleFrequency);
    }
    if (settings.scheduleTime !== undefined) {
      updates.push(`schedule_time = $${paramIndex++}`);
      values.push(settings.scheduleTime);
    }
    if (settings.scheduleTimezone !== undefined) {
      updates.push(`schedule_timezone = $${paramIndex++}`);
      values.push(settings.scheduleTimezone);
    }

    if (updates.length === 0) return;

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(chatId);

    await this.query(
      `UPDATE group_settings SET ${updates.join(', ')} WHERE telegram_chat_id = $${paramIndex}`,
      values
    );
  }

  async updateLastScheduledSummary(chatId: number): Promise<void> {
    await this.query(
      'UPDATE group_settings SET last_scheduled_summary = CURRENT_TIMESTAMP WHERE telegram_chat_id = $1',
      [chatId]
    );
  }

  async getGroupsWithScheduledSummaries(): Promise<any[]> {
    const result = await this.query(
      'SELECT * FROM group_settings WHERE scheduled_enabled = true',
      []
    );
    return result.rows;
  }
}
