import { Database } from '../database';

export abstract class BaseRepository {
  protected db: Database;

  constructor(db: Database) {
    this.db = db;
  }
}
