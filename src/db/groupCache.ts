/**
 * Short-lived cache for group rows and group settings.
 *
 * Every incoming message ran getGroup() and getGroupSettings() before its
 * INSERT - three queries per message, across every group, at Telegram's
 * message rate. Both rows change rarely, so a few seconds of caching removes
 * almost all of that load.
 *
 * The TTL is deliberately short: a stale settings row means a filter toggle
 * takes a moment to take effect, which is fine, but anything longer starts to
 * feel broken to the admin who just flipped it. Writes invalidate explicitly,
 * so the TTL is only a backstop for changes made outside this process.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const TTL_MS = 30 * 1000;

/** Cap so a bot in many groups cannot grow the cache without bound. */
const MAX_ENTRIES = 500;

const groups = new Map<number, CacheEntry<any>>();
const settings = new Map<number, CacheEntry<any>>();

function read<T>(store: Map<number, CacheEntry<T>>, chatId: number): T | undefined {
  const entry = store.get(chatId);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    store.delete(chatId);
    return undefined;
  }

  return entry.value;
}

function write<T>(store: Map<number, CacheEntry<T>>, chatId: number, value: T): void {
  if (store.size >= MAX_ENTRIES) {
    // Drop the oldest insertion; Map preserves insertion order.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(chatId, { value, expiresAt: Date.now() + TTL_MS });
}

export const groupCache = {
  getGroup: (chatId: number) => read(groups, chatId),
  setGroup: (chatId: number, value: any) => write(groups, chatId, value),
  getSettings: (chatId: number) => read(settings, chatId),
  setSettings: (chatId: number, value: any) => write(settings, chatId, value),
};

/** Drops both cached rows for a group. Called on every write. */
export function invalidateGroupCache(chatId: number): void {
  groups.delete(chatId);
  settings.delete(chatId);
}

/** Empties the cache entirely. */
export function clearGroupCache(): void {
  groups.clear();
  settings.clear();
}
