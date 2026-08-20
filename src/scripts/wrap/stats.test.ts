import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isRenderableName, displayNameFor, foldForScreening } from './stats';

/** Spells a word using a contiguous A–Z Unicode block, as "fancy text" tools do. */
const inBlock = (base: number, word: string) =>
  [...word.toUpperCase()].map(c => String.fromCodePoint(base + (c.charCodeAt(0) - 65))).join('');

describe('foldForScreening', () => {
  test('collapses stylised alphabets to plain letters', () => {
    assert.equal(foldForScreening(inBlock(0x1f170, 'HITLER')), 'hitler'); // negative squared
    assert.equal(foldForScreening(inBlock(0x1f150, 'HITLER')), 'hitler'); // negative circled
    assert.equal(foldForScreening(inBlock(0x1f130, 'HITLER')), 'hitler'); // squared
    assert.equal(foldForScreening(inBlock(0x1f1e6, 'HITLER')), 'hitler'); // regional indicator
    assert.equal(foldForScreening(inBlock(0x24b6, 'HITLER')), 'hitler'); // circled
    assert.equal(foldForScreening('𝓗𝓲𝓽𝓵𝓮𝓻'), 'hitler'); // script
    assert.equal(foldForScreening('ʜɪᴛʟᴇʀ'), 'hitler'); // small capitals
  });

  test('keeps ordinary and Ethiopic text intact', () => {
    assert.equal(foldForScreening('Silver_Osterman'), 'silverosterman');
    assert.equal(foldForScreening('ወለድ'), 'ወለድ');
  });
});

describe('name screening', () => {
  // A wrap hands someone a trophy in front of their whole group. A handle
  // carrying a slur must never be what the bot amplifies — and a stylised
  // slur is still a slur.
  test('blocks slurs however they are written', () => {
    for (const n of [
      'Fuckjewsforever',
      'fuck_jews_forever',
      'n1gg3r_fan',
      'total.nazi',
      inBlock(0x1f170, 'HITLER'),
      'ʜɪᴛʟᴇʀ',
      '𝓗𝓲𝓽𝓵𝓮𝓻',
    ]) {
      assert.equal(isRenderableName(n), false, `should block ${JSON.stringify(n)}`);
    }
  });

  test('leaves ordinary handles alone, stylised or not', () => {
    for (const n of ['nyrastrag', 'Backwardkid', 'ch3rrycrush', 'Silver_Osterman', 'ገና', '🄰🅜𝓸иⓖ']) {
      assert.equal(isRenderableName(n), true, `should allow ${JSON.stringify(n)}`);
    }
  });

  // Deliberately not a fallback chain. A real account in the data had the
  // username "Fuckjewsforever" AND a first name spelling a slur in homoglyphs;
  // falling back from one to the other simply rendered the other one.
  test('a blocked signal anywhere means the person is not named', () => {
    assert.equal(displayNameFor('Fuckjewsforever', 'Sami'), 'A member');
    assert.equal(displayNameFor('Fuckjewsforever', null), 'A member');
    assert.equal(
      displayNameFor(null, '\u5350 \u043d \u026a \u03c4 \u2113 \u0454 \u044f'),
      'A member'
    );
    assert.equal(displayNameFor(inBlock(0x1f170, 'HITLER'), null), 'A member');
    assert.equal(displayNameFor(null, null), 'A member');
  });

  test('ordinary people are still named normally', () => {
    assert.equal(displayNameFor('nyrastrag', 'Nyra'), '@nyrastrag');
    assert.equal(displayNameFor(null, 'Sami'), 'Sami');
    assert.equal(displayNameFor(null, '\u12c8\u1208\u12f5'), '\u12c8\u1208\u12f5');
  });

  test('catches homoglyph spelling and hate insignia', () => {
    assert.equal(isRenderableName('\u043d \u026a \u03c4 \u2113 \u0454 \u044f'), false);
    assert.equal(isRenderableName('\u5350'), false, 'swastika alone');
    assert.equal(foldForScreening('\u043d\u026a\u03c4\u2113\u0454\u044f'), 'hitler');
  });
});
