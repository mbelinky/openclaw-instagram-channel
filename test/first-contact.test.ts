import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openFirstContactStore,
  resolveFirstContactStateDir,
} from '../src/instagram/first-contact.js';
import {
  resolveInstagramFirstContactConfig,
  resolveInstagramFirstContactMessage,
  resolveInstagramAccountConfig,
  validateInstagramChannelConfig,
} from '../src/openclaw/config.js';

describe('Instagram first-contact state', () => {
  it('sends only once per account and sender across reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-first-contact-'));
    try {
      const first = openFirstContactStore(dir);
      expect(first.claim('example', 'sender-1')).toBe(true);
      expect(first.claim('example', 'sender-1')).toBe(false);
      first.close();

      const reopened = openFirstContactStore(dir);
      expect(reopened.claim('example', 'sender-1')).toBe(false);
      expect(reopened.claim('other', 'sender-1')).toBe(true);
      reopened.release('other', 'sender-1');
      expect(reopened.claim('other', 'sender-1')).toBe(true);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses configured and default state directories without exposing sender ids', () => {
    expect(resolveFirstContactStateDir('/tmp/instagram-state')).toBe('/tmp/instagram-state');
    expect(resolveFirstContactStateDir()).toMatch(/instagram$/);
  });

  it('normalizes localized configuration and falls back deterministically', () => {
    const firstContact = resolveInstagramFirstContactConfig({
      messages: { ES: 'Hola', en: 'Hello' },
      fallbackLocale: 'es',
    });
    expect(resolveInstagramFirstContactMessage(firstContact, 'en')).toBe('Hello');
    expect(resolveInstagramFirstContactMessage(firstContact, 'ca')).toBe('Hola');
  });

  it('defaults story and media-share reactions on and comments off for existing account config', () => {
    const config = resolveInstagramAccountConfig({
      channels: {
        instagram: {
          accounts: {
            example: {
              igUserId: '17840000000000000',
              dmPolicy: 'open',
              messagePrefix: '🤖 ',
              allowFrom: ['*'],
              firstContact: {
                messages: { es: 'Hola' },
                fallbackLocale: 'es',
              },
            },
          },
        },
      },
    }, 'example');

    expect(config).toMatchObject({
      storyMentionReaction: true,
      mediaShareReaction: true,
      comments: { enabled: false, keywordPrivateReplies: [] },
    });
  });

  it('normalizes keyword-private-reply locales and rejects missing localized replies', () => {
    const config = resolveInstagramAccountConfig({
      channels: {
        instagram: {
          accounts: {
            example: {
              igUserId: '17840000000000000',
              comments: {
                enabled: true,
                keywordPrivateReplies: [{
                  triggers: { ES: [' info '], EN: [' hello '] },
                  replies: { es: ' Hola ', en: ' Hello ' },
                }],
              },
            },
          },
        },
      },
    }, 'example');

    expect(config?.comments.keywordPrivateReplies).toEqual([{
      triggers: { es: ['info'], en: ['hello'] },
      replies: { es: 'Hola', en: 'Hello' },
    }]);
    expect(() => resolveInstagramAccountConfig({
      channels: {
        instagram: {
          accounts: {
            example: {
              igUserId: '17840000000000000',
              comments: {
                keywordPrivateReplies: [{
                  triggers: { es: ['info'] },
                  replies: { en: 'Hello' },
                }],
              },
            },
          },
        },
      },
    }, 'example')).toThrow('replies must include the es trigger locale');
  });

  it('validates malformed fields, rejects wildcard allowlists, and warns for unknown fields', () => {
    const warnings: string[] = [];
    expect(() => validateInstagramChannelConfig({
      channels: { instagram: { accounts: { example: { igUserId: '17840000000000000', dmPolicy: 'allowlist', allowFrom: ['*'] } } } },
    })).toThrow('cannot contain "*" unless dmPolicy is "open"');
    expect(() => validateInstagramChannelConfig({
      channels: { instagram: { accounts: { example: { igUserId: 'not-a-number' } } } },
    })).toThrow('must be a numeric Instagram user id');
    expect(validateInstagramChannelConfig({
      channels: { instagram: { unknownField: true, accounts: { example: { igUserId: '17840000000000000', extra: true } } } },
    }, (message) => warnings.push(message))).toBeDefined();
    expect(warnings).toEqual([
      '[instagram] ignoring unknown config field channels.instagram.unknownField',
      '[instagram] ignoring unknown config field channels.instagram.accounts.example.extra',
    ]);
  });
});
