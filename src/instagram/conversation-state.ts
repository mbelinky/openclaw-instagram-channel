import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const HUMAN_TAKEOVER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AMBIGUOUS_SEND_TTL_MS = 10 * 60 * 1000;
const MESSAGE_DEDUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type MarkerKind = 'bot' | 'ambiguous' | 'human-conversation' | 'comment' | 'reaction';

type HumanConversationState = {
  takeoverExpiresAt: number;
  humanMessages: Record<string, number>;
};

function markerPath(dataDir: string, kind: MarkerKind, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex');
  const extension = kind === 'human-conversation'
    ? 'json'
    : kind === 'comment' || kind === 'reaction'
      ? 'processed'
      : 'until';
  return path.join(dataDir, `${kind}-${digest}.${extension}`);
}

function messageHash(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex');
}

function readActiveMarker(filePath: string, now: number): boolean {
  try {
    const expiresAt = Number(fs.readFileSync(filePath, 'utf8'));
    if (Number.isFinite(expiresAt) && expiresAt > now) return true;
    fs.unlinkSync(filePath);
    return false;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function writeMarker(filePath: string, expiresAt: number): void {
  fs.writeFileSync(filePath, String(expiresAt), { encoding: 'utf8', mode: 0o600 });
}

function readHumanConversationState(filePath: string, currentTime: number): HumanConversationState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as HumanConversationState;
    if (!Number.isFinite(parsed.takeoverExpiresAt) || !parsed.humanMessages || typeof parsed.humanMessages !== 'object') {
      throw new Error(`Invalid Instagram human conversation state: ${filePath}`);
    }
    for (const [hash, expiresAt] of Object.entries(parsed.humanMessages)) {
      if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) delete parsed.humanMessages[hash];
    }
    if (parsed.takeoverExpiresAt <= currentTime && Object.keys(parsed.humanMessages).length === 0) {
      fs.unlinkSync(filePath);
      return undefined;
    }
    return parsed;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function writeHumanConversationState(filePath: string, state: HumanConversationState): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function openInstagramConversationStateStore(
  dataDir: string,
  options: { now?: () => number } = {},
) {
  fs.mkdirSync(dataDir, { recursive: true });
  const now = options.now || Date.now;
  const claimedProcessedActions = new Set<string>();
  let writesSincePrune = 0;

  const pruneExpiredMarkers = () => {
    for (const name of fs.readdirSync(dataDir)) {
      const filePath = path.join(dataDir, name);
      if (/^(?:bot|ambiguous)-[a-f0-9]{64}\.until$/.test(name)) {
        readActiveMarker(filePath, now());
      } else if (/^human-conversation-[a-f0-9]{64}\.json$/.test(name)) {
        readHumanConversationState(filePath, now());
      }
    }
  };
  const writeExpiringMarker = (filePath: string, expiresAt: number) => {
    writeMarker(filePath, expiresAt);
    writesSincePrune += 1;
    if (writesSincePrune >= 100) {
      writesSincePrune = 0;
      pruneExpiredMarkers();
    }
  };
  pruneExpiredMarkers();

  const claimProcessedAction = (
    kind: 'comment' | 'reaction',
    accountId: string,
    externalId: string,
  ): boolean => {
    const filePath = markerPath(dataDir, kind, accountId, externalId);
    if (claimedProcessedActions.has(filePath)) return false;
    try {
      const fd = fs.openSync(filePath, 'wx', 0o600);
      fs.closeSync(fd);
      claimedProcessedActions.add(filePath);
      return true;
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        claimedProcessedActions.add(filePath);
        return false;
      }
      throw error;
    }
  };

  return {
    claimComment(accountId: string, commentId: string): boolean {
      return claimProcessedAction('comment', accountId, commentId);
    },
    claimReaction(accountId: string, messageId: string): boolean {
      return claimProcessedAction('reaction', accountId, messageId);
    },
    recordAutomatedMessage(accountId: string, messageId: string): void {
      writeExpiringMarker(
        markerPath(dataDir, 'bot', accountId, messageId),
        now() + MESSAGE_DEDUP_TTL_MS,
      );
    },
    isAutomatedMessage(accountId: string, messageId: string): boolean {
      return readActiveMarker(markerPath(dataDir, 'bot', accountId, messageId), now());
    },
    recordAmbiguousAutomatedText(accountId: string, peerId: string, text: string): void {
      writeExpiringMarker(
        markerPath(dataDir, 'ambiguous', accountId, peerId, text),
        now() + AMBIGUOUS_SEND_TTL_MS,
      );
    },
    isAmbiguousAutomatedText(accountId: string, peerId: string, text: string): boolean {
      return readActiveMarker(markerPath(dataDir, 'ambiguous', accountId, peerId, text), now());
    },
    recordHumanMessage(
      accountId: string,
      peerId: string,
      messageId: string,
      eventTimestamp?: number,
    ): boolean {
      const currentTime = now();
      const filePath = markerPath(dataDir, 'human-conversation', accountId, peerId);
      const state = readHumanConversationState(filePath, currentTime) || {
        takeoverExpiresAt: 0,
        humanMessages: {},
      };
      const dedupKey = messageHash(messageId);
      if ((state.humanMessages[dedupKey] || 0) > currentTime) return false;
      const occurredAt = Number.isFinite(eventTimestamp) && Number(eventTimestamp) <= currentTime + 5 * 60 * 1000
        ? Number(eventTimestamp)
        : currentTime;
      state.takeoverExpiresAt = Math.max(state.takeoverExpiresAt, occurredAt + HUMAN_TAKEOVER_WINDOW_MS);
      state.humanMessages[dedupKey] = currentTime + MESSAGE_DEDUP_TTL_MS;
      writeHumanConversationState(filePath, state);
      writesSincePrune += 1;
      if (writesSincePrune >= 100) {
        writesSincePrune = 0;
        pruneExpiredMarkers();
      }
      return true;
    },
    isHumanTakeoverActive(accountId: string, peerId: string): boolean {
      const currentTime = now();
      const state = readHumanConversationState(
        markerPath(dataDir, 'human-conversation', accountId, peerId),
        currentTime,
      );
      return Boolean(state && state.takeoverExpiresAt > currentTime);
    },
    close(): void {
      // Marker files require no open handle.
    },
  };
}
