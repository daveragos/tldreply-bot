/**
 * Central runtime configuration.
 *
 * Defaults are tuned for a free-tier Postgres (Supabase free plan: 500 MB).
 * The message cache is by far the largest table, so every knob here trades
 * summary reach against stored bytes.
 */

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;

  return Math.min(Math.max(parsed, min), max);
}

export const config = {
  /**
   * When true the process starts, stays alive, and does nothing else: no
   * polling, no background jobs.
   *
   * For platforms with no stop button. Set MAINTENANCE_MODE=true, redeploy,
   * do the database work, then unset and redeploy. The container stays up so
   * the platform does not treat it as a crash loop.
   */
  maintenanceMode: process.env.MAINTENANCE_MODE === 'true',

  /**
   * How long raw messages stay cached before being summarized and deleted.
   * This is the number quoted to users in the privacy notice, so changing it
   * means changing the README and the /tldr_info text with it.
   */
  messageRetentionHours: intFromEnv('MESSAGE_RETENTION_HOURS', 48, 1, 168),

  /** How long generated summaries are kept. Summaries are ~1000x smaller than the messages they replace. */
  summaryRetentionDays: intFromEnv('SUMMARY_RETENTION_DAYS', 14, 1, 365),

  /**
   * Per-message stored length. Telegram allows 4096 characters; the tail of a
   * very long message rarely changes a summary, and this column dominates
   * database size.
   */
  messageMaxChars: intFromEnv('MESSAGE_MAX_CHARS', 2000, 200, 4096),

  /** Rows deleted per statement during cleanup, so a large backlog never holds one long transaction. */
  cleanupBatchSize: intFromEnv('CLEANUP_BATCH_SIZE', 5000, 100, 50000),

  /**
   * Soft ceiling for the database, in megabytes. When exceeded, cleanup gets
   * more aggressive and a warning is logged. Set to the plan's hard limit.
   */
  databaseSoftLimitMb: intFromEnv('DATABASE_SOFT_LIMIT_MB', 500, 10, 1024 * 1024),

  /** Fraction of the soft limit at which cleanup starts shortening the retention window. */
  databasePressureRatio: 0.85,

  /**
   * Models tried in order, first match wins.
   *
   * Kept short deliberately: every entry is a round trip when the one before
   * it fails, so a long list turns one bad key into a long wait. Flash models
   * come first because they are what the Gemini free tier affords.
   *
   * Override with a comma-separated GEMINI_MODELS if a key has different access.
   */
  geminiModels: (
    process.env.GEMINI_MODELS ?? 'gemini-2.5-flash,gemini-2.0-flash-001,gemini-2.0-flash-lite-001'
  )
    .split(',')
    .map(m => m.trim())
    .filter(Boolean),
} as const;
