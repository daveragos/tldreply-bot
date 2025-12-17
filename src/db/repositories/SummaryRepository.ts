import { BaseRepository } from './BaseRepository';
import { logger } from '../../utils/logger';

export class SummaryRepository extends BaseRepository {
  async insertSummary(data: {
    chatId: number;
    summaryText: string;
    messageCount: number;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO summaries (telegram_chat_id, summary_text, message_count, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_chat_id, period_start, period_end) DO NOTHING`,
      [data.chatId, data.summaryText, data.messageCount, data.periodStart, data.periodEnd]
    );
  }

  async getSummariesForGroup(chatId: number, limit: number = 50): Promise<any[]> {
    const result = await this.db.query(
      'SELECT * FROM summaries WHERE telegram_chat_id = $1 ORDER BY created_at DESC LIMIT $2',
      [chatId, limit]
    );
    return result.rows;
  }

  async cleanupOldSummaries(daysAgo: number): Promise<void> {
    // Delete summaries older than specified days (default 2 weeks = 14 days)
    const result = await this.db.query(
      "DELETE FROM summaries WHERE created_at < NOW() - (INTERVAL '1 day' * $1)",
      [daysAgo]
    );
    logger.info(`Cleaned up ${result.rowCount} old summaries`);
  }
}
