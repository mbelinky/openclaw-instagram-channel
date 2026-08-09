import { createHash } from 'node:crypto';
import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import {
  createChannelMessageAdapterFromOutbound,
  createMessageReceiptFromOutboundResults,
} from 'openclaw/plugin-sdk/channel-outbound';
import { createRestrictSendersChannelSecurity } from 'openclaw/plugin-sdk/channel-policy';
import { createAttachedChannelResultAdapter } from 'openclaw/plugin-sdk/channel-send-result';
import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/channel-inbound';
import { shouldComputeCommandAuthorized } from 'openclaw/plugin-sdk/command-auth';
import * as hookRuntime from 'openclaw/plugin-sdk/hook-runtime';
import { getGlobalHookRunner } from 'openclaw/plugin-sdk/plugin-runtime';
import { registerPluginHttpRoute } from 'openclaw/plugin-sdk/webhook-ingress';
import {
  CHANNEL_ID,
  WEBHOOK_PATH,
  accessTokenEnvVar,
  listInstagramAccountIds,
  readInstagramChannelConfig,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccount,
  resolveInstagramAccountConfig,
  resolveInstagramFirstContactMessage,
  validateInstagramChannelConfig,
  type ResolvedInstagramAccount,
} from './config.js';
import { buildInstagramDirectDmIdentity } from '../instagram/identity.js';
import { openFirstContactStore, resolveFirstContactStateDir } from '../instagram/first-contact.js';
import { openInstagramConversationStateStore } from '../instagram/conversation-state.js';
import { detectInstagramMessageLocale } from '../instagram/first-contact-locale.js';
import { matchInstagramKeywordPrivateReply } from '../instagram/keyword-private-reply.js';
import {
  instagramPrivateReplyPointer,
  instagramPublicThanks,
} from '../instagram/engagement.js';
import { lookupInstagramUserProfile } from '../instagram/profile.js';
import { isPositivePassiveComment, isReactionOnlyText } from '../instagram/reaction.js';
import { getInstagramRuntime } from './runtime.js';
import {
  InstagramSendError,
  sendInstagramCommentReply,
  sendInstagramPrivateReply,
  sendInstagramReaction,
  sendInstagramText,
} from '../instagram/send.js';
import { emitInstagramMessageSentHook } from './sent-hook.js';
import {
  createInstagramWebhookHandler,
  redactInstagramId,
  type InstagramInboundMessage,
  type InstagramInboundComment,
  type InstagramAccountMessage,
  type InstagramWebhookMessage,
  type InstagramWebhookAccount,
} from '../instagram/webhook.js';

const instagramSecurity = createRestrictSendersChannelSecurity<ResolvedInstagramAccount>({
  channelKey: CHANNEL_ID,
  resolveDmPolicy: (account: ResolvedInstagramAccount) => account.config.dmPolicy,
  resolveDmAllowFrom: (account: ResolvedInstagramAccount) => account.config.allowFrom,
  surface: 'Instagram DMs',
  openScope: 'any Instagram account that can DM the professional account',
  policyPathSuffix: 'dmPolicy',
  mentionGated: false,
  approveHint: 'Add the Instagram-scoped sender id to channels.instagram.accounts.<accountId>.allowFrom',
  normalizeDmEntry: (raw: string) => raw.trim(),
});

const instagramOutbound = {
  deliveryMode: 'gateway' as const,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
    },
  },
  ...createAttachedChannelResultAdapter({
    channel: CHANNEL_ID,
    sendText: async ({ cfg, to, text, accountId, signal }) => {
      const resolvedId = accountId || resolveDefaultInstagramAccountId(cfg);
      const account = resolveInstagramAccount(cfg, resolvedId);
      if (!account) {
        throw new Error(
          `Instagram account "${resolvedId}" is not configured; check channels.instagram.accounts and ${accessTokenEnvVar(resolvedId)}`,
        );
      }
      const active = startedAccounts.get(account.accountId);
      if (!active) {
        throw new Error(`Instagram account "${account.accountId}" is not running; refusing automated send`);
      }
      const result = await sendAutomatedInstagramText(active, to, {
        igUserId: account.config.igUserId,
        recipientId: to,
        text,
        accessToken: account.accessToken,
        messagePrefix: account.config.messagePrefix,
        signal,
      });
      recordAutomatedMessageReceipts(active, result);
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: CHANNEL_ID, messageId: result.messageId, conversationId: to }],
          kind: 'text',
        }),
      };
    },
  }),
  resolveTarget: ({ to }: { to?: string }) => {
    const normalized = to?.trim();
    if (!normalized) return { ok: false as const, error: new Error('No Instagram recipient specified') };
    if (!/^\d+$/.test(normalized)) {
      return { ok: false as const, error: new Error('Instagram recipients must be scoped numeric sender ids') };
    }
    return { ok: true as const, to: normalized };
  },
};

type StartedInstagramAccount = {
  account: ResolvedInstagramAccount;
  ctx: any;
  firstContactStore: ReturnType<typeof openFirstContactStore>;
  conversationStateStore: ReturnType<typeof openInstagramConversationStateStore>;
};

const startedAccounts = new Map<string, StartedInstagramAccount>();
const automatedSendsInFlight = new Map<string, number>();
const provisionalAccountMessages = new Map<string, Set<string>>();
const fallbackHumanTakeovers = new Map<string, number>();
const fallbackHumanMessages = new Map<string, number>();
const fallbackAutomatedMessages = new Map<string, number>();
const fallbackAmbiguousAutomatedTexts = new Map<string, number>();
let unregisterWebhook: (() => void) | null = null;
const ACCOUNT_ECHO_RECONCILE_TIMEOUT_MS = 30_000;
const ACCOUNT_ECHO_RECONCILE_POLL_MS = 25;
const FALLBACK_HUMAN_TAKEOVER_MS = 24 * 60 * 60 * 1000;
const FALLBACK_MESSAGE_DEDUP_MS = 30 * 24 * 60 * 60 * 1000;
const FALLBACK_AMBIGUOUS_SEND_MS = 10 * 60 * 1000;
const MAX_FALLBACK_ENTRIES = 10_000;
const SENDER_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const SENDER_PROFILE_FAILURE_TTL_MS = 5 * 60 * 1000;
const MAX_SENDER_PROFILE_CACHE_ENTRIES = 1_000;
const senderProfileCache = new Map<string, { username?: string; expiresAt: number }>();
const senderProfileLookups = new Map<string, Promise<string | undefined>>();

