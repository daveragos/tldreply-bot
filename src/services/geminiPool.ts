import { GeminiService } from './gemini';
import { EncryptionService } from '../utils/encryption';
import { logger } from '../utils/logger';

/**
 * Per-group cache of GeminiService instances.
 *
 * GeminiService tracks which API keys are quota-exhausted and rotates away
 * from them, but that state lives on the instance. Constructing a new service
 * for every /tldr threw the knowledge away each time, so a group with several
 * keys hammered key 0 on every request and rediscovered its exhaustion from
 * scratch. Keeping one instance per group makes the rotation actually work.
 *
 * Entries are keyed by chat ID and validated against the encrypted key blob,
 * so rotating a group's keys transparently replaces its cached client.
 */

interface PoolEntry {
  service: GeminiService;
  /** The encrypted blob the service was built from; used to detect key changes. */
  encryptedKey: string;
  lastUsed: number;
}

const pool = new Map<number, PoolEntry>();

/** Idle entries older than this are dropped, so departed groups do not leak. */
const IDLE_TTL_MS = 60 * 60 * 1000;

/** Upper bound on cached clients, evicting least-recently-used beyond it. */
const MAX_ENTRIES = 200;

function evictStale(): void {
  const now = Date.now();

  for (const [chatId, entry] of pool.entries()) {
    if (now - entry.lastUsed > IDLE_TTL_MS) {
      entry.service.dispose();
      pool.delete(chatId);
    }
  }

  if (pool.size <= MAX_ENTRIES) return;

  const byAge = [...pool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [chatId, entry] of byAge.slice(0, pool.size - MAX_ENTRIES)) {
    entry.service.dispose();
    pool.delete(chatId);
  }
}

/**
 * Returns the cached Gemini client for a group, creating one if needed.
 *
 * @param chatId       group the client belongs to
 * @param encryptedKey encrypted key blob straight from the database
 * @param encryption   service used to decrypt it on a cache miss
 */
export function getGeminiService(
  chatId: number,
  encryptedKey: string,
  encryption: EncryptionService
): GeminiService {
  const existing = pool.get(chatId);

  if (existing && existing.encryptedKey === encryptedKey) {
    existing.lastUsed = Date.now();
    return existing.service;
  }

  // Key changed or first use: build a fresh client and retire the old one.
  if (existing) {
    existing.service.dispose();
    pool.delete(chatId);
  }

  const service = new GeminiService(encryption.decrypt(encryptedKey));
  pool.set(chatId, { service, encryptedKey, lastUsed: Date.now() });

  evictStale();
  logger.debug(`Gemini client created for group ${chatId} (pool size: ${pool.size})`);

  return service;
}

/** Drops a group's cached client, e.g. when the group is removed. */
export function invalidateGeminiService(chatId: number): void {
  const entry = pool.get(chatId);
  if (entry) {
    entry.service.dispose();
    pool.delete(chatId);
  }
}

/** Clears the whole pool. Used on shutdown so pending timers do not hold the process open. */
export function clearGeminiPool(): void {
  for (const entry of pool.values()) {
    entry.service.dispose();
  }
  pool.clear();
}

/** Current pool size, for diagnostics. */
export function geminiPoolSize(): number {
  return pool.size;
}
