import { Api } from 'grammy';
import { logger } from './logger';

/**
 * Deletes a message that contained a secret, best-effort.
 *
 * The bot asks users to paste a Gemini API key into private chat. Storing it
 * encrypted does nothing about the original message, which otherwise stays in
 * Telegram's history on every device signed into that account, indefinitely.
 *
 * The Bot API permits this: bots may delete incoming messages in private
 * chats. It can still fail legitimately — the message is older than 48 hours,
 * was already deleted, or the chat is gone — and none of those should
 * interrupt the flow that called us, so failures are logged and swallowed.
 *
 * Note this only removes the message from Telegram. It does not affect
 * screenshots, forwards, or notification previews already delivered, so a key
 * that was pasted should still be treated as having been exposed if it
 * appeared anywhere else.
 *
 * @returns true if Telegram accepted the deletion
 */
export async function deleteSecretMessage(
  api: Api,
  chatId: number,
  messageId: number | undefined
): Promise<boolean> {
  if (!messageId) return false;

  try {
    await api.deleteMessage(chatId, messageId);
    logger.info('Deleted a message containing an API key', { chatId });
    return true;
  } catch (error) {
    // Common and harmless: message too old, already gone, or no permission.
    logger.warn('Could not delete the message containing an API key', {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Reassurance appended to a success reply. Empty when deletion failed, because
 * that case is reported separately and immediately by warnIfSecretRemains().
 */
export function secretDeletionNotice(deleted: boolean): string {
  return deleted ? '\n\n🧹 Your message with the key was deleted from this chat.' : '';
}

/**
 * Tells the user their key is still in the chat, right away.
 *
 * Sent as its own message rather than appended to the outcome, so it reaches
 * them on every path - including the validation failures, which are exactly
 * the cases where a user is most likely to leave the message sitting there.
 */
export async function warnIfSecretRemains(
  api: Api,
  chatId: number,
  deleted: boolean
): Promise<void> {
  if (deleted) return;

  try {
    await api.sendMessage(
      chatId,
      '⚠️ I could not delete your message containing the API key.\n\n' +
        'Please delete it yourself — it stays in this chat until you do.'
    );
  } catch (error) {
    logger.warn('Could not warn the user about an undeleted key message', {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