type PassiveReaction = {
  content: string;
  failureLabel: string;
};

function passiveReactionForMessage(
  message: InstagramInboundMessage,
  account: ResolvedInstagramAccount,
): PassiveReaction | undefined {
  const storyMentionOnly =
    message.passiveShareOnly &&
    message.media.length > 0 &&
    message.media.every((item) => item.type === 'story_mention');
  if (storyMentionOnly) {
    return account.config.storyMentionReaction !== false
      ? { content: '(❤️ story mention)', failureLabel: 'story mention reaction' }
      : undefined;
  }
  if (account.config.mediaShareReaction === false) return undefined;
  if (message.mediaShareKind === 'recognized') {
    return { content: '(❤️ shared reel/post)', failureLabel: 'shared reel/post reaction' };
  }
  if (message.mediaShareKind === 'untyped') {
    return { content: '(❤️ shared media)', failureLabel: 'shared media reaction' };
  }
  return undefined;
}

async function reactToPassiveMessage(
  active: StartedInstagramAccount,
  message: InstagramInboundMessage,
  sessionKey: string,
): Promise<void> {
  const reaction = passiveReactionForMessage(message, active.account);
  if (!reaction) return;

  let claimed: boolean;
  try {
    claimed = active.conversationStateStore.claimReaction(
      active.account.accountId,
      message.messageId,
    );
  } catch (error) {
    active.ctx.log?.error?.(
      `[instagram] reaction idempotency claim failed accountId=${active.account.accountId} messageHash=${redactInstagramId(message.messageId)}: ${String(error)}`,
    );
    return;
  }
  if (!claimed) {
    active.ctx.log?.info?.(
      `[instagram] ignored duplicate reaction accountId=${active.account.accountId} messageHash=${redactInstagramId(message.messageId)}`,
    );
    return;
  }

  try {
    await sendInstagramReaction({
      igUserId: active.account.config.igUserId,
      recipientId: message.senderId,
      messageId: message.messageId,
      accessToken: active.account.accessToken,
    });
    emitInstagramMessageSentHook({
      to: message.senderId,
      content: reaction.content,
      success: true,
      accountId: active.account.accountId,
      sessionKey,
      sentBy: 'bot',
    });
  } catch (error) {
    active.ctx.log?.warn?.(
      `[instagram] ${reaction.failureLabel} failed accountId=${active.account.accountId} senderHash=${redactInstagramId(message.senderId)} messageHash=${redactInstagramId(message.messageId)}: ${String(error)}`,
    );
  }
}

function automatedMessageIds(result: { messageId: string; messageIds?: string[] }): string[] {
  return result.messageIds?.length ? result.messageIds : [result.messageId];
}

function conversationKey(accountId: string, peerId: string): string {
  return `${accountId}\0${peerId}`;
}

function ambiguousTextKey(accountId: string, peerId: string, text: string): string {
  const textHash = createHash('sha256').update(text).digest('hex');
  return `${conversationKey(accountId, peerId)}\0${textHash}`;
}

function inFlightSendCount(accountId: string, peerId: string): number {
  return automatedSendsInFlight.get(conversationKey(accountId, peerId)) || 0;
}

function addProvisionalAccountMessage(accountId: string, peerId: string, messageId: string): void {
  const key = conversationKey(accountId, peerId);
  const messages = provisionalAccountMessages.get(key) || new Set<string>();
  messages.add(messageId);
  provisionalAccountMessages.set(key, messages);
}

function removeProvisionalAccountMessage(accountId: string, peerId: string, messageId: string): void {
  const key = conversationKey(accountId, peerId);
  const messages = provisionalAccountMessages.get(key);
  if (!messages) return;
  messages.delete(messageId);
  if (messages.size === 0) provisionalAccountMessages.delete(key);
}

function hasProvisionalAccountMessage(accountId: string, peerId: string): boolean {
  return Boolean(provisionalAccountMessages.get(conversationKey(accountId, peerId))?.size);
}

function activeFallback(map: Map<string, number>, key: string): boolean {
  const expiresAt = map.get(key) || 0;
  if (expiresAt > Date.now()) return true;
  if (expiresAt) map.delete(key);
  return false;
}

function setFallback(map: Map<string, number>, key: string, expiresAt: number): void {
  if (!map.has(key) && map.size >= MAX_FALLBACK_ENTRIES) {
    const currentTime = Date.now();
    for (const [candidate, expiry] of map) {
      if (expiry <= currentTime) map.delete(candidate);
    }
    if (map.size >= MAX_FALLBACK_ENTRIES) {
      const oldest = map.keys().next().value;
      if (typeof oldest === 'string') map.delete(oldest);
    }
  }
  map.set(key, Math.max(map.get(key) || 0, expiresAt));
}

function markFallbackHumanTakeover(message: InstagramAccountMessage): void {
  const currentTime = Date.now();
  const occurredAt = Number.isFinite(message.timestamp) && Number(message.timestamp) <= currentTime + 5 * 60 * 1000
    ? Number(message.timestamp)
    : currentTime;
  const expiresAt = occurredAt + FALLBACK_HUMAN_TAKEOVER_MS;
  const takeoverKey = conversationKey(message.accountId, message.peerId);
  setFallback(fallbackHumanTakeovers, takeoverKey, expiresAt);
}

function markFallbackHumanMessage(message: InstagramAccountMessage): void {
  setFallback(
    fallbackHumanMessages,
    conversationKey(message.accountId, message.messageId),
    Date.now() + FALLBACK_MESSAGE_DEDUP_MS,
  );
}

