import { Bot } from 'grammy';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import { MyContext } from './commands/BaseCommand';
import { PrivateCommands } from './commands/PrivateCommands';
import { GroupCommands } from './commands/GroupCommands';
import { AdminCommands } from './commands/AdminCommands';

export class CommandRegistry {
  private privateCommands: PrivateCommands;
  private groupCommands: GroupCommands;
  private adminCommands: AdminCommands;

  constructor(bot: Bot<MyContext>, db: Database, encryption: EncryptionService) {
    this.privateCommands = new PrivateCommands(bot, db, encryption);
    this.groupCommands = new GroupCommands(bot, db, encryption);
    this.adminCommands = new AdminCommands(bot, db, encryption);
  }

  registerAll() {
    this.privateCommands.register();
    this.groupCommands.register();
    this.adminCommands.register();
  }
}
