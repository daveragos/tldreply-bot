import { BaseRepository } from './BaseRepository';

export class GroupRepository extends BaseRepository {
  async createGroup(chatId: number, userId: number): Promise<void> {
    // Use ON CONFLICT to update setup_by_user_id if group exists but isn't linked to this user yet
    await this.db.query(
      `INSERT INTO groups (telegram_chat_id, setup_by_user_id)
       VALUES ($1, $2)
       ON CONFLICT (telegram_chat_id)
       DO UPDATE SET setup_by_user_id = $2, setup_at = CURRENT_TIMESTAMP
       WHERE groups.gemini_api_key_encrypted IS NULL`,
      [chatId, userId]
    );
  }

  async getGroup(chatId: number): Promise<any> {
    const result = await this.db.query('SELECT * FROM groups WHERE telegram_chat_id = $1', [
      chatId,
    ]);
    return result.rows[0];
  }

  async updateGroupApiKey(chatId: number, encryptedKey: string): Promise<void> {
    await this.db.query(
      'UPDATE groups SET gemini_api_key_encrypted = $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_chat_id = $2',
      [encryptedKey, chatId]
    );
  }

  async toggleGroupEnabled(chatId: number, enabled: boolean): Promise<void> {
    await this.db.query(
      'UPDATE groups SET enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_chat_id = $2',
      [enabled, chatId]
    );
  }

  async listGroupsForUser(userId: number): Promise<any[]> {
    const result = await this.db.query(
      'SELECT * FROM groups WHERE setup_by_user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  async deleteGroup(chatId: number): Promise<boolean> {
    const result = await this.db.query('DELETE FROM groups WHERE telegram_chat_id = $1', [chatId]);
    // Returns true if a row was deleted, false otherwise
    return (result.rowCount ?? 0) > 0;
  }

  // Group settings operations
  async getGroupSettings(chatId: number): Promise<any> {
    const result = await this.db.query('SELECT * FROM group_settings WHERE telegram_chat_id = $1', [
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
    await this.db.query(
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

    await this.db.query(
      `UPDATE group_settings SET ${updates.join(', ')} WHERE telegram_chat_id = $${paramIndex}`,
      values
    );
  }

  async updateLastScheduledSummary(chatId: number): Promise<void> {
    await this.db.query(
      'UPDATE group_settings SET last_scheduled_summary = CURRENT_TIMESTAMP WHERE telegram_chat_id = $1',
      [chatId]
    );
  }

  async getGroupsWithScheduledSummaries(): Promise<any[]> {
    const result = await this.db.query(
      'SELECT * FROM group_settings WHERE scheduled_enabled = true',
      []
    );
    return result.rows;
  }
}
