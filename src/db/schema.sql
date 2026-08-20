-- Database schema for TLDR Bot

-- Groups table: stores group chat information and encrypted API keys
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    telegram_chat_id BIGINT UNIQUE NOT NULL,
    gemini_api_key_encrypted TEXT,
    enabled BOOLEAN DEFAULT true,
    setup_by_user_id BIGINT,
    setup_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages table: caches recent messages for summarization
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    telegram_chat_id BIGINT NOT NULL REFERENCES groups(telegram_chat_id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL,
    user_id BIGINT,
    username TEXT,
    first_name TEXT,
    content TEXT,
    is_bot BOOLEAN DEFAULT false,
    is_channel BOOLEAN DEFAULT false,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(telegram_chat_id, message_id)
);

-- Index for faster message retrieval
CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp
ON messages(telegram_chat_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_messages_chat_message
ON messages(telegram_chat_id, message_id);

-- Supports case-insensitive /tldr @username lookups
CREATE INDEX IF NOT EXISTS idx_messages_chat_username_lower
ON messages(telegram_chat_id, LOWER(username));

-- Summaries table: stores auto-generated summaries of messages before deletion
CREATE TABLE IF NOT EXISTS summaries (
    id SERIAL PRIMARY KEY,
    telegram_chat_id BIGINT NOT NULL REFERENCES groups(telegram_chat_id) ON DELETE CASCADE,
    summary_text TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(telegram_chat_id, period_start, period_end)
);

-- Index for faster summary retrieval and cleanup
CREATE INDEX IF NOT EXISTS idx_summaries_chat_created
ON summaries(telegram_chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_summaries_created_at
ON summaries(created_at);

-- Group settings table: stores customization and scheduling settings
CREATE TABLE IF NOT EXISTS group_settings (
    id SERIAL PRIMARY KEY,
    telegram_chat_id BIGINT UNIQUE NOT NULL REFERENCES groups(telegram_chat_id) ON DELETE CASCADE,
    summary_style TEXT DEFAULT 'default',
    custom_prompt TEXT,
    exclude_bot_messages BOOLEAN DEFAULT false,
    exclude_commands BOOLEAN DEFAULT true,
    excluded_user_ids BIGINT[] DEFAULT '{}',
    scheduled_enabled BOOLEAN DEFAULT false,
    schedule_frequency TEXT DEFAULT 'daily', -- 'daily' or 'weekly'
    schedule_time TIME DEFAULT '09:00:00',
    schedule_timezone TEXT DEFAULT 'UTC',
    last_scheduled_summary TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for scheduled summaries
CREATE INDEX IF NOT EXISTS idx_group_settings_scheduled
ON group_settings(telegram_chat_id, scheduled_enabled, schedule_frequency);

-- Note: Messages are cached for 48 hours before automatic deletion and summarization
-- Summaries are kept for 2 weeks before permanent deletion