function isFallbackHumanMessage(accountId: string, messageId: string): boolean {
  return activeFallback(fallbackHumanMessages, conversationKey(accountId, messageId));
}

function markFallbackAutomatedMessage(accountId: string, messageId: string): void {
  setFallback(
    fallbackAutomatedMessages,
    conversationKey(accountId, messageId),
    Date.now() + FALLBACK_MESSAGE_DEDUP_MS,
  );
}

function isFallbackAutomatedMessage(accountId: string, messageId: string): boolean {
  return activeFallback(fallbackAutomatedMessages, conversationKey(accountId, messageId));
}

function markFallbackAmbiguousAutomatedText(accountId: string, peerId: string, text: string): void {
  setFallback(
    fallbackAmbiguousAutomatedTexts,
    ambiguousTextKey(accountId, peerId, text),
    Date.now() + FALLBACK_AMBIGUOUS_SEND_MS,
  );
}

function isFallbackAmbiguousAutomatedText(accountId: string, peerId: string, text: string): boolean {
  return activeFallback(fallbackAmbiguousAutomatedTexts, ambiguousTextKey(accountId, peerId, text));
}

function logConversationStateError(
  active: StartedInstagramAccount,
  action: string,
  error: unknown,
): void {
  active.ctx.log?.error?.(`[instagram] conversation state ${action} failed: ${String(error)}`);
}

function recordAutomatedMessageReceipts(
  active: StartedInstagramAccount,
  result: { messageId: string; messageIds?: string[] },
): void {
  for (const messageId of automatedMessageIds(result)) {
    try {
      active.conversationStateStore.recordAutomatedMessage(active.account.accountId, messageId);
    } catch (error) {
      markFallbackAutomatedMessage(active.account.accountId, messageId);
      logConversationStateError(active, 'receipt write', error);
    }
  }
}

function automatedSendStateCallbacks(active: StartedInstagramAccount, peerId: string) {
  return {
    onChunkPending: () => {
      if (isAutomatedSendBlocked(active, peerId)) {
        throw new Error('Instagram automated send suppressed during active human takeover');
      }
    },
    onChunkReceipt: ({ messageId }: { text: string; messageId: string }) => {
      try {
        active.conversationStateStore.recordAutomatedMessage(active.account.accountId, messageId);
      } catch (error) {
        markFallbackAutomatedMessage(active.account.accountId, messageId);
        logConversationStateError(active, 'receipt reconciliation', error);
      }
      removeProvisionalAccountMessage(active.account.accountId, peerId, messageId);
    },
  };
}

async function sendAutomatedInstagramText(
  active: StartedInstagramAccount,
  peerId: string,
  params: Omit<Parameters<typeof sendInstagramText>[0], 'onChunkPending' | 'onChunkReceipt'>,
) {
  const key = conversationKey(active.account.accountId, peerId);
  let countedInFlight = false;
  let pendingText: string | undefined;
  try {
    await waitForProvisionalAccountMessage(active.account.accountId, peerId);
    if (isAutomatedSendBlocked(active, peerId)) {
      throw new Error('Instagram automated send suppressed during active human takeover');
    }
    automatedSendsInFlight.set(key, inFlightSendCount(active.account.accountId, peerId) + 1);
    countedInFlight = true;
    const callbacks = automatedSendStateCallbacks(active, peerId);
    return await sendInstagramText({
      ...params,
      onChunkPending: (chunk) => {
        callbacks.onChunkPending();
        pendingText = chunk.text;
      },
      onChunkReceipt: (chunk) => {
        callbacks.onChunkReceipt(chunk);
        pendingText = undefined;
      },
    });
  } catch (error) {
    if (pendingText && (!(error instanceof InstagramSendError) || error.deliveryUnknown)) {
      try {
        active.conversationStateStore.recordAmbiguousAutomatedText(
          active.account.accountId,
          peerId,
          pendingText,
        );
      } catch (stateError) {
        markFallbackAmbiguousAutomatedText(active.account.accountId, peerId, pendingText);
        logConversationStateError(active, 'ambiguous send write', stateError);
      }
    }
    throw error;
  } finally {
    if (countedInFlight) {
      const remaining = inFlightSendCount(active.account.accountId, peerId) - 1;
      if (remaining > 0) automatedSendsInFlight.set(key, remaining);
      else automatedSendsInFlight.delete(key);
    }
  }
}

async function sendAutomatedInstagramPrivateReply(
  active: StartedInstagramAccount,
  peerId: string,
  params: Omit<Parameters<typeof sendInstagramPrivateReply>[0], 'onPending' | 'onReceipt'>,
) {
  const key = conversationKey(active.account.accountId, peerId);
  let countedInFlight = false;
  let pendingText: string | undefined;
  try {
    await waitForProvisionalAccountMessage(active.account.accountId, peerId);
    if (isAutomatedSendBlocked(active, peerId)) {
      throw new Error('Instagram automated send suppressed during active human takeover');
    }
    automatedSendsInFlight.set(key, inFlightSendCount(active.account.accountId, peerId) + 1);
    countedInFlight = true;
    const callbacks = automatedSendStateCallbacks(active, peerId);
    const result = await sendInstagramPrivateReply({
      ...params,
      onPending: (reply) => {
        callbacks.onChunkPending();
        pendingText = reply.text;
      },
      onReceipt: (reply) => {
        callbacks.onChunkReceipt(reply);
        pendingText = undefined;
      },
    });
    recordAutomatedMessageReceipts(active, result);
    return result;
  } catch (error) {
    if (pendingText && (!(error instanceof InstagramSendError) || error.deliveryUnknown)) {
      try {
        active.conversationStateStore.recordAmbiguousAutomatedText(
          active.account.accountId,
          peerId,
          pendingText,
        );
      } catch (stateError) {
        markFallbackAmbiguousAutomatedText(active.account.accountId, peerId, pendingText);
        logConversationStateError(active, 'ambiguous private reply write', stateError);
      }
    }
    throw error;
  } finally {
    if (countedInFlight) {
      const remaining = inFlightSendCount(active.account.accountId, peerId) - 1;
      if (remaining > 0) automatedSendsInFlight.set(key, remaining);
      else automatedSendsInFlight.delete(key);
    }
  }
}

