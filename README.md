# TLDR Bot 🤖

A Telegram bot that summarizes group chat conversations using Google's Gemini AI.

## Features

- 📝 **Smart Summaries**: Get concise summaries of group discussions using AI
- ⏰ **Time-Based**: Summarize the last hour, 6 hours, day, or week (max 7 days)
- 💬 **Reply to Summarize**: Reply to any message to summarize from that point
- 📅 **Auto-Summarization**: Messages are automatically summarized before deletion (48 hours)
- 📚 **Summary History**: Summaries are kept for 2 weeks before permanent deletion
- 🔒 **Per-Group API Keys**: Each group uses its own Gemini API key
- 🔐 **Encrypted Storage**: API keys are encrypted at rest
- ⚙️ **Customizable**: Customize summary style, filters, and scheduled summaries
- 🌐 **PostgreSQL**: Uses PostgreSQL for reliable data storage
- 🗑️ **Auto-Delete**: Messages are automatically deleted after 48 hours

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL database (Supabase, Neon, Railway, etc.)
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Google Gemini API Key (from [Google AI Studio](https://makersuite.google.com/app/apikey))

### Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd tldreply-bot
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `env.example`:
```bash
cp env.example .env
```

4. Configure your environment variables:
```env
TELEGRAM_TOKEN=your_telegram_bot_token
DATABASE_URL=postgresql://user:password@host:port/database
ENCRYPTION_SECRET=your_random_secret_min_32_chars
```

5. Set up the database:
```bash
# Connect to your PostgreSQL database and run:
psql $DATABASE_URL < src/db/schema.sql
```

6. Run the bot:
```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Usage

### For Group Admins

**Public Groups (have @username):**
1. Add the bot to your Telegram group
2. **Disable privacy mode**: Go to @BotFather → `/setprivacy` → Select your bot → Choose "Disable"
3. Open a private chat with the bot
4. Run `/setup_group @your_group_username`
5. Provide your Gemini API key when prompted
6. Start using `/tldr` in your group!

**Private Groups (no @username):**
1. Add the bot to your Telegram group
2. **Disable privacy mode**: Go to @BotFather → `/setprivacy` → Select your bot → Choose "Disable"
3. Run `/setup` directly in your group (the bot automatically detects the chat ID!)
4. Open a private chat with your bot
5. Run `/continue_setup` and provide your Gemini API key when prompted
6. Start using `/tldr` in your group!

**Alternative Method (if needed):**
If you prefer the manual method, you can still use `/setup_group <chat_id>` in private chat. To get the chat ID:
- Add @userinfobot to your group
- Forward any message from your group to @userinfobot to get the chat ID
- Use that ID with `/setup_group` (e.g., `/setup_group -123456789`)

### Bot Commands

**Private Chat:**
- `/start` - Welcome message and help
- `/help` - Show detailed help with examples
- `/continue_setup` - Complete a pending group setup
- `/setup_group @group` or `/setup_group chat_id` - Configure a group manually (alternative method)
- `/list_groups` - List all your configured groups
- `/update_api_key <chat_id>` - Update API key for a group
- `/remove_group <chat_id>` - Remove a group configuration

**Group Chat:**
- `/setup` - Start group setup (easiest method - auto-detects chat ID!)
- `/tldr [timeframe]` - Get summary (e.g., `/tldr 1h`, `/tldr 6h`, `/tldr day`, `/tldr week`)
- `Reply to message` + `/tldr` - Summarize from that message to now
- `/tldr_info` - Show group configuration and status
- `/tldr_help` or `/help` - Show help for group commands
- `/tldr_settings` - Manage summary settings (admin only)
  - Customize summary style (default, detailed, brief, bullet, timeline)
  - Set custom prompts
  - Configure message filtering
  - Set up scheduled summaries
- `/schedule` - Set up automatic daily/weekly summaries (admin only)
- `/filter` - Configure message filtering (admin only)
  - Exclude bot messages
  - Exclude commands
  - Exclude specific users
- `/enable` - Enable TLDR bot for this group (admin only)
- `/disable` - Disable TLDR bot for this group (admin only)

### Examples

**Time-based summaries:**
```bash
/tldr         # Summarize last hour (default)
/tldr 1h      # Summarize last hour
/tldr 6h      # Summarize last 6 hours
/tldr day     # Summarize last day
/tldr week    # Summarize last week
/tldr 3d      # Summarize last 3 days (max 7 days)
/tldr 30h     # Summarize last 30 hours
```

**Count-based summaries:**
```bash
/tldr 300     # Summarize last 300 messages
/tldr 1000    # Summarize last 1000 messages
/tldr 50      # Summarize last 50 messages
```

**Reply-based summaries:**
```
Reply to any message with: /tldr
This summarizes from that message to now
```

**Settings (admin only):**
```
/tldr_settings    # Open settings menu
/schedule          # Configure automatic summaries
/filter            # Configure message filtering
/enable            # Enable bot
/disable           # Disable bot
```

## Privacy & Data Storage

**🔒 Important Privacy Information:**

- Messages are temporarily cached in the database to enable historical summaries
- **Automatic deletion**: All cached messages are deleted after 48 hours
- **No permanent storage**: The bot never stores messages permanently
- **API keys**: Your Gemini API keys are encrypted at rest using AES-256
- **Bot privacy mode**: Make sure to disable privacy mode via @BotFather (`/setprivacy`) so the bot can read all messages in the group

The bot only stores messages it receives after being added to a group. It cannot access messages sent before it joined.

## Deploy to Railway

1. Fork this repository
2. Go to [railway.app](https://railway.app) and create an account
3. Click "New Project" → "Deploy from GitHub"
4. Select your fork
5. Add environment variables:
   - `TELEGRAM_TOKEN` - Your bot token
   - `DATABASE_URL` - PostgreSQL connection string (use Supabase for free DB)
   - `ENCRYPTION_SECRET` - Generate with `openssl rand -hex 32`
   - `NODE_ENV` - Set to `production`
6. Bot will auto-deploy!

**Free hosting stack:**
- Railway.app ($5 free credit/month)
- Supabase (free PostgreSQL tier)
- Google Gemini (free AI tier)

## Architecture

- **Bot Framework**: grammY
- **AI**: Google Gemini
- **Database**: PostgreSQL
- **Encryption**: AES-256-CBC with PBKDF2 key derivation

## Security

- **API keys**: Encrypted using AES-256-CBC with PBKDF2 key derivation
- **Isolated keys**: Each group uses its own isolated API key
- **No plain text**: API keys are never stored in plain text
- **SSL connections**: All database connections use SSL in production
- **SQL Injection Protection**: All database queries use parameterized statements
  - User messages containing SQL strings are safely stored as text data
  - SQL commands in messages are never executed
  - Example: A message like `"'; DROP TABLE messages; --"` will be stored as text, not executed
- **Input Validation**: Timeframe inputs are validated and limited (max 7 days)
- **Rate Limiting**: Commands are rate-limited to prevent abuse

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License

## Support

For issues or questions, please open an issue on GitHub.
