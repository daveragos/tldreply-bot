/**
 * Argument parsing for /tldr.
 *
 * Extracted from GroupCommands so it can be tested without a bot, a database
 * or a network. Everything here is a pure function.
 *
 * Command shape:  /tldr [range] [@username] [style] [topic]
 */

import { logger } from './logger';

export const VALID_STYLES = ['default', 'detailed', 'brief', 'bullet', 'timeline'] as const;
export type SummaryStyle = (typeof VALID_STYLES)[number];

/** Longest range the bot will look back, in hours. */
export const MAX_RANGE_HOURS = 168; // 7 days

const MAX_TOPIC_LENGTH = 200;
const MAX_MESSAGE_COUNT = 10000;
const DEFAULT_MESSAGE_COUNT = 100;

/** Words that turn a bare number into a duration rather than a message count. */
const TIME_UNITS: Record<string, number> = {
  h: 1,
  hr: 1,
  hrs: 1,
  hour: 1,
  hours: 1,
  d: 24,
  day: 24,
  days: 24,
  w: 168,
  week: 168,
  weeks: 168,
};

export interface ParsedTldrArgs {
  /** Normalized range token, e.g. "6h", "3d", "300". */
  input: string;
  style?: SummaryStyle;
  username?: string;
  /** Topic that passed validation, ready for the prompt. */
  topicFocus?: string;
  /**
   * Topic the user actually typed, kept even when validation rejected it, so
   * the caller can explain the rejection instead of silently ignoring it.
   */
  rawTopic?: string;
  /** Why the topic was rejected, when it was. */
  topicRejectedReason?: string;
}

/**
 * Validates a topic for use in the summarization prompt.
 *
 * This is a sanity filter, not the injection defense. The real protection is
 * the delimited <user_input> structure in buildStructuredPrompt, which frames
 * everything here as data. Guessing intent from vocabulary was rejecting
 * ordinary requests ("list of tasks") and every non-Latin script, so this
 * checks shape rather than meaning.
 *
 * @returns the normalized topic, or a rejection reason
 */
export function sanitizeTopic(topic: string): { topic: string } | { reason: string } {
  const trimmed = topic.trim();

  if (trimmed.length === 0) {
    return { reason: 'the topic was empty' };
  }

  if (trimmed.length > MAX_TOPIC_LENGTH) {
    return { reason: `topics are limited to ${MAX_TOPIC_LENGTH} characters` };
  }

  // Collapse whitespace and strip line breaks, which are what would let text
  // escape its section of the prompt.
  const normalized = trimmed.replace(/\s+/gu, ' ').trim();

  // Unicode-aware: letters, numbers, combining marks and ordinary punctuation
  // in ANY script. Excludes brackets, backticks, braces and angle brackets,
  // which is the shape that shows up in markup and code injection.
  const ALLOWED = /^[\p{L}\p{N}\p{M}\p{Zs}'".,!?()&/:@#+-]+$/u;

  if (!ALLOWED.test(normalized)) {
    return { reason: 'topics can only contain letters, numbers and basic punctuation' };
  }

  // A topic that is mostly punctuation is not a topic.
  const punctuation = (normalized.match(/[.,!?()'"&/:@#+-]/gu) || []).length;
  if (punctuation / normalized.length > 0.5) {
    return { reason: 'that looked like symbols rather than a topic' };
  }

  return { topic: normalized };
}

/** True when the range token means "last N messages" rather than a duration. */
export function isCountBased(input: string): boolean {
  return /^\d+$/.test(input.toLowerCase().trim());
}

/** Message count from a range token, clamped to sane bounds. */
export function parseCount(input: string): number {
  const value = parseInt(input.trim(), 10);
  if (Number.isNaN(value) || value <= 0) {
    return DEFAULT_MESSAGE_COUNT;
  }
  return Math.min(value, MAX_MESSAGE_COUNT);
}

/**
 * Converts a range token into the timestamp to summarize from.
 * Accepts "6h", "3d", "2 weeks", "day", "week". Clamped to MAX_RANGE_HOURS.
 */
export function parseTimeframe(timeframe: string, now: number = Date.now()): Date {
  const normalized = timeframe.toLowerCase().trim().replace(/\s+/g, ' ');

  const hours = parseTimeframeHours(normalized);
  return new Date(now - hours * 60 * 60 * 1000);
}

/** Range token expressed in hours, clamped. Exported for range-vs-retention checks. */
export function parseTimeframeHours(timeframe: string): number {
  const normalized = timeframe.toLowerCase().trim().replace(/\s+/g, ' ');

  // "3 days", "2 weeks", "1 hour"
  const spaced = normalized.match(/^(\d+)\s+([a-z]+)$/);
  if (spaced) {
    const multiplier = TIME_UNITS[spaced[2]];
    if (multiplier !== undefined) {
      return clampHours(parseInt(spaced[1], 10) * multiplier);
    }
  }

  // "6h", "3d", "2w"
  const compact = normalized.match(/^(\d+)([a-z]+)$/);
  if (compact) {
    const multiplier = TIME_UNITS[compact[2]];
    if (multiplier !== undefined) {
      return clampHours(parseInt(compact[1], 10) * multiplier);
    }
  }

  // Bare unit: "day", "week", "hour"
  const bare = TIME_UNITS[normalized];
  if (bare !== undefined) {
    return clampHours(bare);
  }

  // Bare number falls back to hours.
  const numeric = parseInt(normalized, 10);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return clampHours(numeric);
  }

  return 1;
}

function clampHours(hours: number): number {
  if (Number.isNaN(hours) || hours <= 0) return 1;
  return Math.min(hours, MAX_RANGE_HOURS);
}

/**
 * Parses /tldr arguments.
 *
 * Order is forgiving, but a bare number followed by a time unit is read as one
 * range: "/tldr 3 days" is three days, not the last three messages with the
 * topic "days".
 */
export function parseTLDRArgs(args: string[]): ParsedTldrArgs {
  let input = '1h';
  let rangeFound = false;
  let style: SummaryStyle | undefined;
  let username: string | undefined;
  const topicParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();

    if ((VALID_STYLES as readonly string[]).includes(lower)) {
      style = lower as SummaryStyle;
      continue;
    }

    if (arg.startsWith('@') && arg.length > 1) {
      username = arg.slice(1);
      continue;
    }

    if (!rangeFound) {
      // Look ahead: "3 days" is one range token spread over two arguments.
      const next = args[i + 1]?.toLowerCase();
      if (/^\d+$/.test(lower) && next && TIME_UNITS[next] !== undefined) {
        input = `${lower} ${next}`;
        rangeFound = true;
        i++; // consume the unit
        continue;
      }

      // Single-token ranges: "6h", "3d", "day", "week", or a bare count.
      if (/^\d+[a-z]+$/.test(lower) && TIME_UNITS[lower.replace(/^\d+/, '')] !== undefined) {
        input = lower;
        rangeFound = true;
        continue;
      }

      if (TIME_UNITS[lower] !== undefined || /^\d+$/.test(lower)) {
        input = lower;
        rangeFound = true;
        continue;
      }
    }

    topicParts.push(arg);
  }

  const rawTopic = topicParts.length > 0 ? topicParts.join(' ') : undefined;

  if (!rawTopic) {
    return { input, style, username };
  }

  const result = sanitizeTopic(rawTopic);

  if ('reason' in result) {
    logger.warn(`Rejected topic: ${result.reason}`, { topic: rawTopic.substring(0, 100) });
    return { input, style, username, rawTopic, topicRejectedReason: result.reason };
  }

  return { input, style, username, rawTopic, topicFocus: result.topic };
}
