const INSTAGRAM_GRAPH_ORIGIN = 'https://graph.instagram.com';
const INSTAGRAM_ENGAGEMENT_API_VERSION = 'v21.0';
export const INSTAGRAM_TEXT_LIMIT = 1000;
export const INSTAGRAM_SEND_TIMEOUT_MS = 15_000;
export const INSTAGRAM_MAX_CONCURRENT_SENDS = 4;

export class InstagramSendConcurrencyGuard {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit = INSTAGRAM_MAX_CONCURRENT_SENDS) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Instagram send concurrency limit must be a positive integer');
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

const outboundSendGuard = new InstagramSendConcurrencyGuard();

export function redactInstagramLogValue(value: unknown, secrets: readonly string[] = []): string {
  let text = String(value);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(new RegExp(`\\b(?:EAA${'G'}|IG${'QV'})[A-Za-z0-9_-]+\\b`, 'g'), '[REDACTED]')
    .replace(/(Bearer\s+)[^\s,]+/gi, '$1[REDACTED]');
}

export function formatInstagramPlainText(markdown: string): string {
  const urls: string[] = [];
  const preserveUrl = (url: string) => {
    const placeholder = `\u0000INSTAGRAM_URL_${urls.length}\u0000`;
    urls.push(url);
    return placeholder;
  };

  let text = markdown.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    const preserved = preserveUrl(url);
    return label === url ? preserved : `${label}: ${preserved}`;
  });

  text = text.replace(/https?:\/\/[^\s<\u0000]+/g, (url) => preserveUrl(url));
  text = text
    .replace(/^ {0,3}#{1,6}[\t ]+/gm, '')
    .replace(/^([\t ]*)[*+-][\t ]+/gm, '$1- ')
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '$1')
    .replace(/__(?=\S)([^_\n]*?\S)__/g, '$1')
    .replace(/(^|[^*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n');

  return text.replace(/\u0000INSTAGRAM_URL_(\d+)\u0000/g, (_match, index: string) => urls[Number(index)]);
}

export function applyInstagramMessagePrefix(text: string, messagePrefix?: string): string {
  const prefix = messagePrefix || '';
  if (!prefix.includes('🤖')) return `${prefix}${text}`;

  // The adapter owns the visible bot marker. Remove model-added copies at the
  // beginning of a reply or a continuation line before adding the one marker.
  const withoutRobotMarkers = text.replace(/^[ \t]*(?:🤖[ \t]*)+/gm, '');
  return `${prefix}${withoutRobotMarkers}`;
}

export interface InstagramTextMessageRequest {
  url: string;
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
  payload: {
    recipient: { id: string };
    message: { text: string };
  };
}

export interface InstagramReactionRequest {
  url: string;
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
  payload: {
    recipient: { id: string };
    sender_action: 'react';
    payload: {
      message_id: string;
      reaction: 'love';
    };
  };
}

export interface InstagramPrivateReplyRequest {
  url: string;
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
  payload: {
    recipient: { comment_id: string };
    message: { text: string };
  };
}

export interface InstagramCommentReplyRequest {
  url: string;
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
  payload: {
    message: string;
  };
}

export class InstagramSendError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly traceId?: string;
  readonly deliveryUnknown: boolean;

  constructor(params: {
    message: string;
    status: number;
    code?: number;
    subcode?: number;
    traceId?: string;
    deliveryUnknown?: boolean;
  }) {
    super(params.message);
    this.name = 'InstagramSendError';
    this.status = params.status;
    this.code = params.code;
    this.subcode = params.subcode;
    this.traceId = params.traceId;
    this.deliveryUnknown = params.deliveryUnknown ?? false;
  }
}

export function buildInstagramTextMessageRequest(params: {
  igUserId: string;
  recipientId: string;
  text: string;
  accessToken: string;
  signal?: AbortSignal;
}): InstagramTextMessageRequest {
  const payload = {
    recipient: { id: params.recipientId },
    message: { text: params.text },
  };
  return {
    url: `${INSTAGRAM_GRAPH_ORIGIN}/${encodeURIComponent(params.igUserId)}/messages`,
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      ...(params.signal ? { signal: params.signal } : {}),
    },
    payload,
  };
}

function instagramJsonPostInit(
  accessToken: string,
  payload: unknown,
  signal?: AbortSignal,
): InstagramTextMessageRequest['init'] {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  };
}

export function buildInstagramReactionRequest(params: {
  igUserId: string;
  recipientId: string;
  messageId: string;
  accessToken: string;
  signal?: AbortSignal;
}): InstagramReactionRequest {
  const payload: InstagramReactionRequest['payload'] = {
    recipient: { id: params.recipientId },
    sender_action: 'react',
    payload: {
      message_id: params.messageId,
      reaction: 'love',
    },
  };
  return {
    url: `${INSTAGRAM_GRAPH_ORIGIN}/${INSTAGRAM_ENGAGEMENT_API_VERSION}/${encodeURIComponent(params.igUserId)}/messages`,
    init: instagramJsonPostInit(params.accessToken, payload, params.signal),
    payload,
  };
}