function isConfirmedHumanTakeoverActive(active: StartedInstagramAccount, peerId: string): boolean {
  if (activeFallback(
    fallbackHumanTakeovers,
    conversationKey(active.account.accountId, peerId),
  )) return true;
  try {
    return active.conversationStateStore.isHumanTakeoverActive(active.account.accountId, peerId);
  } catch (error) {
    logConversationStateError(active, 'read', error);
    return true;
  }
}

function isAutomatedSendBlocked(active: StartedInstagramAccount, peerId: string): boolean {
  return hasProvisionalAccountMessage(active.account.accountId, peerId) ||
    isConfirmedHumanTakeoverActive(active, peerId);
}

async function waitForProvisionalAccountMessage(accountId: string, peerId: string): Promise<void> {
  const deadline = Date.now() + ACCOUNT_ECHO_RECONCILE_TIMEOUT_MS;
  while (hasProvisionalAccountMessage(accountId, peerId) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, ACCOUNT_ECHO_RECONCILE_POLL_MS));
  }
}

function isStandaloneUrl(text: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(text.trim())) return false;
  try {
    new URL(text.trim());
    return true;
  } catch {
    return false;
  }
}

function cacheSenderUsername(key: string, username: string | undefined, ttlMs: number) {
  senderProfileCache.delete(key);
  if (senderProfileCache.size >= MAX_SENDER_PROFILE_CACHE_ENTRIES) {
    const oldestKey = senderProfileCache.keys().next().value;
    if (typeof oldestKey === 'string') senderProfileCache.delete(oldestKey);
  }
  senderProfileCache.set(key, { username, expiresAt: Date.now() + ttlMs });
}

async function resolveSenderUsername(
  account: ResolvedInstagramAccount,
  senderId: string,
  log: { warn?: (message: string) => void } | undefined,
): Promise<string | undefined> {
  const cacheKey = `${account.accountId}\0${senderId}`;
  const cached = senderProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.username;
  if (cached) senderProfileCache.delete(cacheKey);

  const inFlight = senderProfileLookups.get(cacheKey);
  if (inFlight) return inFlight;

  const lookup = (async () => {
    try {
      const profile = await lookupInstagramUserProfile({
        senderId,
        accessToken: account.accessToken,
      });
      cacheSenderUsername(cacheKey, profile?.username, profile ? SENDER_PROFILE_TTL_MS : SENDER_PROFILE_FAILURE_TTL_MS);
      return profile?.username;
    } catch (error) {
      cacheSenderUsername(cacheKey, undefined, SENDER_PROFILE_FAILURE_TTL_MS);
      log?.warn?.(
        `[instagram] profile lookup failed sender hash=${redactInstagramId(senderId)} account ${account.accountId}: ${String(error)}`,
      );
      return undefined;
    } finally {
      senderProfileLookups.delete(cacheKey);
    }
  })();
  senderProfileLookups.set(cacheKey, lookup);
  return lookup;
}

function webhookAccounts(cfg: any): InstagramWebhookAccount[] {
  return listInstagramAccountIds(cfg).flatMap((accountId) => {
    const config = resolveInstagramAccountConfig(cfg, accountId);
    if (!config || config.enabled === false) return [];
    return [{
      accountId,
      igUserId: config.igUserId,
      dmPolicy: config.dmPolicy,
      allowFrom: new Set((config.allowFrom || []).map((value) => value.trim()).filter(Boolean)),
      commentsEnabled: config.comments.enabled,
    }];
  });
}

function setupStatus(cfg: any): { status: string; hint?: string } {
  const channel = readInstagramChannelConfig(cfg);
  if (!channel?.enabled) return { status: 'not-configured' };
  if (!process.env.INSTAGRAM_APP_SECRET || !process.env.INSTAGRAM_VERIFY_TOKEN) {
    return { status: 'not-configured', hint: 'Set INSTAGRAM_APP_SECRET and INSTAGRAM_VERIFY_TOKEN' };
  }
  const ids = listInstagramAccountIds(cfg);
  if (ids.length === 0) {
    return { status: 'not-configured', hint: 'Set channels.instagram.accounts.<accountId>.igUserId' };
  }
  for (const id of ids) {
    const account = resolveInstagramAccountConfig(cfg, id);
    if (!account?.igUserId) {
      return { status: 'not-configured', hint: `Set channels.instagram.accounts.${id}.igUserId` };
    }
    const envName = accessTokenEnvVar(id);
    if (!process.env[envName]) return { status: 'not-configured', hint: `Set ${envName}` };
    if (account.dmPolicy === 'allowlist' && !(account.allowFrom || []).length) {
      return {
        status: 'not-configured',
        hint: `Set channels.instagram.accounts.${id}.allowFrom or change dmPolicy to open`,
      };
    }
  }
  return { status: 'configured' };
}

