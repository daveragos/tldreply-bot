import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickReportableError } from './gemini';

const failure = (model: string, message: string) => ({ model, error: new Error(message) });

describe('pickReportableError', () => {
  test('returns nothing when there were no failures', () => {
    assert.equal(pickReportableError([]), undefined);
  });

  // Regression: a retired model at the end of the chain used to mask the quota
  // error that stopped the first model, so /tldr reported a 404 for a model the
  // user was never really blocked on.
  test('prefers the real failure over a retired trailing model', () => {
    const reported = pickReportableError([
      failure('gemini-3.6-flash', '429 RESOURCE_EXHAUSTED: quota exceeded'),
      failure('gemini-3.5-flash-lite', '404 NOT_FOUND: model is no longer available'),
    ]);

    assert.match(reported!.message, /RESOURCE_EXHAUSTED/);
  });

  test('reports every model being unavailable as one message naming them', () => {
    const reported = pickReportableError([
      failure('gemini-2.0-flash-001', '404 NOT_FOUND: no longer available'),
      failure('gemini-2.0-flash-lite-001', 'This model is no longer available (NOT_FOUND)'),
    ]);

    assert.match(reported!.message, /None of the configured Gemini models are available/);
    assert.match(reported!.message, /gemini-2.0-flash-001, gemini-2.0-flash-lite-001/);
    assert.match(reported!.message, /GEMINI_MODELS/);
  });

  test('lists each model once when retries repeat the same failure', () => {
    const reported = pickReportableError([
      failure('gemini-a', '404 NOT_FOUND'),
      failure('gemini-a', '404 NOT_FOUND'),
    ]);

    assert.match(reported!.message, /\(gemini-a\)/);
  });

  test('keeps a server error, which is transient rather than a missing model', () => {
    const reported = pickReportableError([failure('gemini-a', '503 Service Unavailable')]);

    assert.match(reported!.message, /503/);
  });
});