export function buildInstagramPrivateReplyRequest(params: {
  igUserId: string;
  commentId: string;
  text: string;
  accessToken: string;
  signal?: AbortSignal;
}): InstagramPrivateReplyRequest {
  const payload = {
    recipient: { comment_id: params.commentId },
    message: { text: params.text },
  };
  return {
    url: `${INSTAGRAM_GRAPH_ORIGIN}/${INSTAGRAM_ENGAGEMENT_API_VERSION}/${encodeURIComponent(params.igUserId)}/messages`,
    init: instagramJsonPostInit(params.accessToken, payload, params.signal),
    payload,
  };
}

export function buildInstagramCommentReplyRequest(params: {
  commentId: string;
  text: string;
  accessToken: string;
  signal?: AbortSignal;
}): InstagramCommentReplyRequest {
  const payload = { message: params.text };
  return {
    url: `${INSTAGRAM_GRAPH_ORIGIN}/${INSTAGRAM_ENGAGEMENT_API_VERSION}/${encodeURIComponent(params.commentId)}/replies`,
    init: instagramJsonPostInit(params.accessToken, payload, params.signal),
    payload,
  };
}

function parseJson(text: string): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function sendError(response: { status: number }, body: any): InstagramSendError {
  const meta = body?.error && typeof body.error === 'object' ? body.error : {};
  const detail = typeof meta.message === 'string' ? meta.message : body?.raw || 'Unknown Meta API error';
  const code = typeof meta.code === 'number' ? meta.code : undefined;
  const subcode = typeof meta.error_subcode === 'number' ? meta.error_subcode : undefined;
  const traceId = typeof meta.fbtrace_id === 'string' ? meta.fbtrace_id : undefined;
  const windowFailure = /24\s*(?:-|–|—)?\s*hour|24h|outside[^.]*window|messaging window/i.test(detail);
  const fields = [
    `HTTP ${response.status}`,
    code === undefined ? undefined : `code ${code}`,
    subcode === undefined ? undefined : `subcode ${subcode}`,
    traceId ? `trace ${traceId}` : undefined,
  ].filter(Boolean);
  const prefix = windowFailure ? 'Instagram 24-hour messaging-window send rejected' : 'Instagram API send failed';
  return new InstagramSendError({
    message: `${prefix} (${fields.join(', ')}): ${detail}`,
    status: response.status,
    code,
    subcode,
    traceId,
    deliveryUnknown: response.status >= 500,
  });
}