async function dispatchInbound(message: InstagramInboundMessage) {
  const active = startedAccounts.get(message.accountId);
  if (!active) throw new Error(`Instagram account "${message.accountId}" is not running`);
  const { account, ctx, firstContactStore } = active;
  const senderUsername = await resolveSenderUsername(account, message.senderId, ctx.log);
  const identity = buildInstagramDirectDmIdentity({
    accountId: account.accountId,
    senderId: message.senderId,
    recipientIgUserId: account.config.igUserId,
    messageId: message.messageId,
  });
  const runtime = getInstagramRuntime();
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: identity.accountId,
    peer: identity.peer,
  });
  await reactToPassiveMessage(active, message, route.sessionKey);
  const suppressionReason = message.passiveShareOnly
    ? 'passive-share-only'
    : isReactionOnlyText(message.text)
      ? 'reaction-only'
      : isStandaloneUrl(message.text)
        ? 'standalone-url'
        : isConfirmedHumanTakeoverActive(active, message.senderId)
          ? 'human-takeover-active'
          : undefined;
  if (suppressionReason) {
    ctx.log?.info?.(
      `[instagram] suppressed inbound message reason=${suppressionReason} accountId=${account.accountId} senderHash=${redactInstagramId(message.senderId)} messageHash=${redactInstagramId(message.messageId)}`,
    );
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks?.('message_received')) {
      const mediaUrls = message.media.map((item) => item.url);
      const canonical = {
        from: identity.senderAddress,
        to: identity.recipientAddress,
        content: message.text,
        body: message.text,
        bodyForAgent: message.text,
        timestamp: message.timestamp,
        channelId: CHANNEL_ID,
        accountId: route.accountId ?? identity.accountId,
        conversationId: identity.threadId,
        sessionKey: route.sessionKey,
        messageId: identity.messageId,
        senderId: identity.senderId,
        senderUsername,
        provider: CHANNEL_ID,
        surface: CHANNEL_ID,
        threadId: identity.threadId,
        mediaUrl: mediaUrls[0],
        mediaUrls,
        mediaTypes: message.media.map((item) => item.type),
        originatingChannel: CHANNEL_ID,
        originatingTo: identity.originatingTo,
        isGroup: false,
      };
      const inboundHookApi = hookRuntime as any;
      inboundHookApi.fireAndForgetHook(
        Promise.resolve(
          hookRunner.runMessageReceived(
            inboundHookApi.toPluginMessageReceivedEvent(canonical),
            inboundHookApi.toPluginMessageContext(canonical),
          ),
        ),
        'instagram: message_received plugin hook failed',
      );
    }
    return;
  }
  const commandAuthorized = shouldComputeCommandAuthorized(message.text, ctx.cfg) ? true : undefined;
  const mediaUrls = message.media.map((item) => item.url);

  return dispatchInboundDirectDmWithRuntime({
    cfg: ctx.cfg,
    runtime,
    channel: CHANNEL_ID,
    channelLabel: 'Instagram',
    accountId: identity.accountId,
    peer: identity.peer,
    senderId: identity.senderId,
    senderAddress: identity.senderAddress,
    recipientAddress: identity.recipientAddress,
    conversationLabel: senderUsername ? `@${senderUsername}` : identity.senderId,
    rawBody: message.text,
    messageId: identity.messageId,
    timestamp: message.timestamp,
    commandAuthorized,
    provider: CHANNEL_ID,
    surface: CHANNEL_ID,
    originatingTo: identity.originatingTo,
    extraContext: {
      ...(senderUsername ? { SenderUsername: senderUsername } : {}),
      ...(mediaUrls[0] ? { MediaUrl: mediaUrls[0] } : {}),
      ...(mediaUrls.length ? { MediaUrls: mediaUrls } : {}),
      ...(message.media.length ? { InstagramAttachmentTypes: message.media.map((item) => item.type) } : {}),
      ...(message.conversationId ? { InstagramConversationId: message.conversationId } : {}),
    },
    deliver: async (payload: any) => {
      if (!payload?.text) return {};
      if (isConfirmedHumanTakeoverActive(active, message.senderId)) {
        ctx.log?.info?.(
          `[instagram] suppressed generated reply after human takeover accountId=${account.accountId} senderHash=${redactInstagramId(message.senderId)}`,
        );
        return {};
      }
      const firstContact = account.config.firstContact;
      if (firstContact && firstContactStore.claim(account.accountId, message.senderId)) {
        const locale = message.languageText
          ? (await detectInstagramMessageLocale(message.languageText)) ||
            (await detectInstagramMessageLocale(payload.text))
          : undefined;
        const firstContactMessage = resolveInstagramFirstContactMessage(firstContact, locale);
        if (isConfirmedHumanTakeoverActive(active, message.senderId)) {
          firstContactStore.release(account.accountId, message.senderId);
          ctx.log?.info?.(
            `[instagram] suppressed first-contact message after human takeover accountId=${account.accountId} senderHash=${redactInstagramId(message.senderId)}`,
          );
          return {};
        }
        try {
          const intro = await sendAutomatedInstagramText(active, message.senderId, {
            igUserId: account.config.igUserId,
            recipientId: message.senderId,
            text: firstContactMessage,
            accessToken: account.accessToken,
            messagePrefix: account.config.messagePrefix,
          });
          recordAutomatedMessageReceipts(active, intro);
          emitInstagramMessageSentHook({
            to: message.senderId,
            content: firstContactMessage,
            success: true,
            accountId: account.accountId,
            messageId: intro.messageId,
            sessionKey: route.sessionKey,
            sentBy: 'bot',
          });
        } catch (error) {
          emitInstagramMessageSentHook({
            to: message.senderId,
            content: firstContactMessage,
            success: false,
            error: String(error),
            accountId: account.accountId,
            sessionKey: route.sessionKey,
            sentBy: 'bot',
          });
          firstContactStore.release(account.accountId, message.senderId);
          throw error;
        }
      }
      if (isConfirmedHumanTakeoverActive(active, message.senderId)) {
        ctx.log?.info?.(
          `[instagram] suppressed generated reply after human takeover accountId=${account.accountId} senderHash=${redactInstagramId(message.senderId)}`,
        );
        return {};
      }
      try {
        const result = await sendAutomatedInstagramText(active, message.senderId, {
          igUserId: account.config.igUserId,
          recipientId: message.senderId,
          text: payload.text,
          accessToken: account.accessToken,
          messagePrefix: account.config.messagePrefix,
        });
        recordAutomatedMessageReceipts(active, result);
        emitInstagramMessageSentHook({
          to: message.senderId,
          content: payload.text,
          success: true,
          accountId: account.accountId,
          messageId: result.messageId,
          sessionKey: route.sessionKey,
          sentBy: 'bot',
        });
        return {
          messageId: result.messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: CHANNEL_ID, messageId: result.messageId, conversationId: message.senderId }],
            kind: 'text',
          }),
        };
      } catch (err) {
        emitInstagramMessageSentHook({
          to: message.senderId,
          content: payload.text,
          success: false,
          error: String(err),
          accountId: account.accountId,
          sessionKey: route.sessionKey,
          sentBy: 'bot',
        });
        throw err;
      }
    },
    onRecordError: (error: unknown) => {
      ctx.log?.error?.(`[instagram] failed to record inbound message ${message.messageId}: ${String(error)}`);
    },
    onDispatchError: (error: unknown, info: { kind?: string }) => {
      ctx.log?.error?.(
        `[instagram] reply dispatch failed messageId=${message.messageId} kind=${info?.kind || 'unknown'}: ${String(error)}`,
      );
    },
  });
}

