import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'grammy';
import { deleteSecretMessage, secretDeletionNotice, warnIfSecretRemains } from './telegram';

/** Minimal stand-in for grammy's Api, recording what was called. */
function fakeApi(opts: { deleteThrows?: boolean; sendThrows?: boolean } = {}) {
  const calls = { deleted: [] as Array<[number, number]>, sent: [] as string[] };
  const api = {
    deleteMessage: async (chatId: number, messageId: number) => {
      if (opts.deleteThrows) throw new Error('message to delete not found');
      calls.deleted.push([chatId, messageId]);
      return true;
    },
    sendMessage: async (_chatId: number, text: string) => {
      if (opts.sendThrows) throw new Error('bot was blocked by the user');
      calls.sent.push(text);
      return {} as never;
    },
  } as unknown as Api;
  return { api, calls };
}

describe('deleteSecretMessage', () => {
  test('deletes the message and reports success', async () => {
    const { api, calls } = fakeApi();
    assert.equal(await deleteSecretMessage(api, 42, 100), true);
    assert.deepEqual(calls.deleted, [[42, 100]]);
  });

  test('swallows a Telegram failure and reports it', async () => {
    const { api } = fakeApi({ deleteThrows: true });
    assert.equal(await deleteSecretMessage(api, 42, 100), false);
  });

  // A missing message_id must not blow up the calling flow.
  test('is a no-op without a message id', async () => {
    const { api, calls } = fakeApi();
    assert.equal(await deleteSecretMessage(api, 42, undefined), false);
    assert.deepEqual(calls.deleted, []);
  });
});

describe('warnIfSecretRemains', () => {
  test('says nothing when the message was deleted', async () => {
    const { api, calls } = fakeApi();
    await warnIfSecretRemains(api, 42, true);
    assert.deepEqual(calls.sent, []);
  });

  test('warns the user when the key is still in the chat', async () => {
    const { api, calls } = fakeApi();
    await warnIfSecretRemains(api, 42, false);
    assert.equal(calls.sent.length, 1);
    assert.match(calls.sent[0], /could not delete/i);
    assert.match(calls.sent[0], /delete it yourself/i);
  });

  // If even the warning cannot be sent, the caller must still complete.
  test('does not throw when the warning itself fails', async () => {
    const { api } = fakeApi({ sendThrows: true });
    await assert.doesNotReject(() => warnIfSecretRemains(api, 42, false));
  });
});

describe('secretDeletionNotice', () => {
  test('reassures only on success', () => {
    assert.match(secretDeletionNotice(true), /deleted from this chat/);
    assert.equal(secretDeletionNotice(false), '', 'failure is reported separately');
  });
});