async function postInstagramJson(params: {
  request: {
    url: string;
    init: InstagramTextMessageRequest['init'];
  };
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ response: Response; body: any }> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(params.signal?.reason);
  if (params.signal?.aborted) {
    abortFromParent();
  } else {
    params.signal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeoutMs = params.timeoutMs ?? INSTAGRAM_SEND_TIMEOUT_MS;
  const timeout = setTimeout(
    () => controller.abort(new Error(`Instagram API send timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await outboundSendGuard.run(async () => {
      if (controller.signal.aborted) {
        throw controller.signal.reason || new Error('Instagram API send aborted before dispatch');
      }
      const response = await (params.fetchImpl || fetch)(params.request.url, {
        ...params.request.init,
        signal: controller.signal,
      });
      const body = parseJson(await response.text());
      if (!response.ok) throw sendError(response, body);
      return { response, body };
    });
  } catch (error) {
    if (error instanceof InstagramSendError) throw error;
    const authorization = params.request.init.headers.authorization || '';
    const accessToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    throw new InstagramSendError({
      message: `Instagram API request failed: ${redactInstagramLogValue(error, [accessToken])}`,
      status: 0,
      deliveryUnknown: true,
    });
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', abortFromParent);
  }
}

export async function sendInstagramReaction(params: {
  igUserId: string;
  recipientId: string;
  messageId: string;
  accessToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ recipientId: string }> {
  const request = buildInstagramReactionRequest(params);
  const { response, body } = await postInstagramJson({ ...params, request });
  const recipientId = typeof body?.recipient_id === 'string' ? body.recipient_id.trim() : '';
  if (!recipientId) {
    throw new InstagramSendError({
      message: `Instagram reaction returned HTTP ${response.status} without recipient_id; delivery was not confirmed`,
      status: response.status,
      deliveryUnknown: true,
    });
  }
  return { recipientId };
}

function singleInstagramText(text: string, messagePrefix?: string): string {
  const formatted = applyInstagramMessagePrefix(formatInstagramPlainText(text), messagePrefix);
  if (formatted.length > INSTAGRAM_TEXT_LIMIT) {
    throw new Error(`Instagram private replies must be at most ${INSTAGRAM_TEXT_LIMIT} characters`);
  }
  return formatted;
}

export async function sendInstagramPrivateReply(params: {
  igUserId: string;
  commentId: string;
  text: string;
  accessToken: string;
  messagePrefix?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onPending?: (reply: { text: string }) => void;
  onReceipt?: (reply: { text: string; messageId: string }) => void;
}): Promise<{ messageId: string; recipientId?: string }> {
  const request = buildInstagramPrivateReplyRequest({
    ...params,
    text: singleInstagramText(params.text, params.messagePrefix),
  });
  params.onPending?.({ text: request.payload.message.text });
  const { response, body } = await postInstagramJson({ ...params, request });
  const messageId = typeof body?.message_id === 'string' ? body.message_id.trim() : '';
  if (!messageId) {
    throw new InstagramSendError({
      message: `Instagram private reply returned HTTP ${response.status} without message_id; delivery was not confirmed`,
      status: response.status,
      deliveryUnknown: true,
    });
  }
  const recipientId = typeof body?.recipient_id === 'string' ? body.recipient_id.trim() : '';
  params.onReceipt?.({ text: request.payload.message.text, messageId });
  return {
    messageId,
    ...(recipientId ? { recipientId } : {}),
  };
}

export async function sendInstagramCommentReply(params: {
  commentId: string;
  text: string;
  accessToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ commentId: string }> {
  const request = buildInstagramCommentReplyRequest(params);
  const { response, body } = await postInstagramJson({ ...params, request });
  const commentId = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!commentId) {
    throw new InstagramSendError({
      message: `Instagram public reply returned HTTP ${response.status} without id; delivery was not confirmed`,
      status: response.status,
      deliveryUnknown: true,
    });
  }
  return { commentId };
}

function chunkInstagramText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.length - cursor <= limit) {
      chunks.push(text.slice(cursor));
      break;
    }
    const window = text.slice(cursor, cursor + limit);
    const newline = window.lastIndexOf('\n');
    const whitespace = window.search(/\s(?=[^\s]*$)/);
    const breakOffset = newline > 0 ? newline : whitespace > 0 ? whitespace : limit;
    chunks.push(text.slice(cursor, cursor + breakOffset));
    cursor += breakOffset;
    while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
  }
  return chunks;
}

export async function sendInstagramText(params: {
  igUserId: string;
  recipientId: string;
  text: string;
  accessToken: string;
  messagePrefix?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onChunkPending?: (chunk: { text: string }) => void;
  onChunkReceipt?: (chunk: { text: string; messageId: string }) => void;
}): Promise<{ messageId: string; messageIds: string[]; recipientId?: string }> {
  const prefix = params.messagePrefix || '';
  const chunkLimit = INSTAGRAM_TEXT_LIMIT - prefix.length;
  if (chunkLimit <= 0) {
    throw new Error(`Instagram messagePrefix must be shorter than ${INSTAGRAM_TEXT_LIMIT} characters`);
  }
  const chunks = chunkInstagramText(formatInstagramPlainText(params.text), chunkLimit);
  let result: { messageId: string; recipientId?: string } | undefined;
  const messageIds: string[] = [];

  for (const chunk of chunks) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(params.signal?.reason);
    if (params.signal?.aborted) {
      abortFromParent();
    } else {
      params.signal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const timeoutMs = params.timeoutMs ?? INSTAGRAM_SEND_TIMEOUT_MS;
    const timeout = setTimeout(
      () => controller.abort(new Error(`Instagram API send timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const request = buildInstagramTextMessageRequest({
      ...params,
      text: applyInstagramMessagePrefix(chunk, prefix),
      signal: controller.signal,
    });
    let response: Response;
    let body: any;
    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason || new Error('Instagram API send aborted before dispatch');
      }
      params.onChunkPending?.({ text: request.payload.message.text });
      if (controller.signal.aborted) {
        throw controller.signal.reason || new Error('Instagram API send aborted before dispatch');
      }
      ({ response, body } = await postInstagramJson({
        request,
        signal: controller.signal,
        timeoutMs,
        fetchImpl: params.fetchImpl,
      }));
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener('abort', abortFromParent);
    }
    const messageId = typeof body?.message_id === 'string' ? body.message_id.trim() : '';
    if (!messageId) {
      throw new InstagramSendError({
        message: `Instagram API send returned HTTP ${response.status} without message_id; delivery was not confirmed`,
        status: response.status,
        deliveryUnknown: true,
      });
    }
    result = {
      messageId,
      ...(typeof body.recipient_id === 'string' ? { recipientId: body.recipient_id } : {}),
    };
    messageIds.push(messageId);
    params.onChunkReceipt?.({ text: request.payload.message.text, messageId });
  }

  return { ...result!, messageIds };
}
