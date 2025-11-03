# TLDR Bot 🤖

A Telegram bot that summarizes group chat conversations using Google's Gemini AI.

## Features

- 📝 **Smart Summaries**: Get concise summaries of group discussions using AI
- ⏰ **Time-Based**: Summarize the last hour, 6 hours, day, or week
- 💬 **Reply to Summarize**: Reply to any message to summarize from that point
- 🔒 **Per-Group API Keys**: Each group uses its own Gemini API key
- 🔐 **Encrypted Storage**: API keys are encrypted at rest
- 🌐 **PostgreSQL**: Uses PostgreSQL for reliable data storage

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

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
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
2. Open a private chat with the bot
3. Run `/setup_group @your_group_username`
4. Provide your Gemini API key when prompted
5. Start using `/tldr` in your group!

**Private Groups (no @username):**
1. Add the bot to your Telegram group
2. Add @userinfobot to your group
3. Forward any message from your group to @userinfobot to get the chat ID
4. Open a private chat with your bot
5. Run `/setup_group <chat_id>` (use the ID from step 3, e.g., `/setup_group -123456789`)
6. Provide your Gemini API key when prompted
7. Start using `/tldr` in your group!

### Bot Commands

**Private Chat:**
- `/start` - Welcome message and help
- `/setup_group @group` or `/setup_group chat_id` - Configure a group for TLDR
- `/list_groups` - List your configured groups

**Group Chat:**
- `/tldr [timeframe]` - Get summary (e.g., `/tldr 1h`, `/tldr 6h`, `/tldr day`)
- `Reply to message` + `/tldr` - Summarize from that message
- `/tldr_info` - Show group configuration

### Examples

```bash
/tldr 1h      # Summarize last hour
/tldr 6h      # Summarize last 6 hours
/tldr day     # Summarize last day
/tldr week    # Summarize last week
```

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

- API keys are encrypted using AES-256-CBC
- Each group uses its own isolated API key
- No API keys are stored in plain text
- All database connections use SSL in production

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License

## Support

For issues or questions, please open an issue on GitHub.
