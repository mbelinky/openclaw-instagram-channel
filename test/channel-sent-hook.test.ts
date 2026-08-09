import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchInbound: undefined as undefined | ((message: any) => Promise<any>),
  createInstagramWebhookHandler: vi.fn(),
  dispatchInboundDirectDmWithRuntime: vi.fn(),
  registerPluginHttpRoute: vi.fn(() => vi.fn()),
  sendInstagramText: vi.fn(),
  sendInstagramReaction: vi.fn(),
  sendInstagramPrivateReply: vi.fn(),
  sendInstagramCommentReply: vi.fn(),
  emitInstagramMessageSentHook: vi.fn(),
  lookupInstagramUserProfile: vi.fn(),
  detectInstagramMessageLocale: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  resolveAgentRoute: vi.fn(),
  runMessageReceived: vi.fn(),
  hookCheck: vi.fn(),
  fireAndForgetHook: vi.fn((promise: Promise<unknown>) => {
    void promise;
  }),
}));

vi.mock('openclaw/plugin-sdk/channel-core', () => ({
  createChatChannelPlugin: (params: any) => params,
}));

vi.mock('openclaw/plugin-sdk/channel-outbound', () => ({
  createChannelMessageAdapterFromOutbound: (params: any) => params,
  createMessageReceiptFromOutboundResults: (params: any) => params,
}));

vi.mock('openclaw/plugin-sdk/channel-policy', () => ({
  createRestrictSendersChannelSecurity: (params: any) => params,
}));

vi.mock('openclaw/plugin-sdk/channel-send-result', () => ({
  createAttachedChannelResultAdapter: (params: any) => params,
}));

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchInboundDirectDmWithRuntime: mocks.dispatchInboundDirectDmWithRuntime,
}));

vi.mock('openclaw/plugin-sdk/command-auth', () => ({
  shouldComputeCommandAuthorized: () => false,
}));

vi.mock('openclaw/plugin-sdk/hook-runtime', () => ({
  fireAndForgetHook: mocks.fireAndForgetHook,
  toPluginMessageReceivedEvent: (canonical: any) => ({
    from: canonical.from,
    content: canonical.content,
    timestamp: canonical.timestamp,
    threadId: canonical.threadId,
    messageId: canonical.messageId,
    senderId: canonical.senderId,
    sessionKey: canonical.sessionKey,
    metadata: {
      senderUsername: canonical.senderUsername,
      mediaUrl: canonical.mediaUrl,
      mediaUrls: canonical.mediaUrls,
      mediaTypes: canonical.mediaTypes,
    },
  }),
  toPluginMessageContext: (canonical: any) => ({
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
    sessionKey: canonical.sessionKey,
    messageId: canonical.messageId,
    senderId: canonical.senderId,
  }),
}));

vi.mock('openclaw/plugin-sdk/plugin-runtime', () => ({
  getGlobalHookRunner: () => ({
    hasHooks: mocks.hookCheck,
    runMessageReceived: mocks.runMessageReceived,
  }),
}));

vi.mock('openclaw/plugin-sdk/webhook-ingress', () => ({
  registerPluginHttpRoute: mocks.registerPluginHttpRoute,
}));

vi.mock('openclaw/plugin-sdk/runtime-store', () => ({
  createPluginRuntimeStore: () => ({
    setRuntime: vi.fn(),
    getRuntime: vi.fn(() => ({
      channel: {
        routing: {
          resolveAgentRoute: mocks.resolveAgentRoute,
        },
      },
    })),
  }),
}));

vi.mock('../src/instagram/send.js', () => ({
  InstagramSendError: class InstagramSendError extends Error {
    deliveryUnknown = false;
  },
  sendInstagramText: mocks.sendInstagramText,
  sendInstagramReaction: mocks.sendInstagramReaction,
  sendInstagramPrivateReply: mocks.sendInstagramPrivateReply,
  sendInstagramCommentReply: mocks.sendInstagramCommentReply,
}));

vi.mock('../src/instagram/profile.js', () => ({
  lookupInstagramUserProfile: mocks.lookupInstagramUserProfile,
}));

vi.mock('../src/instagram/first-contact-locale.js', () => ({
  detectInstagramMessageLocale: mocks.detectInstagramMessageLocale,
}));

vi.mock('../src/instagram/webhook.js', () => ({
  createInstagramWebhookHandler: mocks.createInstagramWebhookHandler,
  redactInstagramId: () => 'redacted',
}));

vi.mock('../src/openclaw/sent-hook.js', () => ({
  emitInstagramMessageSentHook: mocks.emitInstagramMessageSentHook,
}));

import { instagramPlugin } from '../src/openclaw/channel.js';

const account = {
  accountId: 'studio',
  name: 'Studio',
  enabled: true,
  config: {
    igUserId: '17841400000000000',
    dmPolicy: 'open',
    allowFrom: [],
    storyMentionReaction: true,
    mediaShareReaction: true,
    comments: {
      enabled: false,
      keywordPrivateReplies: [] as Array<{
        triggers: Record<string, string[]>;
        replies: Record<string, string>;
      }>,
    },
    firstContact: undefined as { messages: Record<string, string>; fallbackLocale: string } | undefined,
  },
  accessToken: 'token',
  appSecret: 'app-secret',
  verifyToken: 'verify-token',
  tokenEnvVar: 'INSTAGRAM_ACCESS_TOKEN_STUDIO',
};

const cfg = {
  channels: {
    instagram: {
      enabled: true,
      firstContactStateDir: undefined as string | undefined,
      accounts: {
        studio: account.config,
      },
    },
  },
};

