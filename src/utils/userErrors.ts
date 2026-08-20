/**
 * Turns an internal failure into something worth showing a person.
 *
 * Provider errors are written for whoever wrote the code, not for the group
 * that just typed /tldr: they carry JSON, model IDs and HTTP codes that mean
 * nothing to the reader and can only worry them. Everything users see is
 * written here instead - one short line saying what happened and the one
 * thing they can do about it. The original error still goes to the logs.
 */

export type ErrorKind =
  | 'invalidKey'
  | 'quota'
  | 'permission'
  | 'modelUnavailable'
  | 'timeout'
  | 'network'
  | 'unknown';

const PATTERNS: Array<[ErrorKind, RegExp]> = [
  ['invalidKey', /invalid api key|API_KEY_INVALID|\b401\b|unauthorized/i],
  ['quota', /quota|QUOTA_EXCEEDED|RESOURCE_EXHAUSTED|\b429\b|rate limit/i],
  ['permission', /permission denied|PERMISSION_DENIED|\b403\b/i],
  [
    'modelUnavailable',
    /NOT_FOUND|\b404\b|no longer available|none of the configured gemini models|no gemini models are configured/i,
  ],
  ['timeout', /timeout|timed out|ETIMEDOUT/i],
  ['network', /network|ECONNREFUSED|ENOTFOUND|fetch failed/i],
];

export function classifyError(error: unknown): ErrorKind {
  const message = error instanceof Error ? error.message : String(error ?? '');

  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return 'unknown';
}

/** What a group sees when a summary could not be produced. */
export function summaryErrorMessage(error: unknown): string {
  switch (classifyError(error)) {
    case 'invalidKey':
      return "❌ This group's Gemini key isn't working any more. An admin can set a new one with /update_api_key in a private chat with me.";
    case 'quota':
      return '❌ Gemini is rate limiting us at the moment. Wait a minute and try again — a shorter range like /tldr 1h usually gets through.';
    case 'permission':
      return "❌ This group's Gemini key isn't allowed to use the API. An admin can check it in Google AI Studio or set a new one with /update_api_key.";
    case 'modelUnavailable':
      return "❌ I can't reach a working Gemini model right now. An admin needs to update the bot's model settings — the details are in the logs.";
    case 'timeout':
      return '❌ That took too long to summarise. Try a shorter range, like /tldr 6h.';
    case 'network':
      return "❌ I couldn't reach Gemini just now. Please try again in a moment.";
    default:
      return '❌ Something went wrong making that summary. Please try again in a moment.';
  }
}

/** What an admin sees when their API keys could not be checked or accepted. */
export function apiKeyErrorMessage(error: unknown): string {
  switch (classifyError(error)) {
    case 'invalidKey':
      return '❌ Those keys were rejected by Google. Check them and run /update_api_key again.\n\n💡 Get a key from: https://aistudio.google.com/app/apikey';
    case 'quota':
      return '❌ The key hit its rate limit while I was testing it, so I could not confirm it. Try /update_api_key again in a minute.';
    case 'permission':
      return '❌ That key is not allowed to use the Gemini API. Check its permissions in Google AI Studio, then run /update_api_key again.';
    case 'modelUnavailable':
      return "❌ I could not test that key because the bot's model settings need updating. The details are in the logs.";
    case 'network':
    case 'timeout':
      return "❌ I couldn't reach Google to check that key. Please try /update_api_key again in a moment.";
    default:
      return '❌ I could not check those keys just now. Please try /update_api_key again in a moment.';
  }
}
