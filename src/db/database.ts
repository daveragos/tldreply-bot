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
    this.pool.on('error', (err) => {
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
    await this.query(
      'INSERT INTO groups (telegram_chat_id, setup_by_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [chatId, userId]
    );
  }

  async getGroup(chatId: number): Promise<any> {
    const result = await this.query(
      'SELECT * FROM groups WHERE telegram_chat_id = $1',
      [chatId]
    );
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

  // Message operations
  async insertMessage(data: {
    chatId: number;
    messageId: number;
    userId?: number;
    username?: string;
    firstName?: string;
    content: string;
  }): Promise<void> {
    await this.query(
      `INSERT INTO messages (telegram_chat_id, message_id, user_id, username, first_name, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (telegram_chat_id, message_id) DO NOTHING`,
      [data.chatId, data.messageId, data.userId, data.username, data.firstName, data.content]
    );
  }

  async getMessagesSinceTimestamp(chatId: number, since: Date): Promise<any[]> {
    const result = await this.query(
      'SELECT * FROM messages WHERE telegram_chat_id = $1 AND timestamp >= $2 ORDER BY timestamp ASC',
      [chatId, since]
    );
    return result.rows;
  }

  async getMessagesSinceMessageId(chatId: number, sinceMessageId: number): Promise<any[]> {
    const result = await this.query(
      'SELECT * FROM messages WHERE telegram_chat_id = $1 AND message_id >= $2 ORDER BY message_id ASC',
      [chatId, sinceMessageId]
    );
    return result.rows;
  }

  async cleanupOldMessages(hoursAgo: number): Promise<void> {
    const result = await this.query(
      'DELETE FROM messages WHERE timestamp < NOW() - INTERVAL \'$1 hours\'',
      [hoursAgo.toString()]
    );
    console.log(`Cleaned up ${result.rowCount} old messages`);
  }

  // Settings operations
  async getGroupSettings(chatId: number): Promise<any> {
    const result = await this.query(
      'SELECT * FROM group_settings WHERE telegram_chat_id = $1',
      [chatId]
    );
    return result.rows[0];
  }

  async createDefaultSettings(chatId: number): Promise<void> {
    await this.query(
      'INSERT INTO group_settings (telegram_chat_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [chatId]
    );
  }
}