async function dispatchComment(message: InstagramInboundComment) {
  const active = startedAccounts.get(message.accountId);
  if (!active) throw new Error(`Instagram account "${message.accountId}" is not running`);
  const { account, ctx, conversationStateStore } = active;
  if (account.config.comments?.enabled !== true) return;

  let claimed: boolean;
  try {
    claimed = conversationStateStore.claimComment(account.accountId, message.commentId);
  } catch (error) {
    ctx.log?.error?.(
      `[instagram] comment idempotency claim failed accountId=${account.accountId} commentHash=${redactInstagramId(message.commentId)}: ${String(error)}`,
    );
    return;
  }
  if (!claimed) {
    ctx.log?.info?.(
      `[instagram] ignored duplicate comment accountId=${account.accountId} commentHash=${redactInstagramId(message.commentId)}`,
    );
    return;
  }

  const identity = buildInstagramDirectDmIdentity({
    accountId: account.accountId,
    senderId: message.commenterId,
    recipientIgUserId: account.config.igUserId,
    messageId: message.commentId,
  });
  const runtime = getInstagramRuntime();
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: identity.accountId,
    peer: identity.peer,
  });
  const keywordPrivateReply = matchInstagramKeywordPrivateReply(
    account.config.comments.keywordPrivateReplies,
    message.text,
  );
  if (keywordPrivateReply) {
    try {
      const privateReply = await sendAutomatedInstagramPrivateReply(active, message.commenterId, {
        igUserId: account.config.igUserId,
        commentId: message.commentId,
        text: keywordPrivateReply.reply,
        accessToken: account.accessToken,
      });
      emitInstagramMessageSentHook({
        to: message.commenterId,
        content: keywordPrivateReply.reply,
        success: true,
        accountId: account.accountId,
        messageId: privateReply.messageId,
        sessionKey: route.sessionKey,
        sentBy: 'bot',
      });
    } catch (error) {
      emitInstagramMessageSentHook({
        to: message.commenterId,
        content: keywordPrivateReply.reply,
        success: false,
        error: String(error),
        accountId: account.accountId,
        sessionKey: route.sessionKey,
        sentBy: 'bot',
      });
      ctx.log?.warn?.(
        `[instagram] keyword private reply failed accountId=${account.accountId} commentHash=${redactInstagramId(message.commentId)} locale=${keywordPrivateReply.locale}: ${String(error)}`,
      );
    }
    return;
  }
  const commandAuthorized = shouldComputeCommandAuthorized(message.text, ctx.cfg) ? true : undefined;
  const inboundText = `(Comment on post) ${message.text}`;
  let localePromise: Promise<string | undefined> | undefined;
  const resolveLocale = () => {
    localePromise ??= detectInstagramMessageLocale(message.text);
    return localePromise;
  };
  let replyDelivery: Promise<any> | undefined;

  await dispatchInboundDirectDmWithRuntime({
    cfg: ctx.cfg,
    runtime,
    channel: CHANNEL_ID,
    channelLabel: 'Instagram',
    accountId: identity.accountId,
    peer: identity.peer,
    senderId: identity.senderId,
    senderAddress: identity.senderAddress,
    recipientAddress: identity.recipientAddress,
    conversationLabel: message.commenterUsername
      ? `@${message.commenterUsername}`
      : identity.senderId,
    rawBody: inboundText,
    messageId: identity.messageId,
    timestamp: message.timestamp,
    commandAuthorized,
    provider: CHANNEL_ID,
    surface: CHANNEL_ID,
    originatingTo: identity.originatingTo,
    extraContext: {
      InstagramInteraction: 'public comment',
      InstagramPublicComment: true,
      InstagramCommentId: message.commentId,
      InstagramMediaId: message.mediaId,
      ...(message.commenterUsername ? { SenderUsername: message.commenterUsername } : {}),
    },
    deliver: async (payload: any) => {
      if (!payload?.text) return {};
      if (isConfirmedHumanTakeoverActive(active, message.commenterId)) {
        ctx.log?.info?.(
          `[instagram] suppressed generated comment reply after human takeover accountId=${account.accountId} senderHash=${redactInstagramId(message.commenterId)}`,
        );
        return {};
      }
      if (replyDelivery) return replyDelivery;
      replyDelivery = (async () => {
        let privateReply;
        try {
          privateReply = await sendAutomatedInstagramPrivateReply(active, message.commenterId, {
            igUserId: account.config.igUserId,
            commentId: message.commentId,
            text: payload.text,
            accessToken: account.accessToken,
            messagePrefix: account.config.messagePrefix,
          });
          emitInstagramMessageSentHook({
            to: message.commenterId,
            content: payload.text,
            success: true,
            accountId: account.accountId,
            messageId: privateReply.messageId,
            sessionKey: route.sessionKey,
            sentBy: 'bot',
          });
        } catch (error) {
          emitInstagramMessageSentHook({
            to: message.commenterId,
            content: payload.text,
            success: false,
            error: String(error),
            accountId: account.accountId,
            sessionKey: route.sessionKey,
            sentBy: 'bot',
          });
          throw error;
        }

        const pointer = instagramPrivateReplyPointer(await resolveLocale());
        if (isConfirmedHumanTakeoverActive(active, message.commenterId)) {
          ctx.log?.info?.(
            `[instagram] suppressed public comment pointer after human takeover accountId=${account.accountId} senderHash=${redactInstagramId(message.commenterId)}`,
          );
          return {
            messageId: privateReply.messageId,
            receipt: createMessageReceiptFromOutboundResults({
              results: [{
                channel: CHANNEL_ID,
                messageId: privateReply.messageId,
                conversationId: message.commenterId,
              }],
              kind: 'text',
            }),
          };
        }
        try {
          const publicReply = await sendInstagramCommentReply({
            commentId: message.commentId,
            text: pointer,
            accessToken: account.accessToken,
          });
          emitInstagramMessageSentHook({
            to: message.commenterId,
            content: pointer,
            success: true,
            accountId: account.accountId,
            messageId: publicReply.commentId,
            sessionKey: route.sessionKey,
            sentBy: 'bot',
          });
        } catch (error) {
          emitInstagramMessageSentHook({
            to: message.commenterId,
            content: pointer,
            success: false,
            error: String(error),
            accountId: account.accountId,
            sessionKey: route.sessionKey,
            sentBy: 'bot',
          });
          throw error;
        }

        return {
          messageId: privateReply.messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{
              channel: CHANNEL_ID,
              messageId: privateReply.messageId,
              conversationId: message.commenterId,
            }],
            kind: 'text',
          }),
        };
      })();
      return replyDelivery;
    },
    onRecordError: (error: unknown) => {
      ctx.log?.error?.(`[instagram] failed to record inbound comment ${message.commentId}: ${String(error)}`);
    },
    onDispatchError: (error: unknown, info: { kind?: string }) => {
      ctx.log?.error?.(
        `[instagram] comment reply dispatch failed commentId=${message.commentId} kind=${info?.kind || 'unknown'}: ${String(error)}`,
      );
    },
  });

  if (replyDelivery) {
    await replyDelivery;
    return;
  }

  if (
    isPositivePassiveComment(message.text) &&
    !isConfirmedHumanTakeoverActive(active, message.commenterId)
  ) {
    const thanks = instagramPublicThanks(await resolveLocale());
    try {
      const publicReply = await sendInstagramCommentReply({
        commentId: message.commentId,
        text: thanks,
        accessToken: account.accessToken,
      });
      emitInstagramMessageSentHook({
        to: message.commenterId,
        content: thanks,
        success: true,
        accountId: account.accountId,
        messageId: publicReply.commentId,
        sessionKey: route.sessionKey,
        sentBy: 'bot',
      });
    } catch (error) {
      emitInstagramMessageSentHook({
        to: message.commenterId,
        content: thanks,
        success: false,
        error: String(error),
        accountId: account.accountId,
        sessionKey: route.sessionKey,
        sentBy: 'bot',
      });
      throw error;
    }
  }
}

