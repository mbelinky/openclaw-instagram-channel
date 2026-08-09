import { describe, expect, it, vi } from 'vitest';
import {
  buildInstagramTextMessageRequest,
  buildInstagramReactionRequest,
  buildInstagramPrivateReplyRequest,
  buildInstagramCommentReplyRequest,
  formatInstagramPlainText,
  applyInstagramMessagePrefix,
  INSTAGRAM_TEXT_LIMIT,
  InstagramSendError,
  InstagramSendConcurrencyGuard,
  redactInstagramLogValue,
  sendInstagramReaction,
  sendInstagramPrivateReply,
  sendInstagramCommentReply,
  sendInstagramText,
} from '../src/instagram/send.js';

function fetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('Instagram outbound', () => {
  it('strips bold, italic, and strikethrough markers', () => {
    expect(formatInstagramPlainText('Use **bold**, *italic*, __bold__, _italic_, and ~~removed~~.')).toBe(
      'Use bold, italic, bold, italic, and removed.',
    );
  });

  it('converts markdown links to plain-text labels and URLs', () => {
    expect(formatInstagramPlainText(
      'Read [the guide](https://example.com/guide) or [https://example.com](https://example.com).',
    )).toBe('Read the guide: https://example.com/guide or https://example.com.');
  });

  it('preserves bare URLs unchanged', () => {
    const text = 'Open https://example.com/a_b_c?mode=**raw** directly.';
    expect(formatInstagramPlainText(text)).toBe(text);
  });

  it('normalizes headings, list markers, and excessive blank lines', () => {
    expect(formatInstagramPlainText('# Heading\n\n\n\n* First\n+ Second\n- Third')).toBe(
      'Heading\n\n- First\n- Second\n- Third',
    );
  });

  it('passes plain text through unchanged', () => {
    const text = 'Hello there.\nThis is already plain text.';
    expect(formatInstagramPlainText(text)).toBe(text);
  });

  it('constructs the Graph text payload and bearer authorization', () => {
    const request = buildInstagramTextMessageRequest({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: 'Hello from OpenClaw',
      accessToken: 'secret-token',
    });
    expect(request.url).toBe('https://graph.instagram.com/17841400000000000/messages');
    expect(request.init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(request.init.body)).toEqual({
      recipient: { id: '123456789' },
      message: { text: 'Hello from OpenClaw' },
    });
  });

  it('constructs Meta reaction payload exactly and pins the approved API version', () => {
    const request = buildInstagramReactionRequest({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      messageId: 'mid.story',
      accessToken: 'secret-token',
    });
    expect(request.url).toBe(
      'https://graph.instagram.com/v21.0/17841400000000000/messages',
    );
    expect(request.init.headers).toEqual({
      authorization: 'Bearer secret-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(request.init.body)).toEqual({
      recipient: { id: '123456789' },
      sender_action: 'react',
      payload: {
        message_id: 'mid.story',
        reaction: 'love',
      },
    });
  });

  it('constructs private and public comment reply requests', () => {
    const privateReply = buildInstagramPrivateReplyRequest({
      igUserId: '17841400000000000',
      commentId: 'comment-1',
      text: 'Private answer',
      accessToken: 'secret-token',
    });
    expect(privateReply.url).toBe(
      'https://graph.instagram.com/v21.0/17841400000000000/messages',
    );
    expect(JSON.parse(privateReply.init.body)).toEqual({
      recipient: { comment_id: 'comment-1' },
      message: { text: 'Private answer' },
    });

    const publicReply = buildInstagramCommentReplyRequest({
      commentId: 'comment-1',
      text: 'Te escribimos por privado 🤖',
      accessToken: 'secret-token',
    });
    expect(publicReply.url).toBe(
      'https://graph.instagram.com/v21.0/comment-1/replies',
    );
    expect(JSON.parse(publicReply.init.body)).toEqual({
      message: 'Te escribimos por privado 🤖',
    });
  });

  it('requires Meta confirmation for reactions and both comment reply types', async () => {
    await expect(sendInstagramReaction({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      messageId: 'mid.story',
      accessToken: 'token',
      fetchImpl: (async () => fetchResponse(200, { recipient_id: '123456789' })) as typeof fetch,
    })).resolves.toEqual({ recipientId: '123456789' });

    const onPending = vi.fn();
    const onReceipt = vi.fn();
    await expect(sendInstagramPrivateReply({
      igUserId: '17841400000000000',
      commentId: 'comment-1',
      text: '**Private** answer',
      messagePrefix: '🤖 ',
      accessToken: 'token',
      onPending,
      onReceipt,
      fetchImpl: (async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          message: { text: '🤖 Private answer' },
        });
        return fetchResponse(200, {
          recipient_id: '123456789',
          message_id: 'mid.private',
        });
      }) as typeof fetch,
    })).resolves.toEqual({
      recipientId: '123456789',
      messageId: 'mid.private',
    });
    expect(onPending).toHaveBeenCalledWith({ text: '🤖 Private answer' });
    expect(onReceipt).toHaveBeenCalledWith({
      text: '🤖 Private answer',
      messageId: 'mid.private',
    });

    await expect(sendInstagramCommentReply({
      commentId: 'comment-1',
      text: 'Te escribimos por privado 🤖',
      accessToken: 'token',
      fetchImpl: (async () => fetchResponse(200, { id: 'comment-reply-1' })) as typeof fetch,
    })).resolves.toEqual({ commentId: 'comment-reply-1' });

    await expect(sendInstagramReaction({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      messageId: 'mid.story',
      accessToken: 'token',
      fetchImpl: (async () => fetchResponse(200, {})) as typeof fetch,
    })).rejects.toThrow(/without recipient_id/);
  });

  it('wraps transport failures in typed errors and redacts token-shaped values', async () => {
    await expect(sendInstagramText({
      igUserId: '17840000000000000',
      recipientId: '123456789',
      text: 'Hello',
      accessToken: 'token',
      fetchImpl: (async () => { throw new Error('Bearer token disconnected'); }) as typeof fetch,
    })).rejects.toMatchObject({
      name: 'InstagramSendError',
      status: 0,
      deliveryUnknown: true,
    });
    expect(redactInstagramLogValue('Bearer token', ['token']))
      .toBe('Bearer [REDACTED]');
  });

  it('caps concurrent Graph API work', async () => {
    const guard = new InstagramSendConcurrencyGuard(1);
    let active = 0;
    let highest = 0;
    await Promise.all([1, 2, 3].map(() => guard.run(async () => {
      active += 1;
      highest = Math.max(highest, active);
      await Promise.resolve();
      active -= 1;
    })));
    expect(highest).toBe(1);
  });

  it('returns the real Meta message receipt', async () => {
    const fetchImpl = vi.fn(async () => fetchResponse(200, {
      recipient_id: '123456789',
      message_id: 'mid.abc',
    }));
    const result = await sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: 'hello',
      accessToken: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({
      messageId: 'mid.abc',
      messageIds: ['mid.abc'],
      recipientId: '123456789',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('formats markdown before sending it to Meta', async () => {
    const fetchImpl = vi.fn(async () => fetchResponse(200, { message_id: 'mid.formatted' }));
    await sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: '**Hello** [site](https://example.com)',
      accessToken: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      message: { text: 'Hello site: https://example.com' },
    });
  });

  it('applies the configured prefix after stripping markdown', async () => {
    const fetchImpl = vi.fn(async () => fetchResponse(200, { message_id: 'mid.prefixed' }));
    await sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: '**Hello** _there_',
      accessToken: 'token',
      messagePrefix: '[Bot] ',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      message: { text: '[Bot] Hello there' },
    });
  });

  it('keeps exactly one robot marker when the model also adds one', () => {
    expect(applyInstagramMessagePrefix('🤖 Hola\n🤖 ¿En qué podemos ayudarte?', '🤖 ')).toBe(
      '🤖 Hola\n¿En qué podemos ayudarte?',
    );
  });

  it('does not add a prefix when none is configured', async () => {
    const fetchImpl = vi.fn(async () => fetchResponse(200, { message_id: 'mid.unprefixed' }));
    await sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: 'Hello',
      accessToken: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ message: { text: 'Hello' } });
  });

  it('reserves prefix space when chunking and prefixes every send', async () => {
    const prefix = '[Bot] ';
    const text = 'x'.repeat((INSTAGRAM_TEXT_LIMIT - prefix.length) * 2 + 1);
    const fetchImpl = vi.fn(async () => fetchResponse(200, { message_id: 'mid.chunk' }));
    const result = await sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text,
      accessToken: 'token',
      messagePrefix: prefix,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const sentTexts = fetchImpl.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)).message.text as string
    );
    expect(sentTexts).toHaveLength(3);
    expect(result.messageIds).toEqual(['mid.chunk', 'mid.chunk', 'mid.chunk']);
    expect(sentTexts.every((chunk) => chunk.startsWith(prefix))).toBe(true);
    expect(sentTexts.every((chunk) => chunk.length <= INSTAGRAM_TEXT_LIMIT)).toBe(true);
    expect(sentTexts.map((chunk) => chunk.slice(prefix.length)).join('')).toBe(text);
  });

  it('reports pending and confirmed chunks before a later chunk fails', async () => {
    const text = 'x'.repeat(INSTAGRAM_TEXT_LIMIT + 1);
    const onChunkPending = vi.fn();
    const onChunkReceipt = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fetchResponse(200, { message_id: 'mid.first' }))
      .mockResolvedValueOnce(fetchResponse(500, { error: { message: 'failed' } }));

    await expect(sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text,
      accessToken: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onChunkPending,
      onChunkReceipt,
    })).rejects.toMatchObject({
      message: expect.stringMatching(/Instagram API send failed/),
      deliveryUnknown: true,
    });

    expect(onChunkPending).toHaveBeenCalledTimes(2);
    expect(onChunkReceipt).toHaveBeenCalledOnce();
    expect(onChunkReceipt).toHaveBeenCalledWith({
      text: 'x'.repeat(INSTAGRAM_TEXT_LIMIT),
      messageId: 'mid.first',
    });
  });

  it('aborts a Graph send that exceeds its request timeout', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));

    await expect(sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: 'hello',
      accessToken: 'token',
      timeoutMs: 5,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow(/timed out after 5ms/);
  });

  it('does not mark a chunk pending or call fetch when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller canceled'));
    const fetchImpl = vi.fn();
    const onChunkPending = vi.fn();

    await expect(sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: 'hello',
      accessToken: 'token',
      signal: controller.signal,
      fetchImpl: fetchImpl as typeof fetch,
      onChunkPending,
    })).rejects.toThrow(/caller canceled/);

    expect(onChunkPending).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces Meta 24-hour-window errors with codes and never returns success', async () => {
    const fetchImpl = vi.fn(async () => fetchResponse(400, {
      error: {
        message: 'This message is outside the allowed 24-hour messaging window',
        type: 'OAuthException',
        code: 10,
        error_subcode: 2018278,
        fbtrace_id: 'trace-1',
      },
    }));
    await expect(sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: 'late reply',
      accessToken: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject<Partial<InstagramSendError>>({
      name: 'InstagramSendError',
      status: 400,
      code: 10,
      subcode: 2018278,
      traceId: 'trace-1',
      deliveryUnknown: false,
    });
    await expect(sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: 'late reply',
      accessToken: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/24-hour messaging-window send rejected/);
  });

  it('rejects a success-shaped response without message_id', async () => {
    await expect(sendInstagramText({
      igUserId: '17841400000000000',
      recipientId: '123456789',
      text: 'hello',
      accessToken: 'token',
      fetchImpl: (async () => fetchResponse(200, { recipient_id: '123456789' })) as typeof fetch,
    })).rejects.toThrow(/without message_id/);
  });
});
