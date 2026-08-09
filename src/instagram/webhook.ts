import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface InstagramWebhookAccount {
  accountId: string;
  igUserId: string;
  dmPolicy: 'allowlist' | 'open';
  allowFrom: Set<string>;
  commentsEnabled?: boolean;
}

export interface InstagramInboundMedia {
  type: string;
  url: string;
}

export interface InstagramInboundMessage {
  kind: 'inbound';
  accountId: string;
  senderId: string;
  threadId: string;
  recipientIgUserId: string;
  messageId: string;
  text: string;
  languageText?: string;
  timestamp?: number;
  media: InstagramInboundMedia[];
  passiveShareOnly: boolean;
  mediaShareKind?: 'recognized' | 'untyped';
  conversationId?: string;
}

export interface InstagramAccountMessage {
  kind: 'account';
  accountId: string;
  peerId: string;
  recipientIgUserId: string;
  messageId: string;
  text: string;
  timestamp?: number;
  media: InstagramInboundMedia[];
}

export interface InstagramInboundComment {
  kind: 'comment';
  accountId: string;
  commenterId: string;
  commenterUsername?: string;
  recipientIgUserId: string;
  messageId: string;
  commentId: string;
  mediaId: string;
  text: string;
  timestamp?: number;
}

export type InstagramWebhookMessage =
  | InstagramInboundMessage
  | InstagramAccountMessage
  | InstagramInboundComment;

export interface InstagramWebhookConfig {
  appSecret: string;
  verifyToken: string;
  accounts: InstagramWebhookAccount[];
  bodyMaxBytes?: number;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}

export type InstagramDispatch = (message: InstagramWebhookMessage) => void | Promise<void>;

