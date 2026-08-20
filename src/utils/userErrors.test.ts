import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, summaryErrorMessage, apiKeyErrorMessage } from './userErrors';

// The error a group actually saw: raw provider JSON, quoted straight back at them.
const RETIRED_MODEL_ERROR = new Error(
  '{"error":{"code":404,"message":"This model models/gemini-2.0-flash-lite-001 is no longer available.","status":"NOT_FOUND"}}'
);

describe('classifyError', () => {
  test('recognises the failures the Gemini API reports', () => {
    assert.equal(classifyError(RETIRED_MODEL_ERROR), 'modelUnavailable');
    assert.equal(classifyError(new Error('429 RESOURCE_EXHAUSTED')), 'quota');
    assert.equal(classifyError(new Error('API_KEY_INVALID')), 'invalidKey');
    assert.equal(classifyError(new Error('PERMISSION_DENIED')), 'permission');
    assert.equal(classifyError(new Error('connect ECONNREFUSED')), 'network');
    assert.equal(classifyError(new Error('request timeout')), 'timeout');
  });

  test('recognises the wrapped messages the summariser raises', () => {
    assert.equal(
      classifyError(new Error('Invalid API key. Please check your Gemini API key.')),
      'invalidKey'
    );
    assert.equal(
      classifyError(new Error('None of the configured Gemini models are available (a, b).')),
      'modelUnavailable'
    );
  });

  test('falls back to unknown rather than guessing', () => {
    assert.equal(classifyError(new Error('something odd happened')), 'unknown');
    assert.equal(classifyError(undefined), 'unknown');
  });
});

describe('user-facing messages', () => {
  const everyMessage = [
    summaryErrorMessage(RETIRED_MODEL_ERROR),
    summaryErrorMessage(new Error('429 RESOURCE_EXHAUSTED: quota')),
    summaryErrorMessage(new Error('API_KEY_INVALID')),
    summaryErrorMessage(new Error('boom')),
    apiKeyErrorMessage(RETIRED_MODEL_ERROR),
    apiKeyErrorMessage(new Error('API_KEY_INVALID')),
    apiKeyErrorMessage(new Error('boom')),
  ];

  test('never leak the provider text', () => {
    for (const message of everyMessage) {
      assert.doesNotMatch(message, /gemini-|NOT_FOUND|RESOURCE_EXHAUSTED|\{|\d{3}\b/);
    }
  });

  test('stay short enough to read at a glance', () => {
    for (const message of everyMessage) {
      assert.ok(message.length < 200, `too long: ${message}`);
    }
  });

  test('tell the reader what to do next', () => {
    assert.match(summaryErrorMessage(new Error('API_KEY_INVALID')), /\/update_api_key/);
    assert.match(summaryErrorMessage(new Error('429 quota')), /try again/i);
    assert.match(apiKeyErrorMessage(new Error('API_KEY_INVALID')), /aistudio\.google\.com/);
  });
});