async function withStartedAccount(run: () => Promise<void>) {
  const abortController = new AbortController();
  const startPromise = (instagramPlugin as any).base.gateway.startAccount({
    account,
    cfg,
    abortSignal: abortController.signal,
    log: { info: mocks.info, warn: mocks.warn, error: mocks.error },
  });
  try {
    await vi.waitFor(() => expect(mocks.dispatchInbound).toBeTypeOf('function'));
    await run();
  } finally {
    abortController.abort();
    await startPromise;
  }
}

describe('Instagram inbound reply sent hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('INSTAGRAM_ACCESS_TOKEN_STUDIO', 'token');
    vi.stubEnv('INSTAGRAM_APP_SECRET', 'app-secret');
    vi.stubEnv('INSTAGRAM_VERIFY_TOKEN', 'verify-token');
    mocks.dispatchInbound = undefined;
    cfg.channels.instagram.firstContactStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'instagram-channel-first-contact-'),
    );
    mocks.lookupInstagramUserProfile.mockResolvedValue({ username: 'example' });
    mocks.detectInstagramMessageLocale.mockResolvedValue('en');
    mocks.sendInstagramReaction.mockResolvedValue({ recipientId: '112233445' });
    mocks.hookCheck.mockImplementation((name) => name === 'message_received');
    mocks.resolveAgentRoute.mockImplementation(({ peer }) => ({
      agentId: 'example-agent',
      accountId: 'studio',
      sessionKey: `agent:example:instagram:studio:direct:${peer.id}`,
    }));
    mocks.runMessageReceived.mockResolvedValue(undefined);
    mocks.createInstagramWebhookHandler.mockImplementation((_options, dispatch) => {
      mocks.dispatchInbound = dispatch;
      return vi.fn();
    });
    mocks.dispatchInboundDirectDmWithRuntime.mockImplementation(async (params) =>
      params.deliver({ text: 'Reply text' })
    );
  });

  it('keeps the channel prompt transport-only and lets the agent interpret normal text', () => {
    const hints = (instagramPlugin as any).base.agentPrompt.messageToolHints().join(' ');

    expect(hints).toContain('Instagram direct message');
    expect(hints).not.toContain('MK Pottery Studio');
    expect(hints).not.toContain('NO_REPLY');
    expect(hints).not.toContain('explicit question');
    expect(hints).not.toContain('clear request');
  });

  it('records passive story shares without dispatching or claiming the localized first-contact introduction', async () => {
    account.config.firstContact = {
      messages: { en: 'I am Example Bot.' },
      fallbackLocale: 'en',
    };
    mocks.sendInstagramText
      .mockResolvedValueOnce({ messageId: 'mid.intro' })
      .mockResolvedValueOnce({ messageId: 'mid.reply' });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.story',
        timestamp: 1710000000000,
        text: '(Mentioned us in their Instagram story)',
        media: [{
          type: 'story_mention',
          url: 'https://cdn.example.test/story.jpg',
        }],
        passiveShareOnly: true,
      });

      expect(mocks.runMessageReceived).toHaveBeenCalledOnce();
      expect(mocks.runMessageReceived.mock.calls[0]?.[0]).toMatchObject({
        content: '(Mentioned us in their Instagram story)',
        threadId: '112233445',
        senderId: '112233445',
        sessionKey: 'agent:example:instagram:studio:direct:112233445',
        metadata: {
          senderUsername: 'example',
          mediaUrl: 'https://cdn.example.test/story.jpg',
          mediaUrls: ['https://cdn.example.test/story.jpg'],
          mediaTypes: ['story_mention'],
        },
      });
      expect(mocks.runMessageReceived.mock.calls[0]?.[1]).toMatchObject({
        channelId: 'instagram',
        accountId: 'studio',
        conversationId: '112233445',
        sessionKey: 'agent:example:instagram:studio:direct:112233445',
        senderId: '112233445',
      });
      expect(mocks.resolveAgentRoute).toHaveBeenCalledWith({
        cfg,
        channel: 'instagram',
        accountId: 'studio',
        peer: { kind: 'direct', id: '112233445' },
      });
      expect(mocks.fireAndForgetHook).toHaveBeenCalledOnce();
      expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
      expect(mocks.sendInstagramText).not.toHaveBeenCalled();
      expect(mocks.sendInstagramReaction).toHaveBeenCalledWith({
        igUserId: account.config.igUserId,
        recipientId: '112233445',
        messageId: 'mid.story',
        accessToken: 'token',
      });
      expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
        to: '112233445',
        content: '(❤️ story mention)',
        success: true,
        accountId: 'studio',
        sessionKey: 'agent:example:instagram:studio:direct:112233445',
        sentBy: 'bot',
      });
      expect(mocks.info).toHaveBeenCalledWith(
        '[instagram] suppressed inbound message reason=passive-share-only accountId=studio senderHash=redacted messageHash=redacted',
      );
      const logLines = mocks.info.mock.calls.flat().join(' ');
      expect(logLines).not.toContain('112233445');
      expect(logLines).not.toContain('mid.story');

      await mocks.dispatchInbound?.({
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.normal',
        timestamp: 1710000000001,
        text: 'Hello',
        languageText: 'Hello',
        media: [],
        passiveShareOnly: false,
      });
    });

    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledOnce();
    expect(mocks.sendInstagramText.mock.calls.map(([params]) => params.text)).toEqual([
      'I am Example Bot.',
      'Reply text',
    ]);
    expect(mocks.resolveAgentRoute).toHaveBeenCalledTimes(2);
  });

  it('logs a story reaction failure without emitting a sent hook or changing suppression', async () => {
    const failure = new Error('Meta rejected the fake message id');
    mocks.sendInstagramReaction.mockRejectedValue(failure);

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.story.failure',
        text: '(Mentioned us in their Instagram story)',
        media: [{
          type: 'story_mention',
          url: 'https://cdn.example.test/story.jpg',
        }],
        passiveShareOnly: true,
      });
    });

    expect(mocks.runMessageReceived).toHaveBeenCalledOnce();
    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[instagram\] story mention reaction failed accountId=studio senderHash=redacted messageHash=redacted: Error: Meta rejected the fake message id$/,
      ),
    );
    expect(mocks.warn.mock.calls.flat().join(' ')).not.toContain('token');
  });

  it('can disable story mention reactions without changing record-only handling', async () => {
    account.config.storyMentionReaction = false;

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.story.disabled',
        text: '(Mentioned us in their Instagram story)',
        media: [{
          type: 'story_mention',
          url: 'https://cdn.example.test/story.jpg',
        }],
        passiveShareOnly: true,
      });
    });

    expect(mocks.runMessageReceived).toHaveBeenCalledOnce();
    expect(mocks.sendInstagramReaction).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalled();
  });

  it('hearts a recognized shared reel and records only the confirmed reaction', async () => {
    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.shared.reel',
        text: '(Shared a reel)',
        media: [{
          type: 'ig_reel',
          url: 'https://cdn.example.test/shared-reel',
        }],
        passiveShareOnly: true,
        mediaShareKind: 'recognized',
      });
    });

    expect(mocks.sendInstagramReaction).toHaveBeenCalledOnce();
    expect(mocks.sendInstagramReaction).toHaveBeenCalledWith({
      igUserId: account.config.igUserId,
      recipientId: '112233445',
      messageId: 'mid.shared.reel',
      accessToken: 'token',
    });
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '112233445',
      content: '(❤️ shared reel/post)',
      success: true,
      accountId: 'studio',
      sessionKey: 'agent:example:instagram:studio:direct:112233445',
      sentBy: 'bot',
    });
    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
  });

  it('hearts text-less untyped media without changing its existing agent path', async () => {
    mocks.dispatchInboundDirectDmWithRuntime.mockResolvedValue({});

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.shared.untyped',
        text: '(Instagram media message)',
        media: [{
          type: 'file',
          url: 'https://cdn.example.test/untyped-reel',
        }],
        passiveShareOnly: false,
        mediaShareKind: 'untyped',
      });
    });

    expect(mocks.sendInstagramReaction).toHaveBeenCalledOnce();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '112233445',
      content: '(❤️ shared media)',
      success: true,
      accountId: 'studio',
      sessionKey: 'agent:example:instagram:studio:direct:112233445',
      sentBy: 'bot',
    });
    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledOnce();
  });

  it('does not heart media messages that contain user text', async () => {
    mocks.dispatchInboundDirectDmWithRuntime.mockResolvedValue({});

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.shared.with-text',
        text: 'Can you make something like this?',
        languageText: 'Can you make something like this?',
        media: [{
          type: 'ig_reel',
          url: 'https://cdn.example.test/shared-reel-with-text',
        }],
        passiveShareOnly: false,
      });
    });

    expect(mocks.sendInstagramReaction).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalled();
    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledOnce();
  });

  it('does nothing for shared media when mediaShareReaction is disabled', async () => {
    account.config.mediaShareReaction = false;

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.shared.disabled',
        text: '(Shared a post)',
        media: [{
          type: 'share',
          url: 'https://cdn.example.test/shared-post',
        }],
        passiveShareOnly: true,
        mediaShareKind: 'recognized',
      });
    });

    expect(mocks.runMessageReceived).toHaveBeenCalledOnce();
    expect(mocks.sendInstagramReaction).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalled();
    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
  });

  it('sends at most one passive reaction for duplicate message ids', async () => {
    const message = {
      kind: 'inbound' as const,
      accountId: 'studio',
      senderId: '112233445',
      threadId: '112233445',
      recipientIgUserId: account.config.igUserId,
      messageId: 'mid.shared.duplicate',
      text: '(Shared a reel)',
      media: [{
        type: 'reel',
        url: 'https://cdn.example.test/shared-duplicate',
      }],
      passiveShareOnly: true,
      mediaShareKind: 'recognized' as const,
    };

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.(message);
      await mocks.dispatchInbound?.(message);
    });

    expect(mocks.sendInstagramReaction).toHaveBeenCalledOnce();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] ignored duplicate reaction accountId=studio messageHash=redacted',
    );
  });

  it('gates comments off before logging, dispatching, or sending', async () => {
    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'comment',
        accountId: 'studio',
        commenterId: '112233445',
        commenterUsername: 'clayfan',
        recipientIgUserId: account.config.igUserId,
        messageId: 'comment-disabled',
        commentId: 'comment-disabled',
        mediaId: 'media-1',
        text: 'Do you ship?',
      });
    });

    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
    expect(mocks.sendInstagramPrivateReply).not.toHaveBeenCalled();
    expect(mocks.sendInstagramCommentReply).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalled();
  });

  it('logs and routes a comment, then sends one private reply before one public pointer', async () => {
    account.config.comments.enabled = true;
    const order: string[] = [];
    mocks.dispatchInboundDirectDmWithRuntime.mockImplementation(async (params) => {
      await Promise.all([
        params.deliver({ text: 'Reply text' }),
        params.deliver({ text: 'Reply text' }),
      ]);
      return {};
    });
    mocks.sendInstagramPrivateReply.mockImplementation(async () => {
      order.push('private');
      return { messageId: 'mid.private' };
    });
    mocks.sendInstagramCommentReply.mockImplementation(async () => {
      order.push('public');
      return { commentId: 'comment.public' };
    });

    const comment = {
      kind: 'comment',
      accountId: 'studio',
      commenterId: '112233445',
      commenterUsername: 'clayfan',
      recipientIgUserId: account.config.igUserId,
      messageId: 'comment-question',
      commentId: 'comment-question',
      mediaId: 'media-1',
      text: 'Do you ship to France?',
    };
    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.(comment);
      await mocks.dispatchInbound?.(comment);
      await mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.private',
        text: 'Reply text',
        media: [],
      });
    });

    expect(order).toEqual(['private', 'public']);
    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledOnce();
    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'studio',
        peer: { kind: 'direct', id: '112233445' },
        senderId: '112233445',
        conversationLabel: '@clayfan',
        rawBody: '(Comment on post) Do you ship to France?',
        messageId: 'comment-question',
        extraContext: expect.objectContaining({
          InstagramInteraction: 'public comment',
          InstagramPublicComment: true,
          InstagramCommentId: 'comment-question',
          InstagramMediaId: 'media-1',
          SenderUsername: 'clayfan',
        }),
      }),
    );
    expect(mocks.sendInstagramPrivateReply).toHaveBeenCalledWith(expect.objectContaining({
      igUserId: account.config.igUserId,
      commentId: 'comment-question',
      text: 'Reply text',
      accessToken: 'token',
      messagePrefix: undefined,
      onPending: expect.any(Function),
      onReceipt: expect.any(Function),
    }));
    expect(mocks.sendInstagramCommentReply).toHaveBeenCalledWith({
      commentId: 'comment-question',
      text: 'We sent you a DM 🤖',
      accessToken: 'token',
    });
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenNthCalledWith(1, {
      to: '112233445',
      content: 'Reply text',
      success: true,
      accountId: 'studio',
      messageId: 'mid.private',
      sessionKey: 'agent:example:instagram:studio:direct:112233445',
      sentBy: 'bot',
    });
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenNthCalledWith(2, {
      to: '112233445',
      content: 'We sent you a DM 🤖',
      success: true,
      accountId: 'studio',
      messageId: 'comment.public',
      sessionKey: 'agent:example:instagram:studio:direct:112233445',
      sentBy: 'bot',
    });
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] ignored duplicate comment accountId=studio commentHash=redacted',
    );
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] reconciled automated echo accountId=studio messageHash=redacted',
    );
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalledWith(
      expect.objectContaining({ sentBy: 'human' }),
    );
  });

  it('sends one deterministic keyword private reply without agent dispatch across redelivery', async () => {
    account.config.comments.enabled = true;
    account.config.comments.keywordPrivateReplies = [{
      triggers: { es: ['info'], en: ['hello'], ca: ['details'] },
      replies: {
        es: 'Información: https://example.test/info',
        en: 'Information: https://example.test/info',
        ca: 'Informació: https://example.test/info',
      },
    }];
    mocks.sendInstagramPrivateReply.mockResolvedValue({ messageId: 'mid.keyword' });

    const comment = {
      kind: 'comment',
      accountId: 'studio',
      commenterId: '112233445',
      commenterUsername: 'clayfan',
      recipientIgUserId: account.config.igUserId,
      messageId: 'comment-keyword',
      commentId: 'comment-keyword',
      mediaId: 'media-1',
      text: 'Quiero ÍNFO, por favor',
    };
    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.(comment);
      await mocks.dispatchInbound?.(comment);
    });

    expect(mocks.sendInstagramPrivateReply).toHaveBeenCalledOnce();
    expect(mocks.sendInstagramPrivateReply).toHaveBeenCalledWith(expect.objectContaining({
      igUserId: account.config.igUserId,
      commentId: 'comment-keyword',
      text: 'Información: https://example.test/info',
      accessToken: 'token',
      onPending: expect.any(Function),
      onReceipt: expect.any(Function),
    }));
    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
    expect(mocks.detectInstagramMessageLocale).not.toHaveBeenCalled();
    expect(mocks.sendInstagramCommentReply).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledOnce();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '112233445',
      content: 'Información: https://example.test/info',
      success: true,
      accountId: 'studio',
      messageId: 'mid.keyword',
      sessionKey: 'agent:example:instagram:studio:direct:112233445',
      sentBy: 'bot',
    });
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] ignored duplicate comment accountId=studio commentHash=redacted',
    );
  });

  it('logs and swallows keyword private-reply API failures', async () => {
    account.config.comments.enabled = true;
    account.config.comments.keywordPrivateReplies = [{
      triggers: { en: ['hello'] },
      replies: { en: 'Information: https://example.test/info' },
    }];
    mocks.sendInstagramPrivateReply.mockRejectedValue(new Error('Meta reply window expired'));

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'comment',
        accountId: 'studio',
        commenterId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'comment-keyword-failure',
        commentId: 'comment-keyword-failure',
        mediaId: 'media-1',
        text: 'hello',
      });
    });

    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '112233445',
      content: 'Information: https://example.test/info',
      success: false,
      error: 'Error: Meta reply window expired',
      accountId: 'studio',
      sessionKey: 'agent:example:instagram:studio:direct:112233445',
      sentBy: 'bot',
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      '[instagram] keyword private reply failed accountId=studio commentHash=redacted locale=en: Error: Meta reply window expired',
    );
  });

  it('thanks only clearly positive passive comments after NO_REPLY', async () => {
    account.config.comments.enabled = true;
    mocks.dispatchInboundDirectDmWithRuntime.mockResolvedValue({});
    mocks.detectInstagramMessageLocale.mockResolvedValue('es');
    mocks.sendInstagramCommentReply.mockResolvedValue({ commentId: 'comment.thanks' });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'comment',
        accountId: 'studio',
        commenterId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'comment-positive',
        commentId: 'comment-positive',
        mediaId: 'media-1',
        text: 'Muchas gracias ❤️',
      });
      await mocks.dispatchInbound?.({
        kind: 'comment',
        accountId: 'studio',
        commenterId: '998877665',
        recipientIgUserId: account.config.igUserId,
        messageId: 'comment-negative',
        commentId: 'comment-negative',
        mediaId: 'media-1',
        text: 'No gracias',
      });
    });

    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.sendInstagramPrivateReply).not.toHaveBeenCalled();
    expect(mocks.sendInstagramCommentReply).toHaveBeenCalledOnce();
    expect(mocks.sendInstagramCommentReply).toHaveBeenCalledWith({
      commentId: 'comment-positive',
      text: '¡Gracias! 🤍🤖',
      accessToken: 'token',
    });
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledOnce();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '112233445',
      content: '¡Gracias! 🤍🤖',
      success: true,
      accountId: 'studio',
      messageId: 'comment.thanks',
      sessionKey: 'agent:example:instagram:studio:direct:112233445',
      sentBy: 'bot',
    });
  });

  it('records a link-only channel share without sending the first-contact notice or a reply', async () => {
    account.config.firstContact = {
      messages: { en: 'I am Example Bot.' },
      fallbackLocale: 'en',
    };

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.channel-share',
        timestamp: 1710000000000,
        text: 'https://www.instagram.com/channel/example/',
        languageText: 'https://www.instagram.com/channel/example/',
        media: [],
        passiveShareOnly: false,
      });
    });

    expect(mocks.runMessageReceived).toHaveBeenCalledOnce();
    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
    expect(mocks.sendInstagramText).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] suppressed inbound message reason=standalone-url accountId=studio senderHash=redacted messageHash=redacted',
    );
  });

  it('records an emoji-only reaction without running the agent or sending an error reply', async () => {
    account.config.firstContact = {
      messages: { en: 'I am Example Bot.' },
      fallbackLocale: 'en',
    };

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '112233445',
        threadId: '112233445',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.reaction',
        timestamp: 1710000000000,
        text: '😍',
        languageText: '😍',
        media: [],
        passiveShareOnly: false,
      });
    });

    expect(mocks.runMessageReceived).toHaveBeenCalledOnce();
    expect(mocks.runMessageReceived.mock.calls[0]?.[0]).toMatchObject({
      content: '😍',
      threadId: '112233445',
    });
    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
    expect(mocks.sendInstagramText).not.toHaveBeenCalled();
    expect(mocks.sendInstagramReaction).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] suppressed inbound message reason=reaction-only accountId=studio senderHash=redacted messageHash=redacted',
    );
  });

  it('stops an in-flight reply and pauses the thread when a human answers from our account', async () => {
    let deliver: ((payload: any) => Promise<any>) | undefined;
    mocks.dispatchInboundDirectDmWithRuntime.mockImplementation(async (params) => {
      deliver = params.deliver;
      return {};
    });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        timestamp: 1710000000000,
        text: 'You got so many people',
        languageText: 'You got so many people',
        media: [],
        passiveShareOnly: false,
      });

      const humanMessage = {
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.human',
        text: 'nah, working on it',
        media: [],
      };
      await mocks.dispatchInbound?.(humanMessage);
      await mocks.dispatchInbound?.(humanMessage);

      await deliver?.({ text: 'A late automated reply' });
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.follow-up',
        timestamp: 1710000002000,
        text: 'Hahaha',
        languageText: 'Hahaha',
        media: [],
        passiveShareOnly: false,
      });
    });

    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledOnce();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '123456789',
      content: 'nah, working on it',
      success: true,
      accountId: 'studio',
      messageId: 'mid.human',
      sessionKey: 'agent:example:instagram:studio:direct:123456789',
      sentBy: 'human',
    });
    expect(mocks.sendInstagramText).not.toHaveBeenCalled();
    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledOnce();
    expect(mocks.runMessageReceived).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] suppressed generated reply after human takeover accountId=studio senderHash=redacted',
    );
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] suppressed inbound message reason=human-takeover-active accountId=studio senderHash=redacted messageHash=redacted',
    );
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] ignored duplicate account message accountId=studio messageHash=redacted',
    );
  });

  it('reserves an account message before a concurrent automated send can start', async () => {
    let deliver: ((payload: any) => Promise<any>) | undefined;
    mocks.dispatchInboundDirectDmWithRuntime.mockImplementation(async (params) => {
      deliver = params.deliver;
      return {};
    });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        text: 'You got so many people',
        languageText: 'You got so many people',
        media: [],
        passiveShareOnly: false,
      });

      const replyPromise = deliver?.({ text: 'A concurrent automated reply' });
      const humanPromise = mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.human',
        text: 'nah, working on it',
        media: [],
      });

      await humanPromise;
      await expect(replyPromise).rejects.toThrow(/human takeover/);
    });

    expect(mocks.sendInstagramText).not.toHaveBeenCalled();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'mid.human', sentBy: 'human' }),
    );
  });

  it('reconciles a bot echo while the Graph send is still in flight', async () => {
    let finishSend: (() => void) | undefined;
    mocks.sendInstagramText
      .mockImplementationOnce((params) => {
        params.onChunkPending?.({ text: 'Reply text' });
        return new Promise((resolve) => {
          finishSend = () => {
            params.onChunkReceipt?.({ text: 'Reply text', messageId: 'mid.bot' });
            resolve({ messageId: 'mid.bot', messageIds: ['mid.bot'] });
          };
        });
      })
      .mockResolvedValue({ messageId: 'mid.next', messageIds: ['mid.next'] });

    await withStartedAccount(async () => {
      const inboundPromise = mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        text: 'When is the workshop?',
        languageText: 'When is the workshop?',
        media: [],
        passiveShareOnly: false,
      });
      await vi.waitFor(() => expect(mocks.sendInstagramText).toHaveBeenCalledOnce());
      const echoPromise = mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.bot',
        text: 'Reply text',
        media: [],
      });
      const secondInboundPromise = mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.second-inbound',
        text: 'A second real question',
        languageText: 'A second real question',
        media: [],
        passiveShareOnly: false,
      });
      await vi.waitFor(() => expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledTimes(2));
      finishSend?.();
      await Promise.all([inboundPromise, echoPromise, secondInboundPromise]);
    });

    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledTimes(2);
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalledWith(
      expect.objectContaining({ sentBy: 'human' }),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] reconciled automated echo accountId=studio messageHash=redacted',
    );
  });

  it('pauses without guessing bot or human after an ambiguous Graph failure', async () => {
    let deliver: ((payload: any) => Promise<any>) | undefined;
    mocks.dispatchInboundDirectDmWithRuntime.mockImplementation(async (params) => {
      deliver = params.deliver;
      return {};
    });
    mocks.sendInstagramText.mockImplementationOnce(async (params) => {
      params.onChunkPending?.({ text: 'Reply text' });
      throw new Error('network timeout after possible delivery');
    });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        text: 'When is the workshop?',
        languageText: 'When is the workshop?',
        media: [],
        passiveShareOnly: false,
      });
      await expect(deliver?.({ text: 'Reply text' })).rejects.toThrow(/possible delivery/);

      await mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.ambiguous-bot',
        text: 'Reply text',
        media: [],
      });

      await expect((instagramPlugin as any).outbound.sendText({
        cfg,
        to: '123456789',
        text: 'A later automated follow-up',
        accountId: 'studio',
      })).rejects.toThrow(/human takeover/);
    });

    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalledWith(
      expect.objectContaining({ sentBy: 'human' }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      '[instagram] account message left unresolved; automation paused accountId=studio messageHash=redacted',
    );
  });

  it('logs a nonmatching staff reply while retaining ambiguity for the delayed bot echo', async () => {
    let deliver: ((payload: any) => Promise<any>) | undefined;
    mocks.dispatchInboundDirectDmWithRuntime.mockImplementation(async (params) => {
      deliver = params.deliver;
      return {};
    });
    mocks.sendInstagramText.mockImplementationOnce(async (params) => {
      params.onChunkPending?.({ text: 'Reply text' });
      throw new Error('network timeout after possible delivery');
    });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        text: 'When is the workshop?',
        languageText: 'When is the workshop?',
        media: [],
        passiveShareOnly: false,
      });
      await expect(deliver?.({ text: 'Reply text' })).rejects.toThrow(/possible delivery/);

      await mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.human',
        text: 'I will handle this one',
        media: [],
      });
      await mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.delayed-bot',
        text: 'Reply text',
        media: [],
      });
    });

    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'mid.human', sentBy: 'human' }),
    );
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'mid.delayed-bot', sentBy: 'human' }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      '[instagram] account message left unresolved; automation paused accountId=studio messageHash=redacted',
    );
  });

  it('checks takeover again before each chunk of a long automated reply', async () => {
    let firstChunkSent: (() => void) | undefined;
    const firstChunkPromise = new Promise<void>((resolve) => {
      firstChunkSent = resolve;
    });
    let continueSend: (() => void) | undefined;
    const continuePromise = new Promise<void>((resolve) => {
      continueSend = resolve;
    });
    mocks.sendInstagramText.mockImplementation(async (params) => {
      params.onChunkPending?.({ text: 'first chunk' });
      params.onChunkReceipt?.({ text: 'first chunk', messageId: 'mid.first' });
      firstChunkSent?.();
      await continuePromise;
      params.onChunkPending?.({ text: 'same staff phrase' });
      return { messageId: 'mid.second', messageIds: ['mid.first', 'mid.second'] };
    });

    await withStartedAccount(async () => {
      const inboundPromise = mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        text: 'Please help',
        languageText: 'Please help',
        media: [],
        passiveShareOnly: false,
      });
      await firstChunkPromise;
      const humanPromise = mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.human',
        text: 'same staff phrase',
        media: [],
      });
      continueSend?.();
      await expect(inboundPromise).rejects.toThrow(/human takeover/);
      await humanPromise;
    });

    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'mid.human', sentBy: 'human' }),
    );
  });

  it('rechecks takeover after locale detection before sending first contact', async () => {
    account.config.firstContact = {
      messages: { en: 'I am Example Bot.' },
      fallbackLocale: 'en',
    };
    let resolveLocale: ((locale: string) => void) | undefined;
    mocks.detectInstagramMessageLocale.mockImplementation(() =>
      new Promise((resolve) => {
        resolveLocale = resolve;
      })
    );

    await withStartedAccount(async () => {
      const inboundPromise = mocks.dispatchInbound?.({
        kind: 'inbound',
        accountId: 'studio',
        senderId: '123456789',
        threadId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        text: 'When is the workshop?',
        languageText: 'When is the workshop?',
        media: [],
        passiveShareOnly: false,
      });
      await vi.waitFor(() => expect(mocks.detectInstagramMessageLocale).toHaveBeenCalledOnce());
      await mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.human',
        text: 'I will answer this one',
        media: [],
      });
      resolveLocale?.('en');
      await inboundPromise;
    });

    expect(mocks.sendInstagramText).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] suppressed first-contact message after human takeover accountId=studio senderHash=redacted',
    );
    expect(
      fs.readdirSync(cfg.channels.instagram.firstContactStateDir!).filter((name) => name.endsWith('.sent')),
    ).toEqual([]);
  });

  it('blocks direct automated outbound sends while human takeover is active', async () => {
    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.human',
        text: 'I am handling this',
        media: [],
      });

      await expect((instagramPlugin as any).outbound.sendText({
        cfg,
        to: '123456789',
        text: 'Automated follow-up',
        accountId: 'studio',
      })).rejects.toThrow(/human takeover/);
    });

    expect(mocks.sendInstagramText).not.toHaveBeenCalled();
  });

  it('keeps human takeover active in memory when durable state is unwritable', async () => {
    await withStartedAccount(async () => {
      const stateDir = cfg.channels.instagram.firstContactStateDir!;
      fs.chmodSync(stateDir, 0o500);
      try {
        const humanMessage = {
          kind: 'account',
          accountId: 'studio',
          peerId: '555555555',
          recipientIgUserId: account.config.igUserId,
          messageId: 'mid.human-storage-failure',
          text: 'I am handling this',
          media: [],
        };
        await mocks.dispatchInbound?.(humanMessage);
        await mocks.dispatchInbound?.(humanMessage);
        await mocks.dispatchInbound?.({
          kind: 'inbound',
          accountId: 'studio',
          senderId: '555555555',
          threadId: '555555555',
          recipientIgUserId: account.config.igUserId,
          messageId: 'mid.follow-up',
          text: 'Thanks',
          languageText: 'Thanks',
          media: [],
          passiveShareOnly: false,
        });
      } finally {
        fs.chmodSync(stateDir, 0o700);
      }
    });

    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledOnce();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'mid.human-storage-failure', sentBy: 'human' }),
    );
    expect(mocks.dispatchInboundDirectDmWithRuntime).not.toHaveBeenCalled();
    expect(mocks.runMessageReceived).toHaveBeenCalledOnce();
  });

  it('keeps bot receipts in memory when durable state is unwritable', async () => {
    mocks.sendInstagramText.mockResolvedValue({
      messageId: 'mid.bot-storage-failure',
      messageIds: ['mid.bot-storage-failure'],
    });

    await withStartedAccount(async () => {
      const stateDir = cfg.channels.instagram.firstContactStateDir!;
      fs.chmodSync(stateDir, 0o500);
      try {
        await mocks.dispatchInbound?.({
          kind: 'inbound',
          accountId: 'studio',
          senderId: '666666666',
          threadId: '666666666',
          recipientIgUserId: account.config.igUserId,
          messageId: 'mid.inbound',
          text: 'When is the workshop?',
          languageText: 'When is the workshop?',
          media: [],
          passiveShareOnly: false,
        });
      } finally {
        fs.chmodSync(stateDir, 0o700);
      }

      await mocks.dispatchInbound?.({
        kind: 'account',
        accountId: 'studio',
        peerId: '666666666',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.bot-storage-failure',
        text: 'Reply text',
        media: [],
      });
    });

    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledOnce();
    expect(mocks.emitInstagramMessageSentHook).not.toHaveBeenCalledWith(
      expect.objectContaining({ sentBy: 'human' }),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      '[instagram] reconciled automated echo accountId=studio messageHash=redacted',
    );
  });

  it('refuses direct outbound sends when the account is not running', async () => {
    await expect((instagramPlugin as any).outbound.sendText({
      cfg,
      to: '123456789',
      text: 'Automated follow-up',
      accountId: 'studio',
    })).rejects.toThrow(/not running/);

    expect(mocks.sendInstagramText).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (cfg.channels.instagram.firstContactStateDir) {
      fs.rmSync(cfg.channels.instagram.firstContactStateDir, { recursive: true, force: true });
    }
    cfg.channels.instagram.firstContactStateDir = undefined;
    account.config.firstContact = undefined;
    account.config.storyMentionReaction = true;
    account.config.mediaShareReaction = true;
    account.config.comments.enabled = false;
    account.config.comments.keywordPrivateReplies = [];
  });

  it('emits success after the direct Graph API send', async () => {
    mocks.sendInstagramText.mockResolvedValue({ messageId: 'mid.outbound' });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        accountId: 'studio',
        senderId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        timestamp: 1710000000000,
        text: 'Inbound text',
        media: [],
      });
    });

    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '123456789',
      content: 'Reply text',
      success: true,
      accountId: 'studio',
      messageId: 'mid.outbound',
      sessionKey: 'agent:example:instagram:studio:direct:123456789',
      sentBy: 'bot',
    });
    expect(mocks.resolveAgentRoute).toHaveBeenCalledOnce();
    expect(mocks.dispatchInboundDirectDmWithRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationLabel: '@example',
        extraContext: expect.objectContaining({ SenderUsername: 'example' }),
      }),
    );
  });

  it('coalesces concurrent profile lookups for the same sender', async () => {
    let resolveProfile: (profile: { username: string }) => void;
    mocks.lookupInstagramUserProfile.mockImplementation(
      () => new Promise((resolve) => {
        resolveProfile = resolve as (profile: { username: string }) => void;
      }),
    );
    mocks.sendInstagramText.mockResolvedValue({ messageId: 'mid.outbound' });

    await withStartedAccount(async () => {
      const dispatch = mocks.dispatchInbound!;
      const message = {
        accountId: 'studio',
        senderId: '135792468',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound.1',
        timestamp: 1710000000000,
        text: 'Inbound text',
        media: [],
      };
      const first = dispatch(message);
      const second = dispatch({ ...message, messageId: 'mid.inbound.2' });

      await vi.waitFor(() => expect(mocks.lookupInstagramUserProfile).toHaveBeenCalledTimes(1));
      resolveProfile!({ username: 'example' });
      await Promise.all([first, second]);
    });

    expect(mocks.lookupInstagramUserProfile).toHaveBeenCalledTimes(1);
  });

  it('emits failure and preserves the original send error', async () => {
    const sendError = new Error('Graph API rejected the send');
    mocks.sendInstagramText.mockRejectedValue(sendError);

    await withStartedAccount(async () => {
      await expect(mocks.dispatchInbound?.({
        accountId: 'studio',
        senderId: '123456789',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        timestamp: 1710000000000,
        text: 'Inbound text',
        media: [],
      })).rejects.toBe(sendError);
    });

    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '123456789',
      content: 'Reply text',
      success: false,
      error: 'Error: Graph API rejected the send',
      accountId: 'studio',
      sessionKey: 'agent:example:instagram:studio:direct:123456789',
      sentBy: 'bot',
    });
    expect(mocks.resolveAgentRoute).toHaveBeenCalledOnce();
  });

  it('continues with the canonical ID when profile lookup fails', async () => {
    mocks.lookupInstagramUserProfile.mockRejectedValue(new Error('profile unavailable'));
    mocks.sendInstagramText.mockResolvedValue({ messageId: 'mid.outbound' });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        accountId: 'studio',
        senderId: '987654321',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        timestamp: 1710000000000,
        text: 'Inbound text',
        media: [],
      });
    });

    const params = mocks.dispatchInboundDirectDmWithRuntime.mock.calls[0]?.[0];
    expect(params.conversationLabel).toBe('987654321');
    expect(params.extraContext).not.toHaveProperty('SenderUsername');
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('profile lookup failed'));
  });

  it('keeps the localized introduction before the first automated reply', async () => {
    account.config.firstContact = {
      messages: { en: 'I am Example Bot.' },
      fallbackLocale: 'en',
    };
    mocks.sendInstagramText
      .mockResolvedValueOnce({ messageId: 'mid.intro' })
      .mockResolvedValueOnce({ messageId: 'mid.reply' });

    await withStartedAccount(async () => {
      await mocks.dispatchInbound?.({
        accountId: 'studio',
        senderId: '246813579',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        timestamp: 1710000000000,
        text: 'Hello',
        languageText: 'Hello',
        media: [],
      });
    });

    expect(mocks.sendInstagramText.mock.calls.map(([params]) => params.text)).toEqual([
      'I am Example Bot.',
      'Reply text',
    ]);
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenNthCalledWith(1, {
      to: '246813579',
      content: 'I am Example Bot.',
      success: true,
      accountId: 'studio',
      messageId: 'mid.intro',
      sessionKey: 'agent:example:instagram:studio:direct:246813579',
      sentBy: 'bot',
    });
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenNthCalledWith(2, {
      to: '246813579',
      content: 'Reply text',
      success: true,
      accountId: 'studio',
      messageId: 'mid.reply',
      sessionKey: 'agent:example:instagram:studio:direct:246813579',
      sentBy: 'bot',
    });
    expect(mocks.resolveAgentRoute).toHaveBeenCalledOnce();
  });

  it('emits the routed session key when the first-contact introduction fails', async () => {
    account.config.firstContact = {
      messages: { en: 'I am Example Bot.' },
      fallbackLocale: 'en',
    };
    const sendError = new Error('Graph API rejected the introduction');
    mocks.sendInstagramText.mockRejectedValueOnce(sendError);

    await withStartedAccount(async () => {
      await expect(mocks.dispatchInbound?.({
        accountId: 'studio',
        senderId: '864209753',
        recipientIgUserId: account.config.igUserId,
        messageId: 'mid.inbound',
        timestamp: 1710000000000,
        text: 'Hello',
        languageText: 'Hello',
        media: [],
      })).rejects.toBe(sendError);
    });

    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledOnce();
    expect(mocks.emitInstagramMessageSentHook).toHaveBeenCalledWith({
      to: '864209753',
      content: 'I am Example Bot.',
      success: false,
      error: 'Error: Graph API rejected the introduction',
      accountId: 'studio',
      sessionKey: 'agent:example:instagram:studio:direct:864209753',
      sentBy: 'bot',
    });
    expect(mocks.resolveAgentRoute).toHaveBeenCalledOnce();
  });
});