export function redactInstagramId(value: string): string {
  if (!value) return 'missing';
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

async function collectRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RangeError('webhook body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function computeInstagramSignature(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export function validateInstagramSignature(
  rawBody: Buffer,
  signatureHeader: string,
  appSecret: string,
): boolean {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) return false;
  const expected = Buffer.from(computeInstagramSignature(rawBody, appSecret), 'utf8');
  const received = Buffer.from(signatureHeader.toLowerCase(), 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function respond(res: ServerResponse, status: number, body: string, contentType = 'text/plain') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function messageMedia(message: any): InstagramInboundMedia[] {
  if (!Array.isArray(message?.attachments)) return [];
  return message.attachments.flatMap((attachment: any) => {
    const url = typeof attachment?.payload?.url === 'string' ? attachment.payload.url.trim() : '';
    if (!url) return [];
    const type = typeof attachment.type === 'string' ? attachment.type.trim() : '';
    return [{ type: type || 'file', url }];
  });
}

function mediaPlaceholder(media: InstagramInboundMedia[]): string {
  const types = media.map((item) => item.type);
  if (types.every((type) => type === 'story_mention')) {
    return '(Mentioned us in their Instagram story)';
  }
  if (types.includes('share')) return '(Shared a post)';
  if (types.some((type) => type === 'ig_reel' || type === 'reel')) return '(Shared a reel)';
  if (types.every((type) => type === 'image')) return '(Sent a photo)';
  if (types.every((type) => type === 'video')) return '(Sent a video)';
  if (types.every((type) => type === 'audio')) return '(Sent a voice message)';
  return '(Instagram media message)';
}

function conversationId(event: any): string | undefined {
  const value = event?.conversation?.id ?? event?.thread_id ?? event?.threadId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function eventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function commentValues(entry: any): any[] {
  const fields = [
    ...(entry?.field === 'comments' ? [{ field: entry.field, value: entry.value }] : []),
    ...(Array.isArray(entry?.changes) ? entry.changes : []),
  ];
  return fields.flatMap((change: any) => {
    if (change?.field !== 'comments') return [];
    return Array.isArray(change.value) ? change.value : [change.value];
  }).filter(Boolean);
}

function normalizeInstagramComments(
  entry: any,
  accounts: InstagramWebhookAccount[],
  log?: InstagramWebhookConfig['log'],
): InstagramInboundComment[] {
  const recipientId = typeof entry?.id === 'string' ? entry.id.trim() : '';
  const account = accounts.find((candidate) => candidate.igUserId === recipientId);
  const values = commentValues(entry);
  if (values.length === 0) return [];
  if (!account) {
    log?.warn?.(`[instagram] ignored comment event for unknown account hash=${redactInstagramId(recipientId)}`);
    return [];
  }
  if (!account.commentsEnabled) return [];

  return values.flatMap((value: any) => {
    const commenterIdValue = value?.from?.id ?? value?.sender_id;
    const commenterId = typeof commenterIdValue === 'string' ? commenterIdValue.trim() : '';
    const eventRecipient = typeof value?.recipient_id === 'string' ? value.recipient_id.trim() : '';
    if (!commenterId || commenterId === account.igUserId) return [];
    if (eventRecipient && eventRecipient !== account.igUserId) return [];

    const commentId = typeof value?.id === 'string' ? value.id.trim() : '';
    const mediaIdValue = value?.media?.id ?? value?.media_id;
    const mediaId = typeof mediaIdValue === 'string' ? mediaIdValue.trim() : '';
    const text = typeof value?.text === 'string' ? value.text.trim() : '';
    if (!commentId || !mediaId || !text) return [];

    const usernameValue = value?.from?.username;
    const commenterUsername = typeof usernameValue === 'string'
      ? usernameValue.trim().replace(/^@+/u, '')
      : '';
    const timestamp = eventTimestamp(value?.created_time ?? entry?.time);
    return [{
      kind: 'comment' as const,
      accountId: account.accountId,
      commenterId,
      ...(commenterUsername ? { commenterUsername } : {}),
      recipientIgUserId: account.igUserId,
      messageId: commentId,
      commentId,
      mediaId,
      text,
      ...(timestamp === undefined ? {} : { timestamp }),
    }];
  });
}

export function normalizeInstagramWebhookPayload(
  payload: any,
  accounts: InstagramWebhookAccount[],
  log?: InstagramWebhookConfig['log'],
): InstagramWebhookMessage[] {
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) return [];
  const normalized: InstagramWebhookMessage[] = [];

  for (const entry of payload.entry) {
    normalized.push(...normalizeInstagramComments(entry, accounts, log));
    const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const event of events) {
      const senderId = typeof event?.sender?.id === 'string' ? event.sender.id.trim() : '';
      const recipientId = typeof event?.recipient?.id === 'string' ? event.recipient.id.trim() : '';
      const message = event?.message;
      if (!message || !senderId) continue;

      const accountMessageAccount = accounts.find((candidate) => candidate.igUserId === senderId);
      if (accountMessageAccount) {
        if (!recipientId) continue;
        const media = messageMedia(message);
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (!text && media.length === 0) continue;
        const messageId = typeof message.mid === 'string' && message.mid.trim()
          ? message.mid.trim()
          : `instagram:${String(event?.timestamp || Date.now())}:${recipientId}`;
        normalized.push({
          kind: 'account',
          accountId: accountMessageAccount.accountId,
          peerId: recipientId,
          recipientIgUserId: accountMessageAccount.igUserId,
          messageId,
          text: text || mediaPlaceholder(media),
          ...(Number.isFinite(event?.timestamp) ? { timestamp: Number(event.timestamp) } : {}),
          media,
        });
        continue;
      }
      if (message.is_echo === true) continue;

      const account = accounts.find((candidate) => candidate.igUserId === recipientId);
      if (!account) {
        log?.warn?.(`[instagram] ignored inbound event for unknown recipient hash=${redactInstagramId(recipientId)}`);
        continue;
      }
      if (account.dmPolicy !== 'open' && !account.allowFrom.has(senderId)) {
        log?.warn?.(`[instagram] blocked sender hash=${redactInstagramId(senderId)} for account ${account.accountId}`);
        continue;
      }

      const media = messageMedia(message);
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      if (!text && media.length === 0) continue;
      const mediaShareKind = !text && media.length > 0
        ? media.every((item) => ['share', 'ig_reel', 'reel'].includes(item.type))
          ? 'recognized' as const
          : media.every((item) => item.type === 'file')
            ? 'untyped' as const
            : undefined
        : undefined;
      const passiveShareOnly =
        !text && media.length > 0 && media.every((item) =>
          ['story_mention', 'share', 'ig_reel', 'reel'].includes(item.type)
        );
      const messageId = typeof message.mid === 'string' && message.mid.trim()
        ? message.mid.trim()
        : `instagram:${String(event?.timestamp || Date.now())}:${senderId}`;
      normalized.push({
        kind: 'inbound',
        accountId: account.accountId,
        senderId,
        threadId: senderId,
        recipientIgUserId: account.igUserId,
        messageId,
        text: text || mediaPlaceholder(media),
        ...(text ? { languageText: text } : {}),
        ...(Number.isFinite(event?.timestamp) ? { timestamp: Number(event.timestamp) } : {}),
        media,
        passiveShareOnly,
        ...(mediaShareKind ? { mediaShareKind } : {}),
        ...(conversationId(event) ? { conversationId: conversationId(event) } : {}),
      });
    }
  }
  return normalized;
}

export function createInstagramWebhookHandler(
  config: InstagramWebhookConfig,
  dispatch: InstagramDispatch,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost');
      const mode = url.searchParams.get('hub.mode') || '';
      const token = url.searchParams.get('hub.verify_token') || '';
      const challenge = url.searchParams.get('hub.challenge') || '';
      if (mode === 'subscribe' && challenge && safeTokenEqual(token, config.verifyToken)) {
        respond(res, 200, challenge);
      } else {
        respond(res, 403, 'Forbidden');
      }
      return;
    }

    if (req.method !== 'POST') {
      respond(res, 405, 'Method Not Allowed');
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await collectRawBody(req, config.bodyMaxBytes ?? DEFAULT_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RangeError) {
        respond(res, 413, 'Request Entity Too Large');
        return;
      }
      respond(res, 500, 'Internal Server Error');
      return;
    }

    const signature = firstHeader(req.headers['x-hub-signature-256']);
    if (!validateInstagramSignature(rawBody, signature, config.appSecret)) {
      respond(res, 403, 'Invalid signature');
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      respond(res, 400, 'Invalid JSON');
      return;
    }

    const messages = normalizeInstagramWebhookPayload(payload, config.accounts, config.log);
    respond(res, 200, 'EVENT_RECEIVED');
    await Promise.all(messages.map(async (message) => {
      try {
        await dispatch(message);
      } catch (error) {
        config.log?.error?.(
          `[instagram] dispatch failed messageId=${message.messageId} accountId=${message.accountId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }));
  };
}
