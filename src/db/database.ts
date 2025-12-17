import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import { GroupRepository } from './repositories/GroupRepository';
import { MessageRepository } from './repositories/MessageRepository';
import { SummaryRepository } from './repositories/SummaryRepository';

export class Database {
  private pool: Pool;

  // Public repositories
  public readonly groups: GroupRepository;
  public readonly messages: MessageRepository;
  public readonly summaries: SummaryRepository;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Set connection timeout to help debug connection issues
      connectionTimeoutMillis: 10000,
    });

    // Handle connection errors
    this.pool.on('error', err => {
      logger.error('Unexpected error on idle database client', err);
    });

    // Initialize repositories
    this.groups = new GroupRepository(this);
    this.messages = new MessageRepository(this);
    this.summaries = new SummaryRepository(this);
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
      logger.error('Database connection test failed:', error);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // --- Forwarded Delegations for Backward Compatibility ---
  // (Ideally, update callers to use db.groups.createGroup(...) instead)

  // Groups
  async createGroup(chatId: number, userId: number): Promise<void> {
    return this.groups.createGroup(chatId, userId);
  }
  async getGroup(chatId: number): Promise<any> {
    return this.groups.getGroup(chatId);
  }
  async updateGroupApiKey(chatId: number, encryptedKey: string): Promise<void> {
    return this.groups.updateGroupApiKey(chatId, encryptedKey);
  }
  async toggleGroupEnabled(chatId: number, enabled: boolean): Promise<void> {
    return this.groups.toggleGroupEnabled(chatId, enabled);
  }
  async listGroupsForUser(userId: number): Promise<any[]> {
    return this.groups.listGroupsForUser(userId);
  }
  async deleteGroup(chatId: number): Promise<boolean> {
    return this.groups.deleteGroup(chatId);
  }

  // Group Settings
  async getGroupSettings(chatId: number): Promise<any> {
    return this.groups.getGroupSettings(chatId);
  }
  async createGroupSettings(chatId: number): Promise<void> {
    return this.groups.createGroupSettings(chatId);
  }
  async updateGroupSettings(chatId: number, settings: any): Promise<void> {
    return this.groups.updateGroupSettings(chatId, settings);
  }
  async updateLastScheduledSummary(chatId: number): Promise<void> {
    return this.groups.updateLastScheduledSummary(chatId);
  }
  async getGroupsWithScheduledSummaries(): Promise<any[]> {
    return this.groups.getGroupsWithScheduledSummaries();
  }

  // Messages
  async insertMessage(data: any): Promise<void> {
    return this.messages.insertMessage(data);
  }
  async getMessagesSinceTimestamp(chatId: number, since: Date, limit?: number): Promise<any[]> {
    return this.messages.getMessagesSinceTimestamp(chatId, since, limit);
  }
  async getMessagesSinceMessageId(
    chatId: number,
    sinceMessageId: number,
    limit?: number
  ): Promise<any[]> {
    return this.messages.getMessagesSinceMessageId(chatId, sinceMessageId, limit);
  }
  async getLastNMessages(chatId: number, count: number): Promise<any[]> {
    return this.messages.getLastNMessages(chatId, count);
  }
  async getMessagesToCleanup(hoursAgo: number): Promise<any[]> {
    return this.messages.getMessagesToCleanup(hoursAgo);
  }
  async cleanupOldMessages(hoursAgo: number): Promise<void> {
    return this.messages.cleanupOldMessages(hoursAgo);
  }

  // Summaries
  async insertSummary(data: any): Promise<void> {
    return this.summaries.insertSummary(data);
  }
  async getSummariesForGroup(chatId: number, limit?: number): Promise<any[]> {
    return this.summaries.getSummariesForGroup(chatId, limit);
  }
  async cleanupOldSummaries(daysAgo: number): Promise<void> {
    return this.summaries.cleanupOldSummaries(daysAgo);
  }
}