async function reconcileAutomatedAccountMessage(
  active: StartedInstagramAccount,
  message: InstagramAccountMessage,
): Promise<'automated' | 'human' | 'unresolved'> {
  const { account, conversationStateStore } = active;
  if (isFallbackAutomatedMessage(account.accountId, message.messageId)) return 'automated';
  if (isFallbackAmbiguousAutomatedText(account.accountId, message.peerId, message.text)) return 'unresolved';
  try {
    if (conversationStateStore.isAutomatedMessage(account.accountId, message.messageId)) return 'automated';
    if (conversationStateStore.isAmbiguousAutomatedText(
      account.accountId,
      message.peerId,
      message.text,
    )) return 'unresolved';
  } catch (error) {
    logConversationStateError(active, 'echo read', error);
    markFallbackHumanTakeover(message);
    return 'unresolved';
  }
  if (inFlightSendCount(account.accountId, message.peerId) === 0) return 'human';

  const deadline = Date.now() + ACCOUNT_ECHO_RECONCILE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isFallbackAutomatedMessage(account.accountId, message.messageId)) return 'automated';
    if (isFallbackAmbiguousAutomatedText(account.accountId, message.peerId, message.text)) return 'unresolved';
    try {
      if (conversationStateStore.isAutomatedMessage(account.accountId, message.messageId)) return 'automated';
      if (conversationStateStore.isAmbiguousAutomatedText(
        account.accountId,
        message.peerId,
        message.text,
      )) return 'unresolved';
    } catch (error) {
      logConversationStateError(active, 'echo read', error);
      markFallbackHumanTakeover(message);
      return 'unresolved';
    }
    if (inFlightSendCount(account.accountId, message.peerId) === 0) return 'human';
    await new Promise<void>((resolve) => setTimeout(resolve, ACCOUNT_ECHO_RECONCILE_POLL_MS));
  }
  return 'unresolved';
}

async function dispatchAccountMessage(message: InstagramAccountMessage) {
  const active = startedAccounts.get(message.accountId);
  if (!active) throw new Error(`Instagram account "${message.accountId}" is not running`);
  addProvisionalAccountMessage(message.accountId, message.peerId, message.messageId);
  try {
    await dispatchReservedAccountMessage(active, message);
  } finally {
    removeProvisionalAccountMessage(message.accountId, message.peerId, message.messageId);
  }
}

