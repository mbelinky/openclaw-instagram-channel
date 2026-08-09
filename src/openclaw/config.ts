import type { InstagramKeywordPrivateReplyCampaign } from '../instagram/keyword-private-reply.js';

export type { InstagramKeywordPrivateReplyCampaign } from '../instagram/keyword-private-reply.js';

export const CHANNEL_ID = 'instagram';
export const WEBHOOK_PATH = '/webhook/instagram';

export type InstagramDmPolicy = 'allowlist' | 'open';

export interface InstagramFirstContactConfig {
  messages: Record<string, string>;
  fallbackLocale: string;
}

export interface InstagramCommentsConfig {
  enabled?: boolean;
  keywordPrivateReplies?: InstagramKeywordPrivateReplyCampaign[];
}

export interface InstagramAccountConfig {
  name?: string;
  enabled?: boolean;
  igUserId: string;
  messagePrefix?: string;
  storyMentionReaction?: boolean;
  mediaShareReaction?: boolean;
  comments?: InstagramCommentsConfig;
  firstContact?: InstagramFirstContactConfig;
  dmPolicy?: InstagramDmPolicy;
  allowFrom?: string[];
}

export interface InstagramChannelConfig {
  enabled?: boolean;
  defaultAccount?: string;
  firstContactStateDir?: string;
  accounts: Record<string, InstagramAccountConfig>;
}

export interface ResolvedInstagramAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  config: InstagramAccountConfig & {
    dmPolicy: InstagramDmPolicy;
    storyMentionReaction: boolean;
    mediaShareReaction: boolean;
    comments: {
      enabled: boolean;
      keywordPrivateReplies: InstagramKeywordPrivateReplyCampaign[];
    };
  };
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  tokenEnvVar: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeLocale(value: string): string {
  return value.trim().toLowerCase();
}

type ConfigWarning = (message: string) => void;

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  warn?: ConfigWarning,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) warn?.(`[instagram] ignoring unknown config field ${path}.${key}`);
  }
}

function assertOptionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
}

function assertOptionalString(value: unknown, path: string, maxLength?: number): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  if (maxLength !== undefined && value.length > maxLength) throw new Error(`${path} must be at most ${maxLength} characters`);
}

function validateInstagramAccountConfig(
  value: unknown,
  path: string,
  warn?: ConfigWarning,
): asserts value is InstagramAccountConfig {
  if (!isObjectRecord(value)) throw new Error(`${path} must be an object`);
  assertKnownFields(value, [
    'name', 'enabled', 'igUserId', 'messagePrefix', 'storyMentionReaction',
    'mediaShareReaction', 'comments', 'firstContact', 'dmPolicy', 'allowFrom',
  ], path, warn);
  assertOptionalString(value.name, `${path}.name`);
  assertOptionalBoolean(value.enabled, `${path}.enabled`);
  if (typeof value.igUserId !== 'string' || !/^\d+$/.test(value.igUserId.trim())) {
    throw new Error(`${path}.igUserId must be a numeric Instagram user id`);
  }
  assertOptionalString(value.messagePrefix, `${path}.messagePrefix`, 16);
  assertOptionalBoolean(value.storyMentionReaction, `${path}.storyMentionReaction`);
  assertOptionalBoolean(value.mediaShareReaction, `${path}.mediaShareReaction`);
  if (value.dmPolicy !== undefined && value.dmPolicy !== 'open' && value.dmPolicy !== 'allowlist') {
    throw new Error(`${path}.dmPolicy must be "open" or "allowlist"`);
  }
  if (value.allowFrom !== undefined) {
    if (!Array.isArray(value.allowFrom) || value.allowFrom.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new Error(`${path}.allowFrom must be an array of non-empty Instagram sender ids`);
    }
    if (value.allowFrom.some((entry) => entry.trim() === '*') && value.dmPolicy !== 'open') {
      throw new Error(`${path}.allowFrom cannot contain "*" unless dmPolicy is "open"; use an explicit sender id for allowlist`);
    }
    if (value.allowFrom.some((entry) => entry.trim() !== '*' && !/^\d+$/.test(entry.trim()))) {
      throw new Error(`${path}.allowFrom entries must be numeric Instagram sender ids`);
    }
  }
  if (value.comments !== undefined) {
    if (!isObjectRecord(value.comments)) throw new Error(`${path}.comments must be an object`);
    assertKnownFields(value.comments, ['enabled', 'keywordPrivateReplies'], `${path}.comments`, warn);
    assertOptionalBoolean(value.comments.enabled, `${path}.comments.enabled`);
    resolveInstagramKeywordPrivateReplies(value.comments.keywordPrivateReplies);
  }
  if (value.firstContact !== undefined) resolveInstagramFirstContactConfig(value.firstContact);
}

