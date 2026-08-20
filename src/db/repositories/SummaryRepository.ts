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

  /**
   * Summaries whose covered period overlaps [since, until], oldest first.
   *
   * Used to answer /tldr ranges that reach past the message retention window:
   * the raw messages are gone, but their summary is not.
   */
  async getSummariesInRange(chatId: number, since: Date, until: Date): Promise<any[]> {
    const result = await this.db.query(
      `SELECT * FROM summaries
       WHERE telegram_chat_id = $1
         AND period_end >= $2
         AND period_start <= $3
       ORDER BY period_start ASC`,
      [chatId, since, until]
    );
    return result.rows;
  }

  /** Oldest period covered by any stored summary, or null when there are none. */
  async getEarliestPeriodStart(chatId: number): Promise<Date | null> {
    const result = await this.db.query(
      'SELECT MIN(period_start) AS earliest FROM summaries WHERE telegram_chat_id = $1',
      [chatId]
    );
    const earliest = result.rows[0]?.earliest;
    return earliest ? new Date(earliest) : null;
  }

  /** How many summaries are stored for a group. */
  async countForGroup(chatId: number): Promise<number> {
    const result = await this.db.query(
      'SELECT COUNT(*)::int AS count FROM summaries WHERE telegram_chat_id = $1',
      [chatId]
    );
    return result.rows[0]?.count ?? 0;
  }
}
