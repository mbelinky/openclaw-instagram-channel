import { describe, expect, it } from 'vitest';
import { matchInstagramKeywordPrivateReply } from '../src/instagram/keyword-private-reply.js';

const campaigns = [{
  triggers: { es: ['info'], en: ['hello'], ca: ['details'] },
  replies: { es: 'Respuesta ES', en: 'Reply EN', ca: 'Resposta CA' },
}];

describe('Instagram comment keyword private replies', () => {
  it('matches case and diacritics without requiring a one-word comment', () => {
    expect(matchInstagramKeywordPrivateReply(campaigns, 'Quiero ÍNFO, por favor.')).toEqual({
      locale: 'es',
      reply: 'Respuesta ES',
    });
  });

  it('requires whole-word matches', () => {
    expect(matchInstagramKeywordPrivateReply(campaigns, 'This greeting looks wonderful')).toBeUndefined();
    expect(matchInstagramKeywordPrivateReply(campaigns, 'Please send HELLO details')).toEqual({
      locale: 'en',
      reply: 'Reply EN',
    });
  });

  it('selects the matched language and applies es, en, ca priority', () => {
    expect(matchInstagramKeywordPrivateReply(campaigns, 'Vull informació: details')).toEqual({
      locale: 'ca',
      reply: 'Resposta CA',
    });
    expect(matchInstagramKeywordPrivateReply(campaigns, 'details hello info')).toEqual({
      locale: 'es',
      reply: 'Respuesta ES',
    });
    expect(matchInstagramKeywordPrivateReply(campaigns, 'details and hello')).toEqual({
      locale: 'en',
      reply: 'Reply EN',
    });
  });

  it('uses the first matching campaign from the configured list', () => {
    expect(matchInstagramKeywordPrivateReply([
      ...campaigns,
      {
        triggers: { en: ['hello'] },
        replies: { en: 'Second campaign' },
      },
    ], 'hello')).toEqual({ locale: 'en', reply: 'Reply EN' });
  });

  it('applies language priority across campaigns', () => {
    expect(matchInstagramKeywordPrivateReply([
      {
        triggers: { ca: ['details'] },
        replies: { ca: 'First campaign in Catalan' },
      },
      {
        triggers: { es: ['info'] },
        replies: { es: 'Second campaign in Spanish' },
      },
    ], 'details y info')).toEqual({ locale: 'es', reply: 'Second campaign in Spanish' });
  });
});
