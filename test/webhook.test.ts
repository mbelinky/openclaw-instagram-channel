import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  computeInstagramSignature,
  createInstagramWebhookHandler,
  normalizeInstagramWebhookPayload,
  type InstagramWebhookAccount,
} from '../src/instagram/webhook.js';

function request(params: {
  method: string;
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}) {
  const req = Readable.from(params.body === undefined ? [] : [Buffer.from(params.body)]);
  Object.assign(req, {
    method: params.method,
    url: params.url || '/webhook/instagram',
    headers: params.headers || {},
  });
  return req as any;
}

function response() {
  const state = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
  };
  return {
    state,
    value: {
      writeHead(statusCode: number, headers?: Record<string, string>) {
        state.statusCode = statusCode;
        state.headers = headers || {};
        return this;
      },
      end(body?: string) {
        state.body = body || '';
        return this;
      },
    } as any,
  };
}

const accounts: InstagramWebhookAccount[] = [
  {
    accountId: 'studio',
    igUserId: '17841400000000000',
    dmPolicy: 'open',
    allowFrom: new Set(),
    commentsEnabled: true,
  },
  {
    accountId: 'private',
    igUserId: '17841400000000001',
    dmPolicy: 'allowlist',
    allowFrom: new Set(['222']),
    commentsEnabled: false,
  },
];

function signedPost(body: string, signature = computeInstagramSignature(body, 'app-secret')) {
  return request({
    method: 'POST',
    body,
    headers: { 'x-hub-signature-256': signature },
  });
}