export function validateInstagramChannelConfig(cfg: any, warn?: ConfigWarning): InstagramChannelConfig | undefined {
  const value = cfg?.channels?.[CHANNEL_ID];
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) throw new Error(`channels.${CHANNEL_ID} must be an object`);
  assertKnownFields(value, ['enabled', 'defaultAccount', 'firstContactStateDir', 'accounts'], `channels.${CHANNEL_ID}`, warn);
  assertOptionalBoolean(value.enabled, `channels.${CHANNEL_ID}.enabled`);
  assertOptionalString(value.defaultAccount, `channels.${CHANNEL_ID}.defaultAccount`);
  assertOptionalString(value.firstContactStateDir, `channels.${CHANNEL_ID}.firstContactStateDir`);
  if (!isObjectRecord(value.accounts)) throw new Error(`channels.${CHANNEL_ID}.accounts must be an object`);
  if (Object.keys(value.accounts).length === 0) throw new Error(`channels.${CHANNEL_ID}.accounts must include at least one account`);
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!normalizeAccountId(accountId) || normalizeAccountId(accountId) === 'default' && accountId.trim() !== 'default') {
      throw new Error(`channels.${CHANNEL_ID}.accounts has an invalid account id`);
    }
    validateInstagramAccountConfig(account, `channels.${CHANNEL_ID}.accounts.${accountId}`, warn);
  }
  return value as unknown as InstagramChannelConfig;
}

export function resolveInstagramKeywordPrivateReplies(
  value: unknown,
): InstagramKeywordPrivateReplyCampaign[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('comments.keywordPrivateReplies must be an array');
  }

  return value.map((campaign, campaignIndex) => {
    const path = `comments.keywordPrivateReplies[${campaignIndex}]`;
    if (!isObjectRecord(campaign)) {
      throw new Error(`${path} must be an object`);
    }
    if (!isObjectRecord(campaign.triggers)) {
      throw new Error(`${path}.triggers must be an object`);
    }
    if (!isObjectRecord(campaign.replies)) {
      throw new Error(`${path}.replies must be an object`);
    }

    const triggers: Record<string, string[]> = {};
    for (const [locale, configuredTriggers] of Object.entries(campaign.triggers)) {
      const normalizedLocale = normalizeLocale(locale);
      if (!normalizedLocale || !Array.isArray(configuredTriggers) || configuredTriggers.length === 0) {
        throw new Error(`${path}.triggers must contain non-empty locale arrays`);
      }
      const normalizedTriggers = configuredTriggers.map((trigger) =>
        typeof trigger === 'string' ? trigger.trim() : ''
      );
      if (normalizedTriggers.some((trigger) => !trigger)) {
        throw new Error(`${path}.triggers must contain non-empty strings`);
      }
      triggers[normalizedLocale] = normalizedTriggers;
    }
    if (Object.keys(triggers).length === 0) {
      throw new Error(`${path}.triggers must not be empty`);
    }

    const replies: Record<string, string> = {};
    for (const [locale, configuredReply] of Object.entries(campaign.replies)) {
      const normalizedLocale = normalizeLocale(locale);
      const reply = typeof configuredReply === 'string' ? configuredReply.trim() : '';
      if (!normalizedLocale || !reply) {
        throw new Error(`${path}.replies must contain non-empty locale keys and messages`);
      }
      if (reply.length > 1000) {
        throw new Error(`${path}.replies messages must be at most 1000 characters`);
      }
      replies[normalizedLocale] = reply;
    }
    if (Object.keys(replies).length === 0) {
      throw new Error(`${path}.replies must not be empty`);
    }
    for (const locale of Object.keys(triggers)) {
      if (!replies[locale]) {
        throw new Error(`${path}.replies must include the ${locale} trigger locale`);
      }
    }

    return { triggers, replies };
  });
}

export function resolveInstagramFirstContactConfig(
  value: unknown,
): InstagramFirstContactConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error('firstContact must be an object');
  }
  if (!isObjectRecord(value.messages)) {
    throw new Error('firstContact.messages must be an object');
  }
  if (typeof value.fallbackLocale !== 'string') {
    throw new Error('firstContact.fallbackLocale must be a string');
  }

  const messages: Record<string, string> = {};
  for (const [locale, message] of Object.entries(value.messages)) {
    const normalizedLocale = normalizeLocale(locale);
    const normalizedMessage = typeof message === 'string' ? message.trim() : '';
    if (!normalizedLocale || !normalizedMessage) {
      throw new Error('firstContact.messages must contain non-empty locale keys and messages');
    }
    messages[normalizedLocale] = normalizedMessage;
  }
  if (Object.keys(messages).length === 0) {
    throw new Error('firstContact.messages must not be empty');
  }

  const fallbackLocale = normalizeLocale(value.fallbackLocale);
  if (!messages[fallbackLocale]) {
    throw new Error('firstContact.fallbackLocale must name a configured message locale');
  }
  return { messages, fallbackLocale };
}