async function dispatchReservedAccountMessage(
  active: StartedInstagramAccount,
  message: InstagramAccountMessage,
) {
  const { account, ctx, conversationStateStore } = active;

  const classification = await reconcileAutomatedAccountMessage(active, message);
  if (classification === 'automated') {
    ctx.log?.info?.(
      `[instagram] reconciled automated echo accountId=${account.accountId} messageHash=${redactInstagramId(message.messageId)}`,
    );
    return;
  }
  if (classification === 'unresolved') {
    try {
      conversationStateStore.recordHumanMessage(
        account.accountId,
        message.peerId,
        message.messageId,
        message.timestamp,
      );
    } catch (error) {
      logConversationStateError(active, 'unresolved account message write', error);
      markFallbackHumanTakeover(message);
      markFallbackHumanMessage(message);
    }
    ctx.log?.warn?.(
      `[instagram] account message left unresolved; automation paused accountId=${account.accountId} messageHash=${redactInstagramId(message.messageId)}`,
    );
    return;
  }
  if (isFallbackHumanMessage(account.accountId, message.messageId)) {
    ctx.log?.info?.(
      `[instagram] ignored duplicate account message accountId=${account.accountId} messageHash=${redactInstagramId(message.messageId)}`,
    );
    return;
  }

  try {
    const recordedHumanMessage = conversationStateStore.recordHumanMessage(
      account.accountId,
      message.peerId,
      message.messageId,
      message.timestamp,
    );
    if (!recordedHumanMessage) {
      ctx.log?.info?.(
        `[instagram] ignored duplicate account message accountId=${account.accountId} messageHash=${redactInstagramId(message.messageId)}`,
      );
      return;
    }
  } catch (error) {
    logConversationStateError(active, 'human takeover write', error);
    markFallbackHumanTakeover(message);
    markFallbackHumanMessage(message);
  }
  const identity = buildInstagramDirectDmIdentity({
    accountId: account.accountId,
    senderId: message.peerId,
    recipientIgUserId: account.config.igUserId,
    messageId: message.messageId,
  });
  const runtime = getInstagramRuntime();
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: identity.accountId,
    peer: identity.peer,
  });
  emitInstagramMessageSentHook({
    to: message.peerId,
    content: message.text,
    success: true,
    accountId: account.accountId,
    messageId: message.messageId,
    sessionKey: route.sessionKey,
    sentBy: 'human',
  });
  ctx.log?.info?.(
    `[instagram] human takeover activated accountId=${account.accountId} peerHash=${redactInstagramId(message.peerId)} messageHash=${redactInstagramId(message.messageId)}`,
  );
}

async function dispatchWebhookMessage(message: InstagramWebhookMessage) {
  if (message.kind === 'account') return dispatchAccountMessage(message);
  if (message.kind === 'comment') return dispatchComment(message);
  return dispatchInbound(message);
}

export const instagramPlugin = createChatChannelPlugin<ResolvedInstagramAccount>({
  base: {
    id: CHANNEL_ID,
    message: createChannelMessageAdapterFromOutbound({
      id: CHANNEL_ID,
      outbound: instagramOutbound,
    }),
    config: {
      listAccountIds: (cfg: any) => listInstagramAccountIds(cfg),
      resolveAccount: (cfg: any, accountId?: string) => resolveInstagramAccount(cfg, accountId),
      defaultAccountId: (cfg: any) => resolveDefaultInstagramAccountId(cfg),
      setAccountEnabled: ({ cfg }: { cfg: any }) => cfg,
      deleteAccount: ({ cfg }: { cfg: any }) => cfg,
    },
    resolveAccount: ({ cfg, accountId }: { cfg: any; accountId?: string }) =>
      resolveInstagramAccount(cfg, accountId),
    security: instagramSecurity,
    messaging: {
      normalizeTarget: (target: string) => {
        const value = target.trim();
        return /^\d+$/.test(value) ? value : undefined;
      },
      targetResolver: {
        looksLikeId: (id: string | undefined) => Boolean(id && /^\d+$/.test(id.trim())),
        hint: '<Instagram-scoped sender id>',
      },
    },
    setup: {
      resolveChannelSetupStatus: ({ cfg }: { cfg: any }) => setupStatus(cfg),
    },
    status: {
      resolveAccountStatus: async ({ account }: { account: ResolvedInstagramAccount }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: true,
        extra: {
          igUserId: account.config.igUserId,
          dmPolicy: account.config.dmPolicy,
          allowFrom: account.config.allowFrom,
          storyMentionReaction: account.config.storyMentionReaction,
          mediaShareReaction: account.config.mediaShareReaction,
          commentsEnabled: account.config.comments.enabled,
          tokenEnvVar: account.tokenEnvVar,
        },
      }),
      resolveAccountState: ({ configured }: { configured: boolean }) => configured ? 'ready' : 'not configured',
    },
    gateway: {
      startAccount: async (ctx: any) => {
        const account = ctx.account as ResolvedInstagramAccount;
        const channelConfig = validateInstagramChannelConfig(
          ctx.cfg,
          (message) => (ctx.log?.warn || ctx.log?.info)?.(message),
        );
        const firstContactStore = openFirstContactStore(
          resolveFirstContactStateDir(channelConfig?.firstContactStateDir),
        );
        const conversationStateStore = openInstagramConversationStateStore(
          resolveFirstContactStateDir(channelConfig?.firstContactStateDir),
        );
        startedAccounts.set(account.accountId, {
          account,
          ctx,
          firstContactStore,
          conversationStateStore,
        });

        if (!unregisterWebhook) {
          const handler = createInstagramWebhookHandler(
            {
              appSecret: account.appSecret,
              verifyToken: account.verifyToken,
              accounts: webhookAccounts(ctx.cfg),
              log: {
                info: (message) => ctx.log?.info?.(message),
                warn: (message) => (ctx.log?.warn || ctx.log?.info)?.(message),
                error: (message) => ctx.log?.error?.(message),
              },
            },
            dispatchWebhookMessage,
          );
          unregisterWebhook = registerPluginHttpRoute({
            path: WEBHOOK_PATH,
            auth: 'plugin',
            replaceExisting: true,
            pluginId: CHANNEL_ID,
            handler,
          });
        }

        ctx.log?.info?.(
          `[${account.accountId}] Instagram channel started (igUserIdHash=${redactInstagramId(account.config.igUserId)})`,
        );
        if (ctx.abortSignal && !ctx.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        startedAccounts.delete(account.accountId);
        firstContactStore.close();
        conversationStateStore.close();
        if (startedAccounts.size === 0 && unregisterWebhook) {
          unregisterWebhook();
          unregisterWebhook = null;
        }
        ctx.log?.info?.(`[${account.accountId}] Instagram channel stopped`);
      },
    },
    agentPrompt: {
      messageToolHints: () => [
        '',
        'The user is in an Instagram direct message. Keep replies concise and plain-text friendly.',
        'This channel can send text replies only.',
      ],
    },
  },
  outbound: instagramOutbound,
});