async function flushDispatch() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Instagram webhook', () => {
  it('normalizes comments from both supported comments-field envelopes', () => {
    const messages = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: '17841400000000000',
          time: 1710000000,
          field: 'comments',
          value: {
            id: 'comment-direct',
            from: { id: '111', username: '@clayfan' },
            text: 'Do you ship?',
            media: { id: 'media-1', media_product_type: 'FEED' },
          },
        },
        {
          id: '17841400000000000',
          changes: [{
            field: 'comments',
            value: {
              id: 'comment-change',
              from: { id: '222', username: 'potter' },
              text: 'Beautiful work ❤️',
              media: { id: 'media-2', media_product_type: 'REELS' },
              created_time: '2026-07-28T12:00:00Z',
            },
          }],
        },
      ],
    }, accounts);

    expect(messages).toEqual([
      {
        kind: 'comment',
        accountId: 'studio',
        commenterId: '111',
        commenterUsername: 'clayfan',
        recipientIgUserId: '17841400000000000',
        messageId: 'comment-direct',
        commentId: 'comment-direct',
        mediaId: 'media-1',
        text: 'Do you ship?',
        timestamp: 1710000000000,
      },
      {
        kind: 'comment',
        accountId: 'studio',
        commenterId: '222',
        commenterUsername: 'potter',
        recipientIgUserId: '17841400000000000',
        messageId: 'comment-change',
        commentId: 'comment-change',
        mediaId: 'media-2',
        text: 'Beautiful work ❤️',
        timestamp: Date.parse('2026-07-28T12:00:00Z'),
      },
    ]);
  });

  it('makes disabled comments a full no-op and ignores keyword-like self or other-account comments', () => {
    const warnings: string[] = [];
    const messages = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [
        {
          id: '17841400000000001',
          field: 'comments',
          value: {
            id: 'disabled',
            from: { id: '222', username: 'allowed-dm-user' },
            text: 'INFO',
            media: { id: 'media-disabled' },
          },
        },
        {
          id: '17841400000000000',
          field: 'comments',
          value: {
            id: 'self',
            from: { id: '17841400000000000', username: 'studio' },
            text: 'INFO',
            media: { id: 'media-self' },
          },
        },
        {
          id: '999999999999',
          field: 'comments',
          value: {
            id: 'other-account',
            from: { id: '333', username: 'other-user' },
            text: 'INFO',
            media: { id: 'media-other' },
          },
        },
      ],
    }, accounts, { warn: (line) => warnings.push(line) });

    expect(messages).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unknown account hash=');
    expect(warnings.join(' ')).not.toContain('999999999999');
  });

  it('marks a text-less story mention for record-only handling', () => {
    const [message] = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: '111' },
          recipient: { id: '17841400000000000' },
          message: {
            mid: 'story-mention-only',
            attachments: [{
              type: 'story_mention',
              payload: { url: 'https://cdn.example.test/story.jpg' },
            }],
          },
        }],
      }],
    }, accounts);

    expect(message).toMatchObject({
      text: '(Mentioned us in their Instagram story)',
      kind: 'inbound',
      passiveShareOnly: true,
      media: [{
        type: 'story_mention',
        url: 'https://cdn.example.test/story.jpg',
      }],
    });
  });

  it('preserves text alongside a story mention and keeps normal reply handling enabled', () => {
    const [message] = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: '111' },
          recipient: { id: '17841400000000000' },
          message: {
            mid: 'story-mention-with-text',
            text: 'Thought you would like this!',
            attachments: [{
              type: 'story_mention',
              payload: { url: 'https://cdn.example.test/story-with-text.jpg' },
            }],
          },
        }],
      }],
    }, accounts);

    expect(message).toMatchObject({
      text: 'Thought you would like this!',
      languageText: 'Thought you would like this!',
      passiveShareOnly: false,
    });
  });

  it.each([
    ['share', '(Shared a post)', true, 'recognized'],
    ['ig_reel', '(Shared a reel)', true, 'recognized'],
    ['image', '(Sent a photo)', false, undefined],
  ])('uses a kind-aware placeholder for %s attachments', (
    type,
    expectedText,
    passiveShareOnly,
    mediaShareKind,
  ) => {
    const [message] = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: '111' },
          recipient: { id: '17841400000000000' },
          message: {
            mid: `media-${type}`,
            attachments: [{
              type,
              payload: { url: `https://cdn.example.test/${type}` },
            }],
          },
        }],
      }],
    }, accounts);

    expect(message).toMatchObject({
      text: expectedText,
      passiveShareOnly,
    });
    expect(message.kind === 'inbound' ? message.mediaShareKind : undefined).toBe(mediaShareKind);
  });

  it('classifies text-less attachments without a type as untyped media shares', () => {
    const [message] = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: '111' },
          recipient: { id: '17841400000000000' },
          message: {
            mid: 'media-untyped',
            attachments: [{
              payload: { url: 'https://cdn.example.test/untyped-reel' },
            }],
          },
        }],
      }],
    }, accounts);

    expect(message).toMatchObject({
      kind: 'inbound',
      text: '(Instagram media message)',
      passiveShareOnly: false,
      mediaShareKind: 'untyped',
      media: [{
        type: 'file',
        url: 'https://cdn.example.test/untyped-reel',
      }],
    });
  });

  it('does not classify a recognized share as passive media when user text is present', () => {
    const [message] = normalizeInstagramWebhookPayload({
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: '111' },
          recipient: { id: '17841400000000000' },
          message: {
            mid: 'media-share-with-text',
            text: 'Can you make something like this?',
            attachments: [{
              type: 'ig_reel',
              payload: { url: 'https://cdn.example.test/reel-with-text' },
            }],
          },
        }],
      }],
    }, accounts);

    expect(message).toMatchObject({
      kind: 'inbound',
      text: 'Can you make something like this?',
      languageText: 'Can you make something like this?',
      passiveShareOnly: false,
    });
    expect(message.kind === 'inbound' ? message.mediaShareKind : undefined).toBeUndefined();
  });

  it('answers valid GET verification and rejects a wrong verify token', async () => {
    const handler = createInstagramWebhookHandler(
      { appSecret: 'app-secret', verifyToken: 'verify-me', accounts },
      vi.fn(),
    );
    const accepted = response();
    await handler(
      request({
        method: 'GET',
        url: '/webhook/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123',
      }),
      accepted.value,
    );
    expect(accepted.state).toMatchObject({ statusCode: 200, body: 'abc123' });

    const rejected = response();
    await handler(
      request({
        method: 'GET',
        url: '/webhook/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123',
      }),
      rejected.value,
    );
    expect(rejected.state.statusCode).toBe(403);
  });

  it('accepts a valid raw-body signature and rejects an invalid signature before JSON parsing', async () => {
    const dispatch = vi.fn();
    const handler = createInstagramWebhookHandler(
      { appSecret: 'app-secret', verifyToken: 'verify-me', accounts },
      dispatch,
    );
    const body = JSON.stringify({
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: '111' },
          recipient: { id: '17841400000000000' },
          timestamp: 1710000000000,
          message: { mid: 'm-1', text: 'hello' },
        }],
      }],
    });
    const accepted = response();
    await handler(signedPost(body), accepted.value);
    await flushDispatch();
    expect(accepted.state).toMatchObject({ statusCode: 200, body: 'EVENT_RECEIVED' });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const rejected = response();
    await handler(signedPost('{not-json', 'sha256='.padEnd(71, '0')), rejected.value);
    expect(rejected.state).toMatchObject({ statusCode: 403, body: 'Invalid signature' });
  });

  it('keeps the request lifecycle open until acknowledged dispatch completes', async () => {
    let releaseDispatch: (() => void) | undefined;
    const dispatch = vi.fn(() => new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    }));
    const handler = createInstagramWebhookHandler(
      { appSecret: 'app-secret', verifyToken: 'verify-me', accounts },
      dispatch,
    );
    const body = JSON.stringify({
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: '111' },
          recipient: { id: '17841400000000000' },
          message: { mid: 'detached-1', text: 'hello' },
        }],
      }],
    });
    const res = response();

    let handlerSettled = false;
    const handlerPromise = handler(signedPost(body), res.value).then(() => {
      handlerSettled = true;
    });
    await flushDispatch();

    expect(res.state).toMatchObject({ statusCode: 200, body: 'EVENT_RECEIVED' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(handlerSettled).toBe(false);

    releaseDispatch?.();
    await handlerPromise;
    expect(handlerSettled).toBe(true);
  });

  it('routes inbound and account-side messages, ignores unknown recipients, and enforces allowlists', async () => {
    const dispatch = vi.fn();
    const warnings: string[] = [];
    const handler = createInstagramWebhookHandler(
      {
        appSecret: 'app-secret',
        verifyToken: 'verify-me',
        accounts,
        log: { warn: (line) => warnings.push(line) },
      },
      dispatch,
    );
    const body = JSON.stringify({
      object: 'instagram',
      entry: [{
        messaging: [
          {
            sender: { id: '222' },
            recipient: { id: '17841400000000001' },
            message: { mid: 'known', text: 'allowed' },
          },
          {
            sender: { id: '333' },
            recipient: { id: '999999' },
            message: { mid: 'unknown', text: 'ignore' },
          },
          {
            sender: { id: '17841400000000000' },
            recipient: { id: '111' },
            message: { mid: 'echo', text: 'own reply', is_echo: true },
          },
          {
            sender: { id: 'blocked' },
            recipient: { id: '17841400000000001' },
            message: { mid: 'blocked', text: 'no access' },
          },
        ],
      }],
    });
    const res = response();
    await handler(signedPost(body), res.value);
    await flushDispatch();

    expect(res.state.statusCode).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      accountId: 'private',
      senderId: '222',
      threadId: '222',
      recipientIgUserId: '17841400000000001',
      messageId: 'known',
    });
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      kind: 'account',
      accountId: 'studio',
      peerId: '111',
      recipientIgUserId: '17841400000000000',
      messageId: 'echo',
      text: 'own reply',
    });
    expect(warnings.some((line) => line.includes('unknown recipient'))).toBe(true);
    expect(warnings.some((line) => line.includes('blocked sender'))).toBe(true);
  });

  it('normalizes text and media attachments for inbound dispatch', async () => {
    const dispatch = vi.fn();
    const handler = createInstagramWebhookHandler(
      { appSecret: 'app-secret', verifyToken: 'verify-me', accounts },
      dispatch,
    );
    const body = JSON.stringify({
      object: 'instagram',
      entry: [{
        messaging: [{
          sender: { id: '111' },
          recipient: { id: '17841400000000000' },
          conversation: { id: 'conversation-7' },
          message: {
            mid: 'media-1',
            text: 'look',
            attachments: [
              { type: 'image', payload: { url: 'https://cdn.example.test/image.jpg' } },
              { type: 'video', payload: { url: 'https://cdn.example.test/video.mp4' } },
            ],
          },
        }],
      }],
    });
    const res = response();
    await handler(signedPost(body), res.value);
    await flushDispatch();

    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      text: 'look',
      languageText: 'look',
      passiveShareOnly: false,
      conversationId: 'conversation-7',
      media: [
        { type: 'image', url: 'https://cdn.example.test/image.jpg' },
        { type: 'video', url: 'https://cdn.example.test/video.mp4' },
      ],
    });
  });
});