export function resolveInstagramFirstContactMessage(
  config: InstagramFirstContactConfig,
  locale?: string,
): string;
export function resolveInstagramFirstContactMessage(
  config: undefined,
  locale?: string,
): undefined;
export function resolveInstagramFirstContactMessage(
  config: InstagramFirstContactConfig | undefined,
  locale?: string,
): string | undefined;
export function resolveInstagramFirstContactMessage(
  config: InstagramFirstContactConfig | undefined,
  locale?: string,
): string | undefined {
  if (!config) return undefined;
  const message = locale ? config.messages[normalizeLocale(locale)] : undefined;
  return message || config.messages[config.fallbackLocale];
}

export function normalizeAccountId(value: string | null | undefined): string {
  const normalized = (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

export function accessTokenEnvVar(accountId: string): string {
  const suffix = normalizeAccountId(accountId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `INSTAGRAM_ACCESS_TOKEN_${suffix}`;
}

export function readInstagramChannelConfig(cfg: any): InstagramChannelConfig | undefined {
  return validateInstagramChannelConfig(cfg);
}

export function listInstagramAccountIds(cfg: any): string[] {
  const channel = readInstagramChannelConfig(cfg);
  const accounts = isObjectRecord(channel?.accounts) ? channel.accounts : {};
  return Object.keys(accounts)
    .map(normalizeAccountId)
    .filter((id, index, all) => all.indexOf(id) === index);
}

export function resolveDefaultInstagramAccountId(cfg: any): string {
  const channel = readInstagramChannelConfig(cfg);
  const ids = listInstagramAccountIds(cfg);
  const configured = normalizeAccountId(channel?.defaultAccount);
  return channel?.defaultAccount && ids.includes(configured) ? configured : ids[0] || 'default';
}

export function resolveInstagramAccountConfig(
  cfg: any,
  accountId: string,
): (InstagramAccountConfig & {
  dmPolicy: InstagramDmPolicy;
  storyMentionReaction: boolean;
  mediaShareReaction: boolean;
  comments: {
    enabled: boolean;
    keywordPrivateReplies: InstagramKeywordPrivateReplyCampaign[];
  };
}) | null {
  const channel = readInstagramChannelConfig(cfg);
  if (!channel || !isObjectRecord(channel.accounts)) return null;
  const normalized = normalizeAccountId(accountId);
  for (const [key, value] of Object.entries(channel.accounts)) {
    if (normalizeAccountId(key) !== normalized) continue;
    validateInstagramAccountConfig(value, `channels.${CHANNEL_ID}.accounts.${key}`);
    const account = value;
    const firstContact = resolveInstagramFirstContactConfig(account.firstContact);
    const keywordPrivateReplies = resolveInstagramKeywordPrivateReplies(
      account.comments?.keywordPrivateReplies,
    );
    return {
      ...account,
      ...(firstContact ? { firstContact } : {}),
      dmPolicy: account.dmPolicy === 'open' ? 'open' : 'allowlist',
      storyMentionReaction: account.storyMentionReaction !== false,
      mediaShareReaction: account.mediaShareReaction !== false,
      comments: {
        enabled: account.comments?.enabled === true,
        keywordPrivateReplies,
      },
    };
  }
  return null;
}

export function resolveInstagramAccount(
  cfg: any,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedInstagramAccount | null {
  const channel = readInstagramChannelConfig(cfg);
  if (!channel?.enabled) return null;
  const resolvedAccountId = normalizeAccountId(accountId || resolveDefaultInstagramAccountId(cfg));
  const config = resolveInstagramAccountConfig(cfg, resolvedAccountId);
  if (!config || config.enabled === false || !config.igUserId) return null;

  const tokenEnvVar = accessTokenEnvVar(resolvedAccountId);
  const accessToken = env[tokenEnvVar] || '';
  const appSecret = env.INSTAGRAM_APP_SECRET || '';
  const verifyToken = env.INSTAGRAM_VERIFY_TOKEN || '';
  if (!accessToken || !appSecret || !verifyToken) return null;

  return {
    accountId: resolvedAccountId,
    name: config.name || `Instagram (${resolvedAccountId})`,
    enabled: true,
    config,
    accessToken,
    appSecret,
    verifyToken,
    tokenEnvVar,
  };
}
