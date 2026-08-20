# TLDR Bot

A Telegram bot that summarizes group chat conversations using Google's Gemini AI.

## Features

- 📝 **Smart Summaries**: Get concise summaries of group discussions using AI
- ⏰ **Time-Based**: Summarize the last hour, 6 hours, day, or week (max 7 days)
- 💬 **Reply to Summarize**: Reply to any message to summarize from that point
- 📅 **Auto-Summarization**: Messages are automatically summarized before deletion (48 hours)
- 📚 **Summary History**: Read archived summaries with `/history`, kept for 2 weeks
- 🗄️ **Beyond Retention**: Long `/tldr` ranges are answered from the archive once the raw messages are gone
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

5. Optional tuning (see `env.example` for the full list):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MESSAGE_RETENTION_HOURS` | `48` | How long raw messages are cached. Quoted to users in the privacy notice. |
| `SUMMARY_RETENTION_DAYS` | `14` | How long archived summaries are kept. |
| `MESSAGE_MAX_CHARS` | `2000` | Stored characters per message — the biggest lever on database size. |
| `DATABASE_SOFT_LIMIT_MB` | `500` | Your plan's size cap. Retention halves past 85% of it. |
| `GEMINI_MODELS` | flash models | Models to try, in order. |
| `PORT` | unset | When set, serves an HTTP health endpoint. Needed only if your host health checks over HTTP. |
| `LOG_TO_FILE` | `false` | Write rotating log files. Only useful with persistent disk. |
| `MAINTENANCE_MODE` | `false` | Start but do not poll or run jobs. For database work on hosts with no stop button. |

6. Set up the database:
```bash
# Connect to your PostgreSQL database and run:
psql $DATABASE_URL < src/db/schema.sql
```

7. Run the bot:
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
- `/tldr [range] [@user] [style] [topic]` - Get summary with the **Standard Command Rule**
- `Reply to message` + `/tldr` - Summarize from that message to now
- `/history` - List archived summaries (`/history 2` reads one in full)
- `/tldr_info` - Show group configuration and status
- `/tldr_help` or `/help` - Show help for group commands
- `/tldr_settings` - Manage summary settings (admin only)
  - Customize summary style (default, detailed, brief, bullet, timeline)
  - Set a custom prompt
  - Configure message filtering
  - Set up scheduled summaries, including time and timezone
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
/tldr 3 days  # Multi-word ranges work too
/tldr 2 weeks # Clamped to the 7 day maximum
```

Ranges reaching past the 48-hour retention window are answered from archived
summaries. If no archive covers that period yet, the reply says so rather than
silently returning a shorter range.

**Count-based summaries:**
```bash
/tldr 300     # Summarize last 300 messages
/tldr 1000    # Summarize last 1000 messages
/tldr 50      # Summarize last 50 messages
```

**Focused & User summaries:**
```bash
/tldr @username      # Summarize only messages from @username
/tldr 1d @username   # @username's talk in the last day
/tldr Secret Santa   # Focus on a specific topic (semantic search)
/tldr 500 meeting    # Focus on "meeting" in last 500 messages
/tldr 6h brief @user party  # Combined: last 6h, brief style, from @user, about "party"
```

### The Standard Command Rule
To make usage predictable, follow this standard order:
` /tldr [range] [@username] [style] [topic] `

- **Range**: <code>1h</code>, <code>6h</code>, <code>day</code>, or message count <code>100</code>
- **@username**: Filter messages from a specific user
- **Style**: <code>brief</code>, <code>detailed</code>, <code>bullet</code>, or <code>timeline</code>
- **Topic**: Any words to focus the summary on a specific subject

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
- **Automatic deletion**: All cached messages are deleted after 48 hours (configurable
  via `MESSAGE_RETENTION_HOURS`). Cleanup runs every 6 hours.
- **Summaries outlive messages**: Before deletion, messages are summarized and that
  summary is kept for 2 weeks so `/history` and long `/tldr` ranges still work. The
  original message text is gone; only the summary remains.
