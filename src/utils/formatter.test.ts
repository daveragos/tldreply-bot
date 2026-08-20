import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './formatter';

describe('escapeHtml', () => {
  test('neutralises tags a Telegram display name could carry', () => {
    assert.equal(escapeHtml('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;');
  });

  test('neutralises an injected link', () => {
    assert.equal(
      escapeHtml('<a href="https://evil.example">Bank</a>'),
      '&lt;a href=&quot;https://evil.example&quot;&gt;Bank&lt;/a&gt;'
    );
  });

  test('escapes ampersands first so entities are not double-formed', () => {
    assert.equal(escapeHtml('a & <b'), 'a &amp; &lt;b');
  });

  test('leaves ordinary and non-Latin text untouched', () => {
    assert.equal(escapeHtml('ገና በዓል — Q3 planning'), 'ገና በዓል — Q3 planning');
  });
});
