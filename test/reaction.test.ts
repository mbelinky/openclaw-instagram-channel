import { describe, expect, it } from 'vitest';
import { isPositivePassiveComment, isReactionOnlyText } from '../src/instagram/reaction.js';
import {
  instagramPrivateReplyPointer,
  instagramPublicThanks,
} from '../src/instagram/engagement.js';

describe('isReactionOnlyText', () => {
  it.each(['😍', '❤️', '👏🏽', '🔥🔥', '🇯🇵'])(
    'treats %s as passive engagement',
    (text) => {
      expect(isReactionOnlyText(text)).toBe(true);
    },
  );

  it.each(['', '1', '😍 gracias', 'Me encanta ❤️', 'https://example.com/🔥'])(
    'keeps %s in the normal reply path',
    (text) => {
      expect(isReactionOnlyText(text)).toBe(false);
    },
  );
});

describe('positive passive comments', () => {
  it.each([
    '😍',
    '👏👏',
    'Muchas gracias',
    'Thanks so much!',
    'Gràcies ❤️',
    'Beautiful work',
    "M'encanta",
  ])('accepts clearly positive passive text: %s', (text) => {
    expect(isPositivePassiveComment(text)).toBe(true);
  });

  it.each([
    '',
    'No gracias',
    'Thanks for nothing',
    'Thanks, but my order is broken',
    'Beautiful?',
    '¿Gracias?',
    'When is the next class',
    'I have a problem ❤️',
    'https://example.com/❤️',
  ])('rejects ambiguous, negative, or non-positive text: %s', (text) => {
    expect(isPositivePassiveComment(text)).toBe(false);
  });

  it('matches public replies to Spanish, English, and Catalan with Spanish fallback', () => {
    expect(instagramPrivateReplyPointer('es')).toBe('Te escribimos por privado 🤖');
    expect(instagramPrivateReplyPointer('en-US')).toBe('We sent you a DM 🤖');
    expect(instagramPrivateReplyPointer('ca')).toBe("T'hem escrit per privat 🤖");
    expect(instagramPrivateReplyPointer(undefined)).toBe('Te escribimos por privado 🤖');

    expect(instagramPublicThanks('es')).toBe('¡Gracias! 🤍🤖');
    expect(instagramPublicThanks('en')).toBe('Thank you! 🤍🤖');
    expect(instagramPublicThanks('ca-ES')).toBe('Gràcies! 🤍🤖');
  });
});