- **No permanent storage**: The bot never stores raw messages permanently
- **API keys**: Your Gemini API keys are encrypted at rest with AES-256-GCM
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
- Supabase (free PostgreSQL tier)
- Google Gemini (free AI tier)

## Deploying

The bot uses Telegram long polling, so it needs a process that stays running.
It is **not** a serverless workload: there is no request to respond to, and the
background jobs (retention cleanup, scheduled summaries) run on timers inside
the process.

### EthioDeploy

Deploy it as a **Background Worker**, not a Web Service. A web service is health
checked over HTTP, and a polling bot serves no HTTP, so the check would never
pass. Worker deploys are also sequential — the old container stops before the
new one starts — which matters here, because two instances calling `getUpdates`
at once causes Telegram 409 conflicts.

Node.js is auto-detected. The relevant scripts already exist:

| | |
| --- | --- |
| Build | `npm run build` |
| Start | `npm start` |

Set these environment variables in the dashboard:

```
TELEGRAM_TOKEN
DATABASE_URL
ENCRYPTION_SECRET
NODE_ENV=production
```

Logs go to stdout, so they appear in the platform's log viewer. Leave
`LOG_TO_FILE` unset — the container filesystem is ephemeral, so rotated log
files are lost on every deploy.

### Other platforms

Anything that runs a persistent container works the same way: Railway, Render,
Fly.io, or a plain VPS with a process manager.

If the platform insists on an HTTP health check, set `PORT` and the app will
bind it and serve:

| Path | Meaning |
| --- | --- |
| `/` | Liveness — the process is up |
| `/health` | Readiness — includes a database round trip and usage stats |

Without `PORT`, no socket is opened.

## Taking the bot offline

Hosts without a stop button can use the maintenance switch. Set
`MAINTENANCE_MODE=true` and redeploy: the process starts, connects, and then
idles — no polling, no background jobs — so the platform sees a healthy
container rather than a crash loop. Unset it and redeploy to resume.

Use it before a `VACUUM FULL`, which briefly takes an exclusive lock on the
messages table.

## Database maintenance

The bot is designed to run on a free-tier Postgres, where the size cap is a real
ceiling. Two commands help when it gets tight:

```bash
npm run db:stats
```

Shows total size against `DATABASE_SOFT_LIMIT_MB`, a per-table breakdown, and
how many messages are past the retention window.

```bash
npm run db:purge
```

Deletes messages past the retention window. Note that a plain `DELETE` in
Postgres frees space for reuse but does not shrink the file on disk. To reclaim
it fully:

```bash
npm run db:purge -- --compact
```

That runs `VACUUM FULL`, which takes an exclusive lock and needs temporary room
for a table rewrite. The bot also vacuums automatically after each cleanup run,
and shortens its retention window when usage passes 85% of the soft limit.

## Architecture

- **Bot Framework**: grammY
- **AI**: Google Gemini
- **Database**: PostgreSQL
- **Encryption**: AES-256-GCM with PBKDF2 key derivation
- **Tests**: `node:test` (no test framework dependency)
- **Runtime**: a single long-lived process (long polling + timer-driven jobs)

## Security

- **API keys**: Encrypted using AES-256-GCM with PBKDF2 key derivation and a random
  per-record salt. GCM authenticates the ciphertext, so tampering is detected rather
  than silently producing garbage.
- **Isolated keys**: Each group uses its own isolated API key
- **No plain text**: API keys are never stored in plain text
- **SSL connections**: All database connections use SSL in production
- **SQL Injection Protection**: All database queries use parameterized statements
  - User messages containing SQL strings are safely stored as text data
  - SQL commands in messages are never executed
  - Example: A message like `"'; DROP TABLE messages; --"` will be stored as text, not executed
- **Input Validation**: Timeframe inputs are validated and limited (max 7 days)
- **Rate Limiting**: Commands are rate-limited to prevent abuse
- **Admin-only settings**: Every settings button re-verifies admin status, not just the
  command that opened the menu

## Testing

```bash
npm test
```

Unit tests cover the pure functions — `/tldr` argument parsing, timeframe handling,
topic validation and encryption. They need no database and no network.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License

## Support

For issues or questions, please open an issue on GitHub.
