import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'),
);
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

function schemaAccepts(value: unknown, schema: any): boolean {
  if (Array.isArray(schema?.anyOf)) {
    return schema.anyOf.some((candidate: any) => schemaAccepts(value, candidate));
  }
  if (Object.hasOwn(schema || {}, 'const') && value !== schema.const) return false;
  if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) return false;
  if (schema?.type === 'boolean') return typeof value === 'boolean';
  if (schema?.type === 'string') {
    return typeof value === 'string' &&
      (schema.minLength === undefined || value.length >= schema.minLength) &&
      (schema.maxLength === undefined || value.length <= schema.maxLength) &&
      (schema.pattern === undefined || new RegExp(schema.pattern).test(value));
  }
  if (schema?.type === 'array') {
    return Array.isArray(value) && value.every((item) => schemaAccepts(item, schema.items));
  }
  if (schema?.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (schema.minProperties !== undefined && Object.keys(record).length < schema.minProperties) return false;
    if ((schema.required || []).some((key: string) => !Object.hasOwn(record, key))) return false;
    return Object.entries(record).every(([key, item]) => {
      if (schema.properties?.[key]) return schemaAccepts(item, schema.properties[key]);
      if (schema.additionalProperties === false) return false;
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return schemaAccepts(item, schema.additionalProperties);
      }
      return true;
    });
  }
  return true;
}

describe('plugin manifest', () => {
  it('declares the external channel and keeps secrets out of config schema', () => {
    expect(manifest).toMatchObject({
      id: 'instagram',
      kind: 'channel',
      channels: ['instagram'],
      channelEnvVars: {
        instagram: ['INSTAGRAM_APP_SECRET', 'INSTAGRAM_VERIFY_TOKEN'],
      },
    });
    const serializedSchema = JSON.stringify(manifest.channelConfigs.instagram.schema);
    expect(serializedSchema).not.toMatch(/secret|accessToken|verifyToken/i);
    expect(manifest.channelConfigs.instagram.schema.properties.accounts.additionalProperties.required)
      .toEqual(['igUserId']);
    expect(manifest.channelConfigs.instagram.schema.properties.accounts.additionalProperties.properties.messagePrefix)
      .toEqual({
        type: 'string',
        maxLength: 16,
        description: 'Optional prefix added to every outbound message.',
      });
    const schema = manifest.channelConfigs.instagram.schema;
    const accountProperties = schema.properties.accounts.additionalProperties.properties;
    expect(schema.properties.firstContactStateDir).toEqual({
      type: 'string',
      description: 'Directory for durable first-contact, automated-receipt, human-takeover, comment-idempotency, and reaction-idempotency state.',
    });
    expect(accountProperties.storyMentionReaction).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(accountProperties.mediaShareReaction).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(accountProperties.comments).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          default: false,
        },
        keywordPrivateReplies: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['triggers', 'replies'],
          },
        },
      },
    });
    expect(accountProperties.firstContact).toMatchObject({
      type: 'object',
      required: ['messages', 'fallbackLocale'],
    });
    expect(accountProperties.allowFrom.items).toMatchObject({
      anyOf: [{ pattern: '^[0-9]+$' }, { const: '*' }],
    });
  });

  it('accepts the current live account shape without either reaction setting', () => {
    const currentLiveShape = {
      accounts: {
        example: {
          igUserId: '17840000000000000',
          dmPolicy: 'open',
          messagePrefix: '🤖 ',
          allowFrom: ['*'],
          comments: {
            enabled: true,
            keywordPrivateReplies: [{
              triggers: { es: ['info'], en: ['hello'], ca: ['details'] },
              replies: { es: 'Hola', en: 'Hello', ca: 'Hola' },
            }],
          },
          firstContact: {
            messages: {
              es: 'Hola',
              en: 'Hello',
            },
            fallbackLocale: 'es',
          },
        },
      },
    };

    expect(schemaAccepts(
      currentLiveShape,
      manifest.channelConfigs.instagram.schema,
    )).toBe(true);
  });

  it('keeps the manifest entry points present after build', () => {
    expect(existsSync(new URL('../dist/index.js', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../dist/setup-entry.js', import.meta.url))).toBe(true);
  });

  it('ships the Meta setup guide in the public package', () => {
    expect(packageJson.files).toContain('docs');
    expect(existsSync(new URL('../docs/meta-setup.md', import.meta.url))).toBe(true);
  });
});
